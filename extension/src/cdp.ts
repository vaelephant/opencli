/**
 * 浏览器桥接扩展中的 Chrome DevTools Protocol（CDP）辅助模块。
 *
 * ## 在 OpenCLI 中的位置
 * - 主自动化路径使用 **内容脚本 + JSON-RPC**（见 `background.ts` / `protocol.ts`）。
 * - 本模块通过 **`chrome.debugger`** 挂接到标签页，提供 **基于 CDP** 的能力。
 * - 当宿主需要带 `awaitPromise` 的 **Runtime.evaluate**、**截图**，或 **DOM.setFileInputFiles**，
 *   且仅靠消息传递难以实现时，会走这里。
 *
 * ## 权限模型
 * - `chrome.debugger` 仅需 **「debugger」** 权限 —— **不需要** `<all_urls>` 或 `host_permissions` 才能 attach。
 *   Chrome 仍会限制哪些标签可被调试。
 * - 我们只对 **http(s)** 页面（以及内部 `data:` 空白页）attach。**chrome://**、**chrome-extension://**
 *   标签应被拒绝；`background.ts` 的 `resolveTabId` 不应把这类标签传进来。
 *
 * ## 协议版本
 * - `chrome.debugger.attach(..., '1.3')` 使用 CDP **协议 1.3**（由 Chrome 映射到内置协议）。
 *
 * ## 反检测说明
 * - attach 后启用 **Debugger** 域，并调用 **`Debugger.setBreakpointsActive({ active: false })`**，
 *   使页面 JS 里的 **`debugger;` 不会暂停执行**。部分反爬脚本用 `debugger;` 做计时陷阱检测自动化；
 *   关闭断点激活可避免暂停，且无需改页面源码。
 *
 * @module cdp
 */

// ── 模块状态 ─────────────────────────────────────────────────────────────
/** 我们认为仍挂着 `chrome.debugger` 的标签 ID（未验证前可能过期）。 */
const attached = new Set<number>(); // 标签ID集合，用于记录已attached的标签

/** 自动化标签尚无真实导航时使用的占位 URL（须保持可 attach）。 */
const BLANK_PAGE = 'data:text/html,<html></html>'; // 空白页面URL

/** 用于识别可能干扰 debugger attach 的第三方扩展 iframe 等。 */
const FOREIGN_EXTENSION_URL_PREFIX = 'chrome-extension://'; // 第三方扩展URL前缀

/** 移除外来嵌入后重试 attach 前的短延迟（毫秒），让布局稳定。 */
const ATTACH_RECOVERY_DELAY_MS = 120;

// ── URL 是否可调试 ──────────────────────────────────────────────────────

/**
 * 判断标签 URL 是否允许用 `chrome.debugger` attach。
 * - **http/https**：普通网页 —— 允许。
 * - **undefined / 空**：可能仍在加载 —— 允许 attach（之后 URL 可能更新）。
 * - **BLANK_PAGE**：内部空白文档 —— 允许。
 * - **chrome://**、**chrome-extension://**（本扩展除外）、**file://** 等 —— 此处不允许。
 */
function isDebuggableUrl(url?: string): boolean {
  if (!url) return true; // 加载中或未提交 —— 允许；若 URL 变坏 onUpdated 会 detach
  return url.startsWith('http://') || url.startsWith('https://') || url === BLANK_PAGE;
}

type CleanupResult = { removed: number };

/**
 * 从页面 DOM 中移除**其它扩展**嵌入的框架（`iframe` / `frame` / …）。
 *
 * **原因：** attach 失败时错误信息里有时会出现 **`chrome-extension://`**。其它扩展往页面里注入
 * 跨扩展的 frame 可能导致 debugger 无法附加。删除**非本扩展**的 `chrome-extension://` 嵌入（保留本扩展自己的）
 * 是一种尽力恢复手段。
 *
 * 遍历 **document + 已打开的 shadow root**，以覆盖嵌套自定义元素。
 */
