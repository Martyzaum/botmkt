// =====================================================================
//  Playbook CAMPANHA-FILA — modelo PULL em ondas, com troca de sessions.
//
//  A fila do batch (1 número = 1 par) é consumida por TODAS as VPS do
//  tenant em paralelo: cada VPS faz lease(16) -> roda a onda -> commit,
//  em loop, até a fila secar. Balanceia sozinho.
//
//  SETUP (1x por VPS): manda o zip de sessions daquela VPS pro pool
//  (Desktop\sessions). Cada zip vem de um upload separado por agente.
//
//  Ciclo de uma onda (por VPS) — sessions E telefones rodam TODA onda:
//    sync 16 pares de telefone
//    -> limpar-broadcast (sempre, no começo)
//    -> limpar-telefones -> renomear-telefones -> limpar-telefones  (reset dos slots)
//    -> limpar-sessions  (pra rotacionar; renomear-sessions pula se 'session' existe)
//    -> movimenta-telefones
//    -> movimenta-sessions  (se o pool secou, devolve os telefones à fila e para)
//    -> renomear-sessions -> renomear-telefones
//    -> start-all
//    -> commit (sucessos saem; erros voltam p/ retry → re-sync no próximo lease)
//    -> grava no banco
//  O retry da fila já reenvia o número que falhou; tratar-erros (descarte p/
//  TELEFONES ERRO) NÃO é usado aqui de propósito.
//
//  Aciona:
//     node cli.js play campanha-fila '{"batch":"acme-2026","tenant":"acme"}'
//
//  Args opcionais:
//     tenant       processa só as VPS desse tenant (default: todas)
//     skipSetup    true = não reenvia as sessions (pool já está na VPS)
//     wave         pares por onda (default 16)
//     inactivity   ms sem log p/ TRAVADO (default 240000)
//     startTimeout ms de janela do start-all (default 2700000 = 45min)
//     agents       lista de VPS específicas (sobrepõe tenant)
// =====================================================================

const NEY = '$env:USERPROFILE\\Desktop\\neymarlol-scripts';
const node = (f, env = '') => `${env ? env + ' ' : ''}node "${NEY}\\${f}"`;
const parseResumo = (stdout) => {
  const m = (stdout || '').match(/RESULTADO_JSON (\{.*\})/);
  if (!m) return null;
  try { return JSON.parse(m[1]); } catch { return null; }
};
// quantas sessions o movimenta-sessions moveu nesta rodada (0 = pool seco)
const movedSessions = (stdout) => {
  const m = (stdout || '').match(/processadas nesta rodada:\s*(\d+)/i);
  if (m) return Number(m[1]);
  if (/Nenhuma subpasta/i.test(stdout || '')) return 0;
  return null; // desconhecido -> segue
};

export const meta = { name: 'campanha-fila', description: 'Loop pull em ondas (sessions+telefones) por tenant' };

