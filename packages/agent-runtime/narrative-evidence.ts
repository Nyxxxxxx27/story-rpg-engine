import { narrationSchema, type CanonicalFact, type Narration } from '../contracts/index.ts';

const allowed = (fact: CanonicalFact) => fact.visibility !== 'private' && ['fact', 'character', 'relationship'].includes(String(fact.payload?.type));
export function bindExactEvidence(input: Narration, facts: CanonicalFact[]): Narration {
  const narration = narrationSchema.parse(input);
  if (!narration.claims.length) {
    narration.claims = facts.filter(f => allowed(f) && narration.prose.includes(f.text)).slice(0, 40).map(f => ({
      id: `claim_${f.id.replaceAll('-', '')}`, text: f.text, factIds: [f.id],
      mode: f.kind === 'dialogue' ? 'reported' as const : /可能|据说|怀疑|未确认/.test(f.text) ? 'uncertain' as const : 'event' as const,
      speakerId: null,
    }));
  }
  if (!narration.segments.length) narration.segments = narration.prose.split(/\n\n+/).filter(Boolean).map((text, i) => ({ id: `paragraph_${i + 1}`, text, claimIds: narration.claims.filter(c => text.includes(c.text)).map(c => c.id) }));
  return narration;
}
export function checkNarrativeEvidence(narration: Narration, facts: CanonicalFact[]): string[] {
  const issues: string[] = []; const byId = new Map(facts.filter(allowed).map(f => [f.id, f]));
  if (!narration.claims.length && facts.some(f => allowed(f))) issues.push('正文缺少关键陈述的事实引用');
  const claims = new Map(narration.claims.map(c => [c.id, c]));
  if (claims.size !== narration.claims.length) issues.push('陈述 ID 重复');
  if (new Set(narration.segments.map(s => s.id)).size !== narration.segments.length) issues.push('段落 ID 重复');
  if (narration.segments.map(s => s.text).join('\n\n') !== narration.prose) issues.push('段落与最终正文不一致');
  for (const claim of narration.claims) {
    const support = claim.factIds.map(id => byId.get(id));
    if (support.some(f => !f)) issues.push(`无效或非公开事实引用：${claim.id}`);
    if (!narration.prose.includes(claim.text)) issues.push(`最终正文缺少已绑定陈述：${claim.id}`);
    if (!narration.segments.some(s => s.claimIds.includes(claim.id) && s.text.includes(claim.text))) issues.push(`陈述未绑定到对应段落：${claim.id}`);
    if (claim.mode === 'event' && support.length && support.every(f => f?.kind === 'dialogue' || /可能|据说|声称|怀疑|未确认/.test(f?.text ?? ''))) issues.push(`人物说法或猜测被升级为客观事件：${claim.id}`);
    if (claim.speakerId && support.every(f => !(f?.tags.includes(claim.speakerId!) || JSON.stringify(f?.payload).includes(claim.speakerId!)))) issues.push(`说话人缺少来源：${claim.id}`);
  }
  for (const segment of narration.segments) if (segment.claimIds.some(id => !claims.has(id))) issues.push(`段落引用未知陈述：${segment.id}`);
  return issues;
}
