import MarkdownIt from 'markdown-it';
import hljs from 'highlight.js';
import footnote from 'markdown-it-footnote';
import * as fs from 'fs';
import * as path from 'path';
import { makeSlug, runObsidian } from './crawler';
import { ConversionContext } from './types';

// ──────────────────────────────────────────
// markdown-it の初期化
// ──────────────────────────────────────────

const md = new MarkdownIt({
  html: true,
  linkify: true,
  typographer: true,
  breaks: true, // 改行を反映（コールアウト・引用・本文すべての改行を維持）
  highlight(str: string, lang: string): string {
    if (lang && hljs.getLanguage(lang)) {
      try {
        const highlighted = hljs.highlight(str, {
          language: lang,
          ignoreIllegals: true,
        }).value;
        return `<pre class="hljs language-${escAttr(lang)}"><code>${highlighted}</code></pre>`;
      } catch {
        // fallthrough
      }
    }
    return `<pre class="hljs"><code>${md.utils.escapeHtml(str)}</code></pre>`;
  },
});

md.use(footnote);

// Mermaid コードブロックのカスタムレンダリング
const defaultFenceRenderer = md.renderer.rules.fence;
md.renderer.rules.fence = (tokens, idx, options, env, self) => {
  const token = tokens[idx];
  const info = token.info ? token.info.trim() : '';
  const langName = info.split(/\s+/)[0];

  if (langName === 'mermaid') {
    return `<div class="mermaid">${md.utils.escapeHtml(token.content)}</div>`;
  }

  return defaultFenceRenderer
    ? defaultFenceRenderer(tokens, idx, options, env, self)
    : `<pre><code>${md.utils.escapeHtml(token.content)}</code></pre>`;
};

// ──────────────────────────────────────────
// 数式プリプロセス / ポストプロセス
// ──────────────────────────────────────────

interface MathPlaceholder {
  placeholder: string;
  tex: string;
  isBlock: boolean;
}

/**
 * 数式 ($...$ や $$...$$) をプレースホルダーに置き換える。
 * Markdownパーサーによる下線(_)やアスタリスク(*)の誤作動を完全に防ぐ。
 */
function extractMath(content: string): { processed: string; mathList: MathPlaceholder[] } {
  const mathList: MathPlaceholder[] = [];
  let index = 0;

  // 1. ブロック数式 ($$ ... $$) を抽出 (非強欲マッチ)
  let processed = content.replace(/\$\$([\s\S]+?)\$\$/g, (_match, tex) => {
    const placeholder = `MATHBLOCKPLACEHOLDER${index}XYZ`;
    mathList.push({ placeholder, tex: tex.trim(), isBlock: true });
    index++;
    return placeholder;
  });

  // 2. インライン数式 ($ ... $) を抽出
  processed = processed.replace(/(?<!\\)\$([^\$\n]+?)(?<!\\)\$/g, (match, tex) => {
    if (tex.trim() === '') return match;
    const placeholder = `MATHINLINEPLACEHOLDER${index}XYZ`;
    mathList.push({ placeholder, tex: tex.trim(), isBlock: false });
    index++;
    return placeholder;
  });

  return { processed, mathList };
}

/**
 * プレースホルダーを元のTeX数式に戻す。
 * これによりブラウザ上の MathJax が検知・レンダリングできるようになる。
 */
function restoreMath(html: string, mathList: MathPlaceholder[]): string {
  let result = html;
  for (const item of mathList) {
    const cleanTex = item.tex.replace(/[\u200B-\u200D\uFEFF]/g, '');
    const restored = item.isBlock
      ? `$$\n${cleanTex}\n$$`
      : `$${cleanTex}$`;
    result = result.split(item.placeholder).join(restored);
  }
  return result;
}

/**
 * Markdownからフロントマターブロック (--- ... ---) を除去する
 */
function stripFrontmatter(text: string): string {
  if (text.startsWith('---\n')) {
    const parts = text.split('---\n');
    if (parts.length >= 3) {
      return parts.slice(2).join('---\n');
    }
  } else if (text.startsWith('---\r\n')) {
    const parts = text.split('---\r\n');
    if (parts.length >= 3) {
      return parts.slice(2).join('---\r\n');
    }
  }
  return text;
}

// ──────────────────────────────────────────
// メイン変換関数
// ──────────────────────────────────────────

