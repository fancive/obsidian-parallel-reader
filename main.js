'use strict';

const { Plugin, ItemView, PluginSettingTab, Setting, Notice, MarkdownView, TFile, Menu, MarkdownRenderer, requestUrl } = require('obsidian');
const { spawn } = require('child_process');
const os = require('os');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

function hashContent(text) {
  return crypto.createHash('sha1').update(text, 'utf8').digest('hex');
}

const VIEW_TYPE_PARALLEL = 'parallel-reader-view';

const DEFAULT_SETTINGS = {
  backend: 'claude-code', // 'claude-code' | 'codex' | 'anthropic-api'
  cliPath: '',             // optional override; empty = auto-discover
  apiKey: '',              // only used when backend === 'anthropic-api'
  model: 'claude-sonnet-4-6',
  exportFolder: 'Reading/Articles',
  cliTimeoutMs: 120000,
};

/* ---------- Document preparation & anchor resolution ---------- */

const MAX_DOC_CHARS = 20000;

function buildPrompts(content, settings) {
  const doc = content.length > MAX_DOC_CHARS
    ? content.slice(0, MAX_DOC_CHARS) + '\n\n[文档过长，已截断]'
    : content;

  const system = `你是一个长文阅读摘要助手。阅读全文后，把文章切成 5-15 个"自然主题单元"——不必对应 markdown heading，以"一个完整论点或话题"为单位自行判断粒度：短章节合并、长章节拆分。

**每张卡片的结构：一句话领读 + 若干条 bullet。bullet 承载细节，gist 是一句话导读。**

对每个单元输出：

- title: 3-10 字的短标题（中文），要能独立说明这段讲什么，避免"背景""介绍"这类空泛词
- anchor: 该单元开头的**逐字引用**，从原文 1:1 复制 40-80 字，保留原始标点/空格/换行；仅供插件内部定位，用户不可见
- gist: **一句话领读**（20-40 字），点出该单元的核心立场或结论，作为 bullets 的导读
- bullets: **3-6 条**支撑 bullet，每条 20-50 字。承载数据、对比、机制、例子、反直觉观察。gist 是立场，bullets 是具体内容，两者不允许重复。

规则：
- anchor 必须能在原文里 exact substring match 找到。绝对不要改动、总结、翻译，必须原样复制
- anchor 选用该单元最靠前且足够独特的一段（避免通用套话如"综上所述"）
- 每张卡都必须同时有 gist 和 bullets——不要只有 gist，也不要只有 bullets
- bullet 每条是一个完整独立的断言，不要用"首先""其次"这种顺序词
- 严格只输出 JSON，无 markdown fence、无解释、无 tool call

输出格式：
{"cards":[{"title":"...","anchor":"...","gist":"一句领读","bullets":["...","..."]}]}

示例：
{"cards":[
  {"title":"U 型收益曲线","anchor":"那谁又会被 AI 所受益？整体来看，它把整个分数变成了一分到七分","gist":"AI 生产力收益呈 U 型，两端受益最大、中间层塌陷","bullets":["最高薪岗位（软件管理）通过加速既有工作受益最大","最低薪岗位（外卖员、园艺工）用 AI 开副业创造新收入","中间层科学家、律师收益最少，部分因对 prompt 精度信任不足","全体均分 5.1/7，42% 报告收益模糊"]}
]}`;

  const user = `以下是需要处理的文档全文：\n\n${doc}`;
  return { system, user };
}

function findLineForAnchor(content, anchor) {
  if (!anchor) return -1;
  const normalize = s => s.replace(/\s+/g, ' ').trim();
  const tryAt = needle => {
    if (!needle) return -1;
    const idx = content.indexOf(needle);
    if (idx === -1) return -1;
    let line = 0;
    for (let i = 0; i < idx; i++) if (content[i] === '\n') line++;
    return line;
  };

  let line = tryAt(anchor);
  if (line >= 0) return line;

  // Fallback 1: trim trailing whitespace variants
  line = tryAt(anchor.trim());
  if (line >= 0) return line;

  // Fallback 2: progressively shorter prefix (LLM may paraphrase the tail)
  for (const len of [60, 40, 25, 15]) {
    const prefix = anchor.trim().slice(0, len);
    line = tryAt(prefix);
    if (line >= 0) return line;
  }

  // Fallback 3: whitespace-normalized search (costlier, rarely needed)
  const normDoc = normalize(content);
  const normAnchor = normalize(anchor).slice(0, 30);
  const normIdx = normDoc.indexOf(normAnchor);
  if (normIdx === -1) return -1;
  // Walk original content tracking normalized offset
  let normSeen = 0;
  let prevWs = true;
  for (let i = 0; i < content.length; i++) {
    const c = content[i];
    const isWs = /\s/.test(c);
    if (isWs) {
      if (!prevWs) normSeen++;
      prevWs = true;
    } else {
      if (normSeen === normIdx) {
        let l = 0;
        for (let j = 0; j < i; j++) if (content[j] === '\n') l++;
        return l;
      }
      normSeen++;
      prevWs = false;
    }
  }
  return -1;
}

