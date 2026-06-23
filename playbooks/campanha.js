// =====================================================================
//  Playbook CAMPANHA — fluxo completo nas 4 VPS, via scripts node
//  (sem pause / sem janela) em Desktop\neymarlol-scripts.
//
//  Aciona com:
//     node cli.js play campanha '{"batch":"camp-2026-06-23"}'
//
//  Pré-requisito: já ter subido os arquivos do batch:
//     node cli.js upload camp-2026-06-23 sessions  "C:\local\sessions"
//     node cli.js upload camp-2026-06-23 telefones "C:\local\telefones"
//
//  Args opcionais:
//     setup        true = faz SESSIONS (movimenta+renomear) antes. default false.
//     startTimeout ms de janela do start-all (default 45min). >= GLOBAL_MS do start-all.
//     inactivity   ms sem log p/ o supervisor marcar TRAVADO (default 240000).
// =====================================================================

// Pasta dos scripts node dentro de cada VPS (deploy uma vez via RDP / upload).
const NEY = '$env:USERPROFILE\\Desktop\\neymarlol-scripts';
const node = (f, env = '') => `${env ? env + ' ' : ''}node "${NEY}\\${f}"`;

export const meta = { name: 'campanha', description: 'Distribui sessions+telefones e roda o fluxo (node) nas 4 VPS' };

export default async function ({ distribute, run, runAll, log, args }) {
  const batch = args.batch;
  if (!batch) throw new Error('passe o batch: play campanha \'{"batch":"..."}\'');
  const startTimeout = Number(args.startTimeout || 45 * 60 * 1000);
  const inactivity = Number(args.inactivity || 4 * 60 * 1000);

  // roda um script node em todas as VPS e loga exit code de cada uma
  const runStep = async (label, cmd, opts = {}) => {
    log(`▶ ${label}`);
    const results = await runAll(cmd, opts);
    for (const r of results)
      log(`   ${r.agent}: exit=${r.code}${r.stderr ? ' err=' + r.stderr.slice(0, 160) : ''}`);
    const falhas = results.filter((r) => r.code !== 0);
    if (falhas.length) log(`   ⚠ ${falhas.length} VPS com erro em ${label}`);
    return results;
  };

  // 1) SESSIONS (só no setup): distribui e processa
  if (args.setup) {
    log('=== SESSIONS (setup) ===');
    const ds = await distribute(batch, 'sessions');
    for (const r of ds.results) log(`   ${r.agent}: ${r.stdout}`);
    await runStep('MOVIMENTA SESSIONS', node('movimenta-sessions.js'));
    await runStep('RENOMEAR SESSIONS', node('renomear-sessions.js'));
  }

  // 2) TELEFONES: distribui e processa (a cada onda)
  log('=== TELEFONES ===');
  const dt = await distribute(batch, 'telefones');
  for (const r of dt.results) log(`   ${r.agent}: ${r.stdout}`);
  await runStep('MOVIMENTA TELEFONES', node('movimenta-numeros.js'));
  await runStep('RENOMEAR TELEFONES', node('renomear-numeros.js'));

  // 3) START-ALL: sobe os 16 slots e espera o veredito de cada um.
  //    janela longa (startTimeout) — o start-all tem teto proprio por slot.
  log('=== START-ALL (aguardando os slots terminarem) ===');
  const startCmd = node('start-all.js', `$env:INACTIVITY_MS=${inactivity};`);
  const results = await runAll(startCmd, { timeoutMs: startTimeout });

  const resumoPorVps = [];
  for (const r of results) {
    const m = (r.stdout || '').match(/RESULTADO_JSON (\{.*\})/);
    let resumo = null;
    if (m) { try { resumo = JSON.parse(m[1]); } catch { /* ignore */ } }
    if (resumo) {
      log(`   ${r.agent}: sucesso=${resumo.sucesso.length} travado=[${resumo.travado.join(',')}] erro=[${resumo.erro.join(',')}]`);
      resumoPorVps.push({ agent: r.agent, ...resumo });
    } else {
      log(`   ${r.agent}: SEM RESUMO (exit=${r.code})${r.stderr ? ' err=' + r.stderr.slice(0, 160) : ''}`);
      resumoPorVps.push({ agent: r.agent, semResumo: true, code: r.code });
    }
  }

  // slots que precisam de atenção (travado/erro) — entrada pro tratamento de erro/proxima onda
  const problemas = resumoPorVps.flatMap((v) =>
    v.semResumo
      ? [{ agent: v.agent, slot: '*', status: 'sem-resumo' }]
      : [...(v.travado || []).map((s) => ({ agent: v.agent, slot: s, status: 'travado' })),
         ...(v.erro || []).map((s) => ({ agent: v.agent, slot: s, status: 'erro' }))]
  );
  if (problemas.length) log(`⚠ ${problemas.length} slot(s) com problema: ` +
    problemas.map((p) => `${p.agent}#${p.slot}(${p.status})`).join(', '));
  else log('✔ todos os slots concluíram com sucesso');

  // 4) TRATAMENTO DE ERRO por VPS: move TELEFONES-XXX dos slots travados/erro
  //    para 'TELEFONES ERRO' e limpa o BROADCAST.txt desses slots.
  if (args.tratarErros !== false) {
    for (const v of resumoPorVps) {
      if (v.semResumo) continue;
      const ruins = [...(v.travado || []), ...(v.erro || [])];
      if (!ruins.length) continue;
      log(`▶ tratando erros em ${v.agent}: slots ${ruins.join(',')}`);
      const cmd = node('tratar-erros.js', `$env:SLOTS_ERRO='${ruins.join(',')}';`);
      const r = await run(v.agent, cmd);
      log(`   ${v.agent}: exit=${r.code}${r.stderr ? ' err=' + r.stderr.slice(0, 160) : ''}`);
      if (r.stdout) for (const ln of r.stdout.trim().split(/\r?\n/)) log(`     ${ln}`);
    }
  }

  return { batch, vps: resumoPorVps, problemas };
}
