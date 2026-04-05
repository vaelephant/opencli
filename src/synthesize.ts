/**
 * 从「探测结果」合成候选 CLI（YAML 管线草稿）。
 *
 * 在项目中的作用：
 * - **输入**：`opencli explore <url>` 写出的目录（`manifest.json`、`endpoints.json`、`capabilities.json`、`auth.json`）；
 * - **输出**：在同目录下 `candidates/`（或 `opts.outDir`）生成若干 `*.yaml`，以及 `candidates.json` 索引；
 * - **目的**：把 explore 阶段推断的「能力」转成可注册的管线模板，风格贴近手写适配器（如 bilibili/hot、hackernews/top）：
 *   - **public**：直接 `fetch` + 可选 `select`；
 *   - **需登录/Cookie**：`navigate` + `evaluate`（页内 `fetch`+`credentials:'include'`+JSON 解析）；
 *   - **store-action**（签名/拦截）：`navigate` + `wait` + `tap` 触发前端 store。
 *
 * 相关命令：`opencli synthesize <target>`、`generate`/`cascade` 流水线中的一环；`buildCandidate` 供 `scaffold.ts` 兼容旧字段名。
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import yaml from 'js-yaml';
import { VOLATILE_PARAMS, SEARCH_PARAMS, LIMIT_PARAMS, PAGINATION_PARAMS } from './constants.js';
import type { ExploreAuthSummary, ExploreEndpointArtifact, ExploreManifest } from './explore.js';

/** 与 `constants` 中同名集合一致，便于本文件内阅读 */
const SEARCH_PARAM_NAMES = SEARCH_PARAMS;
const LIMIT_PARAM_NAMES = LIMIT_PARAMS;
const PAGE_PARAM_NAMES = PAGINATION_PARAMS;

/** explore 输出的 recommendedArgs 单项形状 */
interface RecommendedArg {
  name: string;
  type?: string;
  required?: boolean;
  default?: unknown;
}

/** explore 推断的 Pinia/Vuex 与接口配对提示 */
interface StoreHint {
  store: string;
  action: string;
}

/**
 * 与 `capabilities.json` 中单条能力对应（含蛇形字段别名以兼容旧数据）。
 */
export interface SynthesizeCapability {
  name: string;
  description: string;
  strategy: string;
  confidence?: number;
  endpoint?: string;
  itemPath?: string | null;
  recommendedColumns?: string[];
  recommendedArgs?: RecommendedArg[];
  recommended_args?: RecommendedArg[];
  recommendedColumnsLegacy?: string[];
  recommended_columns?: string[];
  storeHint?: StoreHint;
}

/** 写入 YAML 的 `args:` 字段定义 */
export interface GeneratedArgDefinition {
  type: string;
  required?: boolean;
  default?: unknown;
  description?: string;
}

/** 候选管线中允许出现的步骤类型（与 `pipeline/registry` 注册的键一致） */
type CandidatePipelineStep =
  | { navigate: string }
  | { wait: number }
  | { evaluate: string }
  | { select: string }
  | { map: Record<string, string> }
  | { limit: string }
  | { fetch: { url: string } }
  | { tap: { store: string; action: string; timeout: number; capture?: string; select?: string | null } };

/** 单个候选命令的完整 YAML 结构（将序列化为文件） */
export interface CandidateYaml {
  site: string;
  name: string;
  description: string;
  domain: string;
  strategy: string;
  browser: boolean;
  args: Record<string, GeneratedArgDefinition>;
  pipeline: CandidatePipelineStep[];
  columns: string[];
}

/** 写入结果摘要用：每条候选的名称、路径、策略 */
export interface SynthesizeCandidateSummary {
  name: string;
  path: string;
  strategy: string;
  confidence?: number;
}

/** `synthesizeFromExplore` 的返回值 */
export interface SynthesizeResult {
  site: string;
  explore_dir: string;
  out_dir: string;
  candidate_count: number;
  candidates: SynthesizeCandidateSummary[];
}

type ExploreManifestLike = Pick<ExploreManifest, 'target_url' | 'final_url'> & Partial<ExploreManifest>;

/** 内存中的 explore 产物聚合 */
interface LoadedExploreBundle {
  manifest: ExploreManifest;
  endpoints: ExploreEndpointArtifact[];
  capabilities: SynthesizeCapability[];
  auth: ExploreAuthSummary;
}

/**
 * 读取 explore 目录，取置信度最高的前 `top` 条能力（默认 3），为每条匹配 endpoint 并生成 YAML。
 */