export function convertNote(
  noteName: string,
  rawContent: string,
  collectedNotes: Set<string>,
  vaultPath: string,
  frontmatter: Record<string, unknown>,
  context?: ConversionContext
): { html: string; frontmatter: Record<string, unknown> } {
  const content = stripFrontmatter(rawContent);

  // コメントアウトを除去 (Obsidian 形式 %% と HTML 形式 <!-- -->)
  let cleanContent = content
    .replace(/%%[\s\S]*?%%/g, '')
    .replace(/<!--[\s\S]*?-->/g, '');

  // ==Highlight== 構文を <mark>Highlight</mark> に置換
  cleanContent = cleanContent.replace(/==([\s\S]+?)==/g, '<mark>$1</mark>');

  // 1. 数式の退避 (プリプロセス)
  const { processed: withoutMath, mathList } = extractMath(cleanContent);

  // 2. Obsidian コールアウト（折りたたみ対応） → HTML に変換
  let processed = processCallouts(withoutMath);

  // 3. ウィキリンク変換
  processed = processWikilinks(processed, collectedNotes, noteName, context);

  // 4. Markdown → HTML
  let html = md.render(processed);
  if (context) {
    html = html.replace(/href="([^"]+)"/g, (match, href: string) => {
      if (/^(?:#|[a-z][a-z\d+.-]*:|\/\/)/i.test(href)) return match;
      const ref = href.replace(/&amp;/g, '&');
      let decoded: string;
      try { decoded = decodeURIComponent(ref); } catch { return match; }
      const [target, heading] = decoded.split('#');
      const key = context.resolveNote(target);
      const anchor = heading ? '-' + heading.toLowerCase().replace(/[\s_]+/g, '-').replace(/[^\w\-\u3040-\u9fff\u30a0-\u30ff\u4e00-\u9fff]/g, '').replace(/-+/g, '-').replace(/^-|-$/g, '') : '';
      return collectedNotes.has(key) ? `href="#${context.slugForNote(key)}${anchor}"` : match;
    });
  }

  // タスクリストの変換 (<li>[ ] と <li>[x] を本家風チェックボックスに置換)
  html = html
    .replace(/<li>\[ \]\s*/g, '<li class="task-list-item"><input type="checkbox" disabled class="task-list-item-checkbox"> ')
    .replace(/<li>\[x\]\s*/g, '<li class="task-list-item"><input type="checkbox" checked disabled class="task-list-item-checkbox"> ');

  // 5. 数式の復元 (ポストプロセス)
  html = restoreMath(html, mathList);

  // 6. 見出しに id 付与
  html = addHeadingIds(html, context?.slugForNote(noteName) ?? makeSlug(noteName));

  // 7. 画像を base64 埋め込み
  if (vaultPath || context) {
    html = embedImages(html, vaultPath, noteName, context?.resolveImage);
  }

  return { html, frontmatter: frontmatter as Record<string, unknown> };
}

// ──────────────────────────────────────────
// Obsidian コールアウト処理（折りたたみ対応）
// ──────────────────────────────────────────

