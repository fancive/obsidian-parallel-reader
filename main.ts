'use strict';
import { Plugin, ItemView, PluginSettingTab, Setting, Notice, MarkdownView, TFile, Menu, MarkdownRenderer, requestUrl, setIcon } from 'obsidian';
import { spawn } from 'child_process';
import os from 'os';
import path from 'path';
import fs from 'fs';
import { cardToMarkdown, cardToPlain, cardsToMarkdown } from './src/markdown';
import {
  extractJson,
  normalizeCardsPayload,
  parseCardsJson,
} from './src/schema';
import {
  buildAnthropicMessagesBody,
  buildGeminiBody,
  buildOpenAiChatBody,
  buildOpenAiResponsesBody,
  summarizeViaApi,
  testApiBackend,
  tokenLimitFieldForOpenAiChat,
} from './src/providers';
import {
  GenerationJobAlreadyRunningError,
  GenerationJobCancelledError,
  GenerationJobManager,
  classifyGenerationError,
} from './src/generation-job-manager';
import {
  API_AUTH_TYPES,
  API_FORMATS,
  API_PROVIDER_PRESETS,
  CACHE_SCHEMA_VERSION,
  DEFAULT_SETTINGS,
  DEFAULT_MAX_CACHE_ENTRIES,
  MAX_DOC_CHARS,
  PROMPT_LANGUAGES,
  applyApiProviderPreset,
  cacheEntryMatches,
  generationFingerprint,
  getApiFormat,
  getApiPreset,
  hashContent,
  isApiBackend,
  normalizeSettings,
  pruneCacheEntries,
} from './src/settings';

const VIEW_TYPE_PARALLEL = 'parallel-reader-view';

/* ---------- Document preparation & anchor resolution ---------- */

function promptLanguageInstruction(language) {
  if (language === 'en') return 'Write title, gist, and bullets in English.';
  if (language === 'auto') return 'Write title, gist, and bullets in the main language of the source document.';
  return '用中文输出 title、gist 和 bullets。';
}

function promptSchemaExample(language) {
  if (language === 'en') {
    return `{"cards":[
  {"title":"U-shaped gains","anchor":"Who benefits from AI? Overall, it shifts the score from one to seven","gist":"AI productivity gains form a U shape, with both ends benefiting most","bullets":["Top-paid software managers benefit by accelerating existing work","Low-paid workers use AI to create new side income","Middle-layer specialists gain less because prompt precision is hard to trust","Average reported benefit is 5.1/7, with 42% describing gains as unclear"]}
]}`;
  }
  return `{"cards":[
  {"title":"U 型收益曲线","anchor":"那谁又会被 AI 所受益？整体来看，它把整个分数变成了一分到七分","gist":"AI 生产力收益呈 U 型，两端受益最大、中间层塌陷","bullets":["最高薪岗位（软件管理）通过加速既有工作受益最大","最低薪岗位（外卖员、园艺工）用 AI 开副业创造新收入","中间层科学家、律师收益最少，部分因对 prompt 精度信任不足","全体均分 5.1/7，42% 报告收益模糊"]}
]}`;
}

function renderPromptTemplate(template, vars) {
  return String(template || '').replace(/\{([a-zA-Z0-9_]+)\}/g, (match, key) => {
    return Object.prototype.hasOwnProperty.call(vars, key) ? String(vars[key]) : match;
  });
}

function buildPrompts(content, settings) {
  const maxDocChars = Number(settings.maxDocChars) || MAX_DOC_CHARS;
  const promptLanguage = PROMPT_LANGUAGES[settings.promptLanguage] ? settings.promptLanguage : DEFAULT_SETTINGS.promptLanguage;
  const minCards = Math.max(1, Number(settings.minCards) || DEFAULT_SETTINGS.minCards);
  const maxCards = Math.max(minCards, Number(settings.maxCards) || DEFAULT_SETTINGS.maxCards);
  const languageInstruction = promptLanguageInstruction(promptLanguage);
  const doc = content.length > maxDocChars
    ? content.slice(0, maxDocChars) + (promptLanguage === 'en' ? '\n\n[Document truncated]' : '\n\n[文档过长，已截断]')
    : content;

  const schema = '{"cards":[{"title":"...","anchor":"...","gist":"...","bullets":["...","..."]}]}';
  const example = promptSchemaExample(promptLanguage);
  const templateVars = { minCards, maxCards, languageInstruction, schema, example };
  const customSystem = renderPromptTemplate(settings.customSystemPrompt, templateVars).trim();

  const defaultSystem = `你是一个长文阅读摘要助手。阅读全文后，把文章切成 ${minCards}-${maxCards} 个"自然主题单元"——不必对应 markdown heading，以"一个完整论点或话题"为单位自行判断粒度：短章节合并、长章节拆分。

**每张卡片的结构：一句话领读 + 若干条 bullet。bullet 承载细节，gist 是一句话导读。**

语言：
- ${languageInstruction}

对每个单元输出：

- title: 3-10 字的短标题，要能独立说明这段讲什么，避免"背景""介绍"这类空泛词
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
${schema}

示例：
${example}`;

  const system = customSystem
    ? `${customSystem}

不可覆盖的输出契约：
- 必须输出 ${minCards}-${maxCards} 张 cards。
- ${languageInstruction}
- anchor 必须从原文逐字复制，必须能在原文 exact substring match 找到。
- 严格只输出 JSON，无 markdown fence、无解释、无 tool call。
- JSON shape: ${schema}`
    : defaultSystem;

  const user = promptLanguage === 'en'
    ? `Source document:\n\n${doc}`
    : `以下是需要处理的文档全文：\n\n${doc}`;
  return { system, user };
}

