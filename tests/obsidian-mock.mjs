/**
 * Shared `obsidian` module mock for all test files.
 *
 * tests/ts-loader.js installs a resolve hook that points the bare `obsidian`
 * specifier at THIS file, so every `import … from 'obsidian'` inside main.ts /
 * src/*.ts resolves here. Test files that want the call recorders below can
 * `require('./obsidian-mock.mjs')` and get the very same module instance.
 *
 * ESM (not CJS) on purpose: named ESM imports out of a CommonJS file depend on
 * cjs-module-lexer's heuristics, which silently miss keys whose value is not a
 * bare identifier (`setIcon: () => {}` was missed, and the failure surfaces as a
 * confusing "does not provide an export named 'setIcon'"). Explicit ESM exports
 * remove that whole class of problem.
 */

let requestUrlMock = async () => ({ status: 200, json: {}, text: '{}' });

// Every `new Notice(...)` is recorded here so tests can inspect notices without
// error-ui.ts needing to return them. Cleared per-file, since each *.test.js runs
// as its own `node` process.
const noticeInstances = [];

// Every `setTooltip(el, tooltip, options)` call is recorded here so tests can verify
// Obsidian's own tooltip manager is used instead of the native `title` attribute
// (see src/ui-helpers.ts). Cleared per-file for the same reason as noticeInstances.
const tooltipCalls = [];

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

/**
 * Minimal but behaviorally-accurate re-implementation of Obsidian's Component: enough
 * to exercise the S9 lifecycle fix (child-Component-owned scroll listener, detached on
 * rebind via removeChild and on plugin unload via the normal unload cascade) under test.
 */
export class Component {
  constructor() {
    this._loaded = false;
    this._children = [];
    this._cleanups = [];
  }
  load() {
    if (this._loaded) return;
    this._loaded = true;
    this.onload();
    for (const child of this._children) child.load();
  }
  onload() {}
  unload() {
    if (!this._loaded) return;
    this._loaded = false;
    for (const child of this._children.slice()) child.unload();
    this._children = [];
    const cleanups = this._cleanups.splice(0, this._cleanups.length);
    for (const cb of cleanups) {
      try {
        cb();
      } catch (_e) {
        // Obsidian tolerates a throwing cleanup callback rather than aborting the rest.
      }
    }
    this.onunload();
  }
  onunload() {}
  addChild(component) {
    this._children.push(component);
    if (this._loaded) component.load();
    return component;
  }
  removeChild(component) {
    const i = this._children.indexOf(component);
    if (i >= 0) this._children.splice(i, 1);
    component.unload();
    return component;
  }
  register(cb) {
    this._cleanups.push(cb);
  }
  registerEvent(eventRef) {
    this.register(() => {
      if (eventRef && typeof eventRef.detach === 'function') eventRef.detach();
    });
  }
  registerDomEvent(el, type, callback, options) {
    el.addEventListener(type, callback, options);
    this.register(() => el.removeEventListener(type, callback, options));
  }
  registerInterval(id) {
    this.register(() => clearInterval(id));
    return id;
  }
}

export class Plugin extends Component {}

export class ItemView {
  constructor(leaf) {
    this.leaf = leaf;
    this.containerEl = { children: [{}, {}] };
  }
}

export class PluginSettingTab {}
export class Setting {}

export class Notice {
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

export class MarkdownView {}
export class TFile {}
export class Menu {}
export class Modal {}

export const MarkdownRenderer = { render: async () => {} };

export const requestUrl = (params) => requestUrlMock(params);

export const setIcon = () => {};

export const setTooltip = (el, tooltip, options) => {
  tooltipCalls.push({ el, tooltip, options });
};

/* ---------- test-only helpers (not part of Obsidian's API surface) ---------- */

export function getRequestUrlMock() {
  return requestUrlMock;
}

export function setRequestUrlMock(fn) {
  requestUrlMock = fn;
}

/** All Notice instances created so far, oldest first. Does not clear the list. */
export function getNotices() {
  return noticeInstances.slice();
}

/** Returns and clears all captured Notice instances (oldest first). */
export function takeNotices() {
  return noticeInstances.splice(0, noticeInstances.length);
}

/** All setTooltip(el, tooltip, options) calls made so far, oldest first. Does not clear. */
export function getTooltips() {
  return tooltipCalls.slice();
}

/** Returns and clears all captured setTooltip calls (oldest first). */
export function takeTooltips() {
  return tooltipCalls.splice(0, tooltipCalls.length);
}
