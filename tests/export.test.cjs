const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

class TFile {
  constructor(filePath) {
    this.path = filePath;
    this.extension = path.extname(filePath).slice(1);
    this.basename = path.basename(filePath, path.extname(filePath));
  }
}
class FileSystemAdapter {
  constructor(base) { this.base = base; }
  getBasePath() { return this.base; }
}
const originalLoad = Module._load;
Module._load = function (id, ...args) {
  if (id === 'obsidian') return { TFile, FileSystemAdapter };
  return originalLoad.call(this, id, ...args);
};
const { crawlVault, imageResolver, noteSlug, noteKey, parseDepth, resolveOutput } = require('../dist/plugin-export');
Module._load = originalLoad;
const { buildHtml } = require('../dist/builder');
const childProcess = require('node:child_process');
childProcess.execSync = () => { throw new Error('Plugin must never invoke Obsidian CLI'); };

function fixture(base) {
  const files = ['Root.md', 'a/Same.md', 'b/Same.md', 'End.md', 'image.png'].map(p => new TFile(p));
  const byPath = new Map(files.map(f => [f.path, f]));
  const caches = {
    'Root.md': { links: [{ link: 'a/Same#Section' }, { link: 'b/Same' }, { link: 'Missing' }], embeds: [{ link: 'image.png' }], frontmatter: { tags: ['sample'] } },
    'a/Same.md': { links: [{ link: 'Root' }], frontmatterLinks: [{ link: 'End' }] },
    'b/Same.md': { embeds: [{ link: 'End' }] },
    'End.md': {},
  };
  const content = {
    'Root.md': '[[a/Same#Section|Alpha]] [[b/Same|Beta]]\n\n[B](b/Same.md)\n\n![[image.png|300]]',
    'a/Same.md': '## Section\nAlpha content', 'b/Same.md': 'Beta content', 'End.md': 'End content',
  };
  return {
    start: files[0],
    app: {
      vault: { adapter: new FileSystemAdapter(base), read: async f => content[f.path] },
      metadataCache: {
        getFileCache: f => caches[f.path],
        getFirstLinkpathDest: link => byPath.get(link) ?? byPath.get(`${link}.md`) ?? null,
      },
    },
  };
}

test('BFS respects depth, cycles, note embeds, property links and duplicate basenames', async () => {
  const { app, start } = fixture(os.tmpdir());
  assert.equal((await crawlVault(app, start, 0)).nodes.size, 1);
  const one = await crawlVault(app, start, 1);
  assert.deepEqual([...one.nodes.keys()], ['Root', 'a/Same', 'b/Same']);
  const two = await crawlVault(app, start, 2);
  assert.equal(two.nodes.size, 4);
  assert.equal(two.nodes.get('End').depth, 2);
  assert.deepEqual(two.nodes.get('End').path, ['Root', 'a/Same', 'End']);
  assert.notEqual(two.nodes.get('a/Same').slug, two.nodes.get('b/Same').slug);
});

test('invalid depth and destination are rejected', () => {
  for (const value of ['-1', '1.5', '2x', '', 'Infinity', '9007199254740992']) assert.throws(() => parseDepth(value));
  assert.equal(parseDepth('0'), 0);
  assert.throws(() => resolveOutput(os.tmpdir(), 'note.md'));
  assert.throws(() => resolveOutput(os.tmpdir(), '.obsidian/config.html'));
  assert.ok(resolveOutput(os.tmpdir(), 'exports/sample.html').endsWith('sample.html'));
});

test('bundled plugin loads saved settings and registers hotkey command and file menu', async () => {
  class Plugin {
    commands = []; events = [];
    async loadData() { return { maxDepth: 3, theme: 'light', outputFolder: 'Exports', customCssPath: '' }; }
    addSettingTab(tab) { this.tab = tab; }
    addCommand(command) { this.commands.push(command); }
    addRibbonIcon(icon, title, callback) { this.ribbon = callback; }
    registerEvent(event) { this.events.push(event); }
  }
  const mock = { Plugin, PluginSettingTab: class {}, Modal: class {}, Notice: class {}, TFile, FileSystemAdapter };
  Module._load = function (id, ...args) {
    if (id === 'obsidian') return mock;
    return originalLoad.call(this, id, ...args);
  };
  let HtmlExportPlugin;
  try { HtmlExportPlugin = require('../plugin/obsidian-html/main.js').default; }
  finally { Module._load = originalLoad; }
  const instance = new HtmlExportPlugin();
  let active = new TFile('Root.md');
  let menuCallback;
  instance.app = { workspace: {
    getActiveFile: () => active,
    on: (event, callback) => { assert.equal(event, 'file-menu'); menuCallback = callback; return {}; },
  } };
  await instance.onload();
  assert.equal(instance.settings.maxDepth, 3);
  assert.equal(instance.settings.theme, 'light');
  let selected;
  instance.openExport = file => { selected = file; };
  const command = instance.commands[0];
  assert.equal(command.id, 'export-active-note');
  assert.equal(command.checkCallback(true), true);
  assert.equal(selected, undefined);
  command.checkCallback(false);
  assert.equal(selected, active);
  active = new TFile('image.png');
  assert.equal(command.checkCallback(true), false);
  let itemCallback;
  const item = { setTitle() { return this; }, setIcon() { return this; }, onClick(callback) { itemCallback = callback; return this; } };
  const menu = { addItem: callback => callback(item) };
  const target = new TFile('Other.md');
  menuCallback(menu, target);
  itemCallback();
  assert.equal(selected, target);
});

