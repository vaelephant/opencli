/**
 * 外部 CLI（External CLI）注册与执行。
 *
 * opencli 可以把「本仓库未内置」的第三方命令行工具当作扩展：在 YAML 里登记名称、
 * 实际二进制名、以及各平台一键安装命令。典型用法：`opencli external run <name> -- ...`
 * 或插件子命令转发到 gh、ffmpeg 等。
 *
 * 配置来源（后者覆盖同名前者）：
 * 1. 打包内置：`dist/external-clis.yaml`（随编译从 `src/external-clis.yaml` 复制）
 * 2. 用户目录：`~/.opencli/external-clis.yaml`
 *
 * 安全说明：自动安装命令经 `parseCommand` 解析后用 `execFileSync` 执行，禁止 shell 元字符，
 * 避免 `rm -rf` 一类注入；透传执行使用 `spawnSync` 继承 stdio。
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync, execFileSync } from 'node:child_process';
import yaml from 'js-yaml';
import chalk from 'chalk';
import { log } from './logger.js';
import { EXIT_CODES, getErrorMessage } from './errors.js';

/** 当前模块所在目录（ESM 无 CommonJS 的 __dirname） */
const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** 各操作系统下一键安装命令（字符串，经 parseCommand 解析，不可含 shell 管道等） */
export interface ExternalCliInstall {
  mac?: string;
  linux?: string;
  windows?: string;
  /** 未匹配到 mac/linux/windows 时使用 */
  default?: string;
}

/** 单条外部 CLI 登记项 */
export interface ExternalCliConfig {
  /** 在 opencli 里使用的逻辑名 */
  name: string;
  /** PATH 上可执行文件名（如 gh、ffmpeg） */
  binary: string;
  description?: string;
  homepage?: string;
  tags?: string[];
  install?: ExternalCliInstall;
}

/** 用户级注册表路径：~/.opencli/external-clis.yaml */
function getUserRegistryPath(): string {
  const home = os.homedir();
  return path.join(home, '.opencli', 'external-clis.yaml');
}

/** 内存缓存，避免重复读盘；`registerExternalCli` 写入后会置空以失效 */
let _cachedExternalClis: ExternalCliConfig[] | null = null;

/**
 * 合并内置 + 用户 YAML，按 name 去重（用户覆盖同名内置），排序后返回。
 * 解析失败仅打 warn，不抛错。
 */
export function loadExternalClis(): ExternalCliConfig[] {
  if (_cachedExternalClis) return _cachedExternalClis;
  const configs = new Map<string, ExternalCliConfig>();

  // 1. 内置清单
  const builtinPath = path.resolve(__dirname, 'external-clis.yaml');
  try {
    if (fs.existsSync(builtinPath)) {
      const raw = fs.readFileSync(builtinPath, 'utf8');
      const parsed = (yaml.load(raw) || []) as ExternalCliConfig[];
      for (const item of parsed) configs.set(item.name, item);
    }
  } catch (err) {
    log.warn(`Failed to parse built-in external-clis.yaml: ${getErrorMessage(err)}`);
  }

  // 2. 用户自定义（同名覆盖内置）
  const userPath = getUserRegistryPath();
  try {
    if (fs.existsSync(userPath)) {
      const raw = fs.readFileSync(userPath, 'utf8');
      const parsed = (yaml.load(raw) || []) as ExternalCliConfig[];
      for (const item of parsed) {
        configs.set(item.name, item);
      }
    }
  } catch (err) {
    log.warn(`Failed to parse user external-clis.yaml: ${getErrorMessage(err)}`);
  }

  _cachedExternalClis = Array.from(configs.values()).sort((a, b) => a.name.localeCompare(b.name));
  return _cachedExternalClis;
}

/**
 * 判断 PATH 上是否存在该可执行文件（Windows 用 `where`，其它平台用 `which`）。
 */