export function synthesizeFromExplore(
  target: string,
  opts: { outDir?: string; top?: number } = {},
): SynthesizeResult {
  const exploreDir = resolveExploreDir(target);
  const bundle = loadExploreBundle(exploreDir);

  const targetDir = opts.outDir ?? path.join(exploreDir, 'candidates');
  fs.mkdirSync(targetDir, { recursive: true });

  const site = bundle.manifest.site;
  const capabilities = (bundle.capabilities ?? [])
    .sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0))
    .slice(0, opts.top ?? 3);
  const candidates: SynthesizeCandidateSummary[] = [];

  for (const cap of capabilities) {
    const endpoint = chooseEndpoint(cap, bundle.endpoints);
    if (!endpoint) continue;
    const candidate = buildCandidateYaml(site, bundle.manifest, cap, endpoint);
    const filePath = path.join(targetDir, `${candidate.name}.yaml`);
    fs.writeFileSync(filePath, yaml.dump(candidate.yaml, { sortKeys: false, lineWidth: 120 }));
    candidates.push({ name: candidate.name, path: filePath, strategy: cap.strategy, confidence: cap.confidence });
  }

  const index = { site, target_url: bundle.manifest.target_url, generated_from: exploreDir, candidate_count: candidates.length, candidates };
  fs.writeFileSync(path.join(targetDir, 'candidates.json'), JSON.stringify(index, null, 2));

  return { site, explore_dir: exploreDir, out_dir: targetDir, candidate_count: candidates.length, candidates };
}

/** 终端友好的成功摘要文本 */
export function renderSynthesizeSummary(result: SynthesizeResult): string {
  const lines = ['opencli synthesize: OK', `Site: ${result.site}`, `Source: ${result.explore_dir}`, `Candidates: ${result.candidate_count}`];
  for (const c of result.candidates ?? []) lines.push(`  • ${c.name} (${c.strategy}, ${((c.confidence ?? 0) * 100).toFixed(0)}% confidence) → ${c.path}`);
  return lines.join('\n');
}

/**
 * `target` 为已有目录则直接用；否则尝试 `.opencli/explore/<target>`。
 */
export function resolveExploreDir(target: string): string {
  if (fs.existsSync(target)) return target;
  const candidate = path.join('.opencli', 'explore', target);
  if (fs.existsSync(candidate)) return candidate;
  throw new Error(`Explore directory not found: ${target}`);
}

/** 从 explore 目录读取四个 JSON 文件组成内存结构 */
export function loadExploreBundle(exploreDir: string): LoadedExploreBundle {
  return {
    manifest: JSON.parse(fs.readFileSync(path.join(exploreDir, 'manifest.json'), 'utf-8')) as ExploreManifest,
    endpoints: JSON.parse(fs.readFileSync(path.join(exploreDir, 'endpoints.json'), 'utf-8')) as ExploreEndpointArtifact[],
    capabilities: JSON.parse(fs.readFileSync(path.join(exploreDir, 'capabilities.json'), 'utf-8')) as SynthesizeCapability[],
    auth: JSON.parse(fs.readFileSync(path.join(exploreDir, 'auth.json'), 'utf-8')),
  };
}

function chooseEndpoint(cap: SynthesizeCapability, endpoints: ExploreEndpointArtifact[]): ExploreEndpointArtifact | null {
  if (!endpoints.length) return null;
  if (cap.endpoint) {
    const endpointPattern = cap.endpoint;
    const match = endpoints.find((endpoint) => endpoint.pattern === endpointPattern || endpoint.url?.includes(endpointPattern));
    if (match) return match;
  }
  return [...endpoints].sort((a, b) => (b.score ?? 0) - (a.score ?? 0))[0];
}

// ── URL 模板：把查询参数替换成管线模板变量（keyword/limit/page）────────────────

function buildTemplatedUrl(rawUrl: string, cap: SynthesizeCapability, _endpoint: ExploreEndpointArtifact): string {
  try {
    const u = new URL(rawUrl);
    const base = `${u.protocol}//${u.host}${u.pathname}`;
    const params: Array<[string, string]> = [];
    const hasKeyword = cap.recommendedArgs?.some((arg) => arg.name === 'keyword');

    u.searchParams.forEach((v, k) => {
      if (VOLATILE_PARAMS.has(k)) return;
      if (hasKeyword && SEARCH_PARAM_NAMES.has(k)) params.push([k, '${{ args.keyword }}']);
      else if (LIMIT_PARAM_NAMES.has(k)) params.push([k, '${{ args.limit | default(20) }}']);
      else if (PAGE_PARAM_NAMES.has(k)) params.push([k, '${{ args.page | default(1) }}']);
      else params.push([k, v]);
    });

    return params.length ? base + '?' + params.map(([k, v]) => `${k}=${v}`).join('&') : base;
  } catch { return rawUrl; }
}

/**
 * 生成 `evaluate` 步骤内嵌的异步 IIFE 字符串：在页面上下文 `fetch` JSON、按 `itemPath` 取数组、
 * 可选按 `detectedFields` 映射列（与 bilibili/hot、twitter/trending 等手写风格一致）。
 */
