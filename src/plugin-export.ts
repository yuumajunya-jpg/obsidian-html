import { App, FileSystemAdapter, TFile } from 'obsidian';
import * as fs from 'fs';
import * as path from 'path';
import { NoteGraph } from './types';

export function noteKey(file: TFile): string { return file.path.replace(/\.md$/i, ''); }
export function noteSlug(key: string): string { return `note-${Buffer.from(key).toString('hex')}`; }

export function vaultBasePath(app: App): string {
  if (!(app.vault.adapter instanceof FileSystemAdapter)) {
    throw new Error('HTML出力はデスクトップ版Obsidianで利用できます。');
  }
  return app.vault.adapter.getBasePath();
}

export function parseDepth(value: string): number {
  if (!/^\d+$/.test(value.trim()) || !Number.isSafeInteger(Number(value))) {
    throw new Error('リンクの深さには0以上の整数を指定してください。');
  }
  return Number(value);
}

export function resolveOutput(base: string, value: string): string {
  if (!value.trim() || !/\.html?$/i.test(value.trim())) {
    throw new Error('保存先には.htmlまたは.htmで終わるファイル名を指定してください。');
  }
  const result = path.resolve(base, value.trim());
  const relative = path.relative(base, result);
  if (relative.split(path.sep).some(part => part === '.obsidian' || part === '.git')) {
    throw new Error('設定フォルダーやGit管理フォルダーには出力できません。');
  }
  return result;
}

/** Breadth-first traversal using vault paths, preserving shortest breadcrumbs. */
export async function crawlVault(app: App, start: TFile, maxDepth: number): Promise<NoteGraph> {
  parseDepth(String(maxDepth));
  const nodes: NoteGraph['nodes'] = new Map();
  const queue = [{ file: start, depth: 0, trail: [noteKey(start)] }];
  const seen = new Set([start.path]);
  for (let i = 0; i < queue.length; i++) {
    const { file, depth, trail } = queue[i];
    const content = await app.vault.read(file);
    const cache = app.metadataCache.getFileCache(file);
    if (!cache) throw new Error(`メタデータを取得できません: ${file.path}。少し待ってから再実行してください。`);
    const targets = new Map<string, TFile>();
    for (const link of [...(cache.links ?? []), ...(cache.embeds ?? [])]) {
      const target = app.metadataCache.getFirstLinkpathDest(link.link.split('#')[0], file.path);
      if (target?.extension === 'md') targets.set(target.path, target);
    }
    // Property links are also outgoing note links.
    for (const link of cache.frontmatterLinks ?? []) {
      const target = app.metadataCache.getFirstLinkpathDest(link.link.split('#')[0], file.path);
      if (target?.extension === 'md') targets.set(target.path, target);
    }
    const key = noteKey(file);
    nodes.set(key, {
      name: key, slug: noteSlug(key), content, html: '', depth, path: trail,
      links: [...targets.values()].map(noteKey), frontmatter: cache.frontmatter ?? {},
    });
    if (depth < maxDepth) for (const target of targets.values()) {
      if (seen.has(target.path)) continue;
      seen.add(target.path);
      queue.push({ file: target, depth: depth + 1, trail: [...trail, noteKey(target)] });
    }
  }
  return { nodes, startNote: noteKey(start), vaultPath: vaultBasePath(app) };
}

export function imageResolver(app: App, sourcePath: string): (link: string) => string | null {
  const mime: Record<string, string> = {
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
    svg: 'image/svg+xml', webp: 'image/webp', bmp: 'image/bmp', ico: 'image/x-icon', avif: 'image/avif',
  };
  const base = vaultBasePath(app);
  return link => {
    let decoded: string;
    try { decoded = decodeURIComponent(link); } catch { decoded = link; }
    const file = app.metadataCache.getFirstLinkpathDest(decoded, sourcePath);
    if (!file || !mime[file.extension.toLowerCase()]) return null;
    const data = fs.readFileSync(path.join(base, file.path));
    return `data:${mime[file.extension.toLowerCase()]};base64,${data.toString('base64')}`;
  };
}