/* ---------- LLM call ---------- */

function extractJson(text) {
  const raw = (text || '').trim();
  // 1. Pure JSON already?
  if (raw.startsWith('{')) return raw;
  // 2. Inside a ```json fence
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) return fence[1].trim();
  // 3. Find all balanced {...} candidates and pick the longest one that parses.
  const candidates = [];
  const stack = [];
  let start = -1;
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (c === '{') {
      if (stack.length === 0) start = i;
      stack.push('{');
    } else if (c === '}') {
      if (stack.length > 0) stack.pop();
      if (stack.length === 0 && start >= 0) {
        candidates.push(raw.slice(start, i + 1));
        start = -1;
      }
    }
  }
  // Try candidates longest-first (the "sections" envelope is usually the biggest)
  candidates.sort((a, b) => b.length - a.length);
  for (const c of candidates) {
    try { JSON.parse(c); return c; } catch (_) { /* skip */ }
  }
  return raw; // let caller's JSON.parse throw the real error
}

function parseCardsJson(text) {
  const jsonText = extractJson(text);
  let parsed;
  try {
    parsed = JSON.parse(jsonText);
  } catch (e) {
    throw new Error('LLM 返回非 JSON：\n' + (text || '').slice(0, 500));
  }
  const raw = Array.isArray(parsed.cards) ? parsed.cards : [];
  return raw
    .filter(c => c && typeof c === 'object')
    .map(c => ({
      title: typeof c.title === 'string' ? c.title : '(无标题)',
      anchor: typeof c.anchor === 'string' ? c.anchor : '',
      gist: typeof c.gist === 'string' ? c.gist : '',
      bullets: Array.isArray(c.bullets) ? c.bullets.filter(b => typeof b === 'string') : [],
    }));
}

/* CLI discovery: Obsidian launched from GUI doesn't inherit shell PATH */
function resolveCliPath(name, override) {
  if (override && override.trim()) return override.trim();
  const home = os.homedir();
  const candidates = [
    path.join(home, 'bin', name),                // user-maintained (take precedence)
    path.join(home, '.local/bin', name),
    path.join(home, '.claude/local', name),
    path.join(home, '.codex/bin', name),
    path.join(home, '.bun/bin', name),
    path.join(home, '.npm-global/bin', name),
    path.join(home, '.cargo/bin', name),
    '/opt/homebrew/bin/' + name,                 // homebrew (apple silicon)
    '/usr/local/bin/' + name,                    // may be stale on mac — last resort
  ];
  for (const p of candidates) {
    try { if (fs.existsSync(p)) return p; } catch (_) {}
  }
  return name; // fall back to PATH lookup
}

function runCli(cmd, args, stdinText, timeoutMs) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(cmd, args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          ...process.env,
          // ensure common install paths are in PATH for sub-spawns
          PATH: [
            process.env.PATH || '',
            '/usr/local/bin',
            '/opt/homebrew/bin',
            path.join(os.homedir(), '.local/bin'),
            path.join(os.homedir(), '.claude/local'),
          ].filter(Boolean).join(':'),
        },
      });
    } catch (e) {
      return reject(new Error(`无法启动 ${cmd}: ${e.message}`));
    }

    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch (_) {}
      reject(new Error(`CLI 超时 (${timeoutMs}ms)`));
    }, timeoutMs);

    child.stdout.on('data', d => { stdout += d.toString('utf8'); });
    child.stderr.on('data', d => { stderr += d.toString('utf8'); });
    child.on('error', e => {
      clearTimeout(timer);
      reject(new Error(`CLI 启动错误: ${e.message}（尝试在设置里填绝对路径）`));
    });
    child.on('close', code => {
      clearTimeout(timer);
      if (code !== 0) {
        return reject(new Error(`CLI 退出码 ${code}\nstderr:\n${stderr.slice(0, 1000)}`));
      }
      resolve({ stdout, stderr });
    });

    if (stdinText) {
      try {
        child.stdin.write(stdinText);
        child.stdin.end();
      } catch (e) {
        // swallow — child may have exited
      }
    } else {
      try { child.stdin.end(); } catch (_) {}
    }
  });
}

