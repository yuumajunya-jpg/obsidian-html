/**
 * ノートグラフからHTML単一ファイルを生成するビルダー
 * - 検索・グラフUI は廃止（シンプルなサイドバーのみ）
 * - アクティブリンクハイライト (IntersectionObserver) は維持
 */
import * as fs from 'fs';
import * as path from 'path';
import { NoteGraph, BuildOptions, NoteNode } from './types';
import { convertNote } from './converter';
import { makeSlug } from './crawler';

// ──────────────────────────────────────────
// エントリーポイント
// ──────────────────────────────────────────

export async function buildHtml(options: BuildOptions): Promise<void> {
  const { graph, outputPath, theme } = options;

  // 全ノートを変換
  const collectedNotes = new Set(graph.nodes.keys());
  for (const [name, node] of graph.nodes) {
    const result = convertNote(name, node.content, collectedNotes, graph.vaultPath, node.frontmatter, options.conversionContext?.(name));
    node.html = result.html;
    node.frontmatter = result.frontmatter;
  }

  // CSS 読み込み（--css で外部ファイル指定があればそちらを優先）
  const templateDir = options.templateDir ?? path.join(__dirname, 'templates');
  const css = options.customCssPath
    ? fs.readFileSync(options.customCssPath, 'utf-8')
    : readTemplate(path.join(templateDir, 'style.css'));
  const hljsCss = readTemplate(
    path.join(templateDir, theme === 'dark' ? 'hljs-dark.css' : 'hljs-light.css')
  );

  if (options.customCssPath) {
    console.info(`カスタムCSS: ${options.customCssPath}`);
  }

  const html = assembleHtml({ graph, css, hljsCss, theme });
  fs.writeFileSync(outputPath, html, { encoding: 'utf-8', flag: options.overwrite === false ? 'wx' : 'w' });
}

function readTemplate(filePath: string): string {
  return fs.readFileSync(filePath, 'utf-8');
}

// ──────────────────────────────────────────
// HTML 組み立て
// ──────────────────────────────────────────

function assembleHtml(params: {
  graph: NoteGraph;
  css: string;
  hljsCss: string;
  theme: string;
}): string {
  const { graph, css, hljsCss, theme } = params;

  const startNode = graph.nodes.get(graph.startNote);
  const title = esc(startNode?.name ?? graph.startNote);
  const nodeCount = graph.nodes.size;
  const maxDepth = Math.max(...Array.from(graph.nodes.values()).map(n => n.depth), 0);

  // 深さ → アルファベット順でソート
  const sortedNotes = Array.from(graph.nodes.values()).sort((a, b) => {
    if (a.depth !== b.depth) return a.depth - b.depth;
    return a.name.localeCompare(b.name, 'ja');
  });

  return `<!DOCTYPE html>
<html lang="ja" data-theme="${escAttr(theme)}">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title}</title>
  <meta name="description" content="Obsidianから生成されたエクスポート: ${title} (${nodeCount}ノート)">
  <style>
${css}
${hljsCss}
  </style>
  <!-- MathJax Configuration & Script (本家 Obsidian と同じ MathJax での表示) -->
  <script>
    window.MathJax = {
      tex: {
        inlineMath: [['$', '$']],
        displayMath: [['$$', '$$']],
        processEscapes: true
      },
      options: {
        skipHtmlTags: ['script', 'noscript', 'style', 'textarea', 'pre', 'code']
      }
    };
  </script>
  <script id="MathJax-script" async src="https://cdn.jsdelivr.net/npm/mathjax@3/es5/tex-mml-chtml.js"></script>
</head>
<body class="sidebar-open">
  <!-- ===== サイドバー ===== -->
  <aside class="sidebar" id="sidebar">
    <nav class="sidebar-nav" aria-label="ノート一覧">
      <div class="sidebar-section-title">ノート (${nodeCount}件)</div>
      <ul class="sidebar-list" id="sidebar-list">
        ${sortedNotes.map(n => renderSidebarItem(n)).join('\n')}
      </ul>
    </nav>
  </aside>

  <!-- ===== サイドバー開閉 ===== -->
  <button class="menu-toggle" id="menu-toggle" aria-label="サイドバーを閉じる" aria-controls="sidebar" aria-expanded="true">
    ${iconMenu()}
  </button>

  <!-- ===== メインコンテンツ ===== -->
  <main class="main-content" id="main-content">
    <div class="content-header">
      <h1 class="export-title">${title}</h1>
      <div class="export-stats">
        <span>${nodeCount} ノート</span>
        <span class="stat-sep">·</span>
        <span>最大深さ ${maxDepth}</span>
      </div>
    </div>

    <div class="notes-container">
      ${sortedNotes.map(n => renderNoteCard(n, graph)).join('\n')}
    </div>

    <footer class="page-footer">
      <p>このファイルは <strong>obsidian-html</strong> によって生成されました</p>
    </footer>
  </main>

  <script>
    'use strict';
    ${inlineJs()}
  </script>
  <!-- 外部ライブラリの取得でサイドバー操作を待たせない -->
  <script defer src="https://cdn.jsdelivr.net/npm/mermaid@10/dist/mermaid.min.js"></script>
  <script>
    document.addEventListener('DOMContentLoaded', function () {
    // Mermaid の初期化
    if (window.mermaid) {
      var isDark = document.documentElement.getAttribute('data-theme') === 'dark';
      mermaid.initialize({
        startOnLoad: true,
        theme: isDark ? 'dark' : 'default',
        securityLevel: 'loose',
        flowchart: { useMaxWidth: true, htmlLabels: true }
      });
    }
    });
  </script>
</body>
</html>`;
}

