import { narrationSchema, type Character, type Narration, type ScenePlan } from '../contracts/index.ts';

const PRIVATE_BLOCK = /<(private_reasoning|private_analysis|private_engine_context|thinking|think|analysis|reasoning|chain_of_thought)\b[^>]*>[\s\S]*?<\/\1\s*>/gi;
const XML_TAG = /<\/?[A-Za-z_][^>]*>/g;
const PRIVATE_BLOCK_TEST = /<(?:private_reasoning|private_analysis|private_engine_context|thinking|think|analysis|reasoning|chain_of_thought)\b/i;
const XML_TAG_TEST = /<\/?[A-Za-z_][^>]*>/;
const META_LANGUAGE = /玩家|用户|系统(?:提示|规则|状态|流程|决定|授权)|故事引擎|模型(?:输出|判断|生成)|\bAgent\b|\bPrompt\b|\bSchema\b|\bJSON\b|候选(?:场景|事实|变化|状态|计划|选项)|已提交事实|结构化(?:输出|计划|状态|结论)|状态变更|长期目标|阶段目标|阶段进度|等待(?:玩家|用户|选择)|由玩家决定|本场计划|不得新增状态|思维链/i;
const AGENCY_EXPLANATION = /(?:没有|未|不可|不能|不应|不会|不得).{0,16}(?:替|代替).{0,16}(?:决定|选择|判断)/;

function stripPrivateMarkup(value: string) {
  let clean = value;
  for (let previous = ''; previous !== clean;) {
    previous = clean;
    clean = clean.replace(PRIVATE_BLOCK, '');
  }
  return clean.replace(XML_TAG, '').replace(/\r\n?/g, '\n').trim();
}

export function containsPublicStoryLeak(value: string) {
  const raw = value.trim();
  return PRIVATE_BLOCK_TEST.test(raw) || XML_TAG_TEST.test(raw) || META_LANGUAGE.test(raw) || AGENCY_EXPLANATION.test(raw);
}

function cleanParagraph(paragraph: string) {
  const sentences = paragraph.match(/[^。！？!?]+[。！？!?]?/g) ?? [];
  return sentences.map(sentence => sentence.trim()).filter(sentence => sentence && !META_LANGUAGE.test(sentence) && !AGENCY_EXPLANATION.test(sentence)).join('');
}

export function sanitizePublicStoryText(value: string) {
  return stripPrivateMarkup(value).split(/\n{2,}/).map(cleanParagraph).filter(Boolean).join('\n\n').trim();
}

function firstSafe(values: string[], fallback: string) {
  return values.map(sanitizePublicStoryText).find(Boolean) ?? fallback;
}

export function sanitizeNarrationForPublication(narrationInput: Narration, plan: ScenePlan, characters: Character[]): Narration {
  const narration = narrationSchema.parse(narrationInput);
  const participants = plan.participants.map(id => characters.find(character => character.id === id)?.name).filter(Boolean) as string[];
  const subject = participants.length > 1 ? participants.slice(0, 2).join('与') : participants[0] ?? '一行人';
  const factSentences = plan.changes
    .filter(change => change.type === 'fact')
    .map(change => sanitizePublicStoryText(change.text))
    .filter(Boolean)
    .slice(0, 2);
  const fallbackTitle = firstSafe([plan.title], `${plan.location}的片刻`);
  const fallbackProse = `${subject}在${plan.location}继续眼前的行动。${factSentences.join('') || '现场留下了可以继续追查的痕迹。'}`;
  const fallbackSummary = `${subject}在${plan.location}取得了新的进展。`;
  const title = firstSafe([narration.title], fallbackTitle).slice(0, 120);
  const prose = firstSafe([narration.prose], fallbackProse).slice(0, 8000);
  const summary = firstSafe([narration.summary], fallbackSummary).slice(0, 1000);
  const choiceSource = plan.requiresPlayerChoice && plan.choices.length ? plan.choices : [...narration.choices, ...plan.choices];
  const choices = choiceSource
    .map(sanitizePublicStoryText)
    .filter((choice, index, all) => choice && all.indexOf(choice) === index)
    .slice(0, 5);
  return narrationSchema.parse({ title, prose, summary, choices });
}

const EVENT_SIGNALS = ['忽然', '突然', '原来', '其实', '发现', '确认', '决定', '答应', '拒绝', '死亡', '牺牲', '离开', '抵达', '出现', '消失', '交出', '拿走', '摧毁', '获得', '失去'];

function occurrences(text: string, token: string) {
  return text.split(token).length - 1;
}

export function validateProsePolish(originalInput: string, candidateInput: string, plan: ScenePlan, characters: Character[]) {
  const original = sanitizePublicStoryText(originalInput); const candidate = sanitizePublicStoryText(candidateInput);
  if (!candidate) return { prose: original, applied: false, reason: '润色结果为空或仅含幕后说明，已保留原稿。' };
  const ratio = candidate.length / Math.max(1, original.length);
  if (ratio < 0.65 || ratio > 1.6) return { prose: original, applied: false, reason: '润色篇幅变化过大，已保留原稿。' };
  const originalNumbers = original.match(/\d+(?:\.\d+)?/g) ?? []; const candidateNumbers = candidate.match(/\d+(?:\.\d+)?/g) ?? [];
  if (JSON.stringify(originalNumbers) !== JSON.stringify(candidateNumbers)) return { prose: original, applied: false, reason: '润色改变了数字或时间信息，已保留原稿。' };
  const names = characters.map(character => character.name).filter(Boolean);
  const originalNames = names.filter(name => original.includes(name)).sort(); const candidateNames = names.filter(name => candidate.includes(name)).sort();
  if (JSON.stringify(originalNames) !== JSON.stringify(candidateNames)) return { prose: original, applied: false, reason: '润色增删了出场人物，已保留原稿。' };
  if (original.includes(plan.location) !== candidate.includes(plan.location)) return { prose: original, applied: false, reason: '润色改变了场景地点信息，已保留原稿。' };
  if (!/[“”]/.test(original) && /[“”]/.test(candidate)) return { prose: original, applied: false, reason: '润色新增了人物台词，已保留原稿。' };
  if (EVENT_SIGNALS.some(token => occurrences(candidate, token) > occurrences(original, token))) return { prose: original, applied: false, reason: '润色疑似新增了剧情事件，已保留原稿。' };
  return { prose: candidate, applied: candidate !== original, reason: candidate === original ? '原稿无需改动。' : '已完成纯文笔润色，并通过剧情不变校验。' };
}
