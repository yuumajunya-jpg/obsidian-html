#!/usr/bin/env node
/**
 * obsidian-html CLI エントリーポイント
 */
import { Command } from 'commander';
import * as path from 'path';
import * as fs from 'fs';
import { crawl } from './crawler';
import { buildHtml } from './builder';

const pkg = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf-8')
) as { version: string; description: string };

const program = new Command();

program
  .name('obsidian-html')
  .description(pkg.description)
  .version(pkg.version);

// ── build コマンド ──
program
  .command('build')
  .description('ObsidianノートをHTMLにビルドします')
  .requiredOption('-n, --note <name>', '収集を開始するノート名')
  .option('-d, --depth <n>', 'リンクをたどる最大の深さ (0=起点のみ)', '2')
  .option('-o, --output <path>', '出力HTMLファイルのパス', './output.html')
  .option('-v, --vault <name>', '使用するVault名 (省略時はCWDまたはアクティブVault)')
  .option('--theme <dark|light>',
    '出力HTMLのカラーテーマ (dark または light)',
    'dark'
  )
  .option('--css <path>', 'カスタムCSSファイルのパス (省略時はビルド済みのCSSを使用)')
  .action(async (opts: {
    note: string;
    depth: string;
    output: string;
    vault?: string;
    theme: string;
    css?: string;
  }) => {
    const maxDepth = parseInt(opts.depth, 10);
    if (isNaN(maxDepth) || maxDepth < 0) {
      console.error('エラー: --depth には 0 以上の整数を指定してください');
      process.exit(1);
    }

    const theme = opts.theme === 'light' ? 'light' : 'dark';
    const outputPath = path.resolve(opts.output);

    console.log();
    console.log(`🔍 "${opts.note}" から深さ ${maxDepth} までのノートを収集中...`);
    console.log();

    let graph;
    try {
      graph = await crawl({
        startNote: opts.note,
        maxDepth,
        vault: opts.vault,
      });
    } catch (error: any) {
      console.error('\n❌ ノートの収集に失敗しました:');
      console.error(error.message);
      console.error(
        '\nObsidianが起動しており、CLIが有効になっているか確認してください。\n' +
        'Obsidian設定 → 一般 → コマンドラインインターフェース を有効化'
      );
      process.exit(1);
    }

    const collected = graph.nodes.size;
    if (collected === 0) {
      console.error(`\n❌ ノート "${opts.note}" が見つかりませんでした。`);
      console.error('ノート名が正しいか確認してください。');
      process.exit(1);
    }

    console.log();
    console.log(`✅ ${collected} 件のノートを収集しました`);
    console.log(`🎨 HTMLをビルド中... (テーマ: ${theme})`);

    try {
      await buildHtml({
        graph,
        outputPath,
        theme,
        customCssPath: opts.css ? path.resolve(opts.css) : undefined,
      });
    } catch (error: any) {
      console.error('\n❌ HTMLの生成に失敗しました:');
      console.error(error.message);
      process.exit(1);
    }

    const stats = fs.statSync(outputPath);
    const sizeKb = (stats.size / 1024).toFixed(1);

    console.log();
    console.log(`✨ 完了！`);
    console.log(`   出力先: ${outputPath}`);
    console.log(`   ファイルサイズ: ${sizeKb} KB`);
    console.log(`   収録ノート数: ${collected}`);
    console.log();
  });

// 引数が無い場合はヘルプを表示
if (process.argv.slice(2).length === 0) {
  program.outputHelp();
  process.exit(0);
}

program.parseAsync(process.argv).catch((err: Error) => {
  console.error(err);
  process.exit(1);
});
