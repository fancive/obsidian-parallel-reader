/**
 * Shared obsidian module mock for all test files.
 * Must be require()'d before any module that imports 'obsidian'.
 */
const Module = require('module');

const originalLoad = Module._load;

let requestUrlMock = async () => ({ status: 200, json: {}, text: '{}' });

// Every `new Notice(...)` created through the mock (regardless of which particular class
// definition below produced it — see the comment above `Notice` for why there can be more
// than one) is recorded here so tests can inspect notices without error-ui.ts needing to
// return them. Cleared per-file since each *.test.js runs as its own `node` process.
const noticeInstances = [];

/**
 * Minimal fake DOM element supporting the subset of Obsidian's HTMLElement extensions
 * (createDiv/createEl/createSpan/addClass/addEventListener) that Notice.messageEl consumers
 * (src/error-ui.ts's showActionableNotice) use to build actionable notices.
 */
class FakeNoticeEl {
  constructor(tag = 'div') {
    this.tagName = tag.toUpperCase();
    this.children = [];
    this._classes = new Set();
    this._listeners = {};
    this.textContent = '';
  }
  createDiv(opts = {}) {
    return this._append('div', opts);
  }
  createEl(tag, opts = {}) {
    return this._append(tag, opts);
  }
  createSpan(opts = {}) {
    return this._append('span', opts);
  }
  _append(tag, opts) {
    const el = new FakeNoticeEl(tag);
    if (opts.cls) el.addClass(opts.cls);
    if (opts.text != null) el.textContent = opts.text;
    this.children.push(el);
    return el;
  }
  addClass(cls) {
    this._classes.add(cls);
  }
  removeClass(cls) {
    this._classes.delete(cls);
  }
  hasClass(cls) {
    return this._classes.has(cls);
  }
  addEventListener(type, handler) {
    if (!this._listeners[type]) this._listeners[type] = [];
    this._listeners[type].push(handler);
  }
  removeEventListener(type, handler) {
    const arr = this._listeners[type];
    if (!arr) return;
    const i = arr.indexOf(handler);
    if (i >= 0) arr.splice(i, 1);
  }
  dispatch(type, evtOverrides = {}) {
    const handlers = (this._listeners[type] || []).slice();
    const e = { target: this, preventDefault() {}, stopPropagation() {}, ...evtOverrides };
    for (const h of handlers) h(e);
  }
}

Module._load = function load(request, parent, isMain) {
  if (request === 'obsidian') {
    class Plugin {}
    class ItemView {
      constructor(leaf) {
        this.leaf = leaf;
        this.containerEl = { children: [{}, {}] };
      }
    }
    class PluginSettingTab {}
    class Setting {}
    // NOTE: `Module._load` is fully replaced here (not just wrapped), so every
    // `require('obsidian')` call defines a *new* copy of these classes rather than resolving
    // to a single cached module. That's fine for a bare `class Notice {}`, but once Notice
    // carries real behavior (messageEl, hide()) any test wanting to inspect a notice can't
    // rely on `require('obsidian').Notice` being the same reference the code under test used.
    // `noticeInstances` (module-scoped, above) sidesteps that: every instance is recorded
    // there regardless of which copy of the class constructed it.
    class Notice {
      constructor(message = '', duration) {
        this.message = message;
        this.duration = duration;
        this.messageEl = new FakeNoticeEl('div');
        this.hidden = false;
        noticeInstances.push(this);
      }
      setMessage(message) {
        this.message = message;
        return this;
      }
      hide() {
        this.hidden = true;
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
      requestUrl: (params) => requestUrlMock(params),
      setIcon: () => {},
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};

module.exports = {
  getRequestUrlMock() {
    return requestUrlMock;
  },
  setRequestUrlMock(fn) {
    requestUrlMock = fn;
  },
  /** All Notice instances created so far, oldest first. Does not clear the list. */
  getNotices() {
    return noticeInstances.slice();
  },
  /** Returns and clears all captured Notice instances (oldest first). */
  takeNotices() {
    return noticeInstances.splice(0, noticeInstances.length);
  },
};