async function removeForeignExtensionEmbeds(tabId: number): Promise<CleanupResult> {
  const tab = await chrome.tabs.get(tabId);
  if (!tab.url || (!tab.url.startsWith('http://') && !tab.url.startsWith('https://'))) {
    return { removed: 0 };
  }
  if (!chrome.scripting?.executeScript) return { removed: 0 };

  try {
    const [result] = await chrome.scripting.executeScript({
      target: { tabId }, // 目标标签ID
      args: [`${FOREIGN_EXTENSION_URL_PREFIX}${chrome.runtime.id}/`], // 本扩展的URL
      func: (ownExtensionPrefix: string) => {
        const extensionPrefix = 'chrome-extension://'; // 第三方扩展URL前缀
        const selectors = ['iframe', 'frame', 'embed', 'object']; // 需要移除的元素选择器
        const visitedRoots = new Set<Document | ShadowRoot>(); // 已访问的根节点集合
        const roots: Array<Document | ShadowRoot> = [document]; // 当前需要处理的根节点列表
        let removed = 0; // 移除的元素数量

        while (roots.length > 0) { // 遍历根节点列表
          const root = roots.pop();
          if (!root || visitedRoots.has(root)) continue; // 如果根节点不存在或已访问，则跳过
          visitedRoots.add(root); // 将根节点添加到已访问的根节点集合

          for (const selector of selectors) { // 遍历选择器列表
            const nodes = root.querySelectorAll(selector); // 获取所有匹配的元素
            for (const node of nodes) {
              const src = node.getAttribute('src') || node.getAttribute('data') || ''; // 获取元素的src属性
              if (!src.startsWith(extensionPrefix) || src.startsWith(ownExtensionPrefix)) continue; // 如果src属性不是第三方扩展URL，则跳过
              node.remove(); // 移除元素
              removed++; // 移除的元素数量加1
            }
          }

          const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT); // 创建树遍历器
          let current = walker.nextNode(); // 获取下一个节点
          while (current) { // 遍历节点
            const element = current as Element & { shadowRoot?: ShadowRoot | null }; // 获取元素
            if (element.shadowRoot) roots.push(element.shadowRoot); // 如果元素有shadowRoot，则添加到根节点列表
            current = walker.nextNode(); // 获取下一个节点
          }
        }

        return { removed }; // 返回移除的元素数量
      },
    });
    return result?.result ?? { removed: 0 }; // 返回移除的元素数量
  } catch {
    return { removed: 0 }; // 返回移除的元素数量
  }
}

/**
 * 延迟一段时间
 * @param ms - 延迟时间（毫秒）
 * @returns Promise<void>
 */ 
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms)); // 延迟一段时间
}

/** 底层 attach，CDP 协议版本 1.3（失败则抛错）。 */
async function tryAttach(tabId: number): Promise<void> {
  await chrome.debugger.attach({ tabId }, '1.3');
}

/**
 * 确保 `chrome.debugger` 已挂到 `tabId`，且本文件所需的 CDP 域已就绪。
 *
 * 步骤概要：
 * 1. **校验标签 URL** —— 必须可调试；否则清掉过期缓存。
 * 2. **快路径** —— 若认为已 attach，用 `Runtime.evaluate('1')` 探测；失败则清缓存。
 * 3. **Attach** —— `debugger.attach`；遇特定错误时：去掉第三方扩展嵌入后**重试**，或
 *    已有其它调试器占用时 **detach 再 attach**。
 * 4. **Attach 之后** —— `Runtime.enable`；`Debugger.enable` + **`setBreakpointsActive(false)`**（对抗 `debugger;` 陷阱）。
 */