async function summarizeViaClaudeCode(system, user, settings) {
  const cmd = resolveCliPath('claude', settings.cliPath);
  // -p = print mode; disallow all tools so it returns plain text only; request JSON output format
  const args = [
    '-p',
    '--output-format', 'json',
    '--append-system-prompt', system,
    '--disallowed-tools', 'Bash,Read,Write,Edit,Glob,Grep,WebFetch,WebSearch,TodoWrite,Task',
  ];
  if (settings.model) {
    args.push('--model', settings.model);
  }
  const { stdout } = await runCli(cmd, args, user, settings.cliTimeoutMs);

  // claude -p --output-format json returns {"type":"result", ..., "result":"..."}
  let envelope;
  try { envelope = JSON.parse(stdout); } catch (e) {
    throw new Error('claude CLI 输出非 JSON envelope：\n' + stdout.slice(0, 500));
  }
  const resultText = envelope.result || envelope.content || '';
  return parseCardsJson(resultText);
}

async function summarizeViaCodex(system, user, settings) {
  const cmd = resolveCliPath('codex', settings.cliPath);
  const combined = `<<SYSTEM>>\n${system}\n<<USER>>\n${user}\n\n直接输出 JSON，不要任何解释。`;
  const args = ['exec', '--skip-git-repo-check', '-'];
  const { stdout } = await runCli(cmd, args, combined, settings.cliTimeoutMs);
  return parseCardsJson(stdout);
}

async function summarizeViaAnthropicApi(system, user, settings) {
  if (!settings.apiKey) {
    throw new Error('Anthropic API key not set. Open Settings → Parallel Reader.');
  }
  const body = {
    model: settings.model,
    max_tokens: 4096,
    system,
    messages: [{ role: 'user', content: user }],
  };

  let resp;
  try {
    resp = await requestUrl({
      url: 'https://api.anthropic.com/v1/messages',
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': settings.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
      throw: false,
    });
  } catch (e) {
    throw new Error('Anthropic 请求失败：' + (e.message || e));
  }

  if (resp.status >= 400) {
    throw new Error(`Anthropic API ${resp.status}: ${(resp.text || '').slice(0, 300)}`);
  }

  const text = (resp.json.content || []).map(c => c.text || '').join('').trim();
  return parseCardsJson(text);
}

async function summarizeDocument(content, settings) {
  const { system, user } = buildPrompts(content, settings);
  let cards;
  switch (settings.backend) {
    case 'codex':
      cards = await summarizeViaCodex(system, user, settings);
      break;
    case 'anthropic-api':
      cards = await summarizeViaAnthropicApi(system, user, settings);
      break;
    case 'claude-code':
    default:
      cards = await summarizeViaClaudeCode(system, user, settings);
      break;
  }
  // Resolve each card's anchor → startLine, then sort by doc order (unanchored to tail)
  const resolved = cards.map(c => ({
    title: c.title,
    level: 2,
    anchor: c.anchor,
    gist: c.gist,
    startLine: findLineForAnchor(content, c.anchor),
    bullets: c.bullets,
  }));
  resolved.sort((a, b) => {
    if (a.startLine < 0 && b.startLine < 0) return 0;
    if (a.startLine < 0) return 1;
    if (b.startLine < 0) return -1;
    return a.startLine - b.startLine;
  });
  return resolved;
}

/* ---------- Card → markdown / plain text ---------- */

function cardToMarkdown(card) {
  const parts = [`## ${card.title}`];
  if (card.anchor) {
    const q = card.anchor.replace(/\s+/g, ' ').trim();
    parts.push(`> ${q}`);
  }
  if (card.gist) parts.push(card.gist);
  if (card.bullets && card.bullets.length > 0) {
    parts.push(card.bullets.map(b => `- ${b}`).join('\n'));
  }
  return parts.join('\n\n');
}

function cardToPlain(card) {
  return [
    card.title,
    card.gist || '',
    ...(card.bullets || []).map(b => '• ' + b),
  ].filter(Boolean).join('\n');
}