test('build embeds resolved images and links without CLI, protects existing files', async t => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'obsidian-html-test-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  fs.writeFileSync(path.join(base, 'image.png'), Buffer.from([137, 80, 78, 71]));
  const { app, start } = fixture(base);
  const graph = await crawlVault(app, start, 2);
  const outputPath = path.join(base, 'export.html');
  const options = {
    graph, outputPath, theme: 'light', overwrite: false,
    templateDir: path.resolve(__dirname, '../plugin/obsidian-html/templates'),
    conversionContext: key => ({
      resolveNote: ref => { const file = app.metadataCache.getFirstLinkpathDest(ref, `${key}.md`); return file ? noteKey(file) : ref; },
      slugForNote: noteSlug, resolveImage: imageResolver(app, `${key}.md`),
    }),
  };
  await buildHtml(options);
  const html = fs.readFileSync(outputPath, 'utf8');
  assert.match(html, /data-theme="light"/);
  assert.match(html, /data:image\/png;base64,iVBORw==/);
  assert.match(html, /width="300"/);
  assert.ok(html.includes(`href="#${noteSlug('a/Same')}-section"`));
  assert.ok(html.includes(`id="${noteSlug('a/Same')}-section"`));
  assert.ok(html.includes(`href="#${noteSlug('b/Same')}">B</a>`));
  assert.match(html, /\.sidebar\s*\{/);
  // Execute the exported sidebar controls at desktop and narrow widths.
  const vm = require('node:vm');
  const script = html.match(/\(function \(\) \{[\s\S]*?\}\)\(\);/)[0];
  for (const width of [600, 768, 769, 1200]) {
    const classes = new Set();
    const handlers = {};
    const attributes = {};
    const sidebar = { setAttribute() {}, inert: false };
    const button = {
      setAttribute: (name, value) => { attributes[name] = value; },
      addEventListener: (name, callback) => { handlers[name] = callback; },
    };
    const link = { addEventListener: (name, callback) => { handlers.link = callback; } };
    const document = {
      body: { classList: { toggle: (name, on) => on ? classes.add(name) : classes.delete(name) } },
      getElementById: id => id === 'sidebar' ? sidebar : button,
      querySelectorAll: selector => selector === '.sidebar-link' ? [link] : [],
    };
    vm.runInNewContext(script, { document, window: { innerWidth: width } });
    const initiallyOpen = true;
    assert.equal(attributes['aria-expanded'], String(initiallyOpen));
    handlers.click();
    assert.equal(classes.has('sidebar-open'), !initiallyOpen);
    assert.equal(sidebar.inert, initiallyOpen);
    handlers.click();
    assert.equal(classes.has('sidebar-open'), initiallyOpen);
    assert.equal(attributes['aria-expanded'], String(initiallyOpen));
    if (!initiallyOpen) handlers.click();
    handlers.link();
    assert.equal(classes.has('sidebar-open'), width > 768);
  }
  assert.match(html, /<body class="sidebar-open">/);
  assert.match(html, /<script defer src="https:\/\/cdn\.jsdelivr\.net\/npm\/mermaid/);
  assert.ok(html.indexOf('menuToggle.addEventListener') < html.indexOf('<script defer src='));
  await assert.rejects(buildHtml(options), { code: 'EEXIST' });
  assert.equal(fs.readFileSync(outputPath, 'utf8'), html);
  await buildHtml({ ...options, overwrite: true });
  await assert.rejects(buildHtml({ ...options, overwrite: true, customCssPath: path.join(base, 'missing.css') }), { code: 'ENOENT' });
});
