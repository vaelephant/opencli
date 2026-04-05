/**
 * 下载相关工具集（HTTP 直链、yt-dlp 封装、Cookie 导出、文档落盘、文件名处理）。
 *
 * 在工程中的位置：
 * - **媒体批量下载**：`media-download.ts` 组合本文件的 `httpDownload` / `ytdlpDownload`、`exportCookiesToNetscape` 等；
 * - **文章导出**：`article-download.ts` 使用 `sanitizeFilename`、`generateFilename`（经本文件导出）；
 * - **管线步骤**：`pipeline/steps/download.ts` 根据 URL 选择 HTTP 或 yt-dlp；
 * - **各站点 CLI**：如 bilibili download 等直接依赖 `checkYtdlp`、`requiresYtdlp`。
 *
 * 依赖：`yt-dlp` 需用户自行安装并在 PATH 中可用（见 `checkYtdlp`）；HTTP 走 `fetchWithNodeNetwork`。
 * 
 * 
 * 
 * src/download/index.ts 是 下载模块的公共底层：被 media-download.ts、article-download.ts、管线里的 download 步骤、以及 B 站等 CLI 复用，
 */

import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { Readable, Transform } from 'node:stream';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import { pipeline } from 'node:stream/promises';
import { URL } from 'node:url';
import type { ProgressBar } from './progress.js';
import { isBinaryInstalled } from '../external.js';
import type { BrowserCookie } from '../types.js';
import { getErrorMessage } from '../errors.js';
import { fetchWithNodeNetwork } from '../node-network.js';

export type { BrowserCookie } from '../types.js';

/** `httpDownload` 的选项：Cookie/头、超时、进度、重定向上限 */
export interface DownloadOptions {
  cookies?: string;
  headers?: Record<string, string>;
  timeout?: number;
  onProgress?: (received: number, total: number) => void;
  maxRedirects?: number;
}

/** `ytdlpDownload` 的选项：Cookie 文件、画质格式、额外参数、进度百分比回调 */
export interface YtdlpOptions {
  cookies?: string;
  cookiesFile?: string;
  format?: string;
  extraArgs?: string[];
  onProgress?: (percent: number) => void;
}

/**
 * 检测系统 PATH 中是否存在 `yt-dlp` 可执行文件（不随 opencli 打包安装）。
 */
export function checkYtdlp(): boolean {
  return isBinaryInstalled('yt-dlp');
}

/** 视为「视频站」的域名列表：用于 `detectContentType` / `requiresYtdlp` 启发式判断 */
const VIDEO_PLATFORM_DOMAINS = [
  'youtube.com', 'youtu.be', 'bilibili.com', 'twitter.com',
  'x.com', 'tiktok.com', 'vimeo.com', 'twitch.tv',
];

const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.svg', '.ico', '.bmp', '.avif']);
const VIDEO_EXTENSIONS = new Set(['.mp4', '.webm', '.avi', '.mov', '.mkv', '.flv', '.m3u8', '.ts']);
const DOC_EXTENSIONS = new Set(['.html', '.htm', '.json', '.xml', '.txt', '.md', '.markdown']);

/**
 * 根据响应头 Content-Type、URL 路径扩展名、是否命中视频站域名，粗分类资源类型。
 * 用于决定走 HTTP 直下还是 yt-dlp、以及默认扩展名等。
 */
export function detectContentType(url: string, contentType?: string): 'image' | 'video' | 'document' | 'binary' {
  if (contentType) {
    if (contentType.startsWith('image/')) return 'image';
    if (contentType.startsWith('video/')) return 'video';
    if (contentType.startsWith('text/') || contentType.includes('json') || contentType.includes('xml')) return 'document';
  }

  const urlLower = url.toLowerCase();
  const ext = path.extname(new URL(url).pathname).toLowerCase();

  if (IMAGE_EXTENSIONS.has(ext)) return 'image';
  if (VIDEO_EXTENSIONS.has(ext)) return 'video';
  if (VIDEO_PLATFORM_DOMAINS.some(d => urlLower.includes(d))) return 'video';
  if (DOC_EXTENSIONS.has(ext)) return 'document';
  return 'binary';
}

/**
 * 该 URL 是否应按「视频平台」处理（通常需 yt-dlp，而非纯 HTTP 拉文件）。
 */
export function requiresYtdlp(url: string): boolean {
  const urlLower = url.toLowerCase();
  return VIDEO_PLATFORM_DOMAINS.some(d => urlLower.includes(d));
}

/**
 * 使用 Node fetch 下载到本地路径；支持 Cookie/自定义头、手动跟随重定向、下载进度。
 * 先写入 `.tmp` 再 rename，避免半截文件；重定向到其它主机时会去掉 Cookie 头以防泄露。
 */
