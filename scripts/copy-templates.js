/**
 * ビルド後にtemplatesとhighlight.jsのCSSをdist/へコピーするスクリプト
 */
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const srcTemplates = path.join(root, 'src', 'templates');
const dstTemplates = path.join(root, 'dist', 'templates');

// dist/templates/ ディレクトリを作成
fs.mkdirSync(dstTemplates, { recursive: true });

// src/templates/ 内のファイルをコピー
if (fs.existsSync(srcTemplates)) {
  const files = fs.readdirSync(srcTemplates);
  for (const file of files) {
    fs.copyFileSync(
      path.join(srcTemplates, file),
      path.join(dstTemplates, file)
    );
    console.log(`Copied: templates/${file}`);
  }
}

// highlight.js のテーマCSSをコピー
const hljsStylesDir = path.join(root, 'node_modules', 'highlight.js', 'styles');
const themes = [
  { src: 'atom-one-dark.css', dst: 'hljs-dark.css' },
  { src: 'atom-one-light.css', dst: 'hljs-light.css' },
];

for (const theme of themes) {
  const srcPath = path.join(hljsStylesDir, theme.src);
  const dstPath = path.join(dstTemplates, theme.dst);
  if (fs.existsSync(srcPath)) {
    fs.copyFileSync(srcPath, dstPath);
    console.log(`Copied: highlight.js/${theme.src} → templates/${theme.dst}`);
  } else {
    console.warn(`Warning: highlight.js theme not found: ${srcPath}`);
  }
}

console.log('Templates copied successfully.');
