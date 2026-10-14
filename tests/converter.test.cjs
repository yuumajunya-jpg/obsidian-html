const { test } = require('node:test');
const assert = require('node:assert/strict');
const { convertNote } = require('../dist/converter');

const dataUri = 'data:image/png;base64,iVBORw==';
function render(content) {
  return convertNote('Root', content, new Set(['Root']), '', {}, {
    resolveNote: ref => ref,
    slugForNote: name => name,
    resolveImage: () => dataUri,
  }).html;
}

test('Markdown immediately after an Obsidian image is parsed with LF and CRLF', () => {
  for (const newline of ['\n', '\r\n']) {
    for (const image of ['![[image.png]]', '![[image.png|300]]', '![[image.png|300x200]]']) {
      const html = render([image, '*斜体*', '**太字**', '[リンク](https://example.com)'].join(newline));
      assert.ok(html.includes(`<img src="${dataUri}"`));
      assert.match(html, /<br>\n<em>斜体<\/em>/);
      assert.match(html, /<strong>太字<\/strong>/);
      assert.match(html, /<a href="https:\/\/example.com">リンク<\/a>/);
      if (image.includes('|300')) assert.match(html, /width="300"/);
      if (image.includes('x200')) assert.match(html, /height="200"/);
    }
  }
});

test('image parsing preserves paragraphs, inline emphasis, lists and ordinary Markdown images', () => {
  assert.match(render('![[image.png]]\n\n*斜体*'), /<\/p>\n<p><em>斜体<\/em><\/p>/);
  assert.match(render('![[image.png]] *斜体*'), /<em>斜体<\/em>/);
  assert.match(render('* ![[image.png]]\n  *斜体*'), /<li><img[^>]+><br>\n<em>斜体<\/em><\/li>/);
  assert.match(render('![image](image.png)\n*斜体*'), /<br>\n<em>斜体<\/em>/);
});

test('Obsidian image syntax in code remains literal', () => {
  assert.equal(render('`![[image.png]]`'), '<p><code>![[image.png]]</code></p>\n');
  assert.match(render('```\n![[image.png]]\n```'), /<code>!\[\[image\.png\]\]\n<\/code>/);
});