async function copyToClipboard(text, successMsg) {
  try {
    await navigator.clipboard.writeText(text);
    new Notice(successMsg);
  } catch (e) {
    new Notice('复制失败：' + (e.message || e));
  }
}

/* ---------- Right-pane view ---------- */

class ParallelReaderView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.sections = []; // [{title, level, anchor, startLine, bullets}]
    this.sourceFile = null;
    this.cards = []; // DOM refs
    this.activeIdx = -1;
  }

  getViewType() { return VIEW_TYPE_PARALLEL; }
  getDisplayText() { return '对照阅读笔记'; }
  getIcon() { return 'book-open'; }

  async onOpen() {
    const container = this.containerEl.children[1];
    container.empty();
    container.addClass('parallel-reader-container');
    this.renderEmpty();
  }

  async onClose() {}

  renderEmpty() {
    const container = this.containerEl.children[1];
    container.empty();
    const hint = container.createDiv({ cls: 'parallel-reader-empty' });
    hint.createEl('h3', { text: '对照阅读笔记' });
    hint.createEl('p', { text: '打开一篇笔记，然后运行命令：' });
    hint.createEl('code', { text: 'Parallel Reader: 为当前笔记生成对照笔记' });
  }

  async loadFor(file, sections, stale) {
    this.sourceFile = file;
    this.sections = sections;
    this.stale = !!stale;
    this.render();
  }

  renderEmptyWithHint(file) {
    const container = this.containerEl.children[1];
    container.empty();
    const hint = container.createDiv({ cls: 'parallel-reader-empty' });
    hint.createEl('h3', { text: file.basename });
    hint.createEl('p', { text: '该笔记尚无对照笔记缓存。运行命令：' });
    hint.createEl('code', { text: 'Parallel Reader: 为当前笔记生成对照笔记' });
  }

  render() {
    const container = this.containerEl.children[1];
    container.empty();

    const header = container.createDiv({ cls: 'parallel-reader-header' });
    header.createEl('div', { text: this.sourceFile?.basename || '', cls: 'parallel-reader-title' });

    if (this.stale) {
      const banner = container.createDiv({ cls: 'parallel-reader-stale-banner' });
      banner.setText('⚠ 源笔记已修改，当前是旧缓存。点击"重新生成"刷新。');
    }

    const list = container.createDiv({ cls: 'parallel-reader-cards' });
    this.cards = [];
    const sourcePath = this.sourceFile?.path || '';
    this.sections.forEach((s, i) => {
      const card = list.createDiv({ cls: 'parallel-reader-card' });
      card.dataset.idx = String(i);
      if (s.startLine < 0) card.addClass('parallel-reader-card-unanchored');

      // --- Title row ---
      const title = card.createEl('div', { cls: 'parallel-reader-card-title' });
      title.createSpan({ text: s.title });
      if (s.startLine < 0) {
        title.createEl('span', { text: ' ⚠', cls: 'parallel-reader-warn', title: 'anchor 匹配失败，无法滚动联动' });
      }

      // --- Gist (rendered as markdown so inline bold/code/links work) ---
      if (s.gist) {
        const gistEl = card.createEl('div', { cls: 'parallel-reader-gist' });
        MarkdownRenderer.render(this.app, s.gist, gistEl, sourcePath, this).catch(() => {
          gistEl.setText(s.gist);
        });
      }

      // --- Bullets (rendered as markdown list — handles tables, bold, etc.) ---
      const bs = s.bullets || [];
      if (bs.length > 0) {
        const bulletsEl = card.createEl('div', { cls: 'parallel-reader-bullets-md' });
        const md = bs.map(b => `- ${b}`).join('\n');
        MarkdownRenderer.render(this.app, md, bulletsEl, sourcePath, this).catch(() => {
          bulletsEl.setText(md);
        });
      } else if (!s.gist) {
        card.createEl('div', { cls: 'parallel-reader-empty-li', text: '（未生成）' });
      }

      // Left click → jump to source line
      card.addEventListener('click', (e) => {
        // Don't hijack when user is selecting text
        const sel = window.getSelection();
        if (sel && sel.toString().length > 0) return;
        // Let clicks on anchor links pass through (e.g. wikilinks inside rendered markdown)
        const target = e.target;
        if (target && target.tagName === 'A') return;
        if (s.startLine >= 0) this.plugin.scrollEditorToLine(s.startLine, this.sourceFile);
      });

      // Right click → context menu with copy actions
      card.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        const menu = new Menu();
        menu.addItem(it => it.setTitle('复制 Markdown').setIcon('copy')
          .onClick(() => copyToClipboard(cardToMarkdown(s), '已复制 Markdown')));
        menu.addItem(it => it.setTitle('复制纯文本').setIcon('clipboard-copy')
          .onClick(() => copyToClipboard(cardToPlain(s), '已复制纯文本')));
        if (s.anchor) {
          menu.addItem(it => it.setTitle('复制 anchor 引用').setIcon('quote-glyph')
            .onClick(() => copyToClipboard(s.anchor, '已复制引用原文')));
        }
        menu.addSeparator();
        if (s.startLine >= 0) {
          menu.addItem(it => it.setTitle('跳转到原文').setIcon('arrow-right')
            .onClick(() => this.plugin.scrollEditorToLine(s.startLine, this.sourceFile)));
        }
        menu.showAtMouseEvent(e);
      });

      this.cards.push(card);
    });
  }

  setActiveSection(idx) {
    if (idx === this.activeIdx) return;
    if (this.activeIdx >= 0 && this.cards[this.activeIdx]) {
      this.cards[this.activeIdx].removeClass('is-active');
    }
    this.activeIdx = idx;
    if (idx >= 0 && this.cards[idx]) {
      this.cards[idx].addClass('is-active');
      this.cards[idx].scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  }

  async exportToVault() {
    if (!this.sourceFile) return;
    const folder = this.plugin.settings.exportFolder.replace(/\/$/, '');
    const name = `${this.sourceFile.basename} - 对照笔记.md`;
    const targetPath = `${folder}/${name}`;

    const lines = [];
    lines.push(`---`);
    lines.push(`source: [[${this.sourceFile.basename}]]`);
    lines.push(`generated: ${new Date().toISOString().slice(0, 10)}`);
    lines.push(`tool: parallel-reader`);
    lines.push(`---`);
    lines.push('');
    lines.push(`# ${this.sourceFile.basename} · 对照笔记`);
    lines.push('');
    this.sections.forEach(s => {
      lines.push(`## ${s.title}`);
      if (s.anchor) {
        const q = s.anchor.replace(/\s+/g, ' ').trim();
        lines.push(`> ${q.length > 120 ? q.slice(0, 120) + '…' : q}`);
      }
      if (s.gist) {
        lines.push('');
        lines.push(s.gist);
      }
      const bs = s.bullets || [];
      if (bs.length > 0) {
        lines.push('');
        bs.forEach(b => lines.push(`- ${b}`));
      }
      lines.push('');
    });

    const app = this.plugin.app;
    // Ensure folder exists
    const folderTF = app.vault.getAbstractFileByPath(folder);
    if (!folderTF) {
      try { await app.vault.createFolder(folder); } catch (e) { /* exists race */ }
    }

    const existing = app.vault.getAbstractFileByPath(targetPath);
    if (existing instanceof TFile) {
      await app.vault.modify(existing, lines.join('\n'));
    } else {
      await app.vault.create(targetPath, lines.join('\n'));
    }
    new Notice(`已导出 → ${targetPath}`);
  }
}