export async function httpDownload(
  url: string,
  destPath: string,
  options: DownloadOptions = {},
  redirectCount = 0,
): Promise<{ success: boolean; size: number; error?: string }> {
  const { cookies, headers = {}, timeout = 30000, onProgress, maxRedirects = 10 } = options;

  return new Promise((resolve) => {
    const requestHeaders: Record<string, string> = {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36',
      ...headers,
    };

    if (cookies) {
      requestHeaders['Cookie'] = cookies;
    }

    const tempPath = `${destPath}.tmp`;
    let settled = false;

    const finish = (result: { success: boolean; size: number; error?: string }) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    const cleanupTempFile = async () => {
      try {
        await fs.promises.rm(tempPath, { force: true });
      } catch {
        // 保留原始错误信息，忽略清理失败
      }
    };

    void (async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeout);
      try {
        const response = await fetchWithNodeNetwork(url, {
          headers: requestHeaders,
          signal: controller.signal,
          redirect: 'manual',
        });
        clearTimeout(timer);

        // 在创建写流之前处理 3xx，避免向错误 URL 落盘
        if (response.status >= 300 && response.status < 400) {
          const location = response.headers.get('location');
          if (location) {
            if (redirectCount >= maxRedirects) {
              finish({ success: false, size: 0, error: `Too many redirects (> ${maxRedirects})` });
              return;
            }
            const redirectUrl = resolveRedirectUrl(url, location);
            const originalHost = new URL(url).hostname;
            const redirectHost = new URL(redirectUrl).hostname;
            const redirectOptions = originalHost === redirectHost
              ? options
              : { ...options, cookies: undefined, headers: stripCookieHeaders(options.headers) };
            finish(await httpDownload(
              redirectUrl,
              destPath,
              redirectOptions,
              redirectCount + 1,
            ));
            return;
          }
        }

        if (response.status !== 200) {
          finish({ success: false, size: 0, error: `HTTP ${response.status}` });
          return;
        }

        if (!response.body) {
          finish({ success: false, size: 0, error: 'Empty response body' });
          return;
        }

        const totalSize = parseInt(response.headers.get('content-length') || '0', 10);
        let received = 0;
        const progressStream = new Transform({
          transform(chunk, _encoding, callback) {
            received += chunk.length;
            if (onProgress) onProgress(received, totalSize);
            callback(null, chunk);
          },
        });

        try {
          await fs.promises.mkdir(path.dirname(destPath), { recursive: true });
          await pipeline(
            Readable.fromWeb(response.body as unknown as WebReadableStream),
            progressStream,
            fs.createWriteStream(tempPath),
          );
          await fs.promises.rename(tempPath, destPath);
          finish({ success: true, size: received });
        } catch (err) {
          await cleanupTempFile();
          finish({ success: false, size: 0, error: getErrorMessage(err) });
        }
      } catch (err) {
        clearTimeout(timer);
        await cleanupTempFile();
        finish({ success: false, size: 0, error: err instanceof Error ? err.message : String(err) });
      }
    })();
  });
}

/** 将相对或绝对 Location 解析成完整 URL */
export function resolveRedirectUrl(currentUrl: string, location: string): string {
  return new URL(location, currentUrl).toString();
}

function stripCookieHeaders(headers?: Record<string, string>): Record<string, string> | undefined {
  if (!headers) return headers;
  return Object.fromEntries(
    Object.entries(headers).filter(([key]) => key.toLowerCase() !== 'cookie'),
  );
}

/**
 * 将浏览器 Cookie 数组写成 Netscape cookie 文件格式，供 yt-dlp `--cookies` 使用。
 */
export function exportCookiesToNetscape(
  cookies: BrowserCookie[],
  filePath: string,
): void {
  const lines = [
    '# Netscape HTTP Cookie File',
    '# https://curl.se/docs/http-cookies.html',
    '# This is a generated file!  Do not edit.',
    '',
  ];

  for (const cookie of cookies) {
    const domain = cookie.domain.startsWith('.') ? cookie.domain : `.${cookie.domain}`;
    const includeSubdomains = 'TRUE';
    const cookiePath = cookie.path || '/';
    const secure = cookie.secure ? 'TRUE' : 'FALSE';
    const expiry = Math.floor(Date.now() / 1000) + 86400 * 365; // 约一年后过期
    const safeName = cookie.name.replace(/[\t\n\r]/g, '');
    const safeValue = cookie.value.replace(/[\t\n\r]/g, '');
    lines.push(`${domain}\t${includeSubdomains}\t${cookiePath}\t${secure}\t${expiry}\t${safeName}\t${safeValue}`);
  }

  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, lines.join('\n'));
}

/** 拼成 HTTP `Cookie:` 请求头字符串 */
export function formatCookieHeader(cookies: BrowserCookie[]): string {
  return cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ');
}

/**
 * 调用本机 `yt-dlp` 下载视频到指定路径（需 PATH 可执行）。
 * 默认 `--cookies-from-browser chrome`；若提供 `cookiesFile` 且存在则改用 `--cookies`。
 * 从 stdout/stderr 解析百分比行以驱动 `onProgress`。
 */