export default async function ({ agents, tenantAgents, distribute, lease, returnLease, retryLease, syncTelefones, syncConteudo, commitUnits, queueStatus, recordWave, run, log, args }) {
  const batch = args.batch;
  if (!batch) throw new Error('passe o batch: play campanha-fila \'{"batch":"..."}\'');
  const WAVE = Number(args.wave || 16);
  const maxRetries = Number(args.maxRetries || 3);
  const inactivity = Number(args.inactivity || 4 * 60 * 1000);
  const startTimeout = Number(args.startTimeout || 45 * 60 * 1000);
  const ags = args.agents && args.agents.length
    ? args.agents
    : (args.tenant ? tenantAgents(args.tenant) : agents());
  if (!ags.length) throw new Error(`nenhum agente disponível${args.tenant ? ` para o tenant '${args.tenant}'` : ''}`);

  // SETUP (1x por VPS): sessions pro pool + conteúdo (texto+video) nos DADOS
  if (!args.skipSetup) {
    log('=== SETUP: sessions + conteúdo (1x por VPS) ===');
    await Promise.all(ags.map(async (agent) => {
      // sessions -> Desktop\sessions (pool)
      try {
        const ds = await distribute(`${batch}__${agent}`, 'sessions', { agents: [agent] });
        for (const r of ds.results) log(`   ${agent}: sessions ${r.stdout}`);
      } catch (e) { log(`   ${agent}: sem sessions enviadas (${e.message})`); }
      // conteúdo -> Desktop\CONTEUDO -> espalha nos 16 DADOS
      const sc = await syncConteudo(agent, batch);
      if (sc.skipped) { log(`   ${agent}: sem conteúdo (texto/vídeo) enviado`); return; }
      const r = await run(agent, node('setup-conteudo.js'));
      log(`   ${agent}: conteúdo -> ${r.stdout ? r.stdout.trim().split(/\r?\n/).pop() : `code ${r.code}`}`);
    }));
  }

  const st0 = await queueStatus(batch);
  log(`fila '${batch}'${args.tenant ? ` | tenant=${args.tenant}` : ''}: ${st0.pending} par(es) | ${ags.length} VPS (${ags.join(', ')}) | ondas de ${WAVE}`);
  if (!st0.pending) { log('fila vazia — nada a fazer'); return { batch, vazio: true }; }

  const loopAgente = async (agent) => {
    const acc = { agent, ondas: 0, sucesso: 0, travado: 0, erro: 0, semResumo: 0, descartados: 0, poolSeco: false };
    for (;;) {
      const units = await lease(batch, agent, WAVE);
      if (!units.length) break;
      const wave = acc.ondas + 1;
      const tag = `[${agent} onda ${wave}]`;
      log(`${tag} ${units.length} par(es): ${units.map((u) => u.key).join(', ')}`);

      // 1) telefones pro TELEFONES CAMPANHA da VPS
      const sy = await syncTelefones(agent, batch, units);
      if (sy.code) log(`${tag} ⚠ sync code=${sy.code} ${sy.stderr || ''}`);

      // 2) limpeza da onda anterior:
      //    - broadcast SEMPRE no começo (sem tratar erro condicional; o retry da
      //      fila já reenvia os números que falharam no próximo lease).
      //    - telefones: limpa -> renomeia (promove qualquer leftover) -> limpa de
      //      novo, deixando os slots zerados.
      //    - sessions: limpa pra rotacionar (renomear-sessions PULA o slot se a
      //      pasta 'session' já existir, então sem isto reusaria a session velha).
      await run(agent, node('limpar-broadcast.js'));
      await run(agent, node('limpar-telefones.js'));
      await run(agent, node('renomear-numeros.js'));
      await run(agent, node('limpar-telefones.js'));
      await run(agent, node('limpar-sessions.js'));

      // 3) move os telefones (16 pares) pros slots
      await run(agent, node('movimenta-numeros.js'));

      // 4) sessions frescas do pool — se secou, devolve os telefones e para a VPS
      const ms = await run(agent, node('movimenta-sessions.js'));
      if (movedSessions(ms.stdout) === 0) {
        log(`${tag} ⚠ pool de sessions esgotado — devolvendo ${units.length} par(es) à fila e parando ${agent}`);
        await returnLease(batch, units);
        acc.poolSeco = true;
        break;
      }

      // 5) renomeia sessions e telefones (deixa TELEFONES.txt + session prontos)
      await run(agent, node('renomear-sessions.js'));
      await run(agent, node('renomear-numeros.js'));

      // 6) roda a onda
      acc.ondas = wave;
      const sa = await run(agent, node('start-all.js', `$env:INACTIVITY_MS=${inactivity};`), { timeoutMs: startTimeout });
      const r = parseResumo(sa.stdout);

      // 7) sucessos saem da fila; erros VOLTAM p/ retry (com outra session)
      let okUnits, badUnits;
      if (r) {
        const okSet = new Set(r.sucesso);
        okUnits = units.filter((_, i) => okSet.has(i + 1));
        badUnits = units.filter((_, i) => !okSet.has(i + 1));
        acc.sucesso += r.sucesso.length; acc.travado += r.travado.length; acc.erro += r.erro.length;
        log(`${tag} sucesso=${r.sucesso.length} travado=[${r.travado.join(',')}] erro=[${r.erro.join(',')}]`);
      } else {
        okUnits = []; badUnits = units; acc.semResumo++;
        log(`${tag} ⚠ SEM RESUMO (start-all code=${sa.code}) — números voltam p/ retry`);
      }
      await commitUnits(batch, okUnits.map((u) => u.key));
      const rr = await retryLease(batch, badUnits, maxRetries);
      if (rr.requeued.length) log(`${tag} ↺ ${rr.requeued.length} número(s) de volta à fila p/ retry`);
      if (rr.exhausted.length) { acc.descartados += rr.exhausted.length; log(`${tag} ✖ ${rr.exhausted.length} esgotaram ${maxRetries} tentativas`); }

      // grava a onda no banco
      const st = await queueStatus(batch);
      recordWave({ tenant: args.tenant || 'default', batch, agent, wave, leased: units.map((u) => u.key), pendingAfter: st.pending, resumo: r });
    }
    log(`[${agent}] fim: ${acc.ondas} onda(s) | sucesso=${acc.sucesso} travado=${acc.travado} erro=${acc.erro} descartados=${acc.descartados}${acc.poolSeco ? ' | POOL DE SESSIONS SECO' : ''}`);
    return acc;
  };

  const resumos = await Promise.all(ags.map(loopAgente));
  const fim = await queueStatus(batch);
  const tot = resumos.reduce((a, r) => ({
    ondas: a.ondas + r.ondas, sucesso: a.sucesso + r.sucesso, travado: a.travado + r.travado, erro: a.erro + r.erro,
  }), { ondas: 0, sucesso: 0, travado: 0, erro: 0 });
  const secou = resumos.filter((r) => r.poolSeco).map((r) => r.agent);
  log(`✔ fim | pendentes=${fim.pending} | total: ${tot.ondas} ondas, sucesso=${tot.sucesso} travado=${tot.travado} erro=${tot.erro}${secou.length ? ` | sessions secaram em: ${secou.join(', ')}` : ''}`);
  return { batch, resumos, total: tot, fila: fim, sessionsSecaram: secou };
}
