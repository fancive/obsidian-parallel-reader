'use strict';

import { DEFAULT_SETTINGS, MAX_DOC_CHARS, normalizeCardCount, PROMPT_LANGUAGES } from './settings';
import type { PluginSettings, PromptPair } from './types';

const PROMPT_LANGUAGE_INSTRUCTIONS: Record<string, string> = {
  auto: 'Write title, gist, and bullets in the main language of the source document.',
  zh: '用中文输出 title、gist 和 bullets。',
  en: 'Write title, gist, and bullets in English.',
  ja: 'Write title, gist, and bullets in Japanese.',
  ko: 'Write title, gist, and bullets in Korean.',
  fr: 'Write title, gist, and bullets in French.',
  de: 'Write title, gist, and bullets in German.',
  es: 'Write title, gist, and bullets in Spanish.',
};

const PROMPT_SCHEMA_EXAMPLES: Record<string, string> = {
  zh: `{"cards":[
  {"title":"U 型收益曲线","anchor":"那谁又会被 AI 所受益？整体来看，它把整个分数变成了一分到七分","gist":"AI 生产力收益呈 U 型，两端受益最大、中间层塌陷","bullets":["最高薪岗位（软件管理）通过加速既有工作受益最大","最低薪岗位（外卖员、园艺工）用 AI 开副业创造新收入","中间层科学家、律师收益最少，部分因对 prompt 精度信任不足","全体均分 5.1/7，42% 报告收益模糊"]}
]}`,
  en: `{"cards":[
  {"title":"U-shaped gains","anchor":"Who benefits from AI? Overall, it shifts the score from one to seven","gist":"AI productivity gains form a U shape, with both ends benefiting most","bullets":["Top-paid software managers benefit by accelerating existing work","Low-paid workers use AI to create new side income","Middle-layer specialists gain less because prompt precision is hard to trust","Average reported benefit is 5.1/7, with 42% describing gains as unclear"]}
]}`,
  ja: `{"cards":[
  {"title":"U字型の利益","anchor":"Who benefits from AI? Overall, it shifts the score from one to seven","gist":"AIによる生産性向上はU字型になり、両端の層がもっとも大きな恩恵を受ける","bullets":["高所得のソフトウェア管理職は既存業務を加速できるため大きく恩恵を受ける","低所得の労働者はAIを使って新しい副収入を作り出せる","中間層の専門職は、プロンプト精度への信頼が難しいため利益が小さい","平均利益は5.1/7で、42%が効果は不明確だと報告している"]}
]}`,
  ko: `{"cards":[
  {"title":"U자형 이득","anchor":"Who benefits from AI? Overall, it shifts the score from one to seven","gist":"AI 생산성 향상은 U자형을 보이며 양끝 집단이 가장 큰 혜택을 얻는다","bullets":["고소득 소프트웨어 관리자는 기존 업무를 더 빠르게 처리해 큰 이득을 얻는다","저소득 노동자는 AI로 새로운 부수입 기회를 만들 수 있다","중간층 전문가는 프롬프트 정확도를 신뢰하기 어려워 상대적으로 이득이 작다","평균 체감 이득은 5.1/7이며 42%는 효과가 불명확하다고 답했다"]}
]}`,
  fr: `{"cards":[
  {"title":"Gains en U","anchor":"Who benefits from AI? Overall, it shifts the score from one to seven","gist":"Les gains de productivité liés à l'AI forment une courbe en U, les deux extrémités en profitant le plus","bullets":["Les managers logiciels très rémunérés gagnent surtout en accélérant leur travail existant","Les travailleurs peu rémunérés utilisent l'AI pour créer de nouveaux revenus complémentaires","Les spécialistes intermédiaires gagnent moins, car la précision des prompts reste difficile à fiabiliser","Le bénéfice moyen déclaré est de 5,1/7, avec 42% de gains jugés peu clairs"]}
]}`,
  de: `{"cards":[
  {"title":"U-förmige Gewinne","anchor":"Who benefits from AI? Overall, it shifts the score from one to seven","gist":"AI-Produktivitätsgewinne bilden eine U-Form, bei der beide Enden am stärksten profitieren","bullets":["Hochbezahlte Softwaremanager profitieren, weil sie bestehende Arbeit beschleunigen","Geringverdienende nutzen AI, um neue Nebeneinnahmen zu schaffen","Spezialisten in der Mitte gewinnen weniger, weil präzise Prompts schwer zu vertrauen sind","Der gemeldete Durchschnittsnutzen liegt bei 5,1/7; 42% beschreiben die Gewinne als unklar"]}
]}`,
  es: `{"cards":[
  {"title":"Ganancias en forma de U","anchor":"Who benefits from AI? Overall, it shifts the score from one to seven","gist":"Las mejoras de productividad con AI forman una U: los extremos son quienes más se benefician","bullets":["Los gerentes de software mejor pagados se benefician al acelerar su trabajo existente","Los trabajadores con menores ingresos usan AI para crear nuevas fuentes de ingreso","Los especialistas intermedios ganan menos porque es difícil confiar en la precisión del prompt","El beneficio medio reportado es 5,1/7, con un 42% que describe las ganancias como poco claras"]}
]}`,
};

