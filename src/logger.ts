/**
 * opencli 统一日志模块。
 *
 * 框架侧输出（提示、警告、调试、错误、执行流）应通过本模块输出，以便：
 * - 与「普通 stdout 结果」区分：日志默认走 stderr，避免污染管道/重定向中的结构化输出；
 * - 按环境变量统一控制详细程度（verbose / debug），行为一致。
 *
 * 可见性速查：
 * - 始终输出：`info` / `warn` / `error`
 * - 需 `-v` 或 `OPENCLI_VERBOSE=1`：`verbose`、`flow`
 * - 需 `DEBUG` 含子串 `opencli`：`debug`
 * - `step` / `stepResult`：当前实现**不**检查 verbose，调用方需自行决定是否仅在详细模式下调用
 */

import chalk from 'chalk';

/**
 * 格式化为本地时间的日志时间戳，含毫秒（`HH:mm:ss.SSS`）。
 * 用于各行日志前缀，便于对照相邻两行间隔、估算耗时。
 */
export function formatLogTime(): string {
  const d = new Date();
  const pad = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

/** 带灰色时间戳的片段，形如 `[12:34:56.789]`，供各日志方法拼接。 */
function ts(): string {
  return chalk.dim(`[${formatLogTime()}]`);
}

/**
 * 是否处于「详细模式」：子命令 `-v` 会在运行时设置 `OPENCLI_VERBOSE`，
 * 与 `verbose`、`flow` 的可见性一致。
 */
function isVerbose(): boolean {
  return !!process.env.OPENCLI_VERBOSE;
}

/**
 * 是否开启 opencli 的 debug 行：要求环境变量 `DEBUG` 中包含子串 `opencli`
 *（例如 `DEBUG=opencli` 或 `DEBUG=*` 若实现包含匹配）。用于开发排障，比普通 verbose 更细。
 */
function isDebug(): boolean {
  return !!process.env.DEBUG?.includes('opencli');
}

/**
 * 对外导出的日志 API 集合。
 */
export const log = {
  /**
   * 一般信息：始终输出到 stderr，前缀蓝色 ℹ。
   * 用于用户可见的说明性文字（非错误、非警告）。
   */
  info(msg: string): void {
    process.stderr.write(`${ts()} ${chalk.blue('ℹ')}  ${msg}\n`);
  },

  /**
   * 警告：始终输出，前缀黄色 ⚠。
   * 表示可恢复或非致命问题，命令仍可能继续或已成功但需留意。
   */
  warn(msg: string): void {
    process.stderr.write(`${ts()} ${chalk.yellow('⚠')}  ${msg}\n`);
  },

  /**
   * 错误：始终输出，前缀红色 ✖。
   * 用于失败路径或严重问题；通常 stderr 上还会配合抛错或退出码。
   */
  error(msg: string): void {
    process.stderr.write(`${ts()} ${chalk.red('✖')}  ${msg}\n`);
  },

  /**
   * 详细杂项：仅在 `OPENCLI_VERBOSE` 为真时输出（即 `-v` 或显式设置环境变量）。
   * 前缀为灰色 `[verbose]`，用于非「执行阶段」类的一般调试句，与 `flow` 区分。
   */
  verbose(msg: string): void {
    if (isVerbose()) {
      process.stderr.write(`${ts()} ${chalk.dim('[verbose]')} ${msg}\n`);
    }
  },

  /**
   * 高层执行流追踪：与 `verbose` 相同，仅在详细模式下输出。
   *
   * 典型用途：命令从解析到执行、浏览器会话、适配器加载、预导航、超时边界等「步骤」，
   * 便于用户加 `-v` 时跟随 CLI 在做什么。前缀为洋红色 `[flow]`。
   *
   * @param phase — 步骤类别短标签，如 `execute`、`session`、`adapter`（非灰色，便于扫读）
   * @param detail — 可选补充说明（灰色）；无则只输出 phase + 来源
   * @param from — 可选来源文件名（如 `execution.ts`），灰色前缀，便于对照仓库源码位置
   */
  flow(phase: string, detail?: string, from?: string): void {
    if (!isVerbose()) return;
    const prefix = from ? `${chalk.dim(from)} ` : '';
    const suffix = detail !== undefined && detail !== '' ? ` ${chalk.dim(detail)}` : '';
    process.stderr.write(`${ts()} ${chalk.magenta('[flow]')} ${prefix}${phase}${suffix}\n`);
  },

  /**
   * 调试输出：仅在 `DEBUG` 含 `opencli` 时打印，前缀 `[debug]`。
   * 面向开发者（环境变量），比普通 `-v` 更「开发向」，生产环境通常不开启。
   */
  debug(msg: string): void {
    if (isDebug()) {
      process.stderr.write(`${ts()} ${chalk.dim('[debug]')} ${msg}\n`);
    }
  },

  /**
   * 流水线式步骤行：显示当前第几步、共几步、操作名及可选预览。
   * 常用于 YAML/多步管线；**当前实现不检查 verbose**，由调用方决定是否在详细模式下调用。
   *
   * @param stepNum — 当前步骤序号（从 1 起）
   * @param total — 总步骤数
   * @param op — 本步操作名（青色加粗）
   * @param preview — 附加在同一行的简短预览（可选）
   */
  step(stepNum: number, total: number, op: string, preview: string = ''): void {
    process.stderr.write(`${ts()}   ${chalk.dim(`[${stepNum}/${total}]`)} ${chalk.bold.cyan(op)}${preview}\n`);
  },

  /**
   * 与 `step` 配套的缩进结果摘要行，前缀 `→`（灰色）。
   * 用于在一步操作后输出一行简短结果。
   */
  stepResult(summary: string): void {
    process.stderr.write(`${ts()}        ${chalk.dim(`→ ${summary}`)}\n`);
  },
};