// 本家と同じ Lucide SVG アイコン
const LUCIDE_ICONS: Record<string, string> = {
  note: `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-pencil"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>`,
  info: `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-info"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/></svg>`,
  todo: `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-check-circle-2"><circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/></svg>`,
  important: `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-flame"><path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 2.5z"/></svg>`,
  tip: `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-lightbulb"><path d="M15 14c.2-1 .7-1.7 1.5-2.5 1-.9 1.5-2.2 1.5-3.5A5 5 0 0 0 8 8c0 1 .3 2.2 1.5 3.5.7.7 1.3 1.5 1.5 2.5"/><path d="M9 18h6"/><path d="M10 22h4"/></svg>`,
  hint: `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-lightbulb"><path d="M15 14c.2-1 .7-1.7 1.5-2.5 1-.9 1.5-2.2 1.5-3.5A5 5 0 0 0 8 8c0 1 .3 2.2 1.5 3.5.7.7 1.3 1.5 1.5 2.5"/><path d="M9 18h6"/><path d="M10 22h4"/></svg>`,
  success: `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-check-circle"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>`,
  check: `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-check-circle"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>`,
  done: `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-check-circle"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>`,
  question: `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-help-circle"><circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><path d="M12 17h.01"/></svg>`,
  faq: `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-help-circle"><circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><path d="M12 17h.01"/></svg>`,
  help: `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-help-circle"><circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><path d="M12 17h.01"/></svg>`,
  warning: `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-alert-triangle"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>`,
  caution: `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-alert-triangle"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>`,
  attention: `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-alert-triangle"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>`,
  danger: `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-zap"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>`,
  error: `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-zap"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>`,
  bug: `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-bug"><rect width="8" height="14" x="8" y="6" rx="4"/><path d="m19 7-3 2"/><path d="m5 7 3 2"/><path d="m19 19-3-2"/><path d="m5 19 3-2"/><path d="M20 13h-4"/><path d="M4 13h4"/><path d="m12 6 1-4"/><path d="m12 6-1-4"/></svg>`,
  example: `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-list"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg>`,
  quote: `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-quote"><path d="M3 21c3 0 7-1 7-8V5H3v8h4c0 3.5-1 4.5-4 5Z"/><path d="M14 21c3 0 7-1 7-8V5h-7v8h4c0 3.5-1 4.5-4 5Z"/></svg>`,
  cite: `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-quote"><path d="M3 21c3 0 7-1 7-8V5H3v8h4c0 3.5-1 4.5-4 5Z"/><path d="M14 21c3 0 7-1 7-8V5h-7v8h4c0 3.5-1 4.5-4 5Z"/></svg>`,
  abstract: `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-clipboard-list"><rect width="8" height="4" x="8" y="2" rx="1" ry="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><path d="M12 11h4"/><path d="M12 16h4"/><path d="M8 11h.01"/><path d="M8 16h.01"/></svg>`,
  summary: `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-clipboard-list"><rect width="8" height="4" x="8" y="2" rx="1" ry="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><path d="M12 11h4"/><path d="M12 16h4"/><path d="M8 11h.01"/><path d="M8 16h.01"/></svg>`,
  tldr: `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-clipboard-list"><rect width="8" height="4" x="8" y="2" rx="1" ry="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><path d="M12 11h4"/><path d="M12 16h4"/><path d="M8 11h.01"/><path d="M8 16h.01"/></svg>`,
};

// 本家同様の開閉矢印 (Chevron)
const CHEVRON_ICON = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-chevron-right"><polyline points="9 18 15 12 9 6"/></svg>`;

function processCallouts(content: string): string {
  const lines = content.split('\n');
  const result: string[] = [];
  let inCallout = false;
  let calloutType = '';
  let calloutTitle = '';
  let calloutFoldable = false;   // +/- が付いているか
  let calloutOpen = false;        // デフォルト展開か（+）
  const calloutBody: string[] = [];

  function flushCallout() {
    if (!inCallout) return;

    const type = calloutType.toLowerCase();
    // 対応する本家 Lucide SVG アイコンを取得。なければデフォルトで pencil アイコンを使用。
    const iconSvg = LUCIDE_ICONS[type] ?? LUCIDE_ICONS['note'];
    const displayTitle =
      calloutTitle || (calloutType.charAt(0).toUpperCase() + calloutType.slice(1).toLowerCase());
    const bodyMd = calloutBody.join('\n');

    if (calloutFoldable) {
      // details を使ったアコーディオン式コールアウト
      const openAttr = calloutOpen ? ' open' : '';
      result.push(`<details class="callout callout-${escHtml(type)}" data-callout="${escAttr(type)}"${openAttr}>`);
      result.push(`<summary class="callout-title"><span class="callout-icon">${iconSvg}</span><span class="callout-title-inner">${escHtml(displayTitle)}</span><span class="callout-fold">${CHEVRON_ICON}</span></summary>`);
      result.push(`<div class="callout-content">\n\n${bodyMd}\n\n</div>`);
      result.push('</details>\n');
    } else {
      // 通常コールアウト
      result.push(`<div class="callout callout-${escHtml(type)}" data-callout="${escAttr(type)}">`);
      result.push(`<div class="callout-title"><span class="callout-icon">${iconSvg}</span><span class="callout-title-inner">${escHtml(displayTitle)}</span></div>`);
      result.push(`<div class="callout-content">\n\n${bodyMd}\n\n</div>`);
      result.push('</div>\n');
    }

    inCallout = false;
    calloutType = '';
    calloutTitle = '';
    calloutFoldable = false;
    calloutOpen = false;
    calloutBody.length = 0;
  }

  for (const line of lines) {
    const startMatch = line.match(/^>\s*\[!(\w+)\]([+\-]?)\s*(.*)?$/);
    if (startMatch) {
      flushCallout();
      inCallout = true;
      calloutType = startMatch[1];
      const foldChar = startMatch[2];
      calloutFoldable = foldChar === '+' || foldChar === '-';
      calloutOpen = foldChar === '+';
      calloutTitle = startMatch[3]?.trim() ?? '';
      continue;
    }

    if (inCallout && line.startsWith('>')) {
      calloutBody.push(line.replace(/^>\s?/, ''));
      continue;
    }

    if (inCallout) flushCallout();

    result.push(line);
  }

  flushCallout();
  return result.join('\n');
}

