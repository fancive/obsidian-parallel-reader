'use strict';

import {
  DEFAULT_SETTINGS,
  MAX_DOC_CHARS,
  PROMPT_LANGUAGES,
} from './settings';

export function promptLanguageInstruction(language) {
  if (language === 'en') return 'Write title, gist, and bullets in English.';
  if (language === 'auto') return 'Write title, gist, and bullets in the main language of the source document.';
  return '用中文输出 title、gist 和 bullets。';
}

export function promptSchemaExample(language) {
  if (language === 'en') {
    return `{"cards":[
  {"title":"U-shaped gains","anchor":"Who benefits from AI? Overall, it shifts the score from one to seven","gist":"AI productivity gains form a U shape, with both ends benefiting most","bullets":["Top-paid software managers benefit by accelerating existing work","Low-paid workers use AI to create new side income","Middle-layer specialists gain less because prompt precision is hard to trust","Average reported benefit is 5.1/7, with 42% describing gains as unclear"]}
]}`;
  }
  return `{"cards":[
  {"title":"U 型收益曲线","anchor":"那谁又会被 AI 所受益？整体来看，它把整个分数变成了一分到七分","gist":"AI 生产力收益呈 U 型，两端受益最大、中间层塌陷","bullets":["最高薪岗位（软件管理）通过加速既有工作受益最大","最低薪岗位（外卖员、园艺工）用 AI 开副业创造新收入","中间层科学家、律师收益最少，部分因对 prompt 精度信任不足","全体均分 5.1/7，42% 报告收益模糊"]}
]}`;
}

export function renderPromptTemplate(template, vars) {
  return String(template || '').replace(/\{([a-zA-Z0-9_]+)\}/g, (match, key) => {
    return Object.prototype.hasOwnProperty.call(vars, key) ? String(vars[key]) : match;
  });
}

export function buildPrompts(content, settings) {
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
