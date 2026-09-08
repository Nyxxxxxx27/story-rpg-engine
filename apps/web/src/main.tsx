import { Mechanics,NpcActivity,GraphEditor } from './mechanics.tsx';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Activity, Archive, BookOpen, Bot, ChevronRight, Clock3, Compass, LoaderCircle, Pause, Play, Plus, RefreshCw, Send, Settings, Sparkles, Target, Users } from 'lucide-react';
import type { OutlineDraft, StoryStateView, StoryStage, StoryTurn } from '../../../packages/contracts/index.ts';
import { sanitizePublicStoryText } from '../../../packages/agent-runtime/public-narration.ts';
import './styles.css';
import { Experience, Evidence, Saves } from './experience.tsx';

const conflictMessages: Record<string, string> = {
  STALE_OPTION: '这个选项已失效，已尝试刷新当前场景。', STALE_DECISION: '这个选择已失效，请查看当前场景。',
  CHOICE_ALREADY_RESOLVED: '这个选择已经确认，不能更改。', CHOICE_ID_REQUIRED_OR_STALE: '无法确定当前选择，请刷新后重试。',
  IDEMPOTENCY_CONFLICT: '重复请求的内容不同，请刷新后重新提交。', STORY_BUSY: '当前回合仍在处理中，请稍候。',
  PLAYER_CHOICE_REQUIRED: '请先确认当前选择。', STALE_STAGE: '阶段已更新，请使用最新内容重试。',
  STAGE_DEADLINE_REQUIRES_REVIEW: '请先延长期限或结束当前阶段。', STAGE_PROPOSAL_REQUIRES_REVIEW: '请先确认是否进入下一阶段。',
  DEADLINE_MUST_BE_FUTURE: '新的截止时间必须晚于当前故事时间。', AUTOPLAY_SCENE_LIMIT: '本次托管已达到场景上限，可以重新开启托管。',
  STORY_NOT_ACTIVE: '故事尚未开始或已经结束。', USE_NARRATION_RETRY: '行动已提交，请使用重新生成正文。',
};