// ──────────────────────────────────────────
// ウィキリンク処理
// ──────────────────────────────────────────

function processWikilinks(
  content: string,
  collectedNotes: Set<string>,
  currentNote: string,
  context?: ConversionContext
): string {
  content = content.replace(/!\[\[([^\]]+)\]\]/g, (_m, target: string) => {
    const parts = target.split('|');
    const ref = parts[0].trim();
    const isImage = /\.(png|jpe?g|gif|svg|webp|bmp|ico|avif)$/i.test(ref);

    if (isImage) {
      let width = '';
      let height = '';
      for (let i = 1; i < parts.length; i++) {
        const param = parts[i].trim();
        const sizeMatch = param.match(/^(\d+)x(\d+)$/);
        if (sizeMatch) {
          width = sizeMatch[1];
          height = sizeMatch[2];
          break;
        }
        const widthMatch = param.match(/^(\d+)$/);
        if (widthMatch) {
          width = widthMatch[1];
          break;
        }
      }
      const widthAttr = width ? ` data-width="${width}"` : '';
      const heightAttr = height ? ` data-height="${height}"` : '';
      return `<img data-obsidian-image="${escAttr(ref)}" alt="${escAttr(ref)}"${widthAttr}${heightAttr} class="obsidian-image">`;
    }
    const rawName = ref.split('#')[0].trim();
    const noteName = context?.resolveNote(rawName) ?? rawName;
    if (collectedNotes.has(noteName)) {
      return `<div class="note-embed"><a href="#${context?.slugForNote(noteName) ?? makeSlug(noteName)}" class="wikilink note-embed-link">📎 ${escHtml(rawName)}</a></div>`;
    }
    return `<div class="note-embed note-embed-missing"><span class="embed-label">📎 ${escHtml(noteName)}</span><span class="embed-note">（このエクスポートに含まれていません）</span></div>`;
  });

  content = content.replace(/\[\[([^\]]+)\]\]/g, (_m, target: string) => {
    const pipeIdx = target.indexOf('|');
    const ref = pipeIdx >= 0 ? target.slice(0, pipeIdx) : target;
    const alias = pipeIdx >= 0 ? target.slice(pipeIdx + 1).trim() : null;

    const hashIdx = ref.indexOf('#');
    let noteName = (hashIdx >= 0 ? ref.slice(0, hashIdx) : ref).trim();
    const heading = hashIdx >= 0 ? ref.slice(hashIdx + 1).trim() : '';

    if (!noteName) noteName = currentNote;
    else if (context) noteName = context.resolveNote(noteName);

    const cleanHeading = heading.replace(/^\^/, '');
    const displayText = alias ?? (cleanHeading ? `${noteName} › ${cleanHeading}` : noteName);
    const noteSlug = context?.slugForNote(noteName) ?? makeSlug(noteName);
    const headingAnchor = cleanHeading
      ? '-' +
        cleanHeading
          .toLowerCase()
          .replace(/[\s_]+/g, '-')
          .replace(/[^\w\-\u3040-\u9fff\u30a0-\u30ff\u4e00-\u9fff]/g, '')
          .replace(/-+/g, '-')
      : '';

    const isCollected = collectedNotes.has(noteName) || noteName === currentNote;
    if (isCollected) {
      return `<a href="#${noteSlug}${headingAnchor}" class="wikilink">${escHtml(displayText)}</a>`;
    }
    return `<a href="#" class="wikilink wikilink-missing" title="${escAttr(noteName)} はこのエクスポートに含まれていません">${escHtml(displayText)}</a>`;
  });

  return content;
}

// ──────────────────────────────────────────
// 見出しへの id 付与
// ──────────────────────────────────────────

