/**
 * Command execution: validates args, manages browser sessions, runs commands.
 *
 * This is the single entry point for executing any CLI command. It handles:
 * 1. Argument validation and coercion
 * 2. Browser session lifecycle (if needed)
 * 3. Domain pre-navigation for cookie/header strategies
 * 4. Timeout enforcement
 * 5. Lazy-loading of TS modules from manifest
 * 6. Lifecycle hooks (onBeforeExecute / onAfterExecute)
 */

import { type CliCommand, type InternalCliCommand, type Arg, type CommandArgs, Strategy, getRegistry, fullName, strategyLabel } from './registry.js';
import type { IPage } from './types.js';
import { pathToFileURL } from 'node:url';
import { executePipeline } from './pipeline/index.js';
import { AdapterLoadError, ArgumentError, BrowserConnectError, CommandExecutionError, getErrorMessage } from './errors.js';
import { shouldUseBrowserSession } from './capabilityRouting.js';
import { getBrowserFactory, browserSession, runWithTimeout, DEFAULT_BROWSER_COMMAND_TIMEOUT } from './runtime.js';
import { emitHook, type HookContext } from './hooks.js';
import { checkDaemonStatus } from './browser/discover.js';
import { log } from './logger.js';
import { isElectronApp } from './electron-apps.js';

/** Label for `[flow]` lines so traces map to this module */
const FLOW_SRC = 'execution.ts';
import { resolveElectronEndpoint } from './launcher.js';

const _loadedModules = new Set<string>();

function summarizeKwargs(kwargs: CommandArgs): string {
  const keys = Object.keys(kwargs);
  if (keys.length === 0) return '(none)';
  return keys
    .map((k) => {
      const v = kwargs[k];
      if (v === undefined || v === null) return `${k}=`;
      const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
      const trimmed = s.length > 72 ? `${s.slice(0, 69)}...` : s;
      return `${k}=${trimmed}`;
    })
    .join(', ');
}

export function coerceAndValidateArgs(cmdArgs: Arg[], kwargs: CommandArgs): CommandArgs {
  const result: CommandArgs = { ...kwargs };

  for (const argDef of cmdArgs) {
    const val = result[argDef.name];

    if (argDef.required && (val === undefined || val === null || val === '')) {
      throw new ArgumentError(
        `Argument "${argDef.name}" is required.`,
        argDef.help ?? `Provide a value for --${argDef.name}`,
      );
    }

    if (val !== undefined && val !== null) {
      if (argDef.type === 'int' || argDef.type === 'number') {
        const num = Number(val);
        if (Number.isNaN(num)) {
          throw new ArgumentError(`Argument "${argDef.name}" must be a valid number. Received: "${val}"`);
        }
        result[argDef.name] = num;
      } else if (argDef.type === 'boolean' || argDef.type === 'bool') {
        if (typeof val === 'string') {
          const lower = val.toLowerCase();
          if (lower === 'true' || lower === '1') result[argDef.name] = true;
          else if (lower === 'false' || lower === '0') result[argDef.name] = false;
          else throw new ArgumentError(`Argument "${argDef.name}" must be a boolean (true/false). Received: "${val}"`);
        } else {
          result[argDef.name] = Boolean(val);
        }
      }

      const coercedVal = result[argDef.name];
      if (argDef.choices && argDef.choices.length > 0) {
        if (!argDef.choices.map(String).includes(String(coercedVal))) {
          throw new ArgumentError(`Argument "${argDef.name}" must be one of: ${argDef.choices.join(', ')}. Received: "${coercedVal}"`);
        }
      }
    } else if (argDef.default !== undefined) {
      result[argDef.name] = argDef.default;
    }
  }
  return result;
}

