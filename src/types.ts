/**
 * 型定義
 */

export interface NoteNode {
  /** ノート名（ファイル名から拡張子を除いたもの） */
  name: string;
  /** HTML id 属性用のスラッグ */
  slug: string;
  /** Obsidian CLI から取得した生のMarkdownコンテンツ */
  content: string;
  /** Markdown から変換済みのHTML */
  html: string;
  /** このノートが持つアウトゴーイングリンクのノート名リスト */
  links: string[];
  /** フロントマターのデータ */
  frontmatter: Record<string, unknown>;
  /** 開始ノートからの深さ（起点=0） */
  depth: number;
  /** 起点ノートからこのノートに到達するまでのノート名のパス */
  path: string[];
}

export interface NoteGraph {
  /** 収集されたすべてのノート (key: ノート名) */
  nodes: Map<string, NoteNode>;
  /** 収集の起点となったノート名 */
  startNote: string;
  /** Vault のファイルシステム上のパス（画像埋め込みに使用） */
  vaultPath: string;
}

export interface CrawlOptions {
  /** 収集を開始するノート名 */
  startNote: string;
  /** リンクをたどる最大深さ（0=起点のみ） */
  maxDepth: number;
  /** 使用する Vault の名前（省略時はCWDまたはアクティブVault） */
  vault?: string;
}

export interface BuildOptions {
  /** 構築済みノートグラフ */
  graph: NoteGraph;
  /** 出力先HTMLファイルのパス */
  outputPath: string;
  /** テーマ ('dark' | 'light') */
  theme: 'dark' | 'light';
  /** カスタムCSSファイルの絶対パス（指定した場合はビルド済みCSSの代わりに使用） */
  customCssPath?: string;
  templateDir?: string;
  overwrite?: boolean;
  conversionContext?: (note: string) => ConversionContext;
}

/** Plugin-provided resolvers avoid invoking the CLI during conversion. */
export interface ConversionContext {
  resolveNote: (link: string) => string;
  slugForNote: (note: string) => string;
  resolveImage: (link: string) => string | null;
}