function addHeadingIds(html: string, noteSlug: string): string {
  return html.replace(
    /<h([1-6])([^>]*)>(.*?)<\/h\1>/gs,
    (_m, level: string, attrs: string, inner: string) => {
      const text = inner.replace(/<[^>]+>/g, '');
      const headingSlug =
        text
          .toLowerCase()
          .replace(/[\s_]+/g, '-')
          .replace(/[^\w\-\u3040-\u9fff\u30a0-\u30ff\u4e00-\u9fff]/g, '')
          .replace(/-+/g, '-')
          .replace(/^-|-$/g, '') || 'h';
      const id = `${noteSlug}-${headingSlug}`;
      return `<h${level} id="${id}"${attrs}>${inner}</h${level}>`;
    }
  );
}

// ──────────────────────────────────────────
// 画像の base64 埋め込み
// ──────────────────────────────────────────

function embedImages(html: string, vaultPath: string, noteName: string, resolveImage?: (link: string) => string | null): string {
  const resolve = (link: string) => resolveImage
    ? resolveImage(link.replace(/&quot;/g, '"').replace(/&amp;/g, '&'))
    : findAndEncodeImage(link, vaultPath, noteName);
  html = html.replace(
    /<img data-obsidian-image="([^"]+)"([^>]*)>/g,
    (_m, imageName: string, rest: string) => {
      const dataUri = resolve(imageName);
      
      const widthMatch = rest.match(/data-width="(\d+)"/);
      const heightMatch = rest.match(/data-height="(\d+)"/);
      const width = widthMatch ? ` width="${widthMatch[1]}"` : '';
      const height = heightMatch ? ` height="${heightMatch[1]}"` : '';
      
      const cleanRest = rest
        .replace(/data-width="\d+"/, '')
        .replace(/data-height="\d+"/, '')
        .trim();

      if (dataUri) {
        return `<img src="${dataUri}" alt="${escAttr(imageName)}" class="obsidian-image"${width}${height} ${cleanRest}>`.replace(/\s+/g, ' ');
      }
      return `<span class="missing-image">⚠️ 画像が見つかりません: ${escHtml(imageName)}</span>`;
    }
  );

  html = html.replace(/<img src="([^"]+)"([^>]*)>/g, (match, src: string, rest: string) => {
    if (
      src.startsWith('data:') ||
      src.startsWith('http://') ||
      src.startsWith('https://') ||
      src.startsWith('//')
    ) return match;
    const dataUri = resolve(src);
    return dataUri ? `<img src="${dataUri}"${rest}>` : match;
  });

  return html;
}

export function findAndEncodeImage(imageName: string, vaultPath: string, noteName: string): string | null {
  try {
    const escapedImageName = imageName.replace(/'/g, "\\'");
    const escapedNoteName = noteName.replace(/'/g, "\\'");

    // app.metadataCache.getFirstLinkpathDest を用いて画像の Vault 相対パスを解決する。
    // エスケープやバックスラッシュの問題を避けるため、ダブルクォーテーションを使わないJavaScriptコードを渡す。
    const code = `
      (() => {
        const file = app.vault.getMarkdownFiles().find(f => f.basename === '${escapedNoteName}');
        const dest = app.metadataCache.getFirstLinkpathDest('${escapedImageName}', file ? file.path : '');
        return dest ? dest.path : '';
      })()
    `.trim().replace(/\n\s*/g, ' ');

    const vaultName = path.basename(vaultPath);
    const output = runObsidian(`eval code="${code}"`, vaultName);
    const resolvedPath = output.replace(/^=>\s*/, '').trim();

    if (resolvedPath) {
      const fullPath = path.join(vaultPath, resolvedPath);
      if (fs.existsSync(fullPath)) {
        return encodeImageFile(fullPath);
      }
    }
  } catch (error) {
    // evalエラーなどの場合は null を返してフォールバック
  }
  return null;
}

function encodeImageFile(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase().slice(1);
  const mime: Record<string, string> = {
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
    gif: 'image/gif', svg: 'image/svg+xml', webp: 'image/webp',
    bmp: 'image/bmp', ico: 'image/x-icon', avif: 'image/avif',
  };
  return `data:${mime[ext] ?? 'image/png'};base64,${fs.readFileSync(filePath).toString('base64')}`;
}

// ──────────────────────────────────────────
// ユーティリティ
// ──────────────────────────────────────────

function escHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escAttr(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