function findLineForAnchor(content, anchor) {
  if (!anchor) return -1;
  const normalize = s => s.replace(/\s+/g, ' ').trim();
  const normalizeWithMap = s => {
    const chars = [];
    const map = [];
    let pendingWhitespace = false;
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (/\s/.test(c)) {
        pendingWhitespace = chars.length > 0;
        continue;
      }
      if (pendingWhitespace) {
        chars.push(' ');
        map.push(i);
        pendingWhitespace = false;
      }
      chars.push(c);
      map.push(i);
    }
    return { text: chars.join(''), map };
  };
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
  const normDoc = normalizeWithMap(content);
  const normAnchor = normalize(anchor).slice(0, 30);
  if (!normAnchor) return -1;
  const normIdx = normDoc.text.indexOf(normAnchor);
  if (normIdx === -1) return -1;
  const originalIdx = normDoc.map[normIdx];
  if (originalIdx == null) return -1;
  let l = 0;
  for (let j = 0; j < originalIdx; j++) if (content[j] === '\n') l++;
  return l;
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

function runCli(cmd, args, stdinText, timeoutMs, job?) {
  return new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    let child;
    let settled = false;
    let timer;
    const fail = err => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      reject(err);
    };
    const succeed = value => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(value);
    };
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
    timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch (_) {}
      fail(new Error(`CLI 超时 (${timeoutMs}ms)`));
    }, timeoutMs);
    if (job) {
      job.onCancel(() => {
        try { child.kill('SIGKILL'); } catch (_) {}
        fail(new GenerationJobCancelledError(job.key));
      });
    }

    child.stdout.on('data', d => { stdout += d.toString('utf8'); });
    child.stderr.on('data', d => { stderr += d.toString('utf8'); });
    child.on('error', e => {
      fail(new Error(`CLI 启动错误: ${e.message}（尝试在设置里填绝对路径）`));
    });
    child.on('close', code => {
      if (settled) return;
      if (code !== 0) {
        return fail(new Error(`CLI 退出码 ${code}\nstderr:\n${stderr.slice(0, 1000)}`));
      }
      succeed({ stdout, stderr });
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

async function summarizeViaClaudeCode(system, user, settings, job) {
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
  const { stdout } = await runCli(cmd, args, user, settings.cliTimeoutMs, job);

  // claude -p --output-format json returns {"type":"result", ..., "result":"..."}
  let envelope;
  try { envelope = JSON.parse(stdout); } catch (e) {
    throw new Error('claude CLI 输出非 JSON envelope：\n' + stdout.slice(0, 500));
  }
  const resultText = envelope.result || envelope.content || '';
  return parseCardsJson(resultText);
}

async function summarizeViaCodex(system, user, settings, job) {
  const cmd = resolveCliPath('codex', settings.cliPath);
  const combined = `<<SYSTEM>>\n${system}\n<<USER>>\n${user}\n\n直接输出 JSON，不要任何解释。`;
  const args = ['exec', '--skip-git-repo-check', '-'];
  const { stdout } = await runCli(cmd, args, combined, settings.cliTimeoutMs, job);
  return parseCardsJson(stdout);
}

async function testBackend(settings) {
  if (settings.backend === 'codex') {
    const cmd = resolveCliPath('codex', settings.cliPath);
    const { stdout } = await runCli(cmd, ['--version'], '', 10000);
    return `codex @ ${cmd}\n${stdout.trim()}`;
  }
  if (settings.backend === 'claude-code') {
    const cmd = resolveCliPath('claude', settings.cliPath);
    const { stdout } = await runCli(cmd, ['--version'], '', 10000);
    return `claude @ ${cmd}\n${stdout.trim()}`;
  }
  if (isApiBackend(settings.backend)) {
    return testApiBackend(requestUrl, settings);
  }
  throw new Error('未知 backend：' + settings.backend);
}

async function summarizeDocument(content, settings, job) {
  const { system, user } = buildPrompts(content, settings);
  let cards;
  switch (settings.backend) {
    case 'codex':
      cards = await summarizeViaCodex(system, user, settings, job);
      break;
    case 'api':
      cards = await summarizeViaApi(requestUrl, system, user, settings);
      break;
    case 'anthropic-api':
      cards = await summarizeViaApi(requestUrl, system, user, settings);
      break;
    case 'claude-code':
    default:
      cards = await summarizeViaClaudeCode(system, user, settings, job);
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

function addIconButton(parent, icon, title, onClick) {
  const button = parent.createEl('button', {
    cls: 'parallel-reader-icon-button',
    attr: { type: 'button', 'aria-label': title },
  });
  button.title = title;
  if (typeof setIcon === 'function') {
    setIcon(button, icon);
  } else {
    button.textContent = title;
  }
  button.addEventListener('click', async (e) => {
    e.preventDefault();
    e.stopPropagation();
    try {
      await onClick();
    } catch (err) {
      console.error(err);
      new Notice(`${title}失败：` + (err.message || err));
    }
  });
  return button;
}

function addTextButton(parent, icon, label, onClick, cls) {
  const button = parent.createEl('button', {
    cls: cls || 'parallel-reader-text-button',
    attr: { type: 'button' },
  });
  if (icon && typeof setIcon === 'function') setIcon(button, icon);
  button.createSpan({ text: label });
  button.addEventListener('click', async (e) => {
    e.preventDefault();
    e.stopPropagation();
    try {
      await onClick();
    } catch (err) {
      console.error(err);
      new Notice(`${label}失败：` + (err.message || err));
    }
  });
  return button;
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
  plugin: ParallelReaderPlugin;
  sections: any[];
  sourceFile: TFile | null;
  cards: HTMLElement[];
  activeIdx: number;
  stale: boolean;
  loadingMessage: string;
  errorMessage: string;

  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.sections = []; // [{title, level, anchor, startLine, bullets}]
    this.sourceFile = null;
    this.cards = []; // DOM refs
    this.activeIdx = -1;
    this.loadingMessage = '';
    this.errorMessage = '';
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
    this.sourceFile = null;
    this.sections = [];
    this.stale = false;
    this.loadingMessage = '';
    this.errorMessage = '';
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
    this.loadingMessage = '';
    this.errorMessage = '';
    this.render();
  }

  async renderLoading(file, message) {
    this.sourceFile = file;
    this.sections = [];
    this.stale = false;
    this.loadingMessage = message || '正在生成对照笔记...';
    this.errorMessage = '';
    this.render();
  }

  async renderError(file, message) {
    this.sourceFile = file;
    this.sections = [];
    this.stale = false;
    this.loadingMessage = '';
    this.errorMessage = message || '生成失败';
    this.render();
  }

  renderEmptyWithHint(file) {
    this.sourceFile = file;
    this.sections = [];
    this.stale = false;
    this.loadingMessage = '';
    this.errorMessage = '';
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
    const headerRow = header.createDiv({ cls: 'parallel-reader-header-row' });
    headerRow.createEl('div', { text: this.sourceFile?.basename || '', cls: 'parallel-reader-title' });
    const actions = headerRow.createDiv({ cls: 'parallel-reader-actions' });
    if (this.sourceFile) {
      if (this.plugin.isGeneratingFile(this.sourceFile)) {
        addIconButton(actions, 'square', '取消生成', () => this.plugin.cancelGenerationForFile(this.sourceFile));
      } else {
        addIconButton(actions, 'refresh-cw', '重新生成', () => this.plugin.runForFile(this.sourceFile, true));
      }
      addIconButton(actions, 'copy', '复制全部 Markdown', () => this.plugin.copyCurrentViewMarkdown());
      addIconButton(actions, 'download', '导出到 Vault', () => this.exportToVault());
    }

    if (this.stale) {
      const banner = container.createDiv({ cls: 'parallel-reader-stale-banner' });
      banner.createSpan({ text: '源笔记或生成配置已修改，当前是旧缓存。' });
      addTextButton(
        banner,
        'refresh-cw',
        '重新生成',
        () => this.plugin.runForFile(this.sourceFile, true),
        'parallel-reader-stale-button'
      );
    }

    if (this.loadingMessage) {
      const state = container.createDiv({ cls: 'parallel-reader-state parallel-reader-loading' });
      state.createDiv({ cls: 'parallel-reader-spinner' });
      state.createEl('div', { text: this.loadingMessage, cls: 'parallel-reader-state-title' });
      state.createEl('div', { text: '可以继续阅读原文，生成完成后会自动刷新右侧卡片。', cls: 'parallel-reader-state-subtitle' });
      return;
    }

    if (this.errorMessage) {
      const state = container.createDiv({ cls: 'parallel-reader-state parallel-reader-error' });
      state.createEl('div', { text: '生成失败', cls: 'parallel-reader-state-title' });
      state.createEl('div', { text: this.errorMessage, cls: 'parallel-reader-state-subtitle' });
      addTextButton(
        state,
        'refresh-cw',
        '重新生成',
        () => this.plugin.runForFile(this.sourceFile, true),
        'parallel-reader-text-button'
      );
      return;
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
        const target = e.target as HTMLElement | null;
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

    const markdown = [
      '---',
      `source: [[${this.sourceFile.basename}]]`,
      `generated: ${new Date().toISOString().slice(0, 10)}`,
      'tool: parallel-reader',
      '---',
      '',
      cardsToMarkdown(`${this.sourceFile.basename} · 对照笔记`, this.sections),
      '',
    ].join('\n');

    const app = this.plugin.app;
    // Ensure folder exists
    const folderTF = app.vault.getAbstractFileByPath(folder);
    if (!folderTF) {
      try { await app.vault.createFolder(folder); } catch (e) { /* exists race */ }
    }

    const existing = app.vault.getAbstractFileByPath(targetPath);
    if (existing instanceof TFile) {
      await app.vault.modify(existing, markdown);
    } else {
      await app.vault.create(targetPath, markdown);
    }
    new Notice(`已导出 → ${targetPath}`);
  }
}

/* ---------- Plugin ---------- */

class ParallelReaderPlugin extends Plugin {
  settings: any;
  cache: Record<string, any>;
  jobs: GenerationJobManager;
  _scrollDispose: (() => void) | null;
  _settingsSaveTimer: ReturnType<typeof setTimeout> | null;

  async onload() {
    await this.loadSettings();
    this.jobs = new GenerationJobManager();

    this.addRibbonIcon('book-open', '打开对照笔记面板', async () => {
      const active = this.getActiveView();
      await this.ensureView();
      if (active?.file) await this.syncViewToFile(active.file);
    });

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
        const active = this.getActiveView();
        await this.ensureView();
        if (active?.file) this.syncViewToFile(active.file);
      },
    });

    this.addCommand({
      id: 'parallel-reader-export-current',
      name: '导出当前对照笔记到 Vault',
      callback: () => this.exportCurrentView(),
    });

    this.addCommand({
      id: 'parallel-reader-copy-current-markdown',
      name: '复制当前对照笔记 Markdown',
      callback: () => this.copyCurrentViewMarkdown(),
    });

    this.addCommand({
      id: 'parallel-reader-cancel-current',
      name: '取消当前对照笔记生成',
      callback: () => this.cancelActiveGeneration(),
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
    this.registerEvent(
      this.app.workspace.on('file-menu', (menu, file) => this.addFileMenuItems(menu, file))
    );
    this.registerEvent(
      this.app.vault.on('rename', (file, oldPath) => this.handleFileRename(file, oldPath))
    );
    this.registerEvent(
      this.app.vault.on('delete', (file) => this.handleFileDelete(file))
    );
    this.bindScrollSync();
  }

  async onunload() {
    await this.flushSettingsSave();
    this.app.workspace.detachLeavesOfType(VIEW_TYPE_PARALLEL);
  }

  async loadSettings() {
    const data = (await this.loadData()) || {};
    const settingsBlob = data.settings || {};
    this.settings = normalizeSettings(Object.assign({}, DEFAULT_SETTINGS, settingsBlob));
    await this.loadCache();
  }

  async saveSettings() {
    if (this._settingsSaveTimer) {
      clearTimeout(this._settingsSaveTimer);
      this._settingsSaveTimer = null;
    }
    await this.saveData({ settings: this.settings });
  }

  saveSettingsDebounced(delayMs = 400) {
    if (this._settingsSaveTimer) clearTimeout(this._settingsSaveTimer);
    this._settingsSaveTimer = setTimeout(() => {
      this._settingsSaveTimer = null;
      this.saveSettings().catch(e => console.error('[parallel-reader] failed to save settings', e));
    }, delayMs);
  }

  async flushSettingsSave() {
    if (!this._settingsSaveTimer) return;
    clearTimeout(this._settingsSaveTimer);
    this._settingsSaveTimer = null;
    await this.saveSettings();
  }

  async saveCache() {
    this.pruneCache();
    await this.writeCacheFile();
  }

  cacheFilePath() {
    const configDir = this.app.vault.configDir || '.obsidian';
    const pluginId = this.manifest?.id || 'parallel-reader';
    return `${configDir}/plugins/${pluginId}/cache.json`;
  }

  async ensurePluginDataDir() {
    const adapter = this.app.vault.adapter;
    const configDir = this.app.vault.configDir || '.obsidian';
    const pluginId = this.manifest?.id || 'parallel-reader';
    const dir = `${configDir}/plugins/${pluginId}`;
    try {
      if (typeof adapter.exists === 'function' && await adapter.exists(dir)) return;
      await adapter.mkdir(dir);
    } catch (_) {
      // The plugin directory normally already exists; ignore create races.
    }
  }

  async readCacheFile() {
    const adapter = this.app.vault.adapter;
    try {
      const raw = await adapter.read(this.cacheFilePath());
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && parsed.entries && typeof parsed.entries === 'object') {
        return parsed.entries;
      }
    } catch (e) {
      const message = String(e?.message || e || '');
      if (!/not found|does not exist|ENOENT/i.test(message)) {
        console.warn('[parallel-reader] failed to read cache.json', e);
      }
    }
    return {};
  }

  async writeCacheFile() {
    await this.ensurePluginDataDir();
    await this.app.vault.adapter.write(
      this.cacheFilePath(),
      JSON.stringify({
        version: 1,
        entries: this.cache,
      }, null, 2)
    );
  }

  async loadCache() {
    const fileCache = await this.readCacheFile();
    this.cache = fileCache;
    const pruned = this.pruneCache();
    if (pruned.length > 0) await this.writeCacheFile();
  }

  pruneCache() {
    return pruneCacheEntries(this.cache, this.settings?.maxCacheEntries || DEFAULT_MAX_CACHE_ENTRIES);
  }

  async pruneCacheIfNeeded() {
    const removed = this.pruneCache();
    if (removed.length > 0) await this.writeCacheFile();
    return removed;
  }

  cacheGet(filePath) {
    const entry = this.cache[filePath] || null;
    if (entry) entry.lastAccessedAt = new Date().toISOString();
    return entry;
  }

  async cachePut(filePath, content, cards, settings) {
    const now = new Date().toISOString();
    this.cache[filePath] = {
      schemaVersion: CACHE_SCHEMA_VERSION,
      contentHash: hashContent(content),
      settingsHash: generationFingerprint(settings || this.settings),
      cards,
      generatedAt: now,
      lastAccessedAt: now,
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
    return leaf.view as ParallelReaderView;
  }

  getActiveView() {
    return this.app.workspace.getActiveViewOfType(MarkdownView);
  }

  isGeneratingFile(file) {
    return !!file && !!file.path && this.jobs.isRunning(file.path);
  }

  cancelGenerationForFile(file) {
    if (!file || !file.path) {
      new Notice('当前没有可取消的生成任务');
      return false;
    }
    const cancelled = this.jobs.cancel(file.path);
    new Notice(cancelled ? '已请求取消生成' : '当前没有可取消的生成任务');
    return cancelled;
  }

  viewIsShowingFile(view, file) {
    return !!view && !!file && view.sourceFile?.path === file.path;
  }

  activeFileStillMatches(file) {
    const active = this.getActiveView();
    return !active?.file || active.file.path === file.path;
  }

  cancelActiveGeneration() {
    const active = this.getActiveView();
    if (active?.file && this.cancelGenerationForFile(active.file)) return;
    const view = this.app.workspace.getLeavesOfType(VIEW_TYPE_PARALLEL)[0]?.view as ParallelReaderView | undefined;
    if (view?.sourceFile) this.cancelGenerationForFile(view.sourceFile);
    else new Notice('当前没有可取消的生成任务');
  }

  addFileMenuItems(menu, file) {
    if (!(file instanceof TFile) || !file.path.endsWith('.md')) return;
    menu.addSeparator();
    menu.addItem(it => it
      .setTitle('生成对照笔记')
      .setIcon('book-open')
      .onClick(() => this.runForFile(file, false)));
    menu.addItem(it => it
      .setTitle('强制重新生成对照笔记')
      .setIcon('refresh-cw')
      .onClick(() => this.runForFile(file, true)));
    if (this.cacheGet(file.path)) {
      menu.addItem(it => it
        .setTitle('清除对照笔记缓存')
        .setIcon('trash')
        .onClick(async () => {
          await this.cacheDelete(file.path);
          new Notice('已清除缓存：' + file.basename);
        }));
    }
  }

  async handleFileRename(file, oldPath) {
    if (!(file instanceof TFile) || !oldPath) return;
    const wasMarkdown = oldPath.endsWith('.md');
    const isMarkdown = file.path.endsWith('.md');
    if (!wasMarkdown && !isMarkdown) return;
    if (wasMarkdown && !isMarkdown) {
      if (this.cache[oldPath]) {
        delete this.cache[oldPath];
        await this.saveCache();
      }
      const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_PARALLEL);
      const view = leaves[0]?.view as ParallelReaderView | undefined;
      if (view?.sourceFile?.path === oldPath) view.renderEmpty();
      return;
    }
    if (!wasMarkdown) return;
    if (this.cache[oldPath]) {
      this.cache[file.path] = this.cache[oldPath];
      delete this.cache[oldPath];
      await this.saveCache();
    }
    const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_PARALLEL);
    const view = leaves[0]?.view as ParallelReaderView | undefined;
    if (view?.sourceFile && (view.sourceFile.path === oldPath || view.sourceFile.path === file.path)) {
      view.sourceFile = file;
      await this.syncViewToFile(file);
    }
  }

  async handleFileDelete(file) {
    if (!(file instanceof TFile)) return;
    const hadCache = !!this.cache[file.path];
    if (hadCache) {
      delete this.cache[file.path];
      await this.saveCache();
    }
    const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_PARALLEL);
    const view = leaves[0]?.view as ParallelReaderView | undefined;
    if (view?.sourceFile?.path === file.path) view.renderEmpty();
  }

  async exportCurrentView() {
    const active = this.getActiveView();
    const view = await this.ensureView();
    if (!view.sourceFile || !view.sections.length) {
      if (active?.file) await this.syncViewToFile(active.file);
    }
    if (!view.sourceFile || !view.sections.length) {
      new Notice('当前没有可导出的对照笔记');
      return;
    }
    await view.exportToVault();
  }

  async copyCurrentViewMarkdown() {
    const active = this.getActiveView();
    const view = await this.ensureView();
    if (!view.sourceFile || !view.sections.length) {
      if (active?.file) await this.syncViewToFile(active.file);
    }
    if (!view.sourceFile || !view.sections.length) {
      new Notice('当前没有可复制的对照笔记');
      return;
    }
    await copyToClipboard(
      cardsToMarkdown(`${view.sourceFile.basename} · 对照笔记`, view.sections),
      '已复制全部 Markdown'
    );
  }

  async runForActiveFile(force) {
    const mdView = this.getActiveView();
    if (!mdView || !mdView.file) {
      new Notice('先打开一篇笔记');
      return;
    }
    return this.runForFile(mdView.file, force);
  }

  async runForFile(file, force) {
    if (!file) {
      new Notice('先打开一篇笔记');
      return;
    }
    const runningKey = file.path;
    if (this.jobs.isRunning(runningKey)) {
      new Notice('该笔记正在生成对照笔记');
      return;
    }

    let view = null;
    return this.jobs.start(runningKey, async job => {
      job.setPhase('reading');
      const content = await this.app.vault.read(file);
      job.throwIfCancelled();
      if (!content.trim()) {
        new Notice('笔记为空');
        return;
      }

      view = await this.ensureView();
      job.throwIfCancelled();

      // Try cache unless user explicitly forced regeneration
      job.setPhase('cache-check');
      if (!force) {
        const entry = this.cacheGet(file.path);
        if (cacheEntryMatches(entry, content, this.settings)) {
          if (this.activeFileStillMatches(file)) {
            await view.loadFor(file, this.resolveCardAnchors(content, entry.cards), false);
          }
          return;
        }
      }

      await view.renderLoading(file, '对照阅读：让 LLM 读全文并自适应切段...');
      const maxDocChars = Number(this.settings.maxDocChars) || DEFAULT_SETTINGS.maxDocChars;
      if (content.length > maxDocChars) {
        new Notice(`笔记较长：仅发送前 ${maxDocChars} 个字符给模型`);
      }
      new Notice(`对照阅读：让 LLM 读全文并自适应切段…`);

      job.setPhase('generating');
      const sections = await summarizeDocument(content, this.settings, job);
      job.throwIfCancelled();
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
      job.setPhase('saving');
      await this.cachePut(file.path, content, rawCards, this.settings);
      job.throwIfCancelled();

      if (this.viewIsShowingFile(view, file)) {
        await view.loadFor(file, sections, false);
      }
      const unanchored = sections.filter(s => s.startLine < 0).length;
      new Notice(`对照笔记生成完成：${sections.length} 段${unanchored ? `（⚠ ${unanchored} 段 anchor 未匹配）` : ''}`);
    }).catch(async e => {
      if (e instanceof GenerationJobAlreadyRunningError) {
        new Notice(e.message);
        return;
      }
      if (e instanceof GenerationJobCancelledError) {
        if (this.viewIsShowingFile(view, file)) await view.renderError(file, '生成已取消');
        new Notice('已取消生成');
        return;
      }
      const kind = classifyGenerationError(e);
      console.error(e);
      if (this.viewIsShowingFile(view, file)) await view.renderError(file, e.message || String(e));
      new Notice(`生成失败${kind === 'unknown' ? '' : `（${kind}）`}：` + (e.message || e));
    });
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
    const view = leaves[0].view as ParallelReaderView;
    if (!view) return;
    if (!this.activeFileStillMatches(file)) return;

    const entry = this.cacheGet(file.path);
    if (!entry) {
      // No cache for this file → clear panel
      await view.loadFor(file, [], false);
      view.renderEmptyWithHint(file);
      return;
    }

    const content = await this.app.vault.read(file);
    if (!this.activeFileStillMatches(file)) return;
    const stale = !cacheEntryMatches(entry, content, this.settings);
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
    const cm = editor && (editor as any).cm;
    const scrollDom = cm && cm.scrollDOM ? cm.scrollDOM : mdView.contentEl.querySelector('.cm-scroller');
    if (!scrollDom) return;

    const handler = () => this.handleEditorScroll(mdView);
    scrollDom.addEventListener('scroll', handler, { passive: true });
    this._scrollDispose = () => scrollDom.removeEventListener('scroll', handler);
  }

  handleEditorScroll(mdView) {
    const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_PARALLEL);
    if (leaves.length === 0) return;
    const view = leaves[0].view as ParallelReaderView;
    if (!view || !mdView.file || view.sourceFile?.path !== mdView.file.path) return;

    const editor = mdView.editor;
    const cm = editor && (editor as any).cm;
    if (!cm) return;
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
      const v = leaf.view as any;
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
  plugin: ParallelReaderPlugin;

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
      .setDesc('生成 bullet 的后端：CLI 复用本机登录；API 支持 OpenAI/Anthropic/Gemini 及兼容代理')
      .addDropdown(d => d
        .addOption('claude-code', 'Claude Code CLI')
        .addOption('codex', 'Codex CLI')
        .addOption('api', 'API / Provider')
        .addOption('anthropic-api', 'Anthropic API (legacy)')
        .setValue(this.plugin.settings.backend)
        .onChange(async v => {
          this.plugin.settings.backend = v;
          if (v === 'api' && !this.plugin.settings.apiBaseUrl) {
            applyApiProviderPreset(this.plugin.settings, this.plugin.settings.apiProvider || 'anthropic');
          }
          await this.plugin.saveSettings();
          this.display();
        }));

    const apiBackend = isApiBackend(this.plugin.settings.backend);

    if (!apiBackend) {
      new Setting(containerEl)
        .setName('CLI 路径（可选）')
        .setDesc('留空则自动探测常见位置；Obsidian GUI 启动时不继承 shell PATH，必要时填绝对路径')
        .addText(t => t
          .setPlaceholder('例：/Users/you/bin/codex')
          .setValue(this.plugin.settings.cliPath)
          .onChange(async v => {
            this.plugin.settings.cliPath = v.trim();
            this.plugin.saveSettingsDebounced();
          }));

      new Setting(containerEl)
        .setName('CLI 超时 (ms)')
        .addText(t => t
          .setValue(String(this.plugin.settings.cliTimeoutMs))
          .onChange(async v => {
            const n = parseInt(v, 10);
            if (!isNaN(n) && n > 0) {
              this.plugin.settings.cliTimeoutMs = n;
              this.plugin.saveSettingsDebounced();
            }
          }));
    } else {
      containerEl.createEl('h3', { text: 'API Provider' });

      const preset = getApiPreset(this.plugin.settings);
      new Setting(containerEl)
        .setName('Provider preset')
        .setDesc('参考 OpenClaw 的 provider/model 思路：preset 只负责协议、base URL 和认证默认值')
        .addDropdown(d => {
          for (const [id, entry] of Object.entries(API_PROVIDER_PRESETS)) {
            d.addOption(id, (entry as any).label);
          }
          return d
            .setValue(this.plugin.settings.apiProvider)
            .onChange(async v => {
              applyApiProviderPreset(this.plugin.settings, v);
              await this.plugin.saveSettings();
              this.display();
            });
        });

      new Setting(containerEl)
        .setName('API format')
        .setDesc('不同 provider 的 wire protocol；OpenAI-compatible 代理通常选 Chat Completions')
        .addDropdown(d => {
          for (const [id, entry] of Object.entries(API_FORMATS)) {
            d.addOption(id, (entry as any).label);
          }
          return d
            .setValue(getApiFormat(this.plugin.settings))
            .onChange(async v => {
              this.plugin.settings.apiFormat = v;
              await this.plugin.saveSettings();
              this.display();
            });
        });

      new Setting(containerEl)
        .setName('Base URL')
        .setDesc('填 provider 根地址，不要附加 /chat/completions；留空时使用 preset 默认值')
        .addText(t => t
          .setPlaceholder(
            (this.plugin.settings.apiProvider || '').startsWith('custom-')
              ? 'https://your-provider.example/v1'
              : (preset.baseUrl || API_FORMATS[getApiFormat(this.plugin.settings)].defaultBaseUrl)
          )
          .setValue(this.plugin.settings.apiBaseUrl)
          .onChange(async v => {
            this.plugin.settings.apiBaseUrl = v.trim();
            this.plugin.saveSettingsDebounced();
          }));

      new Setting(containerEl)
        .setName('API Key')
        .setDesc('本地 Ollama/LM Studio 可留空；其他 provider 通常需要 key')
        .addText(t => {
          t.inputEl.type = 'password';
          return t
            .setPlaceholder('sk-...')
            .setValue(this.plugin.settings.apiKey)
            .onChange(async v => {
              this.plugin.settings.apiKey = v.trim();
              this.plugin.saveSettingsDebounced();
            });
        });

      new Setting(containerEl)
        .setName('API Key 环境变量')
        .setDesc('可选；Obsidian GUI 不一定继承 shell 环境，直接填 API Key 更稳定')
        .addText(t => t
          .setPlaceholder(preset.envVar || 'OPENAI_API_KEY')
          .setValue(this.plugin.settings.apiKeyEnvVar)
          .onChange(async v => {
            this.plugin.settings.apiKeyEnvVar = v.trim();
            this.plugin.saveSettingsDebounced();
          }));

      new Setting(containerEl)
        .setName('认证方式')
        .setDesc('Auto 使用 provider preset；自定义代理可按需要改成 Bearer、x-api-key 或 none')
        .addDropdown(d => {
          for (const [id, label] of Object.entries(API_AUTH_TYPES)) {
            d.addOption(id, label);
          }
          return d
            .setValue(this.plugin.settings.apiAuthType || 'auto')
            .onChange(async v => {
              this.plugin.settings.apiAuthType = v;
              await this.plugin.saveSettings();
            });
        });

      new Setting(containerEl)
        .setName('额外 headers')
        .setDesc('可选。支持 JSON 对象或每行 `Header: value`，用于 Cloudflare AI Gateway 等代理')
        .addTextArea(t => t
          .setPlaceholder('cf-aig-authorization: Bearer ...')
          .setValue(this.plugin.settings.apiHeaders)
          .onChange(async v => {
            this.plugin.settings.apiHeaders = v;
            this.plugin.saveSettingsDebounced();
          }));

      new Setting(containerEl)
        .setName('最大输出 tokens')
        .addText(t => t
          .setValue(String(this.plugin.settings.apiMaxTokens))
          .onChange(async v => {
            const n = parseInt(v, 10);
            if (!isNaN(n) && n > 0) {
              this.plugin.settings.apiMaxTokens = n;
              this.plugin.saveSettingsDebounced();
            }
          }));
    }

    new Setting(containerEl)
      .setName('Model')
      .setDesc(apiBackend
        ? 'API 调用的模型 ID；支持 OpenClaw 风格 provider/model，若 provider 前缀匹配当前 preset 会自动剥离'
        : 'Claude Code 下会传 --model；Codex 下通常忽略（用 Codex 默认配置）')
      .addText(t => t
        .setPlaceholder(apiBackend ? (getApiPreset(this.plugin.settings).model || 'model-id') : DEFAULT_SETTINGS.model)
        .setValue(this.plugin.settings.model)
        .onChange(async v => {
          this.plugin.settings.model = v.trim() || (apiBackend ? '' : DEFAULT_SETTINGS.model);
          this.plugin.saveSettingsDebounced();
        }));

    new Setting(containerEl)
      .setName('最大输入字符数')
      .setDesc('超过该长度会截断后再发送给模型；长上下文模型可适当调大')
      .addText(t => t
        .setValue(String(this.plugin.settings.maxDocChars || DEFAULT_SETTINGS.maxDocChars))
        .onChange(async v => {
          const n = parseInt(v, 10);
          if (!isNaN(n) && n >= 1000) {
            this.plugin.settings.maxDocChars = n;
            this.plugin.saveSettingsDebounced();
          }
        }));

    containerEl.createEl('h3', { text: 'Prompt' });

    new Setting(containerEl)
      .setName('输出语言')
      .setDesc('控制 title/gist/bullets 的语言；anchor 始终逐字复制原文')
      .addDropdown(d => {
        for (const [id, label] of Object.entries(PROMPT_LANGUAGES)) {
          d.addOption(id, label);
        }
        return d
          .setValue(this.plugin.settings.promptLanguage || DEFAULT_SETTINGS.promptLanguage)
          .onChange(async v => {
            this.plugin.settings.promptLanguage = v;
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName('卡片数量范围')
      .setDesc('模型会在这个范围内自适应切段')
      .addText(t => t
        .setPlaceholder('min')
        .setValue(String(this.plugin.settings.minCards || DEFAULT_SETTINGS.minCards))
        .onChange(async v => {
          const n = parseInt(v, 10);
          if (!isNaN(n) && n > 0) {
            this.plugin.settings.minCards = n;
            if (this.plugin.settings.maxCards < n) this.plugin.settings.maxCards = n;
            this.plugin.saveSettingsDebounced();
          }
        }))
      .addText(t => t
        .setPlaceholder('max')
        .setValue(String(this.plugin.settings.maxCards || DEFAULT_SETTINGS.maxCards))
        .onChange(async v => {
          const n = parseInt(v, 10);
          if (!isNaN(n) && n > 0) {
            this.plugin.settings.maxCards = Math.max(n, this.plugin.settings.minCards || DEFAULT_SETTINGS.minCards);
            this.plugin.saveSettingsDebounced();
          }
        }));

    new Setting(containerEl)
      .setName('自定义 system prompt')
      .setDesc('可选。支持变量：{minCards}、{maxCards}、{languageInstruction}、{schema}、{example}')
      .addTextArea(t => {
        t.inputEl.rows = 8;
        return t
          .setPlaceholder('留空使用内置 prompt')
          .setValue(this.plugin.settings.customSystemPrompt || '')
          .onChange(async v => {
            this.plugin.settings.customSystemPrompt = v;
            this.plugin.saveSettingsDebounced();
          });
      });

    new Setting(containerEl)
      .setName('测试当前后端')
      .setDesc(apiBackend ? '会发起一次最小 LLM 请求验证 API 设置' : '调用 `<cli> --version` 验证 spawn 能找到二进制')
      .addButton(b => b
        .setButtonText('Test')
        .onClick(async () => {
          try {
            const result = await testBackend(this.plugin.settings);
            new Notice(`✓ ${result.slice(0, 180)}`, 8000);
          } catch (e) {
            new Notice(`✗ 后端测试失败：${e.message}`, 10000);
          }
        }));

    new Setting(containerEl)
      .setName('导出文件夹')
      .setDesc('对照笔记生成位置（相对 Vault 根）')
      .addText(t => t
        .setValue(this.plugin.settings.exportFolder)
        .onChange(async v => {
          this.plugin.settings.exportFolder = v.trim() || DEFAULT_SETTINGS.exportFolder;
          this.plugin.saveSettingsDebounced();
        }));

    containerEl.createEl('h3', { text: '缓存' });

    new Setting(containerEl)
      .setName('最大缓存篇数')
      .setDesc('超过上限后按最近访问时间淘汰最旧的笔记缓存；缓存保存在插件目录的 cache.json')
      .addText(t => {
        t.setValue(String(this.plugin.settings.maxCacheEntries || DEFAULT_MAX_CACHE_ENTRIES));
        const commit = async () => {
          const n = parseInt(t.getValue(), 10);
          if (Number.isFinite(n) && n > 0) {
            this.plugin.settings.maxCacheEntries = n;
            await this.plugin.saveSettings();
            const removed = await this.plugin.pruneCacheIfNeeded();
            if (removed.length > 0) new Notice(`已淘汰 ${removed.length} 条旧缓存`);
            this.display();
          }
        };
        t.inputEl.addEventListener('change', commit);
        t.inputEl.addEventListener('keydown', e => {
          if (e.key === 'Enter') t.inputEl.blur();
        });
        return t;
      });

    const cacheCount = Object.keys(this.plugin.cache).length;
    new Setting(containerEl)
      .setName(`已缓存笔记：${cacheCount} 篇`)
      .setDesc('缓存以源笔记 SHA1 + 生成配置指纹作为失效键，源笔记或模型配置修改后会显示 stale 提示')
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

export default ParallelReaderPlugin;
export const __test = {
  CACHE_SCHEMA_VERSION,
  GenerationJobAlreadyRunningError,
  GenerationJobCancelledError,
  GenerationJobManager,
  buildAnthropicMessagesBody,
  buildGeminiBody,
  buildOpenAiChatBody,
  buildOpenAiResponsesBody,
  buildPrompts,
  cardsToMarkdown,
  cacheEntryMatches,
  classifyGenerationError,
  extractJson,
  findLineForAnchor,
  generationFingerprint,
  normalizeCardsPayload,
  pruneCacheEntries,
  summarizeViaApi,
  tokenLimitFieldForOpenAiChat,
};