async function ensureAttached(tabId: number): Promise<void> {
  // attach 前确认标签 URL 可调试
  try {
    const tab = await chrome.tabs.get(tabId); // 获取标签信息
    if (!isDebuggableUrl(tab.url)) { // 如果标签URL不可调试，则清掉过期缓存 
      attached.delete(tabId); // 若之前认为已 attach，使缓存失效
      throw new Error(`Cannot debug tab ${tabId}: URL is ${tab.url ?? 'unknown'}`); // 抛出错误
    }
  } catch (e) { // 捕获错误
    if (e instanceof Error && e.message.startsWith('Cannot debug tab')) throw e; // 自己的错误继续抛出；仅捕获 chrome.tabs.get 失败
    attached.delete(tabId); // 清掉过期缓存
    throw new Error(`Tab ${tabId} no longer exists`); // 抛出错误
  }

  if (attached.has(tabId)) {
    // 发无害命令确认 debugger 仍真在附着
    try {
      await chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', {
        expression: '1', returnByValue: true,
      });
      return; // 仍附着且可用
    } catch {
      // 缓存过期 —— 需重新 attach
      attached.delete(tabId);
    }
  }

  try {
    await tryAttach(tabId); // 尝试attach
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e); // 获取错误信息
    const hint = msg.includes('chrome-extension://')
      ? '. Tip: another Chrome extension may be interfering — try disabling other extensions'
      : '';
    if (msg.includes('chrome-extension://')) {
      const recoveryCleanup = await removeForeignExtensionEmbeds(tabId); // 移除第三方扩展嵌入
      if (recoveryCleanup.removed > 0) { // 如果移除了第三方扩展嵌入，则打印警告
        console.warn(`[opencli] Removed ${recoveryCleanup.removed} foreign extension frame(s) after attach failure on tab ${tabId}`);
      }
      await delay(ATTACH_RECOVERY_DELAY_MS); // 延迟一段时间
      try {
        await tryAttach(tabId); // 尝试attach
      } catch {
        throw new Error(`attach failed: ${msg}${hint}`); // 抛出错误
      }
    } else if (msg.includes('Another debugger is already attached')) {
      try { await chrome.debugger.detach({ tabId }); } catch { /* ignore */ }
      try {
        await tryAttach(tabId); // 尝试attach
      } catch {
        throw new Error(`attach failed: ${msg}${hint}`); // 抛出错误
      }
    } else {
      throw new Error(`attach failed: ${msg}${hint}`); // 抛出错误
    }
  }
  attached.add(tabId); // 将标签ID添加到已attached的标签ID集合  

  try {
    await chrome.debugger.sendCommand({ tabId }, 'Runtime.enable'); // 发送命令启用Runtime域
  } catch {
    // 部分页面可能不需要显式 enable
  }

  // 关闭断点，避免页面里的 `debugger;` 暂停执行。反爬脚本会用 `debugger;` 计时检测 CDP；
  // 停用断点可使引擎跳过 `debugger;`，在不改页面 JS 的前提下削弱这类侧信道。
  try {
    await chrome.debugger.sendCommand({ tabId }, 'Debugger.enable'); // 发送命令启用Debugger域
    await chrome.debugger.sendCommand({ tabId }, 'Debugger.setBreakpointsActive', { active: false }); // 发送命令设置断点激活
  } catch {
    // 非致命：尽力加固
  }
}

/**
 * 通过 CDP `Runtime.evaluate` 在**页面主世界**执行 JavaScript。
 *
 * - **`awaitPromise: true`** —— 若表达式返回 Promise，CDP 会等其落定。
 * - **`returnByValue: true`** —— 可序列化结果以值形式返回（非对象句柄）。
 *
 * @param tabId - 要调试的 Chrome 标签
 * @param expression - JS 源码字符串（注意与 DevTools 控制台相同的安全与作用域问题）
 * @returns CDP 的 `result.value`；页面抛错则抛出含页面异常文案的 Error
 */
export async function evaluate(tabId: number, expression: string): Promise<unknown> {
  await ensureAttached(tabId);

  const result = await chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', {
    expression, // JS 源码字符串
    returnByValue: true, // 返回值为值形式
    awaitPromise: true, // 等待Promise落定
  }) as {
    result?: { type: string; value?: unknown; description?: string; subtype?: string };
    exceptionDetails?: { exception?: { description?: string }; text?: string };
  };

  if (result.exceptionDetails) {
    const errMsg = result.exceptionDetails.exception?.description
      || result.exceptionDetails.text
      || 'Eval error';
    throw new Error(errMsg);
  }

  return result.result?.value;
}

/** `evaluate` 的别名 —— 名称强调 CDP 侧对异步/Promise 的处理。 */
export const evaluateAsync = evaluate;

/**
 * 通过 CDP `Page.captureScreenshot` 截取视口或**整页**截图。
 *
 * **整页：** 使用 `Page.getLayoutMetrics` + `Emulation.setDeviceMetricsOverride` 把布局扩到可滚动尺寸，
 * 最后在 `finally` 里清除覆盖，使标签恢复常态。
 *
 * @param tabId - 目标标签
 * @param options.format - `png`（默认）或 `jpeg`
 * @param options.quality - JPEG 质量 0–100（仅 jpeg）
 * @param options.fullPage - 为 true 时尽量截取完整可滚动页面（非仅视口）
 * @returns Base64 图片数据（无 `data:` 前缀）
 */