async function runCommand(
  cmd: CliCommand,
  page: IPage | null,
  kwargs: CommandArgs,
  debug: boolean,
): Promise<unknown> {
  log.flow('handler', 'runCommand — resolve implementation', FLOW_SRC);
  const internal = cmd as InternalCliCommand;
  if (internal._lazy && internal._modulePath) {
    const modulePath = internal._modulePath;
    if (!_loadedModules.has(modulePath)) {
      try {
        log.flow('adapter', `dynamic import ${modulePath}`, FLOW_SRC);
        await import(pathToFileURL(modulePath).href);
        _loadedModules.add(modulePath);
        log.flow('adapter', 'module registered commands via cli()', FLOW_SRC);
      } catch (err) {
        throw new AdapterLoadError(
          `Failed to load adapter module ${modulePath}: ${getErrorMessage(err)}`,
          'Check that the adapter file exists and has no syntax errors.',
        );
      }
    }

    const updated = getRegistry().get(fullName(cmd));
    if (updated?.func) {
      if (!page && updated.browser !== false) {
        throw new CommandExecutionError(`Command ${fullName(cmd)} requires a browser session but none was provided`);
      }
      log.flow('invoke', 'TypeScript handler (lazy-registered func)', FLOW_SRC);
      return updated.func(page as IPage, kwargs, debug);
    }
    if (updated?.pipeline) {
      log.flow('invoke', `YAML pipeline — ${updated.pipeline.length} step(s) (lazy)`, FLOW_SRC);
      return executePipeline(page, updated.pipeline, { args: kwargs, debug });
    }
  }

  if (cmd.func) {
    log.flow('invoke', 'TypeScript handler (func)', FLOW_SRC);
    return cmd.func(page as IPage, kwargs, debug);
  }
  if (cmd.pipeline) {
    log.flow('invoke', `YAML pipeline — ${cmd.pipeline.length} step(s)`, FLOW_SRC);
    return executePipeline(page, cmd.pipeline, { args: kwargs, debug });
  }
  throw new CommandExecutionError(
    `Command ${fullName(cmd)} has no func or pipeline`,
    'This is likely a bug in the adapter definition. Please report this issue.',
  );
}

function resolvePreNav(cmd: CliCommand): string | null {
  if (cmd.navigateBefore === false) return null;
  if (typeof cmd.navigateBefore === 'string') return cmd.navigateBefore;

  if ((cmd.strategy === Strategy.COOKIE || cmd.strategy === Strategy.HEADER) && cmd.domain) {
    return `https://${cmd.domain}`;
  }
  return null;
}

function ensureRequiredEnv(cmd: CliCommand): void {
  const missing = (cmd.requiredEnv ?? []).find(({ name }) => {
    const value = process.env[name];
    return value === undefined || value === null || value === '';
  });
  if (!missing) return;

  throw new CommandExecutionError(
    `Command ${fullName(cmd)} requires environment variable ${missing.name}.`,
    missing.help ?? `Set ${missing.name} before running ${fullName(cmd)}.`,
  );
}

/**
 * Check if the browser is already on the target domain, avoiding redundant navigation.
 * Returns true if current page hostname matches the pre-nav URL hostname.
 */
async function isAlreadyOnDomain(page: IPage, targetUrl: string): Promise<boolean> {
  if (!page.getCurrentUrl) return false;
  try {
    const currentUrl = await page.getCurrentUrl();
    if (!currentUrl) return false;
    const currentHost = new URL(currentUrl).hostname;
    const targetHost = new URL(targetUrl).hostname;
    return currentHost === targetHost;
  } catch {
    return false;
  }
}

