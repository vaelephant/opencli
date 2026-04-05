/**
 * YAML 管线的「步骤名 → 实现函数」注册表。
 *
 * 在项目中的作用：
 * - 适配器除 `func` 外可声明 `pipeline: [...]`（见各站点 `*.yaml`），`executor` 顺序执行每一步；
 * - 每一步在 YAML 里是一个键，如 `navigate:`、`fetch:`，键名即此处注册的 **name**；
 * - `getStep(name)` 取出对应 `StepHandler`，传入 `page`、该步参数、`data` 状态、CLI `args`；
 * - 核心步骤在本文件底部 **自动 register**；第三方若接入 opencli，也可在启动时调用
 *   `registerStep('myOp', handler)` 扩展自定义步骤。
 *
 * 相关文件：`executor.ts`（调度）、`steps/*.ts`（各步实现）。
 */

import type { IPage } from '../types.js';

import { stepNavigate, stepClick, stepType, stepWait, stepPress, stepSnapshot, stepEvaluate } from './steps/browser.js';
import { stepFetch } from './steps/fetch.js';
import { stepSelect, stepMap, stepFilter, stepSort, stepLimit } from './steps/transform.js';
import { stepIntercept } from './steps/intercept.js';
import { stepTap } from './steps/tap.js';
import { stepDownload } from './steps/download.js';

/**
 * 单步处理函数签名：所有管线步骤均满足此形状。
 *
 * @param page — 浏览器页面对象；无浏览器会话的命令可能为 `null`
 * @param params — 本步在 YAML 中写的值（对象或字符串等，由各 step 自行解析）
 * @param data — 上游步骤累积/传递的管道数据（列表、对象等）
 * @param args — 用户在 CLI 传入的命名参数（keyword、limit 等）
 */
export type StepHandler<TData = unknown, TResult = unknown, TParams = unknown> = (
  page: IPage | null,
  params: TParams,
  data: TData,
  args: Record<string, unknown>
) => Promise<TResult>;

/** 内存中的步骤注册表（模块加载时由下方自动填充核心步骤） */
const _stepRegistry = new Map<string, StepHandler>();

/**
 * 按步骤名字符串查找已注册的处理器；未注册则返回 `undefined`（executor 会报错或跳过）。
 */
export function getStep(name: string): StepHandler | undefined {
  return _stepRegistry.get(name);
}

/**
 * 注册自定义步骤，供 YAML 使用。名称需与 YAML 顶层键一致（如 `my-step:` → `registerStep('my-step', ...)`）。
 */
export function registerStep(name: string, handler: StepHandler): void {
  _stepRegistry.set(name, handler);
}

// ── 内置步骤：与 YAML 键名对应 ─────────────────────────────────────────────
// navigate — 导航；fetch — HTTP 请求；select — 从 data 取字段
// evaluate / snapshot — 浏览器内执行脚本或快照；click / type / wait / press — UI 自动化
// map / filter / sort / limit — 数据变换；intercept — 配合浏览器拦截请求
// tap — 移动端式轻触；download — 下载资源（含 yt-dlp 等）

registerStep('navigate', stepNavigate);  // 注册导航步骤
registerStep('fetch', stepFetch);  // 
registerStep('select', stepSelect);  // 注册选择步骤
registerStep('evaluate', stepEvaluate);  // 注册执行脚本步骤
registerStep('snapshot', stepSnapshot);  // 注册快照步骤
registerStep('click', stepClick);  // 注册点击步骤
registerStep('type', stepType);  // 注册输入步骤
registerStep('wait', stepWait);  // 注册等待步骤
registerStep('press', stepPress);  // 注册按下步骤
registerStep('map', stepMap);  // 注册映射步骤
registerStep('filter', stepFilter);  // 注册过滤步骤
registerStep('sort', stepSort);  // 注册排序步骤
registerStep('limit', stepLimit);  // 注册限制步骤
registerStep('intercept', stepIntercept);  // 注册拦截步骤
registerStep('tap', stepTap);  // 注册轻触步骤
registerStep('download', stepDownload);  // 注册下载步骤
