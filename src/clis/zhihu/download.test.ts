/**
 * Zhihu download 相关：校验 HTML→Markdown（Turndown）对有序列表的转换。
 *
 * 知乎正文经 `downloadArticle`（见 `src/download/article-download.ts`）用 Turndown 转成 .md；
 * 本测试确保 `<ol><li>` 会变成 `1. …` / `2. …`，且不会出现错误的字面量 `$1`（回归防护）。
 *
 * 运行（adapter 测试工程，见 vitest.config.ts）：
 *   npm run test:adapter
 *   npx vitest run src/clis/zhihu/download.test.ts
 */

import { describe, expect, it } from 'vitest';  // 导入describe、expect、it
import TurndownService from 'turndown';  // 导入TurndownService

describe('article markdown conversion', () => { // 描述文章Markdown转换
  it('renders ordered lists with the original list item content', () => { // 测试有序列表的渲染
    const html = '<ol><li>First item</li><li>Second item</li></ol>'; // 原始HTML
    const td = new TurndownService({ headingStyle: 'atx', bulletListMarker: '-' }); // 创建TurndownService
    const md = td.turndown(html); // 转换为Markdown

    expect(md).toMatch(/1\.\s+First item/); // 匹配第一项
    expect(md).toMatch(/2\.\s+Second item/); // 匹配第二项
    expect(md).not.toContain('$1'); // 不包含$1
  });
});
