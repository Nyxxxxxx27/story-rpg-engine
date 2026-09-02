import { afterEach, describe, expect, it } from 'vitest';
import { StoryRuntime } from '../packages/agent-runtime/runtime.ts';
import { containsPublicStoryLeak, sanitizePublicStoryText } from '../packages/agent-runtime/public-narration.ts';
import { deterministicProvider } from '../packages/agent-runtime/provider.ts';
import { storyDeterministicGenerator } from '../packages/agent-runtime/deterministic.ts';
import { createActiveStory, fixture } from './helpers.ts';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()!(); });

describe('public story boundary', () => {
  it('removes private XML blocks and engine meta-language from legacy prose', () => {
    const source = '<private_reasoning>先说明不能替主角选择。</private_reasoning>雨线敲在窗沿。是否发出，以及是否改用其他内部流程，仍由玩家决定。林砚把信封压在掌下。';
    const clean = sanitizePublicStoryText(source);
    expect(clean).toBe('雨线敲在窗沿。林砚把信封压在掌下。');
    expect(containsPublicStoryLeak(clean)).toBe(false);
  });

  it('uses XML-separated prompts and blocks leaked reasoning before scene publication', async () => {
    const value = await fixture(); cleanups.push(value.close); const storyId = await createActiveStory(value, 'modern_mystery');
    const base = deterministicProvider(storyDeterministicGenerator); let narratorPrompt = '';
    const runtime = new StoryRuntime(value.store, () => ({ name: 'deterministic', async run(role: string, prompt: string, schema: any, signal?: AbortSignal) {
      if (role === 'Narrator Agent') {
        narratorPrompt = prompt;
        return schema.parse({
          title: '寄出之前',
          prose: '<thinking>候选事实已经提交，所以现在等待玩家。</thinking>临时办公室只剩台灯亮着。草案停在发送前，是否发出仍由玩家决定。苏晚把两份记录并排放好。',
          summary: '结构化状态变更完成，等待玩家选择。',
          choices: ['由玩家决定是否发出', '继续核对时间记录'],
        });
      }
      return base.run(role, prompt, schema, signal);
    } }));
    const turn = await value.store.enqueueTurn(storyId, '与苏晚核对记录。', 'test', 'public-boundary-0001'); await runtime.runTurn(turn.id);
    const finished = await value.store.turn(turn.id);
    expect(narratorPrompt).toContain('<private_engine_context visibility="private" publish="never">');
    expect(narratorPrompt).toContain('<public_story_requirements>');
    expect(narratorPrompt).toContain('<public_output_contract visibility="public">');
    expect(finished.status).toBe('completed');
    expect(finished.scene?.prose).toBe('临时办公室只剩台灯亮着。苏晚把两份记录并排放好。');
    expect(finished.scene?.summary).not.toMatch(/玩家|结构化|状态变更/);
    expect(finished.scene?.choices).toEqual(['继续核对时间记录']);
    expect(containsPublicStoryLeak(finished.scene?.prose ?? '')).toBe(false);
  });

  it('publishes a prose-only polish while preserving all non-prose scene fields', async () => {
    const value = await fixture(); cleanups.push(value.close); const storyId = await createActiveStory(value, 'modern_mystery'); const state = await value.store.state(storyId); const protagonist = state.characters.find(character => character.importance === 'protagonist')!; const heroine = state.characters.find(character => character.roleTags.includes('heroine'))!;
    const base = deterministicProvider(storyDeterministicGenerator); let polishPrompt = '';
    const runtime = new StoryRuntime(value.store, () => ({ name: 'deterministic', async run(role: string, prompt: string, schema: any, signal?: AbortSignal) {
      if (role === 'Narrator Agent') return schema.parse({ title: '灯下核对', prose: `${protagonist.name}与${heroine.name}在${protagonist.location}核对了两份记录。窗外雨声很轻。`, summary: '两人核对记录。', choices: ['查看下一份记录'] });
      if (role === 'Polish Agent') { polishPrompt = prompt; return schema.parse({ prose: `${protagonist.name}与${heroine.name}在${protagonist.location}逐页核对两份记录。窗外的雨声轻轻掠过檐角。` }); }
      return base.run(role, prompt, schema, signal);
    } }));
    const turn = await value.store.enqueueTurn(storyId, '核对两份记录。', 'test', 'polish-prose-0001'); await runtime.runTurn(turn.id); const finished = await value.store.turn(turn.id);
    expect(polishPrompt).toContain('<draft_narration>'); expect(polishPrompt).toContain('<polish_constraints>');
    expect(finished.scene).toMatchObject({ title: '灯下核对', summary: '两人核对记录。', choices: ['查看下一份记录'] });
    expect(finished.scene?.prose).toContain('逐页核对'); expect(finished.steps.some(step => step.name === 'polishing' && step.agentRole === 'Polish Agent')).toBe(true);
  });

  it('can disable polishing for future scenes through the versioned story setting', async () => {
    const value = await fixture(); cleanups.push(value.close); const storyId = await createActiveStory(value); const state = await value.store.state(storyId); await value.store.updateConfig(storyId, 'test', { ...state.config, polishMode: 'off' });
    const turn = await value.store.enqueueTurn(storyId, '直接生成正文。', 'test', 'polish-off-0001'); await value.runtime.runTurn(turn.id); const finished = await value.store.turn(turn.id);
    expect(finished.status).toBe('completed'); expect(finished.steps.some(step => step.name === 'polishing')).toBe(false);
  });
});