/* ---------- Plugin ---------- */

class ParallelReaderPlugin extends Plugin {
  async onload() {
    await this.loadSettings();

    this.registerView(VIEW_TYPE_PARALLEL, (leaf) => new ParallelReaderView(leaf, this));

    this.addCommand({
      id: 'parallel-reader-run',
      name: '为当前笔记生成对照笔记（缓存优先）',
      callback: () => this.runForActiveFile(false),
    });

    this.addCommand({
      id: 'parallel-reader-regen',
      name: '强制重新生成（绕过缓存）',
      callback: () => this.runForActiveFile(true),
    });

    this.addCommand({
      id: 'parallel-reader-open-view',
      name: '打开对照笔记面板',
      callback: async () => {
        await this.ensureView();
        const active = this.getActiveView();
        if (active?.file) this.syncViewToFile(active.file);
      },
    });

    this.addCommand({
      id: 'parallel-reader-clear-current',
      name: '清除当前笔记的缓存',
      callback: async () => {
        const active = this.getActiveView();
        if (!active?.file) return new Notice('没有当前笔记');
        await this.cacheDelete(active.file.path);
        new Notice('已清除缓存：' + active.file.basename);
      },
    });

    this.addCommand({
      id: 'parallel-reader-clear-all',
      name: '清除所有缓存',
      callback: async () => {
        const n = Object.keys(this.cache).length;
        await this.cacheClear();
        new Notice(`已清除 ${n} 条缓存`);
      },
    });

    this.addSettingTab(new ParallelReaderSettingTab(this.app, this));

    this.registerEvent(
      this.app.workspace.on('active-leaf-change', () => this.bindScrollSync())
    );
    this.registerEvent(
      this.app.workspace.on('file-open', (file) => {
        if (file) this.syncViewToFile(file);
      })
    );
    this.bindScrollSync();
  }