function usesEnglishPromptShell(language: string): boolean {
  return language !== 'zh' && language !== 'auto';
}

export function promptLanguageInstruction(language: string): string {
  return PROMPT_LANGUAGE_INSTRUCTIONS[language] || PROMPT_LANGUAGE_INSTRUCTIONS.zh;
}

export function promptSchemaExample(language: string): string {
  return PROMPT_SCHEMA_EXAMPLES[language] || PROMPT_SCHEMA_EXAMPLES.zh;
}

export function renderPromptTemplate(template: string, vars: Record<string, string | number>): string {
  return String(template || '').replace(/\{([a-zA-Z0-9_]+)\}/g, (match, key) => {
    return Object.hasOwn(vars, key) ? String(vars[key]) : match;
  });
}

function defaultSystemPrompt(
  language: string,
  minCards: number,
  maxCards: number,
  languageInstruction: string,
  schema: string,
  example: string,
): string {
  if (usesEnglishPromptShell(language)) {
    return `You are a long-form reading summary assistant. After reading the full document, split it into ${minCards}-${maxCards} natural topic units. They do not need to match markdown headings; use a complete argument or topic as the unit, merging short sections and splitting long ones when needed.

Each card has one guiding sentence plus several bullets. Bullets carry details; gist is the lead-in.

Language:
- ${languageInstruction}

For each unit, output:

- title: a concise 3-10 word heading that clearly states what the section is about; avoid vague labels like "Background" or "Introduction"
- anchor: a verbatim quote from the start of this unit, copied 1:1 from the source, 40-80 characters where possible, preserving punctuation, spaces, and line breaks; it is only used internally for positioning
- gist: one guiding sentence, 20-40 words, stating the core claim or conclusion
- bullets: 3-6 supporting bullets, each 20-50 words, carrying data, comparisons, mechanisms, examples, or counterintuitive observations. Gist and bullets must not repeat each other.

Rules:
- anchor must exact-substring-match the source. Never paraphrase, translate, summarize, or alter it.
- Choose the earliest sufficiently distinctive quote for each unit; avoid generic phrases.
- Every card must include both gist and bullets.
- Each bullet must be a standalone assertion; avoid sequencing phrases such as "first" or "then".
- Output strict JSON only: no markdown fence, no explanation, no tool call.

Output shape:
${schema}

Example:
${example}`;
  }

  return `你是一个长文阅读摘要助手。阅读全文后，把文章切成 ${minCards}-${maxCards} 个"自然主题单元"——不必对应 markdown heading，以"一个完整论点或话题"为单位自行判断粒度：短章节合并、长章节拆分。

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
}

function systemPromptContract(
  language: string,
  minCards: number,
  maxCards: number,
  languageInstruction: string,
  schema: string,
): string {
  if (usesEnglishPromptShell(language)) {
    return `Non-overridable output contract:
- Must output ${minCards}-${maxCards} cards.
- ${languageInstruction}
- anchor must be copied verbatim from the source and exact-substring-match the source.
- Output strict JSON only: no markdown fence, no explanation, no tool call.
- JSON shape: ${schema}`;
  }
  return `不可覆盖的输出契约：
- 必须输出 ${minCards}-${maxCards} 张 cards。
- ${languageInstruction}
- anchor 必须从原文逐字复制，必须能在原文 exact substring match 找到。
- 严格只输出 JSON，无 markdown fence、无解释、无 tool call。
- JSON shape: ${schema}`;
}

export function buildPrompts(content: string, settings: PluginSettings): PromptPair {
  const maxDocChars = Number(settings.maxDocChars) || MAX_DOC_CHARS;
  const promptLanguage = (PROMPT_LANGUAGES as Record<string, string>)[settings.promptLanguage]
    ? settings.promptLanguage
    : DEFAULT_SETTINGS.promptLanguage;
  const minCards = normalizeCardCount(settings.minCards, DEFAULT_SETTINGS.minCards);
  const maxCards = Math.max(minCards, normalizeCardCount(settings.maxCards, DEFAULT_SETTINGS.maxCards));
  const languageInstruction = promptLanguageInstruction(promptLanguage);
  const doc =
    content.length > maxDocChars
      ? content.slice(0, maxDocChars) +
        (usesEnglishPromptShell(promptLanguage) ? '\n\n[Document truncated]' : '\n\n[文档过长，已截断]')
      : content;

  const schema = '{"cards":[{"title":"...","anchor":"...","gist":"...","bullets":["...","..."]}]}';
  const example = promptSchemaExample(promptLanguage);
  const templateVars = { minCards, maxCards, languageInstruction, schema, example };
  const customSystem = renderPromptTemplate(settings.customSystemPrompt, templateVars).trim();
  const contract = systemPromptContract(promptLanguage, minCards, maxCards, languageInstruction, schema);
  const defaultSystem = defaultSystemPrompt(promptLanguage, minCards, maxCards, languageInstruction, schema, example);

  const system = customSystem
    ? `${customSystem}

${contract}`
    : defaultSystem;

  const user = usesEnglishPromptShell(promptLanguage)
    ? `Source document:\n\n${doc}`
    : `以下是需要处理的文档全文：\n\n${doc}`;
  return { system, user };
}
