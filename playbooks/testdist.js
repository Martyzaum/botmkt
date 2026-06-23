// Playbook de teste — só distribui sessions e telefones (sem rodar .bat).
export const meta = { name: 'testdist', description: 'testa a distribuição round-robin' };
export default async function ({ distribute, log, args }) {
  const batch = args.batch || 'test';
  log('distribuindo sessions...');
  const s = await distribute(batch, 'sessions');
  for (const r of s.results) log(`  ${r.agent}: ${r.stdout} ${r.stderr ? '(' + r.stderr + ')' : ''}`);
  log('distribuindo telefones...');
  const t = await distribute(batch, 'telefones');
  for (const r of t.results) log(`  ${r.agent}: ${r.stdout} ${r.stderr ? '(' + r.stderr + ')' : ''}`);
  return { batch, ok: true, leftover: { sessions: s.leftover, telefones: t.leftover } };
}