  onunload() {
    this.app.workspace.detachLeavesOfType(VIEW_TYPE_PARALLEL);
  }

  async loadSettings() {
    const data = (await this.loadData()) || {};
    // Backward compat: old plugin versions stored settings flat at root
    const settingsBlob = data.settings || data;
    this.settings = Object.assign({}, DEFAULT_SETTINGS, settingsBlob);
    // Strip cache key out of the flat structure if it accidentally leaked
    delete this.settings.cache;
    this.cache = (data.cache && typeof data.cache === 'object') ? data.cache : {};
  }

  async saveSettings() {
    await this.saveData({ settings: this.settings, cache: this.cache });
  }

  async saveCache() {
    await this.saveData({ settings: this.settings, cache: this.cache });
  }

  cacheGet(filePath) {
    return this.cache[filePath] || null;
  }

  async cachePut(filePath, content, cards) {
    this.cache[filePath] = {
      contentHash: hashContent(content),
      cards,
      generatedAt: new Date().toISOString(),
    };
    await this.saveCache();
  }

  async cacheDelete(filePath) {
    if (this.cache[filePath]) {
      delete this.cache[filePath];
      await this.saveCache();
    }
  }

  async cacheClear() {
    this.cache = {};
    await this.saveCache();
  }

  async ensureView() {
    const { workspace } = this.app;
    let leaf = workspace.getLeavesOfType(VIEW_TYPE_PARALLEL)[0];
    if (!leaf) {
      leaf = workspace.getRightLeaf(false);
      await leaf.setViewState({ type: VIEW_TYPE_PARALLEL, active: true });
    }
    workspace.revealLeaf(leaf);
    return leaf.view;
  }

  getActiveView() {
    return this.app.workspace.getActiveViewOfType(MarkdownView);
  }

  async runForActiveFile(force) {
    const mdView = this.getActiveView();
    if (!mdView || !mdView.file) {
      new Notice('先打开一篇笔记');
      return;
    }
    const file = mdView.file;
    const content = await this.app.vault.read(file);
    if (!content.trim()) {
      new Notice('笔记为空');
      return;
    }

    const view = await this.ensureView();

    // Try cache unless user explicitly forced regeneration
    if (!force) {
      const entry = this.cacheGet(file.path);
      if (entry && entry.contentHash === hashContent(content)) {
        await view.loadFor(file, this.resolveCardAnchors(content, entry.cards), false);
        return;
      }
    }

    await view.loadFor(file, [], false);
    new Notice(`对照阅读：让 LLM 读全文并自适应切段…`);

    try {
      const sections = await summarizeDocument(content, this.settings);
      if (sections.length === 0) {
        new Notice('LLM 未返回任何 card');
        return;
      }
      // Persist raw cards (without computed startLine — re-resolve on load, in case source was renamed/edited)
      const rawCards = sections.map(s => ({
        title: s.title,
        anchor: s.anchor,
        gist: s.gist,
        bullets: s.bullets,
      }));
      await this.cachePut(file.path, content, rawCards);

      await view.loadFor(file, sections, false);
      const unanchored = sections.filter(s => s.startLine < 0).length;
      new Notice(`对照笔记生成完成：${sections.length} 段${unanchored ? `（⚠ ${unanchored} 段 anchor 未匹配）` : ''}`);
    } catch (e) {
      console.error(e);
      new Notice('生成失败：' + e.message);
    }
  }