export function isBinaryInstalled(binary: string): boolean {
  try {
    const isWindows = os.platform() === 'win32';
    execFileSync(isWindows ? 'where' : 'which', [binary], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/**
 * 按当前操作系统从 install 配置里取出一条安装命令字符串；无则返回 null。
 */
export function getInstallCmd(installConfig?: ExternalCliInstall): string | null {
  if (!installConfig) return null;
  const platform = os.platform();
  if (platform === 'darwin' && installConfig.mac) return installConfig.mac;
  if (platform === 'linux' && installConfig.linux) return installConfig.linux;
  if (platform === 'win32' && installConfig.windows) return installConfig.windows;
  if (installConfig.default) return installConfig.default;
  return null;
}

/**
 * 将 YAML 里的一行安装命令安全解析为「可执行文件路径 + 参数数组」，供 execFileSync 使用。
 *
 * - 拒绝包含 shell 运算符（`&&`、`||`、`|`、`;`、重定向、反引子、`$()` 等）的字符串，
 *   无法安全拆成 argv 时直接抛错，要求用户手动安装。
 * - 支持简单引号分段，不做变量展开。
 *
 * @param cmd — 例如 `"brew install gh"`
 * @returns `{ binary, args }`，非法输入则抛 Error
 */
export function parseCommand(cmd: string): { binary: string; args: string[] } {
  const shellOperators = /&&|\|\|?|;|[><`$#\n\r]|\$\(/;
  if (shellOperators.test(cmd)) {
    throw new Error(
      `Install command contains unsafe shell operators and cannot be executed securely: "${cmd}". ` +
        `Please install the tool manually.`
    );
  }

  // 按空格切分，保留单/双引号内整段（无变量展开）
  const tokens: string[] = [];
  const re = /(?:"([^"]*)")|(?:'([^']*)')|(\S+)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(cmd)) !== null) {
    tokens.push(match[1] ?? match[2] ?? match[3]);
  }

  if (tokens.length === 0) {
    throw new Error(`Install command is empty.`);
  }

  const [binary, ...args] = tokens;
  return { binary, args };
}

/** Windows 下无扩展名且 ENOENT 时，再尝试 `binary.cmd`（npm 全局 shim） */
function shouldRetryWithCmdShim(binary: string, err: unknown): boolean {
  const code = err instanceof Error ? (err as NodeJS.ErrnoException).code : undefined;
  return os.platform() === 'win32' && !path.extname(binary) && code === 'ENOENT';
}

/** 解析并执行安装命令；继承 stdio 便于用户看到 brew/apt 等输出 */
function runInstallCommand(cmd: string): void {
  const { binary, args } = parseCommand(cmd);

  try {
    execFileSync(binary, args, { stdio: 'inherit' });
  } catch (err) {
    if (shouldRetryWithCmdShim(binary, err)) {
      execFileSync(`${binary}.cmd`, args, { stdio: 'inherit' });
      return;
    }
    throw err;
  }
}

/**
 * 若配置了 install 且当前平台有对应命令，则执行自动安装；成功返回 true。
 */
export function installExternalCli(cli: ExternalCliConfig): boolean {
  if (!cli.install) {
    console.error(chalk.red(`No auto-install command configured for '${cli.name}'.`));
    console.error(`Please install '${cli.binary}' manually.`);
    return false;
  }

  const cmd = getInstallCmd(cli.install);
  if (!cmd) {
    console.error(chalk.red(`No install command for your platform (${os.platform()}) for '${cli.name}'.`));
    if (cli.homepage) console.error(`See: ${cli.homepage}`);
    return false;
  }

  console.log(chalk.cyan(`🔹 '${cli.name}' is not installed. Auto-installing...`));
  console.log(chalk.dim(`$ ${cmd}`));
  try {
    runInstallCommand(cmd);
    console.log(chalk.green(`✅ Installed '${cli.name}' successfully.\n`));
    return true;
  } catch (err) {
    console.error(chalk.red(`❌ Failed to install '${cli.name}': ${getErrorMessage(err)}`));
    return false;
  }
}

/**
 * 按注册名找到配置 → 若二进制未安装则尝试自动安装 → 否则 `spawnSync` 透传 args。
 * 子进程继承 stdin/stdout/stderr；退出码写回 `process.exitCode`。
 */
export function executeExternalCli(name: string, args: string[], preloaded?: ExternalCliConfig[]): void {
  const configs = preloaded ?? loadExternalClis();
  const cli = configs.find((c) => c.name === name);
  if (!cli) {
    throw new Error(`External CLI '${name}' not found in registry.`);
  }

  if (!isBinaryInstalled(cli.binary)) {
    const success = installExternalCli(cli);
    if (!success) {
      process.exitCode = EXIT_CODES.SERVICE_UNAVAIL;
      return;
    }
  }

  const result = spawnSync(cli.binary, args, { stdio: 'inherit' });
  if (result.error) {
    console.error(chalk.red(`Failed to execute '${cli.binary}': ${result.error.message}`));
    process.exitCode = EXIT_CODES.GENERIC_ERROR;
    return;
  }

  if (result.status !== null) {
    process.exitCode = result.status;
  }
}

/** `registerExternalCli` 的可选字段 */
export interface RegisterOptions {
  binary?: string;
  /** 写入为 install.default */
  install?: string;
  description?: string;
}

/**
 * 向用户注册表追加或更新一条外部 CLI，并写回 `~/.opencli/external-clis.yaml`。
 * 成功后清空内存缓存，使下次 `loadExternalClis` 读到新内容。
 */
export function registerExternalCli(name: string, opts?: RegisterOptions): void {
  const userPath = getUserRegistryPath();
  const configDir = path.dirname(userPath);

  if (!fs.existsSync(configDir)) {
    fs.mkdirSync(configDir, { recursive: true });
  }

  let items: ExternalCliConfig[] = [];
  if (fs.existsSync(userPath)) {
    try {
      const raw = fs.readFileSync(userPath, 'utf8');
      items = (yaml.load(raw) || []) as ExternalCliConfig[];
    } catch {
      // 用户文件损坏时当空列表处理
    }
  }

  const existingIndex = items.findIndex((c) => c.name === name);

  const newItem: ExternalCliConfig = {
    name,
    binary: opts?.binary || name,
  };
  if (opts?.description) newItem.description = opts.description;
  if (opts?.install) newItem.install = { default: opts.install };

  if (existingIndex >= 0) {
    items[existingIndex] = { ...items[existingIndex], ...newItem };
    console.log(chalk.green(`Updated '${name}' in user registry.`));
  } else {
    items.push(newItem);
    console.log(chalk.green(`Registered '${name}' in user registry.`));
  }

  const dump = yaml.dump(items, { indent: 2, sortKeys: true });
  fs.writeFileSync(userPath, dump, 'utf8');
  _cachedExternalClis = null;
  console.log(chalk.dim(userPath));
}