// ──────────────────────────────────────────
// サイドバーアイテム
// ──────────────────────────────────────────

function renderSidebarItem(node: NoteNode): string {
  return `
  <li class="sidebar-item">
    <a href="#${node.slug}" class="sidebar-link" data-depth="${node.depth}">
      <span class="sidebar-icon">📄</span>
      <span class="sidebar-title">${esc(node.name)}</span>
    </a>
  </li>`;
}

// ──────────────────────────────────────────
// ノートカード
// ──────────────────────────────────────────

function renderNoteCard(node: NoteNode, graph: NoteGraph): string {
  const tags = Array.isArray(node.frontmatter['tags'])
    ? (node.frontmatter['tags'] as unknown[]).map(String)
    : [];

  const linkedInExport = node.links.filter(l => graph.nodes.has(l));

  // 起点からのパンくずリスト（Breadcrumbs）を構築（収集済みのノートはリンク化、ツールチップ追加）
  const breadcrumbHtml = node.path.map(p => {
    const slug = graph.nodes.get(p)?.slug ?? makeSlug(p);
    const isCollected = graph.nodes.has(p);
    if (isCollected) {
      return `<a href="#${slug}" class="breadcrumb-link" title="${escAttr(p)}">${esc(p)}</a>`;
    }
    return `<span title="${escAttr(p)}">${esc(p)}</span>`;
  }).join(' &rsaquo; ');

  const footer = linkedInExport.length > 0
    ? `
    <footer class="note-footer">
      <div class="note-linked-notes">
        <span class="linked-notes-label">リンクされたノート：</span>
        <div class="linked-note-chips">
          ${linkedInExport.map(l => {
            const linked = graph.nodes.get(l)!;
            return `<a href="#${linked.slug}" class="linked-note-chip">${esc(l)}</a>`;
          }).join('')}
        </div>
      </div>
    </footer>`
    : '';

  return `
  <article id="${node.slug}" class="note-card" data-depth="${node.depth}">
    <header class="note-header">
      <div class="note-meta">
        <span class="note-breadcrumb">${breadcrumbHtml}</span>
        ${linkedInExport.length > 0
          ? `<span class="note-meta-item">🔗 ${linkedInExport.length} リンク</span>`
          : ''}
        ${tags.map(t => `<span class="note-tag">#${esc(t)}</span>`).join('')}
      </div>
      <h2 class="note-title">${esc(node.name)}</h2>
    </header>
    <div class="note-content">
      ${node.html || '<p class="no-content">（コンテンツなし）</p>'}
    </div>
    ${footer}
  </article>`;
}

// ──────────────────────────────────────────
// インライン JavaScript（サイドバー + アクティブリンク）
// ──────────────────────────────────────────

function inlineJs(): string {
  return `
(function () {
  // ── サイドバートグル ──
  var sidebar     = document.getElementById('sidebar');
  var menuToggle  = document.getElementById('menu-toggle');
  var sidebarOpen = true;

  function setSidebarOpen(open) {
    sidebarOpen = open;
    document.body.classList.toggle('sidebar-open', open);
    sidebar.inert = !open;
    sidebar.setAttribute('aria-hidden', String(!open));
    menuToggle.setAttribute('aria-expanded', String(open));
    menuToggle.setAttribute('aria-label', open ? 'サイドバーを閉じる' : 'サイドバーを開く');
  }
  setSidebarOpen(sidebarOpen);
  menuToggle.addEventListener('click', function () {
    setSidebarOpen(!sidebarOpen);
  });

  document.querySelectorAll('.sidebar-link').forEach(function (link) {
    link.addEventListener('click', function () {
      if (window.innerWidth <= 768) setSidebarOpen(false);
    });
  });

  // ── アクティブリンク（IntersectionObserver）──
  var noteCards = document.querySelectorAll('.note-card');
  var linkMap   = {};
  document.querySelectorAll('.sidebar-link[href^="#"]').forEach(function (link) {
    linkMap[link.getAttribute('href').slice(1)] = link;
  });

  if (noteCards.length > 0 && 'IntersectionObserver' in window) {
    var observer = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) {
          var id = entry.target.id;
          Object.values(linkMap).forEach(function (l) { l.classList.remove('active'); });
          if (linkMap[id]) {
            linkMap[id].classList.add('active');
            linkMap[id].scrollIntoView({ block: 'nearest' });
          }
        }
      });
    }, { rootMargin: '-10% 0px -65% 0px', threshold: 0 });
    noteCards.forEach(function (card) { observer.observe(card); });
  }
})();
`;
}

// ──────────────────────────────────────────
// SVGアイコン
// ──────────────────────────────────────────

function iconMenu(): string {
  return `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/></svg>`;
}

// ──────────────────────────────────────────
// HTMLエスケープ
// ──────────────────────────────────────────

function esc(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function escAttr(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
}