  // Rehydrate cached cards: compute startLine from anchor against current content
  resolveCardAnchors(content, rawCards) {
    const resolved = (rawCards || []).map(c => ({
      title: c.title,
      level: 2,
      anchor: c.anchor,
      gist: c.gist,
      startLine: findLineForAnchor(content, c.anchor),
      bullets: c.bullets || [],
    }));
    resolved.sort((a, b) => {
      if (a.startLine < 0 && b.startLine < 0) return 0;
      if (a.startLine < 0) return 1;
      if (b.startLine < 0) return -1;
      return a.startLine - b.startLine;
    });
    return resolved;
  }

  async syncViewToFile(file) {
    if (!file || !file.path || !file.path.endsWith('.md')) return;
    const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_PARALLEL);
    if (leaves.length === 0) return; // view not open, nothing to sync
    const view = leaves[0].view;
    if (!view) return;

    const entry = this.cacheGet(file.path);
    if (!entry) {
      // No cache for this file → clear panel
      await view.loadFor(file, [], false);
      view.renderEmptyWithHint(file);
      return;
    }

    const content = await this.app.vault.read(file);
    const stale = entry.contentHash !== hashContent(content);
    const resolved = this.resolveCardAnchors(content, entry.cards);
    await view.loadFor(file, resolved, stale);
  }

  bindScrollSync() {
    // Remove previous listener reference
    if (this._scrollDispose) {
      this._scrollDispose();
      this._scrollDispose = null;
    }

    const mdView = this.getActiveView();
    if (!mdView) return;

    // Prefer CM6 scrollDOM when available
    const editor = mdView.editor;
    const cm = editor && editor.cm;
    const scrollDom = cm && cm.scrollDOM ? cm.scrollDOM : mdView.contentEl.querySelector('.cm-scroller');
    if (!scrollDom) return;

    const handler = () => this.handleEditorScroll(mdView);
    scrollDom.addEventListener('scroll', handler, { passive: true });
    this._scrollDispose = () => scrollDom.removeEventListener('scroll', handler);
  }

  handleEditorScroll(mdView) {
    const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_PARALLEL);
    if (leaves.length === 0) return;
    const view = leaves[0].view;
    if (!view || !mdView.file || view.sourceFile?.path !== mdView.file.path) return;

    const editor = mdView.editor;
    if (!editor || !editor.cm) return;
    const cm = editor.cm;
    const scrollDom = cm.scrollDOM;
    if (!scrollDom) return;

    // Find visible top line
    const rect = scrollDom.getBoundingClientRect();
    const topY = rect.top + 80; // offset to pick line just under the header
    let topLine = 0;
    try {
      const pos = cm.posAtCoords({ x: rect.left + 20, y: topY });
      if (pos != null) {
        topLine = cm.state.doc.lineAt(pos).number - 1; // 0-indexed
      }
    } catch (e) {
      return;
    }

    // Find the closest anchored section whose startLine <= topLine
    let activeIdx = -1;
    for (let i = 0; i < view.sections.length; i++) {
      const s = view.sections[i];
      if (s.startLine < 0) continue;
      if (s.startLine <= topLine) activeIdx = i;
      else break;
    }
    view.setActiveSection(activeIdx);
  }

  findLeafForFile(file) {
    if (!file) return null;
    const leaves = this.app.workspace.getLeavesOfType('markdown');
    for (const leaf of leaves) {
      const v = leaf.view;
      if (v && v.file && v.file.path === file.path) return leaf;
    }
    return null;
  }

  async scrollEditorToLine(line, file) {
    let leaf = file ? this.findLeafForFile(file) : null;

    // Fallback: file not open anywhere → open it in a new tab in the main area
    if (!leaf && file) {
      leaf = this.app.workspace.getLeaf('tab');
      await leaf.openFile(file, { active: false });
    }

    // Last resort: currently active markdown view
    if (!leaf) {
      const active = this.getActiveView();
      if (active) leaf = active.leaf;
    }
    if (!leaf) {
      new Notice('找不到源笔记对应的编辑器窗口');
      return;
    }

    this.app.workspace.setActiveLeaf(leaf, { focus: true });
    const mdView = leaf.view;
    if (!(mdView instanceof MarkdownView)) return;

    // Use ephemeral state — works in both source/live-preview AND reading mode.
    mdView.setEphemeralState({ line });

    // Belt-and-suspenders: also scroll the editor if in source/live-preview mode.
    if (mdView.editor) {
      try {
        mdView.editor.setCursor({ line, ch: 0 });
        mdView.editor.scrollIntoView({ from: { line, ch: 0 }, to: { line, ch: 0 } }, true);
      } catch (_) { /* ignore */ }
    }
  }
}