export async function screenshot(
  tabId: number,
  options: { format?: 'png' | 'jpeg'; quality?: number; fullPage?: boolean } = {},
): Promise<string> {
  await ensureAttached(tabId);

  const format = options.format ?? 'png';

  // 整页截图：先取完整页面尺寸
  if (options.fullPage) {
    const metrics = await chrome.debugger.sendCommand({ tabId }, 'Page.getLayoutMetrics') as {
      contentSize?: { width: number; height: number };
      cssContentSize?: { width: number; height: number };
    };
    const size = metrics.cssContentSize || metrics.contentSize;
    if (size) {
      // 设备尺寸设为整页大小
      await chrome.debugger.sendCommand({ tabId }, 'Emulation.setDeviceMetricsOverride', {
        mobile: false,
        width: Math.ceil(size.width),
        height: Math.ceil(size.height),
        deviceScaleFactor: 1,
      });
    }
  }

  try {
    const params: Record<string, unknown> = { format };
    if (format === 'jpeg' && options.quality !== undefined) {
      params.quality = Math.max(0, Math.min(100, options.quality));
    }

    const result = await chrome.debugger.sendCommand({ tabId }, 'Page.captureScreenshot', params) as {
      data: string; // base64
    };

    return result.data;
  } finally {
    // 若曾为整页改过设备指标，在此恢复
    if (options.fullPage) {
      await chrome.debugger.sendCommand({ tabId }, 'Emulation.clearDeviceMetricsOverride').catch(() => {});
    }
  }
}

/**
 * 通过 CDP `DOM.setFileInputFiles` 为文件 `<input>` 设置**本地文件路径**。
 *
 * **为何用 CDP：** 让 Chrome 直接从磁盘读文件，避免大体积 base64 在扩展消息通道里传输。
 *
 * @param tabId - 目标标签
 * @param files - 浏览器进程可读**绝对路径**数组
 * @param selector - 定位 file 控件的 CSS 选择器（默认第一个 `input[type="file"]`）
 */
export async function setFileInputFiles(
  tabId: number,
  files: string[],
  selector?: string,
): Promise<void> {
  await ensureAttached(tabId);

  // 启用 DOM 域（`DOM.querySelector` / `DOM.setFileInputFiles` 需要）
  await chrome.debugger.sendCommand({ tabId }, 'DOM.enable');

  // 文档根节点
  const doc = await chrome.debugger.sendCommand({ tabId }, 'DOM.getDocument') as {
    root: { nodeId: number };
  };

  // 查找 file 输入框
  const query = selector || 'input[type="file"]';
  const result = await chrome.debugger.sendCommand({ tabId }, 'DOM.querySelector', {
    nodeId: doc.root.nodeId,
    selector: query,
  }) as { nodeId: number };

  if (!result.nodeId) {
    throw new Error(`No element found matching selector: ${query}`);
  }

  // 经 CDP 设置路径 —— Chrome 从本地文件系统读取
  await chrome.debugger.sendCommand({ tabId }, 'DOM.setFileInputFiles', {
    files,
    nodeId: result.nodeId,
  });
}

/**
 * 若本模块曾记录该标签为已 attach，则 detach。未知标签上调用也安全（幂等）。
 * 自动化结束清理时可调用。
 */
export async function detach(tabId: number): Promise<void> {
  if (!attached.has(tabId)) return;
  attached.delete(tabId);
  try { await chrome.debugger.detach({ tabId }); } catch { /* ignore */ }
}

/**
 * 订阅 Chrome 事件，使 **`attached` 缓存**与真实状态一致：
 * - **tabs.onRemoved** —— 标签关闭 → 删缓存
 * - **debugger.onDetach** —— 浏览器把我们 detach 了 → 删缓存
 * - **tabs.onUpdated** —— URL 变为不可调试 → **detach**，避免陈旧会话
 *
 * 扩展启动时调用一次即可（例如 service worker 加载后的 `background.ts`）。
 */
export function registerListeners(): void {
  chrome.tabs.onRemoved.addListener((tabId) => {
    attached.delete(tabId);
  });
  chrome.debugger.onDetach.addListener((source) => {
    if (source.tabId) attached.delete(source.tabId);
  });
  // URL 变为不可调试时使 attached 缓存失效
  chrome.tabs.onUpdated.addListener(async (tabId, info) => {
    if (info.url && !isDebuggableUrl(info.url)) {
      await detach(tabId);
    }
  });
}
