/**
 * Unified logging for opencli.
 *
 * All framework output (warnings, debug info, errors) should go through
 * this module so that verbosity levels are respected consistently.
 */

import chalk from 'chalk';

/** Local time with milliseconds for log lines (HH:mm:ss.SSS). */
export function formatLogTime(): string {
  const d = new Date();
  const pad = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

function ts(): string {
  return chalk.dim(`[${formatLogTime()}]`);
}

function isVerbose(): boolean {
  return !!process.env.OPENCLI_VERBOSE;
}

function isDebug(): boolean {
  return !!process.env.DEBUG?.includes('opencli');
}

export const log = {
  /** Informational message (always shown) */
  info(msg: string): void {
    process.stderr.write(`${ts()} ${chalk.blue('ℹ')}  ${msg}\n`);
  },

  /** Warning (always shown) */
  warn(msg: string): void {
    process.stderr.write(`${ts()} ${chalk.yellow('⚠')}  ${msg}\n`);
  },

  /** Error (always shown) */
  error(msg: string): void {
    process.stderr.write(`${ts()} ${chalk.red('✖')}  ${msg}\n`);
  },

  /** Verbose output (only when OPENCLI_VERBOSE is set or -v flag) */
  verbose(msg: string): void {
    if (isVerbose()) {
      process.stderr.write(`${ts()} ${chalk.dim('[verbose]')} ${msg}\n`);
    }
  },

  /**
   * High-level execution flow (same visibility as verbose: `-v` / OPENCLI_VERBOSE).
   * Use for step-by-step traces so users can follow what the CLI is doing.
   */
  flow(phase: string, detail?: string): void {
    if (!isVerbose()) return;
    const suffix = detail !== undefined && detail !== '' ? ` ${chalk.dim(detail)}` : '';
    process.stderr.write(`${ts()} ${chalk.magenta('[flow]')} ${phase}${suffix}\n`);
  },

  /** Debug output (only when DEBUG includes 'opencli') */
  debug(msg: string): void {
    if (isDebug()) {
      process.stderr.write(`${ts()} ${chalk.dim('[debug]')} ${msg}\n`);
    }
  },

  /** Step-style debug (for pipeline steps, etc.) */
  step(stepNum: number, total: number, op: string, preview: string = ''): void {
    process.stderr.write(`${ts()}   ${chalk.dim(`[${stepNum}/${total}]`)} ${chalk.bold.cyan(op)}${preview}\n`);
  },

  /** Step result summary */
  stepResult(summary: string): void {
    process.stderr.write(`${ts()}        ${chalk.dim(`→ ${summary}`)}\n`);
  },
};