/* ---------- Settings tab ---------- */

class ParallelReaderSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl('h2', { text: 'Parallel Reader 设置' });

    new Setting(containerEl)
      .setName('Backend')
      .setDesc('生成 bullet 的后端：Claude Code / Codex CLI 复用你的订阅；Anthropic API 直连需要 key')
      .addDropdown(d => d
        .addOption('claude-code', 'Claude Code CLI')
        .addOption('codex', 'Codex CLI')
        .addOption('anthropic-api', 'Anthropic API (直连)')
        .setValue(this.plugin.settings.backend)
        .onChange(async v => {
          this.plugin.settings.backend = v;
          await this.plugin.saveSettings();
          this.display();
        }));

    new Setting(containerEl)
      .setName('CLI 路径（可选）')
      .setDesc('留空则自动探测常见位置；Obsidian GUI 启动时不继承 shell PATH，建议在终端 `readlink -f $(which claude)` 取真实路径填入。Claude Code 是 Mach-O 可直接跑；Codex 是 node 脚本，需 node 在 PATH')
      .addText(t => t
        .setPlaceholder('例：/Users/you/.local/share/fnm/.../bin/claude.exe')
        .setValue(this.plugin.settings.cliPath)
        .onChange(async v => {
          this.plugin.settings.cliPath = v.trim();
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('测试 CLI 连通')
      .setDesc('调用 `<cli> --version` 验证 spawn 能找到二进制')
      .addButton(b => b
        .setButtonText('Test')
        .onClick(async () => {
          const backend = this.plugin.settings.backend;
          const name = backend === 'codex' ? 'codex' : 'claude';
          const cmd = resolveCliPath(name, this.plugin.settings.cliPath);
          try {
            const { stdout } = await runCli(cmd, ['--version'], '', 10000);
            new Notice(`✓ ${name} @ ${cmd}\n${stdout.trim().slice(0, 100)}`, 8000);
          } catch (e) {
            new Notice(`✗ ${name} 调用失败：${e.message}`, 10000);
          }
        }));

    if (this.plugin.settings.backend === 'anthropic-api') {
      new Setting(containerEl)
        .setName('Anthropic API Key')
        .setDesc('从 https://console.anthropic.com/ 获取')
        .addText(t => t
          .setPlaceholder('sk-ant-...')
          .setValue(this.plugin.settings.apiKey)
          .onChange(async v => {
            this.plugin.settings.apiKey = v.trim();
            await this.plugin.saveSettings();
          }));
    }

    new Setting(containerEl)
      .setName('Model')
      .setDesc('Claude Code 下会传 --model；Codex 下通常忽略（用 Codex 默认配置）；API 下决定调用模型。推荐 claude-sonnet-4-6 或 claude-haiku-4-5-20251001')
      .addText(t => t
        .setValue(this.plugin.settings.model)
        .onChange(async v => {
          this.plugin.settings.model = v.trim() || DEFAULT_SETTINGS.model;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('CLI 超时 (ms)')
      .addText(t => t
        .setValue(String(this.plugin.settings.cliTimeoutMs))
        .onChange(async v => {
          const n = parseInt(v, 10);
          if (!isNaN(n) && n > 0) {
            this.plugin.settings.cliTimeoutMs = n;
            await this.plugin.saveSettings();
          }
        }));

    new Setting(containerEl)
      .setName('导出文件夹')
      .setDesc('对照笔记生成位置（相对 Vault 根）')
      .addText(t => t
        .setValue(this.plugin.settings.exportFolder)
        .onChange(async v => {
          this.plugin.settings.exportFolder = v.trim() || DEFAULT_SETTINGS.exportFolder;
          await this.plugin.saveSettings();
        }));

    containerEl.createEl('h3', { text: '缓存' });

    const cacheCount = Object.keys(this.plugin.cache).length;
    new Setting(containerEl)
      .setName(`已缓存笔记：${cacheCount} 篇`)
      .setDesc('缓存以源笔记 SHA1 哈希作为失效键，源笔记修改后下次打开会显示 stale 提示')
      .addButton(b => b
        .setButtonText('清除所有缓存')
        .setWarning()
        .onClick(async () => {
          const n = Object.keys(this.plugin.cache).length;
          await this.plugin.cacheClear();
          new Notice(`已清除 ${n} 条缓存`);
          this.display();
        }));
  }
}

module.exports = ParallelReaderPlugin;
