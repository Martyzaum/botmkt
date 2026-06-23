// teste: distribui só telefones (valida agrupamento de pares)
export const meta = { name: 'teldist', description: 'teste telefones' };
export default async function teldist({ distribute, log, args }) {
  const t = await distribute(args.batch || 'pares', 'telefones');
  for (const r of t.results) log(`  ${r.agent}: ${r.stdout}`);
  return { leftover: t.leftover };
}
