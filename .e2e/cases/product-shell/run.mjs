import { createHash } from 'crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, copyFileSync } from 'fs';
import Module, { createRequire } from 'module';
import { tmpdir } from 'os';
import path from 'path';

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(import.meta.dirname, '../../..');
const resultPath = path.resolve(repoRoot, process.env.PRODUCT_SHELL_RESULT || '.e2e/results/product-shell.json');
const startedAt = Date.now();

function sha256(filePath) {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex');
}

function writeResult(result) {
  mkdirSync(path.dirname(resultPath), { recursive: true });
  writeFileSync(resultPath, JSON.stringify(result, null, 2) + '\n');
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

class FakeElement {
  constructor(tag = 'div') {
    this.tagName = tag.toUpperCase();
    this.classList = new Set();
    this.attrs = new Map();
    this.children = [];
    this.parent = null;
    this._listeners = new Map();
    this._textContent = '';
    this._title = '';
  }

  get textContent() {
    if (this._textContent && this.children.length === 0) return this._textContent;
    return this.children.map((c) => c.textContent).join('');
  }
  set textContent(value) {
    this._textContent = String(value);
    this.children = [];
  }

  setText(text) {
    this.textContent = text;
  }

  empty() {
    for (const child of this.children) child.parent = null;
    this.children = [];
    this._textContent = '';
  }

  addClass(cls) {
    if (!cls) return;
    for (const part of String(cls).split(/\s+/)) if (part) this.classList.add(part);
  }
  removeClass(cls) {
    if (!cls) return;
    for (const part of String(cls).split(/\s+/)) this.classList.delete(part);
  }
  toggleClass(cls, force) {
    if (force === true) this.addClass(cls);
    else if (force === false) this.removeClass(cls);
    else if (this.classList.has(cls)) this.removeClass(cls);
    else this.addClass(cls);
  }
  hasClass(cls) {
    return this.classList.has(cls);
  }

  setAttr(name, value) {
    this.attrs.set(name, String(value));
  }
  getAttr(name) {
    return this.attrs.has(name) ? this.attrs.get(name) : null;
  }

  appendChild(child) {
    if (child.parent) child.parent.children = child.parent.children.filter((c) => c !== child);
    child.parent = this;
    this.children.push(child);
    return child;
  }

  createEl(tag, options = {}) {
    const child = new FakeElement(tag);
    if (options.cls) child.addClass(options.cls);
    if (options.text != null) child.setText(options.text);
    if (options.title != null) child._title = String(options.title);
    if (options.href != null) child.setAttr('href', options.href);
    return this.appendChild(child);
  }

  createDiv(options = {}) {
    return this.createEl('div', options);
  }

  addEventListener(type, handler) {
    if (typeof handler !== 'function') return;
    if (!this._listeners.has(type)) this._listeners.set(type, []);
    this._listeners.get(type).push(handler);
  }

  removeEventListener(type, handler) {
    const list = this._listeners.get(type);
    if (!list) return;
    this._listeners.set(
      type,
      list.filter((h) => h !== handler),
    );
  }

  focus() {
    /* recorded by view.ts focusSummaryPane which checks typeof container.focus === 'function' */
  }

  querySelector(selector) {
    const match = this._matcher(selector);
    return this._findFirst(match);
  }

  querySelectorAll(selector) {
    const match = this._matcher(selector);
    const out = [];
    this._collect(match, out);
    return out;
  }

  _matcher(selector) {
    const trimmed = String(selector).trim();
    if (trimmed.startsWith('.')) {
      const cls = trimmed.slice(1);
      return (el) => el.classList.has(cls);
    }
    const tag = trimmed.toUpperCase();
    return (el) => el.tagName === tag;
  }

  _findFirst(match) {
    for (const child of this.children) {
      if (match(child)) return child;
      const nested = child._findFirst(match);
      if (nested) return nested;
    }
    return null;
  }

  _collect(match, out) {
    for (const child of this.children) {
      if (match(child)) out.push(child);
      child._collect(match, out);
    }
  }

  snapshot() {
    return {
      tag: this.tagName.toLowerCase(),
      classes: [...this.classList].sort(),
      attrs: Object.fromEntries(this.attrs),
      text: this._textContent || undefined,
      children: this.children.map((c) => c.snapshot()),
    };
  }
}

class DataAdapter {
  constructor(vaultRoot) {
    this.vaultRoot = vaultRoot;
  }

  fullPath(filePath) {
    return path.join(this.vaultRoot, filePath);
  }

  async exists(filePath) {
    return existsSync(this.fullPath(filePath));
  }

  async mkdir(filePath) {
    mkdirSync(this.fullPath(filePath), { recursive: true });
  }

  async read(filePath) {
    return readFileSync(this.fullPath(filePath), 'utf8');
  }

  async write(filePath, content) {
    mkdirSync(path.dirname(this.fullPath(filePath)), { recursive: true });
    writeFileSync(this.fullPath(filePath), content);
  }

  async remove(filePath) {
    rmSync(this.fullPath(filePath), { force: true });
  }
}

function makeObsidianStub(record) {
  class Plugin {
    constructor(app, manifest) {
      this.app = app;
      this.manifest = manifest;
    }

    async loadData() {
      return {};
    }

    async saveData(data) {
      record.savedData = data;
    }

    addRibbonIcon(icon, title, callback) {
      record.ribbonIcons.push({ icon, title, callback });
    }

    registerView(type, factory) {
      record.viewFactories.set(type, factory);
      record.views.push({ type });
    }

    addCommand(command) {
      record.commands.push(command);
    }

    addSettingTab(tab) {
      record.settingTabs.push(tab);
    }

    registerEvent(eventRef) {
      record.events.push(eventRef);
    }
  }

  class ItemView {
    constructor(leaf) {
      this.leaf = leaf;
      this.containerEl = new FakeElement('div');
      this.containerEl.appendChild(new FakeElement('div'));
      this.containerEl.appendChild(new FakeElement('div'));
    }
  }

  class PluginSettingTab {
    constructor(app, plugin) {
      this.app = app;
      this.plugin = plugin;
      this.containerEl = new FakeElement('div');
    }
  }

  class Setting {}
  class Notice {
    constructor(message) {
      record.notices.push(typeof message === 'string' ? message : '<non-string>');
    }
  }
  class MarkdownView {}
  class TFile {}
  class Menu {}
  class Modal {}

  return {
    Plugin,
    ItemView,
    PluginSettingTab,
    Setting,
    Notice,
    MarkdownView,
    TFile,
    Menu,
    Modal,
    MarkdownRenderer: { render: async () => {} },
    requestUrl: async () => {
      throw new Error('requestUrl is not available in product-shell smoke');
    },
    setIcon: () => {},
  };
}

function makeApp(vaultRoot) {
  const adapter = new DataAdapter(vaultRoot);
  return {
    vault: {
      adapter,
      configDir: '.obsidian',
      on: (name) => ({ scope: 'vault', name }),
      read: async (file) => adapter.read(file.path),
      getMarkdownFiles: () => [],
      getAbstractFileByPath: () => null,
    },
    workspace: {
      on: (name) => ({ scope: 'workspace', name }),
      getActiveViewOfType: () => null,
      getLeavesOfType: () => [],
      getRightLeaf: () => null,
      revealLeaf: async () => {},
      setActiveLeaf: () => {},
      getLeaf: () => null,
    },
  };
}

function installPackage(vaultRoot) {
  const pluginDir = path.join(vaultRoot, '.obsidian/plugins/parallel-reader');
  mkdirSync(pluginDir, { recursive: true });
  mkdirSync(path.join(vaultRoot, 'Reading'), { recursive: true });
  writeFileSync(path.join(vaultRoot, '.obsidian/community-plugins.json'), JSON.stringify(['parallel-reader'], null, 2));
  writeFileSync(path.join(vaultRoot, 'Reading/source.md'), '# Source\n\nThis note exercises plugin package installation.\n');

  const files = ['main.js', 'main.js.map', 'manifest.json', 'styles.css'];
  for (const file of files) {
    const source = path.join(repoRoot, file);
    assert(existsSync(source), `missing build artifact: ${file}`);
    assert(statSync(source).size > 0, `empty build artifact: ${file}`);
    copyFileSync(source, path.join(pluginDir, file));
  }
  return { pluginDir, files };
}

const SAFE_COMMANDS = ['card-prev', 'card-next', 'card-jump', 'clear-all'];
const UNSAFE_COMMANDS = ['run', 'regen', 'open-view', 'export-current', 'copy-current-markdown', 'batch-generate'];

async function exerciseView(record, plugin) {
  const factory = record.viewFactories.get('parallel-reader-view');
  assert(typeof factory === 'function', 'view factory is not a function');

  const leaf = { containerEl: new FakeElement('div') };
  const view = factory(leaf);
  assert(view, 'view factory returned no view');
  assert(typeof view.onOpen === 'function', 'view has no onOpen');

  await view.onOpen();

  const container = view.containerEl.children[1];
  assert(container.hasClass('parallel-reader-container'), 'container missing parallel-reader-container class');
  assert(container.getAttr('tabindex') === '0', 'container missing tabindex');

  const empty = container.querySelector('.parallel-reader-empty');
  assert(empty, 'empty state element not rendered');
  const heading = empty.querySelector('h3');
  assert(heading && heading.textContent, 'empty state heading missing');
  const paragraph = empty.querySelector('p');
  assert(paragraph && paragraph.textContent, 'empty state paragraph missing');
  const code = empty.querySelector('code');
  assert(code && code.textContent, 'empty state code hint missing');

  await view.onClose();

  return {
    container: {
      classes: [...container.classList].sort(),
      tabindex: container.getAttr('tabindex'),
      childCount: container.children.length,
    },
    empty: empty.snapshot(),
  };
}

async function invokeSafeCommands(record, plugin) {
  const byId = new Map(record.commands.map((cmd) => [cmd.id, cmd]));
  const invoked = [];
  for (const id of SAFE_COMMANDS) {
    const cmd = byId.get(id);
    assert(cmd && typeof cmd.callback === 'function', `safe command ${id} missing callback`);
    const startedAt = Date.now();
    let error = null;
    try {
      await cmd.callback();
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
    invoked.push({ id, durationMs: Date.now() - startedAt, error });
  }
  return invoked;
}

function recordUnsafeCommands(record) {
  const byId = new Map(record.commands.map((cmd) => [cmd.id, cmd]));
  return UNSAFE_COMMANDS.map((id) => ({
    id,
    registered: byId.has(id),
    attempted: false,
    reason: 'requires workspace/network mocks beyond product-shell shim',
  }));
}

async function main() {
  const vaultRoot = mkdtempSync(path.join(tmpdir(), 'parallel-reader-e2e-vault-'));
  const record = {
    commands: [],
    events: [],
    notices: [],
    ribbonIcons: [],
    settingTabs: [],
    viewFactories: new Map(),
    views: [],
  };

  try {
    const { pluginDir, files } = installPackage(vaultRoot);
    const manifestPath = path.join(pluginDir, 'manifest.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    assert(manifest.id === 'parallel-reader', `unexpected manifest id: ${manifest.id}`);
    assert(manifest.isDesktopOnly === true, 'manifest must remain desktop-only');

    const originalLoad = Module._load;
    const obsidianStub = makeObsidianStub(record);
    Module._load = function load(request, parent, isMain) {
      if (request === 'obsidian') return obsidianStub;
      return originalLoad.call(this, request, parent, isMain);
    };

    let viewRender = null;
    let commandsInvoked = null;
    let commandsAttempted = null;

    try {
      const pluginModule = require(path.join(pluginDir, 'main.js'));
      const PluginClass = pluginModule.default || pluginModule;
      const plugin = new PluginClass(makeApp(vaultRoot), manifest);
      await plugin.onload();
      assert(record.views.some((view) => view.type === 'parallel-reader-view'), 'parallel-reader view was not registered');
      const commandIds = new Set(record.commands.map((command) => command.id));
      for (const id of ['run', 'regen', 'open-view', 'export-current', 'copy-current-markdown', 'batch-generate']) {
        assert(commandIds.has(id), `missing command registration: ${id}`);
      }
      assert(record.settingTabs.length === 1, 'settings tab was not registered');

      viewRender = await exerciseView(record, plugin);
      commandsInvoked = await invokeSafeCommands(record, plugin);
      commandsAttempted = recordUnsafeCommands(record);

      const failedSafe = commandsInvoked.filter((c) => c.error);
      assert(failedSafe.length === 0, `safe commands raised: ${failedSafe.map((c) => `${c.id}=${c.error}`).join('; ')}`);

      await plugin.onunload();
    } finally {
      Module._load = originalLoad;
    }

    writeResult({
      name: 'packaged plugin boot and disposable vault install smoke',
      category: 'e2e',
      status: 'passed',
      durationMs: Date.now() - startedAt,
      checks: {
        manifest: { id: manifest.id, version: manifest.version, desktopOnly: manifest.isDesktopOnly },
        installedFiles: files.map((file) => ({
          file,
          sha256: sha256(path.join(pluginDir, file)),
        })),
        registeredCommands: record.commands.map((command) => command.id).sort(),
        registeredViews: record.views.map((view) => view.type).sort(),
        registeredEventCount: record.events.length,
      },
      viewRender,
      commandsInvoked,
      commandsAttempted,
      noticeCount: record.notices.length,
    });
  } catch (error) {
    writeResult({
      name: 'packaged plugin boot and disposable vault install smoke',
      category: 'e2e',
      status: 'failed',
      durationMs: Date.now() - startedAt,
      error: error instanceof Error ? error.stack || error.message : String(error),
    });
    throw error;
  } finally {
    rmSync(vaultRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
