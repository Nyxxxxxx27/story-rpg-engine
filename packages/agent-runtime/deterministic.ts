import type { DeterministicGenerator } from './provider.ts';

function jsonTag(prompt: string, tag: string) {
  const match = prompt.match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`));
  if (!match) return null;
  const decoded = match[1].replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&');
  try { return JSON.parse(decoded); } catch { return null; }
}

function jsonAfter(prompt: string, label: string) {
  const start = prompt.indexOf(label);
  if (start >= 0) {
    const text = prompt.slice(start + label.length).split('\n\n')[0];
    try { return JSON.parse(text); } catch { /* Try the XML prompt format below. */ }
  }
  const tag = ({
    '世界设定：': 'world_config', '当前阶段：': 'current_stage', '角色档案：': 'character_profiles',
    '最近场景：': 'recent_scenes', '相关事实：': 'canonical_facts',
  } as Record<string, string>)[label];
  if (!tag) return null;
  return jsonTag(prompt, tag);
}

const genreContent: Record<string, { title: string; premise: string; names: string[]; locations: string[]; terms: string[] }> = {
  cultivation: { title: '潮声问路', premise: '河湾边城的旧航道再度显现，失踪多年的引路人留下了会改变众人命运的坐标。', names: ['沈砚', '苏晚棠', '贺临川', '阿沅', '迟陌'], locations: ['河湾渡口', '旧潮堤'], terms: ['潮汐灵脉', '行舟契'] },
  western_fantasy: { title: '灰塔以北', premise: '边境的星火塔熄灭后，一封来自百年前的信指向王国地图上不存在的山谷。', names: ['艾伦', '莉奥娜', '罗文', '米拉', '塞德里克'], locations: ['白鹿驿站', '灰塔古道'], terms: ['星火塔', '誓约石'] },
  science_fiction: { title: '静默轨道', premise: '深空中继站收到一段来自未来三天后的求救记录，而记录中的幸存者正是当前船员。', names: ['林序', '程弥', '韩彻', '乔安', '周弦'], locations: ['中继站七号', '观测环廊'], terms: ['量子回声', '航迹密钥'] },
  modern_mystery: { title: '雨停之前', premise: '一张从未冲洗过的底片出现在旧城照相馆，画面预告了三天后将被抹去的证据。', names: ['许澈', '姜遥', '顾鸣', '叶岚', '陈屿'], locations: ['南桥照相馆', '旧城雨巷'], terms: ['失焦底片', '钟楼档案'] },
  custom: { title: '未定之路', premise: '一条只有少数人能看见的路贯穿熟悉世界，路标记录着尚未发生的选择。', names: ['陆远', '星遥', '闻川', '青禾', '简宁'], locations: ['无名路口', '灯下长街'], terms: ['回声路标', '旧日信物'] },
};

function outline(prompt: string) {
  const config = jsonAfter(prompt, '世界设定：') ?? { genre: 'custom', title: '未命名故事', premise: '一次改变命运的相遇' };
  const source = genreContent[config.genre] ?? genreContent.custom;
  const names = source.names;
  const stages = [
    ['第一道线索', '确认异常事件的真实性，并与关键同行者建立共同调查的理由。'],
    ['边界之外', '追踪线索的来源，发现冲突背后的第一层结构。'],
    ['代价浮现', '面对推进主线所需付出的代价，保护仍可挽回的关系。'],
    ['真相分岔', '验证互相冲突的证据，决定最终行动的方向。'],
    ['长夜尽头', '完成长期目标，并让核心人物的选择得到有依据的结局。'],
  ].map(([title, objective], index) => ({
    title, objective,
    entryCriteria: index ? [`阶段 ${index} 已完成`] : ['开局大纲已确认'],
    completionCriteria: [`${objective}`, '至少一条核心角色关系获得有事件来源的变化'],
    failureConditions: ['关键证据永久丢失且不存在替代路径'],
    boundaries: ['不可替玩家作出不可逆的主角选择'],
    desiredBeats: index === 0 ? ['首日发现可验证线索', '关键同行者参与行动'] : ['主线证据推进', '角色动机产生后果'],
  }));
  return {
    title: config.title && config.title !== '未命名故事' ? config.title : source.title,
    premise: config.premise || source.premise,
    arcObjective: `找出${source.terms[0]}背后的真相，并在局势失控前决定它应被保存、公开还是终止。`,
    stakes: `失败会使${source.locations[0]}及核心人物失去选择自身未来的机会。`,
    stages,
    characters: [
      { id: 'protagonist', name: names[0], importance: 'protagonist', roleTags: ['player_character'], publicProfile: '谨慎而有行动力的事件亲历者。', privateProfile: '害怕自己的判断让同伴承担代价。', drives: ['查明真相并保住选择权'], fears: ['因仓促决定伤害同伴'], location: source.locations[0] },
      { id: 'core-heroine', name: names[1], importance: 'core', roleTags: ['heroine', 'love_interest', 'investigator'], publicProfile: '观察敏锐、坚持证据的关键同行者。', privateProfile: '掌握一段尚未确认能否公开的旧日联系。', drives: ['保护证据与身边的人'], fears: ['信任再次被利用'], location: source.locations[0] },
      { id: 'core-rival', name: names[2], importance: 'core', roleTags: ['rival'], publicProfile: '与主角目标部分重合、手段更强硬的竞争者。', privateProfile: '正受另一方势力施压。', drives: ['抢先控制关键线索'], fears: ['失去谈判筹码'], location: source.locations[1] },
      { id: 'core-witness', name: names[3], importance: 'core', roleTags: ['companion', 'witness'], publicProfile: '知道当地旧事、愿意提供实际帮助。', privateProfile: '曾亲眼见过异常却隐瞒了细节。', drives: ['弥补过去的沉默'], fears: ['旧事牵连家人'], location: source.locations[0] },
      { id: 'core-antagonist', name: names[4], importance: 'core', roleTags: ['antagonist'], publicProfile: '试图封锁线索来源的执行者。', privateProfile: '并不完全认同自己的任务。', drives: ['完成封锁并保住地位'], fears: ['秘密公开后遭到清算'], location: source.locations[1] },
    ],
  };
}

function plan(prompt: string) {
  const characters = jsonAfter(prompt, '角色档案：') ?? [];
  const stage = jsonAfter(prompt, '当前阶段：');
  const scenes = jsonAfter(prompt, '最近场景：') ?? [];
  const protagonist = characters.find((item: any) => item.importance === 'protagonist') ?? characters[0];
  const featured = characters.find((item: any) => item.roleTags?.includes('heroine') || item.roleTags?.includes('love_interest')) ?? characters[1] ?? protagonist;
  const next = scenes.length + 1;
  return {
    title: `${stage?.title ?? '当前阶段'} · 推进一步`,
    objective: `由${protagonist.name}与${featured.name}核对一条可验证线索，使“${stage?.objective ?? '长期目标'}”获得明确进展。`,
    location: featured.location || protagonist.location,
    participants: [...new Set([protagonist.id, featured.id])],
    durationMinutes: 360,
    beats: ['复核上一场景留下的事实', '两名核心人物以各自动机采取行动', '取得可供后续验证的新线索'],
    changes: [
      { type: 'character', characterId: featured.id, field: 'recentBeat', value: `第${next}次推进中与${protagonist.name}共同确认了新线索。`, significance: 'minor' },
      { type: 'relationship', from: protagonist.id, to: featured.id, dimension: 'trust', delta: 1, reason: `${featured.name}与${protagonist.name}共同承担核验线索的责任，互信增加。`, significance: 'minor' },
      { type: 'fact', kind: 'world', text: `第${next}次调查确认：当前线索与阶段目标存在可复核联系。`, tags: ['clue', `scene-${next}`] },
    ],
    stageProgressDelta: 20,
    requiresPlayerChoice: false,
    choicePrompt: null,
    choices: [],
    checkTags: ['investigation'],
  };
}

function narration(prompt: string) {
  const stage = jsonAfter(prompt, '当前阶段：');
  const characters = jsonAfter(prompt, '角色档案：') ?? [];
  const facts = jsonAfter(prompt, '相关事实：') ?? [];
  const protagonist = characters.find((item: any) => item.importance === 'protagonist') ?? characters[0];
  const featured = characters.find((item: any) => item.roleTags?.includes('heroine') || item.roleTags?.includes('love_interest')) ?? characters[1];
  const latest = facts.at(-1)?.text ?? '新的线索已经被记录';
  return {
    title: `${stage?.title ?? '旅程'}：共同的证据`,
    prose: `${protagonist?.name ?? '主角'}抵达现场时，${featured?.name ?? '同行者'}已经把能核对的细节逐项列好。他们沿着时间、位置和见证人的说法反复验证，分歧逐渐收束到同一处疑点。临近下一段行程，两人确认了一个足以继续追查的事实：${latest}。窗外的光线移过桌沿，${featured?.name ?? '同行者'}合上记录册，指向仍能复查的下一条线索。`,
    summary: `${protagonist?.name ?? '主角'}与${featured?.name ?? '核心角色'}共同核验线索，确认了新的疑点，双方互信略有增加。`,
    choices: ['继续沿已验证线索推进', '先与核心同伴复盘风险', '调查另一条旁证'],
  };
}

export const storyDeterministicGenerator: DeterministicGenerator = prompt => {
  if (prompt.includes('开局策划 Agent')) return outline(prompt);
  if (prompt.includes('Director Agent')) return plan(prompt);
  if (prompt.includes('Narrator Agent')) return narration(prompt);
  if (prompt.includes('Polish Agent')) return { prose: jsonTag(prompt, 'draft_narration')?.prose ?? '风声从窗外掠过。' };
  if (prompt.includes('修订一次')) return plan(prompt);
  return { approved: true, summary: '检查通过；计划与已提交事实、阶段目标和角色动机保持一致。', issues: [] };
};