export async function ytdlpDownload(
  url: string,
  destPath: string,
  options: YtdlpOptions = {},
): Promise<{ success: boolean; size: number; error?: string }> {
  const { cookiesFile, format = 'best', extraArgs = [], onProgress } = options;

  if (!checkYtdlp()) {
    return { success: false, size: 0, error: 'yt-dlp not installed. Install with: pip install yt-dlp' };
  }

  return new Promise((resolve) => {
    const dir = path.dirname(destPath);
    fs.mkdirSync(dir, { recursive: true });

    const args = [
      url,
      '-o', destPath,
      '-f', format,
      '--no-playlist',
      '--progress',
    ];

    if (cookiesFile) {
      if (fs.existsSync(cookiesFile)) {
        args.push('--cookies', cookiesFile);
      } else {
        console.error(`[download] Cookies file not found: ${cookiesFile}, falling back to browser cookies`);
        args.push('--cookies-from-browser', 'chrome');
      }
    } else {
      args.push('--cookies-from-browser', 'chrome');
    }

    args.push(...extraArgs);

    const proc = spawn('yt-dlp', args, {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let lastPercent = 0;
    let errorOutput = '';

    proc.stderr.on('data', (data: Buffer) => {
      const line = data.toString();
      errorOutput += line;

      const match = line.match(/(\d+\.?\d*)%/);
      if (match && onProgress) {
        const percent = parseFloat(match[1]);
        if (percent > lastPercent) {
          lastPercent = percent;
          onProgress(percent);
        }
      }
    });

    proc.stdout.on('data', (data: Buffer) => {
      const line = data.toString();
      const match = line.match(/(\d+\.?\d*)%/);
      if (match && onProgress) {
        const percent = parseFloat(match[1]);
        if (percent > lastPercent) {
          lastPercent = percent;
          onProgress(percent);
        }
      }
    });

    proc.on('close', (code) => {
      if (code === 0 && fs.existsSync(destPath)) {
        const stats = fs.statSync(destPath);
        resolve({ success: true, size: stats.size });
      } else {
        // Check for common yt-dlp output patterns
        const patterns = fs.readdirSync(dir).filter(f => f.startsWith(path.basename(destPath, path.extname(destPath))));
        if (patterns.length > 0) {
          const actualFile = path.join(dir, patterns[0]);
          const stats = fs.statSync(actualFile);
          resolve({ success: true, size: stats.size });
        } else {
          resolve({ success: false, size: 0, error: errorOutput.slice(0, 200) || `Exit code ${code}` });
        }
      }
    });

    proc.on('error', (err) => {
      resolve({ success: false, size: 0, error: err.message });
    });
  });
}

/**
 * 将文本内容写入文件；可选 JSON 包装或 Markdown frontmatter。
 */
export async function saveDocument(
  content: string,
  destPath: string,
  format: 'json' | 'markdown' | 'html' | 'text' = 'markdown',
  metadata?: Record<string, any>,
): Promise<{ success: boolean; size: number; error?: string }> {
  try {
    const dir = path.dirname(destPath);
    fs.mkdirSync(dir, { recursive: true });

    let output: string;

    if (format === 'json') {
      output = JSON.stringify({ ...metadata, content }, null, 2);
    } else if (format === 'markdown') {
      const frontmatter = metadata ? `---\n${Object.entries(metadata).map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join('\n')}\n---\n\n` : '';
      output = frontmatter + content;
    } else {
      output = content;
    }

    fs.writeFileSync(destPath, output, 'utf-8');
    return { success: true, size: Buffer.byteLength(output, 'utf-8') };
  } catch (err) {
    return { success: false, size: 0, error: getErrorMessage(err) };
  }
}

/**
 * 清理文件名中的非法字符、压缩空白，并截断长度（用于落盘路径）。
 */
export function sanitizeFilename(name: string, maxLength: number = 200): string {
  return name
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '')
    .slice(0, maxLength);
}

/**
 * 从 URL 推断保存文件名：优先用路径最后一段；否则用 `主机名_序号.扩展名`。
 */
export function generateFilename(url: string, index: number, extension?: string): string {
  try {
    const parsedUrl = new URL(url);
    const pathname = parsedUrl.pathname;
    const basename = path.basename(pathname);

    if (basename && basename !== '/' && basename.includes('.')) {
      return sanitizeFilename(basename);
    }

    const ext = extension || detectExtension(url);
    const hostname = parsedUrl.hostname.replace(/^www\./, '');
    return sanitizeFilename(`${hostname}_${index + 1}${ext}`);
  } catch {
    const ext = extension || '.bin';
    return `download_${index + 1}${ext}`;
  }
}

/** 按 `detectContentType` 结果返回默认扩展名 */
function detectExtension(url: string): string {
  const type = detectContentType(url);
  switch (type) {
    case 'image': return '.jpg';
    case 'video': return '.mp4';
    case 'document': return '.md';
    default: return '.bin';
  }
}

/**
 * Cookie 临时文件等使用的子目录：`系统临时目录/opencli-download`。
 */
export function getTempDir(): string {
  return path.join(os.tmpdir(), 'opencli-download');
}
