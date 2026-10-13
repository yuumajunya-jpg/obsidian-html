/**
 * Obsidian CLI を呼び出してノートを収集するクローラー
 */
import { execSync } from 'child_process';
import { NoteGraph, NoteNode, CrawlOptions } from './types';

// ──────────────────────────────────────────
// Obsidian CLI ラッパー
// ──────────────────────────────────────────

/**
 * obsidian コマンドを実行して stdout を返す。
 * vault 引数は必ずコマンドの最初に置く必要がある（CLI仕様）。
 */
export function runObsidian(args: string, vault?: string): string {
  const vaultPrefix = vault ? `vault="${vault.replace(/"/g, '\\"')}" ` : '';
  const cmd = `obsidian ${vaultPrefix}${args}`;
  try {
    return execSync(cmd, {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 30_000,
    }).trim();
  } catch (error: any) {
    const detail = error.stderr?.toString().trim() || error.message || 'Unknown error';
    throw new Error(`Obsidian CLI エラー\nコマンド: ${cmd}\n詳細: ${detail}`);
  }
}

/** Vault のファイルシステムパスを取得する */
export function getVaultPath(vault?: string): string {
  try {
    const output = runObsidian('vault info=path', vault);
    // 出力形式のパターン: "path  /path/to/vault" または "/path/to/vault"
    for (const line of output.split('\n').map(l => l.trim()).filter(Boolean)) {
      const parts = line.split(/\s+/);
      if (parts[0] === 'path' && parts.length > 1) {
        return parts.slice(1).join(' ');
      }
    }
    return output.split('\n')[0].trim();
  } catch {
    return '';
  }
}

// ──────────────────────────────────────────
// スラッグ生成（HTML id 属性に使用）
// ──────────────────────────────────────────

/**
 * ノート名から HTML id 属性用のスラッグを生成する。
 * 日本語文字（平仮名・片仮名・漢字）はそのまま保持する。
 */
export function makeSlug(name: string): string {
  const slug =
    name
      .toLowerCase()
      .replace(/[\s_]+/g, '-')
      // 英数字・ハイフン・日本語文字以外を除去
      .replace(/[^\w\-\u3040-\u9fff\u30a0-\u30ff\u4e00-\u9fff]/g, '')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '') || 'unnamed';
  return `note-${slug}`;
}

// ──────────────────────────────────────────
// メインのクロール処理（BFS）
// ──────────────────────────────────────────

export async function crawl(options: CrawlOptions): Promise<NoteGraph> {
  const { startNote, maxDepth, vault } = options;

  // Vault パスを取得（画像埋め込みに使用）
  const vaultPath = getVaultPath(vault);
  if (vaultPath) {
    process.stdout.write(`  🗂️  Vault: ${vaultPath}\n`);
  }

  const nodes = new Map<string, NoteNode>();
  const queue: Array<{ name: string; depth: number; path: string[] }> = [
    { name: startNote, depth: 0, path: [startNote] },
  ];
  const visited = new Set<string>();

  while (queue.length > 0) {
    const { name, depth, path: currentPath } = queue.shift()!;

    if (visited.has(name)) continue;
    visited.add(name);

    process.stdout.write(
      `  📄 "${name}" (深さ ${depth})\n`
    );

    let content = '';
    let links: string[] = [];
    let frontmatter: Record<string, unknown> = {};

    try {
      const escapedName = name.replace(/'/g, "\\'");
      // 起動中のObsidianアプリにJavaScriptコードを送信して実行させ、
      // 本文（非同期）、パース済みのリンク/埋め込み、フロントマターを一括取得する。
      const code = `
        (async () => {
          const file = app.vault.getMarkdownFiles().find(f => f.basename === '${escapedName}');
          if (!file) return 'null';
          
          const content = await app.vault.read(file);
          const cache = app.metadataCache.getFileCache(file) || {};
          const frontmatter = cache.frontmatter || {};
          
          const links = cache.links ? cache.links.map(l => l.link) : [];
          const embeds = cache.embeds ? cache.embeds.map(e => e.link) : [];
          const allRaw = [...links, ...embeds];
          
          const mediaRegex = /[.](png|jpe?g|gif|svg|webp|bmp|ico|avif|mp4|mov|avi|mkv|wmv|webm|pdf|zip|rar|7z|tar|gz|docx?|xlsx?|pptx?|mp3|wav|ogg|flac|m4a|aac|woff2?|ttf|otf)$/i;
          const parsedLinks = [];
          
          for (const raw of allRaw) {
            if (!raw || raw.startsWith('#')) continue;
            const basePart = raw.split('#')[0];
            if (!basePart || mediaRegex.test(basePart)) continue;
            
            let clean = basePart;
            if (clean.endsWith('.md')) clean = clean.slice(0, -3);
            
            const parts = clean.split('/').flatMap(p => p.split(String.fromCharCode(92)));
            const baseName = (parts[parts.length - 1] || clean).trim();
            if (baseName) {
              parsedLinks.push(baseName);
            }
          }
          return JSON.stringify({
            content,
            links: [...new Set(parsedLinks)],
            frontmatter
          });
        })()
      `.trim().replace(/\n\s*/g, ' ');

      const output = runObsidian(`eval code="${code}"`, vault);
      const json = output.replace(/^=>\s*/, '').trim();

      if (!json || json === 'null' || json === 'undefined') {
        process.stderr.write(`  ⚠️  "${name}" は存在しないか読み取れませんでした（スキップ）\n`);
        continue;
      }

      const parsed = JSON.parse(json) as {
        content: string;
        links: string[];
        frontmatter: Record<string, unknown>;
      };

      content = parsed.content;
      frontmatter = parsed.frontmatter;
      links = parsed.links;
    } catch (error: any) {
      process.stderr.write(
        `  ⚠️  "${name}" の読み取りに失敗しました: ${error.message}\n`
      );
      continue; // 失敗したノートはスキップ
    }

    const node: NoteNode = {
      name,
      slug: makeSlug(name),
      content,
      html: '',
      links,
      frontmatter,
      depth,
      path: currentPath,
    };

    nodes.set(name, node);

    // 最大深さに達していなければ、未訪問のリンク先をキューに追加
    if (depth < maxDepth) {
      for (const linkName of links) {
        if (!visited.has(linkName)) {
          queue.push({ name: linkName, depth: depth + 1, path: [...currentPath, linkName] });
        }
      }
    }
  }

  return { nodes, startNote, vaultPath };
}
