/**
 * Shared obsidian module mock for all test files.
 * Must be require()'d before any module that imports 'obsidian'.
 */
const Module = require('module');

const originalLoad = Module._load;

let requestUrlMock = async () => ({ status: 200, json: {}, text: '{}' });

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
    class Notice {}
    class MarkdownView {}
    class TFile {}
    class Menu {}
    class Modal {}
    return {
      Plugin, ItemView, PluginSettingTab, Setting, Notice, MarkdownView, TFile, Menu, Modal,
      MarkdownRenderer: { render: async () => {} },
      requestUrl: (params) => requestUrlMock(params),
      setIcon: () => {},
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};

module.exports = {
  getRequestUrlMock() { return requestUrlMock; },
  setRequestUrlMock(fn) { requestUrlMock = fn; },
};
