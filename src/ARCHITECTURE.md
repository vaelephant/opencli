# `src/` 目录结构（简图）

引擎相关实现集中在 **`src/core/`**，explore / generate 等工作流在 **`src/workbench/`**。业务代码应 **`import … from '../../core/registry.js'`**（或对应子路径），不要依赖已删除的 `src/` 根目录 re-export。

## `src/core/` — 运行时内核

命令注册、执行、会话、类型、常量、发现、序列化、输出、网络等与「CLI 引擎」相关的代码。

| 模块 | 职责概要 |
|------|------------|
| `registry.ts` | `cli()`、`Strategy`、命令表 |
| `execution.ts` | `executeCommand`：参数、浏览器、超时、管线/func |
| `runtime.ts` | `browserSession`、`runWithTimeout` |
| `discovery.ts` | 扫描 manifest / 文件系统并注册命令 |
| `errors.ts` / `hooks.ts` / `logger.ts` | 错误类型、生命周期钩子、日志 |
| `types.ts` / `constants.ts` / `utils.ts` | 共享类型与工具 |
| `yaml-schema.ts` / `capabilityRouting.ts` | YAML 参数解析、是否走浏览器 |
| `serialization.ts` / `output.ts` | 帮助文本与表格/JSON 等输出 |
| `node-network.ts` | 代理与 fetch 封装 |
| `version.ts` | 读取根目录 `package.json` 版本 |

## `src/workbench/` — 探测与生成工具链

围绕 **`opencli explore` / `synthesize` / `generate` / `record` / `cascade`** 的工作流：浏览器里抓网络、分析 API、生成候选 YAML、录制请求等。

| 模块 | 职责概要 |
|------|------------|
| `explore.ts` | Deep Explore：导航、抓包、推断能力 |
| `synthesize.ts` | 从 explore 产物生成候选管线 YAML |
| `generate.ts` | explore → synthesize 一键编排 |
| `analysis.ts` | URL/JSON 分析与能力推断（explore/record 共用） |
| `record.ts` | 录制页面请求并生成候选 |
| `cascade.ts` | 策略降级探测 |

## 其它（仍在 `src/` 各子目录）

- **`src/cli.ts`**：Commander 入口、内置子命令注册。
- **`src/main.ts`**：进程入口（`bin` 指向编译后的 `main.js`）。
- **`src/pipeline/`**：YAML 管线步骤与执行器。
- **`src/browser/`**、**`src/download/`**、**`src/commands/`** 等：按领域划分，未在本次整体搬迁。
