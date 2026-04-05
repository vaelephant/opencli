/**
 * Zhihu download — export articles to Markdown format.
 *
 * Usage:
 *   opencli zhihu download --url "https://zhuanlan.zhihu.com/p/xxx" --output ./zhihu
 */

import { cli, Strategy } from '../../core/registry.js';  // 导入cli、Strategy
import { downloadArticle } from '../../download/article-download.js'; // 导入downloadArticle

cli({
  site: 'zhihu', // 站点
  name: 'download', // 名称
  description: '导出知乎文章为 Markdown 格式', // 描述
  domain: 'zhuanlan.zhihu.com', // 域名
  strategy: Strategy.COOKIE, // 使用COOKIE策略
  args: [
    { name: 'url', required: true, help: 'Article URL (zhuanlan.zhihu.com/p/xxx)' }, // 文章URL
    { name: 'output', default: './zhihu-articles', help: 'Output directory' }, // 输出目录
    { name: 'download-images', type: 'boolean', default: false, help: 'Download images locally' }, // 下载图片本地
  ],
  columns: ['title', 'author', 'publish_time', 'status', 'size'], // 列标题
  func: async (page, kwargs) => { // 函数
    const url = kwargs.url; // 文章URL

    // Navigate to article page
    await page.goto(url); // 导航到文章页面
    await page.wait(3);

    // Extract article content
    const data = await page.evaluate(`
      (() => {
        const result = {
          title: '',
          author: '',
          publishTime: '',
          contentHtml: '',
          imageUrls: []
        };

        // Get title
        const titleEl = document.querySelector('.Post-Title, h1.ContentItem-title, .ArticleTitle');
        result.title = titleEl?.textContent?.trim() || 'untitled';

        // Get author
        const authorEl = document.querySelector('.AuthorInfo-name, .UserLink-link');
        result.author = authorEl?.textContent?.trim() || 'unknown';

        // Get publish time
        const timeEl = document.querySelector('.ContentItem-time, .Post-Time');
        result.publishTime = timeEl?.textContent?.trim() || '';

        // Get content HTML
        const contentEl = document.querySelector('.Post-RichTextContainer, .RichText, .ArticleContent');
        if (contentEl) {
          result.contentHtml = contentEl.innerHTML;

          // Extract image URLs
          contentEl.querySelectorAll('img').forEach(img => {
            const src = img.getAttribute('data-original') || img.getAttribute('data-actualsrc') || img.src;
            if (src && !src.includes('data:image')) {
              result.imageUrls.push(src);
            }
          });
        }

        return result;
      })()
    `);

    return downloadArticle(
      {
        title: data?.title || '',
        author: data?.author,
        publishTime: data?.publishTime,
        sourceUrl: url,
        contentHtml: data?.contentHtml || '',
        imageUrls: data?.imageUrls,
      },
      {
        output: kwargs.output,
        downloadImages: kwargs['download-images'],
        imageHeaders: { Referer: 'https://zhuanlan.zhihu.com/' },
      },
    );
  },
});