export async function executeCommand(
  cmd: CliCommand,
  rawKwargs: CommandArgs,
  debug: boolean = false,
): Promise<unknown> {
  let kwargs: CommandArgs;
  try {
    kwargs = coerceAndValidateArgs(cmd.args, rawKwargs);
  } catch (err) {
    if (err instanceof ArgumentError) throw err;
    throw new ArgumentError(getErrorMessage(err));
  }

  log.flow('execute', fullName(cmd), FLOW_SRC);
  log.flow('strategy', strategyLabel(cmd), FLOW_SRC);
  log.flow('args', summarizeKwargs(kwargs), FLOW_SRC);

  const hookCtx: HookContext = {
    command: fullName(cmd),
    args: kwargs,
    startedAt: Date.now(),
  };
  await emitHook('onBeforeExecute', hookCtx);
  log.flow('hook', 'onBeforeExecute finished', FLOW_SRC);

  let result: unknown;
  try {
    if (shouldUseBrowserSession(cmd)) {
      log.flow('browser', 'browser session required (shouldUseBrowserSession)', FLOW_SRC);
      const electron = isElectronApp(cmd.site);
      let cdpEndpoint: string | undefined;

      if (electron) {
        log.flow('electron', 'resolve CDP endpoint for desktop app', FLOW_SRC);
        // Electron apps: auto-detect, prompt restart if needed, launch with CDP
        cdpEndpoint = await resolveElectronEndpoint(cmd.site);
        log.flow('electron', `CDP endpoint ${cdpEndpoint ?? '(none)'}`, FLOW_SRC);
      } else {
        // Browser Bridge: fail-fast when daemon is up but extension is missing.
        // 300ms timeout avoids a full 2s wait on cold-start.
        const status = await checkDaemonStatus({ timeout: 300 });
        log.flow('bridge', `daemon running=${status.running} extension connected=${status.extensionConnected}`, FLOW_SRC);
        if (status.running && !status.extensionConnected) {
          throw new BrowserConnectError(
            'Browser Bridge extension not connected',
            'Install the Browser Bridge:\n' +
            '  1. Download: https://github.com/jackwener/opencli/releases\n' +
            '  2. chrome://extensions → Developer Mode → Load unpacked\n' +
            '  Then run: opencli doctor',
          );
        }
      }

      ensureRequiredEnv(cmd);
      log.flow('env', 'required env vars satisfied', FLOW_SRC);
      const BrowserFactory = getBrowserFactory(cmd.site);
      log.flow('factory', `using ${BrowserFactory.name || 'BrowserFactory'}`, FLOW_SRC);
      result = await browserSession(BrowserFactory, async (page) => {
        const preNavUrl = resolvePreNav(cmd);
        if (preNavUrl) {
          log.flow('pre-nav', `target ${preNavUrl}`, FLOW_SRC);
          const skip = await isAlreadyOnDomain(page, preNavUrl);
          if (skip) {
            log.flow('pre-nav', 'already on target domain — skip goto', FLOW_SRC);
            if (debug) log.debug('[pre-nav] Already on target domain, skipping navigation');
          } else {
            log.flow('pre-nav', 'loading page (goto)', FLOW_SRC);
            try {
              await page.goto(preNavUrl);
              log.flow('pre-nav', 'goto completed', FLOW_SRC);
            } catch (err) {
              log.flow('pre-nav', `goto failed: ${err instanceof Error ? err.message : String(err)}`, FLOW_SRC);
              if (debug) log.debug(`[pre-nav] Failed to navigate to ${preNavUrl}: ${err instanceof Error ? err.message : err}`);
            }
          }
        } else {
          log.flow('pre-nav', 'skipped (no domain pre-navigation for this command)', FLOW_SRC);
        }
        const timeoutSec = cmd.timeoutSeconds ?? DEFAULT_BROWSER_COMMAND_TIMEOUT;
        log.flow('timeout', `command body — ${timeoutSec}s max`, FLOW_SRC);
        return runWithTimeout(runCommand(cmd, page, kwargs, debug), {
          timeout: timeoutSec,
          label: fullName(cmd),
        });
      }, { workspace: `site:${cmd.site}`, cdpEndpoint });
    } else {
      log.flow('browser', 'no browser page — running without Browser Bridge / CDP', FLOW_SRC);
      // Non-browser commands: apply timeout only when explicitly configured.
      const timeout = cmd.timeoutSeconds;
      if (timeout !== undefined && timeout > 0) {
        log.flow('timeout', `non-browser command — ${timeout}s max`, FLOW_SRC);
        result = await runWithTimeout(runCommand(cmd, null, kwargs, debug), {
          timeout,
          label: fullName(cmd),
          hint: `Increase the adapter's timeoutSeconds setting (currently ${timeout}s)`,
        });
      } else {
        result = await runCommand(cmd, null, kwargs, debug);
      }
    }
  } catch (err) {
    hookCtx.error = err;
    hookCtx.finishedAt = Date.now();
    await emitHook('onAfterExecute', hookCtx);
    throw err;
  }

  hookCtx.finishedAt = Date.now();
  await emitHook('onAfterExecute', hookCtx, result);
  if (hookCtx.startedAt !== undefined) {
    log.flow('done', `finished in ${hookCtx.finishedAt - hookCtx.startedAt}ms`, FLOW_SRC);
  }
  log.flow('hook', 'onAfterExecute finished', FLOW_SRC);
  return result;
}