async function api<T = any>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api/v2${path}`, { ...init, headers: { ...(init?.body ? { 'content-type': 'application/json' } : {}), ...init?.headers } });
  const text = await response.text(); let body: any = {};
  try { body = text ? JSON.parse(text) : {}; } catch { throw new Error(response.ok ? '服务返回了无效响应。' : `剧情服务暂时不可用（HTTP ${response.status}）。`); }
  if (!response.ok) throw new Error(conflictMessages[body.code] ?? body.error?.message ?? body.error ?? `请求失败 (${response.status})`); return body;
}
const post = <T,>(path: string, body?: unknown) => api<T>(path, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) });
const genreNames: Record<string, string> = { cultivation: '修仙', western_fantasy: '西方奇幻', science_fiction: '科幻', modern_mystery: '现代悬疑', custom: '自定义' };
const statusNames: Record<string, string> = { queued: '排队', assembling: '组装上下文', directing: '场景策划', reviewing: '多 Agent 审查', repairing: '单次修订', committing: '提交事实', narrating: '生成正文', polishing: '润色文笔', verifying: '核对正文', narration_repair: '修订正文', summarizing: '更新投影', completed: '已完成', waiting_player: '等待关键抉择', failed: '失败' };
function storyTime(minutes: number) { const day = Math.floor(minutes / 1440) + 1, hour = Math.floor((minutes % 1440) / 60), minute = minutes % 60; return `第 ${day} 天 ${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`; }

function CreateStory({ onCreated }: { onCreated(id: string): void }) {
  const [form, setForm] = useState({ title: '未命名长篇', genre: 'western_fantasy', premise: '一段从偶然相遇开始、逐渐改变所有核心人物命运的长线故事。', tone: '沉浸、克制、重视人物关系与选择后果', provider: 'codex', advancedPrompt: '', romanceMode: 'organic' }); const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const create = async () => { setBusy(true); setError(''); try { const value = await post<{ storyId: string }>('/stories', { config: { ...form, pacing: 'balanced', worldRules: ['重要结果必须由场景和已提交事实支持'], terminology: {}, contentBoundaries: [], storyPacks: [form.genre === 'cultivation' ? 'cultivation-hewan' : form.genre === 'western_fantasy' ? 'western-fantasy' : 'generic-story'] } }); onCreated(value.storyId); } catch (e) { setError(String(e instanceof Error ? e.message : e)); } finally { setBusy(false); } };
  return <main className="empty"><div className="create-card"><div className="eyebrow"><Sparkles size={14}/> 新故事</div><h1>建立一个会记住后果的世界</h1><details><summary>恢复已有存档</summary><Saves/></details><p>先定义体系与长期方向，再让动态角色 Agent 在固定流水线中推进细节。</p><div className="form-grid"><label>故事标题<input value={form.title} onChange={e => setForm({ ...form, title: e.target.value })}/></label><label>题材<select value={form.genre} onChange={e => setForm({ ...form, genre: e.target.value })}>{Object.entries(genreNames).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label><label className="wide">开局前提<textarea value={form.premise} onChange={e => setForm({ ...form, premise: e.target.value })}/></label><label>基调<input value={form.tone} onChange={e => setForm({ ...form, tone: e.target.value })}/></label><label>恋爱玩法<select value={form.romanceMode} onChange={e => setForm({ ...form, romanceMode: e.target.value })}><option value="organic">允许自然发展</option><option value="player_led">由玩家触发</option><option value="off">关闭</option></select></label><label>Agent Provider<select value={form.provider} onChange={e => setForm({ ...form, provider: e.target.value })}><option value="codex">Codex（本地账户）</option><option value="openai">OpenAI API（显式付费）</option><option value="deterministic">确定性测试</option></select></label><label className="wide">高级 Prompt（可选）<textarea placeholder="补充本故事的叙事偏好；不能覆盖引擎事实规则。" value={form.advancedPrompt} onChange={e => setForm({ ...form, advancedPrompt: e.target.value })}/></label></div>{error && <p className="error">{error}</p>}<button className="primary" disabled={busy} onClick={create}>{busy ? <LoaderCircle className="spin" size={17}/> : <Plus size={17}/>}创建故事草稿</button></div></main>;
}

function OutlineWizard({ state, refresh }: { state: StoryStateView; refresh(): void }) {
  const [draft, setDraft] = useState<OutlineDraft | null>(state.outline); const [raw, setRaw] = useState(state.outline ? JSON.stringify(state.outline, null, 2) : ''); const [busy, setBusy] = useState(''); const [error, setError] = useState('');
  const generate = async () => { setBusy('正在调用开局策划 Agent…'); setError(''); try { const value = await post<OutlineDraft>(`/stories/${state.id}/outline/generate`); setDraft(value); setRaw(JSON.stringify(value, null, 2)); refresh(); } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(''); } };
  const save = async () => { setBusy('正在保存编辑…'); try { const value = JSON.parse(raw); await api(`/stories/${state.id}/outline`, { method: 'PUT', body: JSON.stringify(value) }); setDraft(value); refresh(); } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(''); } };
  const confirm = async () => { setBusy('正在建立世界…'); try { await post(`/stories/${state.id}/outline/confirm`, JSON.parse(raw)); refresh(); } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(''); } };
  return <main className="wizard"><div className="wizard-head"><div><div className="eyebrow"><Compass size={14}/> 开局向导 · {genreNames[state.config.genre]}</div><h1>{state.title}</h1><p>随机结果不会直接进入世界。你可以编辑、重新生成，确认后才建立人物与阶段。</p></div><button className="secondary" disabled={!!busy} onClick={generate}>{busy ? <LoaderCircle className="spin" size={16}/> : <RefreshCw size={16}/>} {draft ? '重新生成' : '随机生成大纲'}</button></div>{busy && <div className="notice"><LoaderCircle className="spin" size={17}/>{busy}</div>}{error && <div className="notice error">{error}</div>}{draft && <><section className="outline-summary"><article><span>长期主线</span><h2>{draft.arcObjective}</h2><p>{draft.stakes}</p></article><div className="stage-strip">{draft.stages.map((stage, i) => <div className="stage-chip" key={stage.title}><b>{String(i + 1).padStart(2, '0')}</b><span>{stage.title}</span></div>)}</div><div className="cast-row">{draft.characters.map(character => <div className="cast-mini" key={character.id}><div className="avatar">{character.name.slice(0, 1)}</div><div><b>{character.name}</b><small>{character.importance === 'protagonist' ? '主角' : '核心角色'}</small></div></div>)}</div></section><details className="json-editor"><summary>编辑完整大纲 JSON</summary><textarea value={raw} onChange={e => setRaw(e.target.value)} spellCheck={false}/><button className="secondary" onClick={save}>保存编辑</button></details><div className="confirm-bar"><span>确认后，历史事实将开始按版本记录。</span><button className="primary" disabled={!!busy} onClick={confirm}>确认大纲并开始 <ChevronRight size={17}/></button></div></>}</main>;
}

const processingStatuses = new Set(['queued', 'assembling', 'directing', 'reviewing', 'repairing', 'committing', 'narrating', 'summarizing']);
const validationNames = { rules: '规则检查通过', semantic: '语义检查通过', fallback: '本场显示事件简述' };
const outcomeNames: Record<string, string> = { success: '全部达成', partial: '部分达成', failure: '失败', abandoned: '主动结束' };

function Milestones({ stage }: { stage: StoryStage }) {
  return <ul className="milestones">{stage.milestones.map(item => <li key={item.id} className={item.status}>
    <span aria-label={item.status === 'achieved' ? '已达成' : '未达成'}>{item.status === 'achieved' ? '✓' : '○'}</span>
    <div>{item.criterion}{item.evidenceFactIds.length > 0 && <small>依据 {item.evidenceFactIds.length} 条事件记录</small>}</div>
  </li>)}</ul>;
}

function Overview({ state, refresh }: { state: StoryStateView; refresh(): void }) {
  const [input, setInput] = useState(''); const [busy, setBusy] = useState(false); const busyRef = useRef(false);
  const [duration, setDuration] = useState(1440); const [extension, setExtension] = useState(360);
  const [proposals, setProposals] = useState<Array<{ id: string; stage: StoryStage; reason: string }>>([]);
  const [error, setError] = useState(''); const [pendingTurnId, setPendingTurnId] = useState<string | null>(null);
  const inputRequest = useRef({ input: '', key: '' });
  const latest = state.scenes.at(-1), stage = state.activeStage, decision = state.pendingDecision;
  const inFlight = busy || !!pendingTurnId || !!(state.latestTurn && processingStatuses.has(state.latestTurn.status));
  const stageBlocked = !!stage?.awaitingDeadline || (!!stage && stage.status !== 'active');
  const canAct = !inFlight && !stageBlocked && state.status !== 'finished';
  useEffect(() => {
    let current = true;
    void api<{ proposals: typeof proposals }>(`/stories/${state.id}/stage-proposal`).then(value => { if (current) setProposals(value.proposals); }).catch(() => undefined);
    return () => { current = false; };
  }, [state.id, state.revision]);
  useEffect(() => {
    if (!pendingTurnId) return;
    if (state.latestTurn?.id === pendingTurnId && !processingStatuses.has(state.latestTurn.status)) { setPendingTurnId(null); return; }
    const timer = setInterval(() => { void api<StoryTurn>(`/stories/${state.id}/turns/${pendingTurnId}`).then(turn => {
      if (!processingStatuses.has(turn.status)) { setPendingTurnId(null); refresh(); }
    }).catch(() => undefined); }, 1500);
    return () => clearInterval(timer);
  }, [pendingTurnId, state.id, state.latestTurn?.id, state.latestTurn?.status]);
  const action = async (operation: () => Promise<void>) => {
    if (busyRef.current) return; busyRef.current = true; setBusy(true); setError('');
    try { await operation(); refresh(); } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); refresh(); }
    finally { busyRef.current = false; setBusy(false); }
  };
  const send = () => {
    if (!canAct || !input.trim()) return;
    if (inputRequest.current.input !== input) inputRequest.current = { input, key: `web-${crypto.randomUUID()}` };
    void action(async () => {
      const turn = await post<StoryTurn>(`/stories/${state.id}/turns`, { input, source: 'web', idempotencyKey: inputRequest.current.key });
      setPendingTurnId(turn.id); setInput(''); inputRequest.current = { input: '', key: '' };
    });
  };
  const choose = (option: { id: string; text: string }) => {
    if (!canAct || !latest) return;
    void action(async () => {
      if (decision) {
        const result = await post<{ continuationTurnId: string }>(`/stories/${state.id}/choices/resolve`, { decisionId: decision.id, optionId: option.id, idempotencyKey: `web-choice:${decision.id}:${option.id}` });
        setPendingTurnId(result.continuationTurnId);
      } else {
        const turn = await post<StoryTurn>(`/stories/${state.id}/turns`, { input: option.text, source: 'web', sceneId: latest.id, optionId: option.id, idempotencyKey: `web-option:${latest.id}:${option.id}` });
        setPendingTurnId(turn.id);
      }
    });
  };
  const handleDeadline = (kind: 'extend' | 'close') => { if (!stage) return; void action(async () => {
    await post(`/stories/${state.id}/stages/${stage.id}/deadline/resolve`, { revision: stage.revision, action: kind, ...(kind === 'extend' ? { deadlineMinutes: state.clock + extension } : {}), idempotencyKey: `deadline:${stage.id}:${stage.revision}:${kind}:${extension}` });
  }); };
  const publicOptions = decision && decision.sceneId === latest?.id ? decision.options : latest?.options ?? [];
  return <div className="dashboard-grid">
    <section className="scene-card panel">
      {latest ? <>
        <div className="panel-label"><BookOpen size={15}/> 最新场景 · {latest.location} · {storyTime(latest.endTime)}</div>
        <h1>{sanitizePublicStoryText(latest.title)}</h1><div className="prose">{sanitizePublicStoryText(latest.prose)}</div><Evidence scene={latest} storyId={state.id}/>
        {!stageBlocked && state.status !== 'finished' && (!latest.decisionId || decision?.id === latest.decisionId) && <div className="choice-list">{publicOptions.map(option => <button disabled={!canAct} key={option.id} onClick={() => choose(option)}>{sanitizePublicStoryText(option.text)}<ChevronRight size={14}/></button>)}</div>}
        <div className="scene-meta">参与：{latest.participants.map(id => state.characters.find(c => c.id === id)?.name ?? id).join('、')}</div>
        {latest.validation && <div className="validation-note"><span>{validationNames[latest.validation.mode]}</span>{latest.validation.mode === 'fallback' && <button className="ghost" disabled={inFlight} onClick={() => void action(async () => {
          const result = await post<{ turnId: string }>(`/stories/${state.id}/scenes/${latest.id}/narration/retry`, { idempotencyKey: `narration-${crypto.randomUUID()}` }); setPendingTurnId(result.turnId);
        })}>重新生成正文</button>}</div>}
      </> : <div className="first-scene"><BookOpen size={32}/><h2>故事尚未落笔</h2><p>从下方输入主角的第一个行动。</p></div>}
      {inFlight && <div className="notice" role="status"><LoaderCircle className="spin" size={16}/>正在推进这一场剧情…</div>}
      {state.status === 'finished' && <div className="notice" role="status">故事已结束 · {outcomeNames[stage?.outcome ?? ''] ?? '已结算'}</div>}
    </section>
    <aside className="rail">
      <section className="panel objective"><div className="panel-label"><Target size={15}/> 当前阶段</div><h3>{stage?.title}</h3><p>{stage?.objective}</p>
        <div className="progress"><i style={{ width: `${stage?.progress ?? 0}%` }}/></div><small>{stage?.progress ?? 0}% · 长期主线：{state.arc?.objective}</small>
        {stage && <Milestones stage={stage}/>} {stage?.deadlineMinutes != null && <p>截止：{storyTime(stage.deadlineMinutes)}</p>}
      </section>
      <section className="panel autoplay"><div className="panel-label"><Clock3 size={15}/> 剧情托管</div>
        {state.autoplay?.status === 'running' ? <><h3>推进中 · {state.autoplay.scenes} 场</h3><p>目标：{storyTime(state.autoplay.targetTime)}</p><button className="secondary" disabled={busy} onClick={() => void action(async () => { await api(`/stories/${state.id}/autoplay`, { method: 'DELETE' }); })}><Pause size={15}/>停止托管</button></> : <>
          {state.autoplay?.status === 'paused' && <><p>已暂停。选择后只执行一场。</p><button className="secondary" disabled={!canAct || !!decision} onClick={() => void action(async () => { await post(`/stories/${state.id}/autoplay/resume`); })}><Play size={15}/>继续托管</button></>}
          <select aria-label="托管时长" value={duration} onChange={e => setDuration(Number(e.target.value))}><option value={360}>6 小时</option><option value={1440}>1 天</option><option value={4320}>3 天</option><option value={10080}>7 天</option></select>
          <button className="secondary" disabled={!canAct || !!decision} onClick={() => void action(async () => { await post(`/stories/${state.id}/autoplay`, { durationMinutes: duration, maxScenes: 50 }); })}><Play size={15}/>开始托管</button>
        </>}
      </section>
    </aside>
    {stage?.awaitingDeadline && <section className="deadline panel"><h3>阶段期限已到</h3><p>目前达成 {stage.milestones.filter(item => item.status === 'achieved').length}/{stage.milestones.length} 项。延长期限或按当前成果结束这一阶段。</p>
      <label>延长分钟数<input type="number" min={1} max={43200} value={extension} onChange={e => setExtension(Number(e.target.value))}/></label>
      <div className="action-row"><button className="primary" disabled={inFlight || !Number.isInteger(extension) || extension < 1} onClick={() => handleDeadline('extend')}>延长期限</button><button className="secondary" disabled={inFlight} onClick={() => handleDeadline('close')}>按当前成果结束</button></div>
    </section>}
    {!stage?.awaitingDeadline && proposals.map(proposal => <section key={proposal.id} className="proposal panel"><div><div className="panel-label"><Sparkles size={15}/> 下一阶段提案</div><h3>{proposal.stage.title}</h3><p>{proposal.reason}</p></div><div><button className="ghost" disabled={inFlight} onClick={() => void action(async () => { await post(`/stories/${state.id}/stage-proposal/${proposal.id}/review`, { decision: 'reject' }); })}>暂不进入</button><button className="primary" disabled={inFlight} onClick={() => void action(async () => { await post(`/stories/${state.id}/stage-proposal/${proposal.id}/review`, { decision: 'accept' }); setProposals([]); })}>确认进入</button></div></section>)}
    {state.latestTurn?.error && ['failed', 'narrating', 'summarizing'].includes(state.latestTurn.status) && <div className="notice error"><span>{state.latestTurn.error}</span><button className="secondary" onClick={() => void action(async () => { const result = await post<{ turnId: string }>(`/stories/${state.id}/turns/${state.latestTurn!.id}/retry`, { idempotencyKey: `retry-${crypto.randomUUID()}` }); setPendingTurnId(result.turnId); })} disabled={busy}>重试本回合</button></div>}
    {error && <div className="notice error" role="alert">{error}</div>}
    <section className="composer panel"><textarea disabled={!canAct} value={input} onChange={e => setInput(e.target.value)} placeholder="描述主角的行动、回应或想调查的方向…" onKeyDown={e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) send(); }}/><button aria-label="发送行动" className="send" disabled={!canAct || !input.trim()} onClick={send}>{inFlight ? <LoaderCircle className="spin" size={19}/> : <Send size={19}/>}</button><small>Ctrl + Enter 发送 · 每次行动推进一场 · 手动输入会暂停托管</small></section>
  </div>;
}

function Progress({ state }: { state: StoryStateView }) {
  return <section className="page panel"><div className="page-title"><Target/><div><h1>剧情进展</h1><p>{state.arc?.objective}</p></div></div><div className="timeline">{state.stages.filter(stage=>stage.status!=='planned').map((stage, index) => <article className={`timeline-item ${stage.status}`} key={stage.id}>
    <div className="node">{index + 1}</div><div><div className="stage-line"><h2>{stage.title}</h2><span>{stage.outcome ? outcomeNames[stage.outcome] : stage.status === 'active' ? '进行中' : '未开始'} · {stage.progress}%</span></div><p>{stage.objective}</p><Milestones stage={stage}/>
      {stage.legacyProgress !== null && <small>旧存档历史进度：{stage.legacyProgress}%。未完成目标按新证据核验。</small>}
      {stage.deadlineMinutes !== null && <p>截止：{storyTime(stage.deadlineMinutes)}</p>}
    </div></article>)}</div></section>;
}
function Characters({ state }: { state: StoryStateView }) { return <section className="page"><div className="page-title"><Users/><div><h1>核心角色</h1><p>主角与核心角色始终进入上下文摘要；本场出场者使用完整档案运行独立 Agent。</p></div></div><div className="character-grid">{state.characters.filter(c => ['protagonist', 'core'].includes(c.importance)).map(character => { const relations = state.relationships.filter(r => r.from === character.id || r.to === character.id); return <article className="character panel" key={character.id}><header><div className="avatar large">{character.name.slice(0, 1)}</div><div><h2>{character.name}</h2><div className="tags">{character.roleTags.map(tag => <span key={tag}>{tag}</span>)}</div></div><b className="spotlight">{character.spotlight}</b></header><dl><div><dt>当前位置</dt><dd>{character.location}</dd></div><div><dt>状态</dt><dd>{character.condition} · {character.mood}</dd></div><div><dt>当前目标</dt><dd>{character.currentGoal}</dd></div><div><dt>近期剧情</dt><dd>{character.recentBeat}</dd></div><div><dt>未解决事项</dt><dd>{character.unresolvedHooks.join('；') || '暂无'}</dd></div></dl>{relations.map(relation => <div className="relation" key={relation.id}><span>信任 {relation.trust}</span><span>亲近 {relation.affinity}</span><span>张力 {relation.tension}</span><small>{relation.summary}</small></div>)}</article>; })}</div></section>; }
function World({ state }: { state: StoryStateView }) { return <section className="page"><div className="page-title"><Archive/><div><h1>世界档案</h1><p>{state.config.premise}</p></div></div><div className="world-grid"><article className="panel"><h2>世界规则</h2>{state.config.worldRules.map(item => <p key={item}>· {item}</p>)}<h2>故事包</h2><div className="tags">{state.config.storyPacks.map(pack => <span key={pack}>{pack}</span>)}</div></article><article className="panel facts"><h2>规范事实</h2>{state.facts.slice().reverse().map(fact => <div key={fact.id}><b>#{fact.seq}</b><span>{fact.text}</span><small>{storyTime(fact.time)} · {fact.sourceTurnId.slice(0, 8)}</small></div>)}</article></div></section>; }
function Agents({ state }: { state: StoryStateView }) { const turn = state.latestTurn; return <section className="page panel"><div className="page-title"><Bot/><div><h1>Agent 运行</h1><p>只展示节点、耗时和结构化结论，不展示私密思维链。</p></div></div>{turn ? <><div className={`turn-status ${turn.status}`}><Activity size={16}/>{statusNames[turn.status] ?? turn.status}<span>{turn.source} · {turn.id.slice(0, 8)}</span></div><div className="steps">{turn.steps.map(step => <article key={step.id}><i className={step.status}/><div><b>{step.agentRole}</b><small>{statusNames[step.name] ?? step.name} · {step.completedAt ? `${step.completedAt - step.startedAt} ms` : '运行中'}</small><p>{step.summary}</p></div></article>)}</div>{turn.error && <div className="notice error">{turn.error}</div>}</> : <p>尚无回合。</p>}</section>; }
function SettingsPage({ state, refresh }: { state: StoryStateView; refresh(): void }) { const [config, setConfig] = useState(state.config); const save = async () => { await api(`/stories/${state.id}/config`, { method: 'PUT', body: JSON.stringify(config) }); refresh(); }; return <section className="page panel settings"><div className="page-title"><Settings/><div><h1>故事设置</h1><p>修改会创建新的 Prompt 版本，只影响未来场景。</p></div></div><label>Agent Provider<select value={config.provider} onChange={e => setConfig({ ...config, provider: e.target.value as any })}><option value="codex">Codex App Server</option><option value="openai">OpenAI API（需密钥）</option><option value="deterministic">确定性测试</option></select></label><label>恋爱玩法<select value={config.romanceMode} onChange={e => setConfig({ ...config, romanceMode: e.target.value as any })}><option value="organic">允许自然发展</option><option value="player_led">由玩家触发</option><option value="off">关闭</option></select></label><label>普通观察与闲聊的审查<select value={config.fastReview?'fast':'full'} onChange={e=>setConfig({...config,fastReview:e.target.value==='fast'})}><option value="fast">合并审查，发现风险时升级</option><option value="full">始终完整审查</option></select></label><label>正式输出前润色<select value={config.polishMode} onChange={e => setConfig({ ...config, polishMode: e.target.value as any })}><option value="standard">开启：只润色文笔</option><option value="off">关闭：直接使用正文草稿</option></select></label><label>高级 Prompt<textarea value={config.advancedPrompt} onChange={e => setConfig({ ...config, advancedPrompt: e.target.value })}/></label><label>内容边界<textarea value={config.contentBoundaries.join('\n')} onChange={e => setConfig({ ...config, contentBoundaries: e.target.value.split('\n').filter(Boolean) })}/></label><button className="primary" onClick={save}>保存为新版本</button></section>; }

function Workspace({ state, refresh, stories, select }: { state: StoryStateView; refresh(): void; stories: any[]; select(id: string): void }) { const [tab, setTab] = useState('overview'); const core = state.characters.find(c => c.importance === 'core'); return <div className="shell"><aside className="sidebar"><div className="brand"><div className="brand-mark">S</div><div><b>Story Engine</b><small>LONG FORM RPG</small></div></div><button className="new-story" onClick={() => select('')}><Plus size={16}/> 新故事</button><div className="story-list">{stories.map(story => <button className={story.id === state.id ? 'active' : ''} key={story.id} onClick={() => select(story.id)}><BookOpen size={15}/><span>{story.title}<small>{storyTime(story.clock)}</small></span></button>)}</div><nav>{[['overview', BookOpen, '故事'], ['history', Archive, '历史与记忆'], ['progress', Target, '进展'], ['resources', Activity, '角色面板'], ['npcs', Users, '人物动态'], ['characters', Users, '核心角色'], ['world', Archive, '世界档案'], ['agents', Bot, 'Agent'], ['settings', Settings, '设置']].map(([id, Icon, label]: any) => <button className={tab === id ? 'active' : ''} key={id} onClick={() => setTab(id)}><Icon size={17}/>{label}</button>)}</nav><div className="sidebar-foot"><span className="online"/> story-v2 · 本地运行</div></aside><main className="workspace"><header className="topbar"><div><small>{genreNames[state.config.genre]} · {state.branch}</small><h2>{state.title}</h2></div><div className="top-status"><div><Clock3 size={15}/><span>{storyTime(state.clock)}</span></div>{core && <div><div className="avatar tiny">{core.name.slice(0, 1)}</div><span>{core.name} · {core.condition}</span></div>}<button onClick={refresh}><RefreshCw size={16}/></button></div></header><div className="content">{tab === 'overview' && <Overview key={state.id} state={state} refresh={refresh}/>} {tab === 'history' && <Experience key={state.id} state={state} refresh={refresh}/>} {tab === 'progress' && <><Progress state={state}/><GraphEditor key={state.outline?.graph?.revision} state={state} refresh={refresh}/></>} {tab === 'resources' && <Mechanics state={state} refresh={refresh}/>} {tab === 'npcs' && <NpcActivity state={state}/>} {tab === 'characters' && <Characters state={state}/>} {tab === 'world' && <World state={state}/>} {tab === 'agents' && <Agents state={state}/>} {tab === 'settings' && <SettingsPage key={state.id} state={state} refresh={refresh}/>}</div></main></div>; }

function App() { const [stories, setStories] = useState<any[]>([]); const [selected, setSelected] = useState(localStorage.getItem('story-id') ?? ''); const [state, setState] = useState<StoryStateView | null>(null); const [loading, setLoading] = useState(true); const loadList = async () => { const value = await api<{ stories: any[] }>('/stories'); setStories(value.stories); return value.stories; }; const refresh = async () => { if (!selected) return; try { setState(await api(`/stories/${selected}`)); } catch { /* SSE reconnects after a bounded service restart. */ } finally { setLoading(false); } };
  useEffect(()=>{const restore=(event:Event)=>{const id=(event as CustomEvent<string>).detail;setSelected(id);localStorage.setItem('story-id',id);void loadList();};window.addEventListener('srpg:open-save',restore);return()=>window.removeEventListener('srpg:open-save',restore);},[]);
  useEffect(() => { void loadList().then(list => { if (!selected && list[0]) setSelected(list[0].id); else setLoading(false); }).catch(() => setLoading(false)); }, []); useEffect(() => { if (!selected) { setState(null); setLoading(false); localStorage.removeItem('story-id'); return; } localStorage.setItem('story-id', selected); setLoading(true); void refresh().catch(() => undefined); const events = new EventSource(`/api/v2/stories/${selected}/events`); events.addEventListener('state', event => { setState(JSON.parse((event as MessageEvent).data)); void loadList().catch(() => undefined); setLoading(false); }); return () => events.close(); }, [selected]);
  if (loading) return <div className="loading"><LoaderCircle className="spin"/><span>正在读取世界状态</span></div>; if (!selected || !state) return <CreateStory onCreated={id => { setSelected(id); void loadList().catch(() => undefined); }}/>; if (state.status === 'draft') return <OutlineWizard state={state} refresh={refresh}/>; return <Workspace state={state} refresh={refresh} stories={stories} select={setSelected}/>; }
createRoot(document.getElementById('root')!).render(<React.StrictMode><App/></React.StrictMode>);