function buildEvaluateScript(url: string, itemPath: string, endpoint: ExploreEndpointArtifact): string {
  const pathChain = itemPath.split('.').map((p: string) => `?.${p}`).join('');
  const detectedFields = endpoint?.detectedFields ?? {};
  const hasFields = Object.keys(detectedFields).length > 0;

  let mapCode = '';
  if (hasFields) {
    const mappings = Object.entries(detectedFields)
      .map(([role, field]) => `      ${role}: item${String(field).split('.').map(p => `?.${p}`).join('')}`)
      .join(',\n');
    mapCode = `.map((item) => ({\n${mappings}\n    }))`;
  }

  return [
    '(async () => {',
    `  const res = await fetch(${JSON.stringify(url)}, {`,
    `    credentials: 'include'`,
    '  });',
    '  const data = await res.json();',
    `  return (data${pathChain} || [])${mapCode};`,
    '})()\n',
  ].join('\n');
}

// ── 组装完整 CandidateYaml ─────────────────────────────────────────────────

/**
 * 按策略分支拼装 pipeline，再统一追加 `map` + `limit`，并生成 `args`/`columns`。
 */
function buildCandidateYaml(site: string, manifest: ExploreManifestLike, cap: SynthesizeCapability, endpoint: ExploreEndpointArtifact): { name: string; yaml: CandidateYaml } {
  const needsBrowser = cap.strategy !== 'public';
  const pipeline: CandidatePipelineStep[] = [];
  const templatedUrl = buildTemplatedUrl(endpoint?.url ?? manifest.target_url, cap, endpoint);

  let domain = '';
  try { domain = new URL(manifest.target_url).hostname; } catch {}

  if (cap.strategy === 'store-action' && cap.storeHint) {
    // Vue/Pinia 场景：打开页 → 等待 → tap 触发 store，必要时从 URL 猜 capture 片段
    pipeline.push({ navigate: manifest.target_url });
    pipeline.push({ wait: 3 });
    const tapStep: { store: string; action: string; timeout: number; capture?: string; select?: string | null } = {
      store: cap.storeHint.store,
      action: cap.storeHint.action,
      timeout: 8,
    };
    if (endpoint?.url) {
      try {
        const epUrl = new URL(endpoint.url);
        const pathParts = epUrl.pathname.split('/').filter((p: string) => p);
        const capturePart = pathParts.filter((p: string) => !p.match(/^v\d+$/)).pop();
        if (capturePart) tapStep.capture = capturePart;
      } catch {}
    }
    if (cap.itemPath) tapStep.select = cap.itemPath;
    pipeline.push({ tap: tapStep });
  } else if (needsBrowser) {
    // 需 Cookie：先进入站点再在内联脚本里 fetch（同域携带登录态）
    pipeline.push({ navigate: manifest.target_url });
    const itemPath = cap.itemPath ?? 'data.data.list';
    pipeline.push({ evaluate: buildEvaluateScript(templatedUrl, itemPath, endpoint) });
  } else {
    // 公开 API：管线直接 fetch，必要时 select 取 item 路径
    pipeline.push({ fetch: { url: templatedUrl } });
    if (cap.itemPath) pipeline.push({ select: cap.itemPath });
  }

  const mapStep: Record<string, string> = {};
  const columns = cap.recommendedColumns ?? ['title', 'url'];
  if (!cap.recommendedArgs?.some((arg) => arg.name === 'keyword')) mapStep['rank'] = '${{ index + 1 }}';
  const detectedFields = endpoint?.detectedFields ?? {};
  for (const col of columns) {
    const fieldPath = detectedFields[col];
    mapStep[col] = fieldPath ? `\${{ item.${fieldPath} }}` : `\${{ item.${col} }}`;
  }
  pipeline.push({ map: mapStep });
  pipeline.push({ limit: '${{ args.limit | default(20) }}' });

  const argsDef: Record<string, GeneratedArgDefinition> = {};
  for (const arg of cap.recommendedArgs ?? []) {
    const def: GeneratedArgDefinition = { type: arg.type ?? 'str' };
    if (arg.required) def.required = true;
    if (arg.default != null) def.default = arg.default;
    if (arg.name === 'keyword') def.description = 'Search keyword';
    else if (arg.name === 'limit') def.description = 'Number of items to return';
    else if (arg.name === 'page') def.description = 'Page number';
    argsDef[arg.name] = def;
  }
  if (!argsDef['limit']) argsDef['limit'] = { type: 'int', default: 20, description: 'Number of items to return' };

  return {
    name: cap.name,
    yaml: {
      site, name: cap.name, description: `${cap.description || site + ' ' + cap.name} (auto-generated)`,
      domain, strategy: cap.strategy, browser: needsBrowser,
      args: argsDef, pipeline, columns: Object.keys(mapStep),
    },
  };
}

/**
 * 供 `scaffold.ts` 使用：兼容 `recommended_args` / `recommended_columns` 旧字段名后再生成 YAML。
 */
export function buildCandidate(site: string, targetUrl: string, cap: SynthesizeCapability, endpoint: ExploreEndpointArtifact): { name: string; yaml: CandidateYaml } {
  const normalizedCap = {
    ...cap,
    recommendedArgs: cap.recommendedArgs ?? cap.recommended_args,
    recommendedColumns: cap.recommendedColumns ?? cap.recommended_columns,
  };
  const manifest = { target_url: targetUrl, final_url: targetUrl };
  return buildCandidateYaml(site, manifest, normalizedCap, endpoint);
}
