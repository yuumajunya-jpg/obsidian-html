import { App, Modal, Notice, Plugin, PluginSettingTab, Setting, TFile } from 'obsidian';
import * as fs from 'fs';
import * as path from 'path';
import { buildHtml } from './builder';
import { crawlVault, imageResolver, noteSlug, noteKey, parseDepth, resolveOutput, vaultBasePath } from './plugin-export';

interface HtmlSettings {
  maxDepth: number;
  outputFolder: string;
  theme: 'dark' | 'light';
  customCssPath: string;
}
const DEFAULTS: HtmlSettings = { maxDepth: 2, outputFolder: 'HTML Exports', theme: 'dark', customCssPath: '' };

export default class HtmlExportPlugin extends Plugin {
  settings: HtmlSettings = { ...DEFAULTS };
  private exporting = false;

  async onload(): Promise<void> {
    const saved = await this.loadData();
    this.settings = {
      maxDepth: Number.isSafeInteger(saved?.maxDepth) && saved.maxDepth >= 0 ? saved.maxDepth : DEFAULTS.maxDepth,
      outputFolder: typeof saved?.outputFolder === 'string' ? saved.outputFolder : DEFAULTS.outputFolder,
      theme: saved?.theme === 'light' ? 'light' : 'dark',
      customCssPath: typeof saved?.customCssPath === 'string' ? saved.customCssPath : '',
    };
    this.addSettingTab(new HtmlSettingTab(this.app, this));
    this.addCommand({
      id: 'export-active-note', name: '現在のノートをHTMLに出力（深度を指定）',
      checkCallback: checking => {
        const file = this.app.workspace.getActiveFile();
        if (file?.extension !== 'md') return false;
        if (!checking) this.openExport(file);
        return true;
      },
    });
    this.addRibbonIcon('file-output', 'ノートをHTMLに出力', () => {
      const file = this.app.workspace.getActiveFile();
      if (file?.extension === 'md') this.openExport(file);
      else new Notice('出力するMarkdownノートを開いてください。');
    });
    this.registerEvent(this.app.workspace.on('file-menu', (menu, file) => {
      if (file instanceof TFile && file.extension === 'md') {
        menu.addItem(item => item.setTitle('HTMLに出力').setIcon('file-output').onClick(() => this.openExport(file)));
      }
    }));
  }

  openExport(file: TFile): void {
    if (this.exporting) { new Notice('HTMLを出力中です。完了までお待ちください。'); return; }
    new ExportModal(this.app, this, file).open();
  }

  async exportNote(file: TFile, depth: string, destination: string): Promise<boolean> {
    if (this.exporting) { new Notice('HTMLを出力中です。'); return false; }
    let progress: Notice | undefined;
    try {
      const maxDepth = parseDepth(depth);
      const base = vaultBasePath(this.app);
      const outputPath = resolveOutput(base, destination);
      const settings = { ...this.settings };
      this.exporting = true;
      progress = new Notice('リンク先のノートを収集しています…', 0);
      const graph = await crawlVault(this.app, file, maxDepth);
      progress.setMessage(`${graph.nodes.size}件のノートをHTMLに変換しています…`);
      const templateDir = path.join(base, this.manifest.dir ?? `${this.app.vault.configDir}/plugins/${this.manifest.id}`, 'templates');
      fs.mkdirSync(path.dirname(outputPath), { recursive: true });
      await buildHtml({
        graph, outputPath, theme: settings.theme, templateDir, overwrite: true,
        customCssPath: settings.customCssPath.trim() ? path.resolve(base, settings.customCssPath.trim()) : undefined,
        conversionContext: key => ({
          resolveNote: link => {
            const target = this.app.metadataCache.getFirstLinkpathDest(link, `${key}.md`);
            return target ? noteKey(target) : link;
          },
          slugForNote: noteSlug,
          resolveImage: imageResolver(this.app, `${key}.md`),
        }),
      });
      new Notice(`HTML出力が完了しました（${graph.nodes.size}ノート）\n${outputPath}`, 10000);
      return true;
    } catch (error) {
      console.error('obsidian-html:', error);
      new Notice(`HTML出力に失敗しました: ${error instanceof Error ? error.message : String(error)}`, 10000);
      return false;
    } finally { progress?.hide(); this.exporting = false; }
  }
}

class ExportModal extends Modal {
  constructor(app: App, private plugin: HtmlExportPlugin, private file: TFile) { super(app); }
  onOpen(): void {
    this.titleEl.setText('ノートをHTMLに出力');
    this.contentEl.createEl('p', { text: `起点: ${this.file.path}` });
    let depth = String(this.plugin.settings.maxDepth);
    let destination = path.join(this.plugin.settings.outputFolder, `${this.file.basename}.html`);
    new Setting(this.contentEl).setName('リンクの深さ').setDesc('0: このノートのみ / 1: 直接のリンク先 / 2: その先まで')
      .addText(text => {
        text.setValue(depth).onChange(value => { depth = value; });
        text.inputEl.type = 'number'; text.inputEl.min = '0'; text.inputEl.step = '1';
      });
    new Setting(this.contentEl).setName('保存先').setDesc('Vaultからの相対パス、または絶対パス')
      .addText(text => text.setValue(destination).onChange(value => { destination = value; }));
    new Setting(this.contentEl)
      .addButton(button => button.setButtonText('キャンセル').onClick(() => this.close()))
      .addButton(button => button.setButtonText('HTMLを出力').setCta().onClick(async () => {
        button.setDisabled(true);
        try { if (await this.plugin.exportNote(this.file, depth, destination)) this.close(); }
        finally { button.setDisabled(false); }
      }));
  }
  onClose(): void { this.contentEl.empty(); }
}

class HtmlSettingTab extends PluginSettingTab {
  constructor(app: App, private plugin: HtmlExportPlugin) { super(app, plugin); }
  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl('h2', { text: 'Obsidian HTML' });
    const save = () => this.plugin.saveData(this.plugin.settings);
    new Setting(containerEl).setName('既定のリンク深度').setDesc('実行時の画面で変更できます。0は起点ノートのみ。')
      .addText(text => text.setValue(String(this.plugin.settings.maxDepth)).onChange(async value => {
        try { this.plugin.settings.maxDepth = parseDepth(value); await save(); }
        catch { /* Keep the last valid value while editing. */ }
      }));
    new Setting(containerEl).setName('出力フォルダー').setDesc('Vaultからの相対パス、または絶対パス')
      .addText(text => text.setValue(this.plugin.settings.outputFolder).onChange(async value => {
        this.plugin.settings.outputFolder = value; await save();
      }));
    new Setting(containerEl).setName('HTMLのテーマ').addDropdown(dropdown => dropdown
      .addOption('dark', 'ダーク').addOption('light', 'ライト').setValue(this.plugin.settings.theme)
      .onChange(async value => { this.plugin.settings.theme = value === 'light' ? 'light' : 'dark'; await save(); }));
    new Setting(containerEl).setName('カスタムCSS').setDesc('空欄なら標準CSS。Vaultからの相対パス、または絶対パス。')
      .addText(text => text.setValue(this.plugin.settings.customCssPath).onChange(async value => {
        this.plugin.settings.customCssPath = value; await save();
      }));
    containerEl.createEl('p', { text: 'ショートカットは「設定 → ホットキー」で「Obsidian HTML」を検索して割り当ててください。' });
  }
}
