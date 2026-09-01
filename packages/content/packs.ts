import type { ScenePlan, StoryWorldConfig } from '../contracts/index.ts';

export interface StoryPackContext { config: StoryWorldConfig; knownLocations: Set<string> }
export interface StoryPack {
  id: string;
  title: string;
  genreTags: string[];
  prompt: string;
  validate(plan: ScenePlan, context: StoryPackContext): string[];
}

const cultivation: StoryPack = {
  id: 'cultivation-hewan', title: '河湾修行故事包', genreTags: ['cultivation'],
  prompt: '此故事包允许修炼、境界、灵力、江湖势力和河湾地域内容。所有成长必须由已提交场景与时间支撑，宗门经营不是默认主线。',
  validate: plan => plan.checkTags.includes('instant_breakthrough') ? ['修炼突破不能在没有过程与时间投入时瞬间完成。'] : [],
};

const westernFantasy: StoryPack = {
  id: 'western-fantasy', title: '西方奇幻故事包', genreTags: ['western_fantasy'],
  prompt: '此故事包允许王国、行会、古代遗迹和法术体系。魔法结果必须服从世界设定，重要誓约与永久诅咒属于重大变化。',
  validate: plan => plan.checkTags.includes('unbounded_magic') ? ['法术效果超出世界规则边界。'] : [],
};

const generic: StoryPack = {
  id: 'generic-story', title: '通用长线剧情包', genreTags: ['science_fiction', 'modern_mystery', 'custom'],
  prompt: '保持题材术语一致，围绕人物选择、长期矛盾和阶段目标推进，不套用其他类型的力量体系。',
  validate: () => [],
};

export const storyPacks: Record<string, StoryPack> = Object.fromEntries([cultivation, westernFantasy, generic].map(pack => [pack.id, pack]));
export function packsFor(config: StoryWorldConfig) { return config.storyPacks.map(id => storyPacks[id]).filter((pack): pack is StoryPack => !!pack); }
