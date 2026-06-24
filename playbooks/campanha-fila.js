// =====================================================================
//  Playbook CAMPANHA-FILA — modelo PULL em ondas, com troca de sessions.
//
//  A fila do batch (1 número = 1 par) é consumida por TODAS as VPS do
//  tenant em paralelo: cada VPS faz lease(16) -> roda a onda -> commit,
//  em loop, até a fila secar. Balanceia sozinho.
//
//  SETUP: o pool de sessions é COMPARTILHADO (<batch>/sessions) e espalhado
//  entre as VPS ativas (1 distribute, round-robin por subpasta <numero>-<n>).
//  Cada session carrega o session-link.txt (gravado no upload).
//
//  Ciclo de uma onda (por VPS):
//    sync 16 pares de telefone (sempre — cada onda manda lotes novos)
//    -> limpar-broadcast (sempre, no começo)
//    -> limpar-telefones -> renomear-telefones -> limpar-telefones  (reset dos slots)
//    -> limpar-sessions SÓ DOS SLOTS QUE FALHARAM na onda anterior
//         (1ª onda: limpa todos; quem teve sucesso MANTÉM a session)
//    -> movimenta-telefones
//    -> movimenta-sessions  (enche só os slots vazios; 0 slots com session = pool
//                            seco real -> devolve os telefones à fila e para)
//    -> renomear-sessions (pula quem já tem 'session') -> renomear-telefones
//    -> gera-texto  (TEXTO.txt de cada slot = link da session + texto base)
//    -> start-all
//    -> commit (sucessos saem; erros voltam p/ retry → re-sync no próximo lease)
//    -> grava no banco; guarda travado+erro como failedSlots p/ a próxima onda
//
//  >>> SESSIONS são REUSADAS: só a do slot que travou/errou é trocada. Isso faz
//      o pool durar muito mais (antes rotacionava as 16 e secava em 1 onda). <<<
//  O retry da fila já reenvia o número que falhou (até 3x); o telefone NÃO se
//  perde — por isso tratar-erros (descarte p/ TELEFONES ERRO) não é usado aqui.
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
const ps = (file, arg = '') => `& '${NEY}\\${file}'${arg ? ' ' + arg : ''}`; // roda um .ps1
const parseResumo = (stdout) => {
  const m = (stdout || '').match(/RESULTADO_JSON (\{.*\})/);
  if (!m) return null;
  try { return JSON.parse(m[1]); } catch { return null; }
};
// resumo do movimenta-sessions: RESULTADO_SESSIONS vazios=.. movidas=.. comSession=.. poolRestante=..
//  comSession = quantos dos 16 slots têm session nesta onda (0 = pool TOTALMENTE seco).
const parseSessions = (stdout) => {
  const m = (stdout || '').match(/RESULTADO_SESSIONS vazios=(\d+) movidas=(\d+) comSession=(\d+) poolRestante=(\d+)/);
  if (!m) return null;
  return { vazios: +m[1], movidas: +m[2], comSession: +m[3], poolRestante: +m[4] };
};
// slot -> subsession, do stdout do movimenta-sessions ("<telefone>/<numero>-<n> -> pasta N")
const parseSlotSessions = (stdout) => {
  const map = {};
  for (const m of (stdout || '').matchAll(/^.+?\/(\S+)\s*->\s*pasta\s*(\d+)/gim)) map[Number(m[2])] = m[1];
  return map;
};
// slot -> numero do telefone, do stdout do movimenta-numeros ("Numero X -> pasta N")
const parseSlotNumeros = (stdout) => {
  const map = {};
  for (const m of (stdout || '').matchAll(/^Numero\s+(\d+)\s*->\s*pasta\s+(\d+)/gim)) map[Number(m[2])] = Number(m[1]);
  return map;
};

export const meta = { name: 'campanha-fila', description: 'Loop pull em ondas (sessions+telefones) por tenant' };

export default async function ({ agents, tenantAgents, distribute, lease, returnLease, retryLease, syncTelefones, syncConteudo, commitUnits, queueStatus, recordWave, run, log, args }) {
  const batch = args.batch;
  if (!batch) throw new Error('passe o batch: play campanha-fila \'{"batch":"..."}\'');
  const WAVE = Number(args.wave || 16);
  const maxRetries = Number(args.maxRetries || 3);
  const maxSemSucesso = Number(args.maxSemSucesso || 2); // desiste após N ondas seguidas com 0 envio
  const inactivity = Number(args.inactivity || 4 * 60 * 1000);
  const startTimeout = Number(args.startTimeout || 45 * 60 * 1000);
  const ags = args.agents && args.agents.length
    ? args.agents
    : (args.tenant ? tenantAgents(args.tenant) : agents());
  if (!ags.length) throw new Error(`nenhum agente disponível${args.tenant ? ` para o tenant '${args.tenant}'` : ''}`);

  // SETUP: sessions do pool COMPARTILHADO espalhadas entre as VPS ativas +
  // conteúdo global (texto base + vídeo) no CONTEUDO de cada VPS.
  if (!args.skipSetup) {
    log('=== SETUP: sessions (espalha entre VPS) + conteúdo ===');
    // 1 distribute: as subpastas <numero>-<n> vão round-robin pras VPS ativas
    try {
      const ds = await distribute(batch, 'sessions', { agents: ags });
      for (const r of ds.results) log(`   sessions ${r.agent}: ${r.stdout}`);
    } catch (e) { log(`   sem sessions distribuídas (${e.message})`); }
    // conteúdo (texto base + vídeo) -> CONTEUDO; setup-conteudo espalha o VÍDEO
    // (o TEXTO.txt por slot é gerado por onda pelo gera-texto.js).
    await Promise.all(ags.map(async (agent) => {
      const sc = await syncConteudo(agent, batch);
      if (sc.skipped) { log(`   ${agent}: sem conteúdo (texto/vídeo) enviado`); return; }
      const r = await run(agent, node('setup-conteudo.js'));
      log(`   ${agent}: conteúdo -> ${r.stdout ? r.stdout.trim().split(/\r?\n/).pop() : `code ${r.code}`}`);
    }));
  }

  const st0 = await queueStatus(batch);
  log(`fila '${batch}'${args.tenant ? ` | tenant=${args.tenant}` : ''}: ${st0.pending} par(es) | ${ags.length} VPS (${ags.join(', ')}) | ondas de ${WAVE}`);
  if (!st0.pending) { log('fila vazia — nada a fazer'); return { batch, vazio: true }; }

  // abre/fecha os terminais de log da VPS automaticamente (default ON; windows:false desliga)
  const wantWindows = args.windows !== false;
  const loopAgente = async (agent) => {
    const acc = { agent, ondas: 0, enviados: 0, retry: 0, descartados: 0, semResumo: 0, poolSeco: false, desistiu: false };
    // slots que falharam na onda ANTERIOR -> só esses trocam de session na próxima.
    // null = primeira onda (limpa todas as sessions pra começar do zero).
    let failedSlots = null;
    let ondasSemSucesso = 0; // circuit breaker: ondas seguidas com 0 envio
    if (wantWindows) { try { await run(agent, ps('ver-logs.ps1', `-Slots ${WAVE}`)); } catch { /* janelas são best-effort */ } }
    try {
    for (;;) {
      const wave = acc.ondas + 1;
      const tag = `[${agent} onda ${wave}]`;

      // A) SESSIONS PRIMEIRO — definem quais slots rodam nesta onda.
      //    broadcast sempre zerado; limpa a session SÓ dos slots que falharam na
      //    onda anterior (1ª onda: zera tudo). As que funcionaram são MANTIDAS.
      await run(agent, node('limpar-broadcast.js'));
      if (failedSlots === null) {
        await run(agent, node('limpar-sessions.js'));                 // 1ª onda: zera tudo
      } else if (failedSlots.length) {
        await run(agent, node('limpar-sessions.js', `$env:SLOTS_LIMPAR='${failedSlots.join(',')}';`));
        log(`${tag} troca de session só nos slots que falharam: ${failedSlots.join(', ')}`);
      } // ninguém falhou -> mantém todas

      // B) sessions frescas do pool nos slots vazios; renomeia p/ 'session'.
      //    K = comSession = quantos slots vão rodar. 0 = pool seco -> para a VPS.
      const ms = await run(agent, node('movimenta-sessions.js'));
      const se = parseSessions(ms.stdout);
      await run(agent, node('renomear-sessions.js'));        // ativos passam a ter 'session'
      const K = se ? se.comSession : WAVE;
      if (K <= 0) {
        log(`${tag} ⚠ pool de sessions esgotado (0 slots com session) — parando ${agent}`);
        acc.poolSeco = true;
        break;
      }
      if (se && se.movidas < se.vazios) {
        log(`${tag} ⚠ pool acabando: faltaram ${se.vazios - se.movidas} session(s) | pool restante=${se.poolRestante}`);
      }

      // C) lease = nº de slots ativos (não adianta puxar mais telefone que session).
      const units = await lease(batch, agent, Math.min(WAVE, K));
      if (!units.length) break;                              // fila vazia
      acc.ondas = wave;
      log(`${tag} ${units.length} par(es) p/ ${K} session(s): ${units.map((u) => u.key).join(', ')}`);

      // D) telefones -> SÓ nos slots que têm session (movimenta-numeros é session-aware).
      const sy = await syncTelefones(agent, batch, units);
      if (sy.code) log(`${tag} ⚠ sync code=${sy.code} ${sy.stderr || ''}`);
      await run(agent, node('limpar-telefones.js'));         // zera leftovers
      await run(agent, node('limpar-telefones.js'));
      const mn = await run(agent, node('movimenta-numeros.js'));
      await run(agent, node('renomear-numeros.js'));
      await run(agent, node('gera-texto.js'));

      // mapeia slot -> numero -> unidade (movimenta-numeros: "Numero X -> pasta N")
      const slotNum = parseSlotNumeros(mn.stdout);           // { slot: num }
      const byNum = new Map(units.map((u) => [u.num, u]));
      const unitSlot = new Map();                            // key -> slot
      const slotUnit = {};                                   // slot -> key (p/ recordWave)
      for (const [slot, num] of Object.entries(slotNum)) {
        const u = byNum.get(num);
        if (u) { unitSlot.set(u.key, Number(slot)); slotUnit[slot] = u.key; }
      }

      // E) roda a onda
      const sa = await run(agent, node('start-all.js', `$env:INACTIVITY_MS=${inactivity};`), { timeoutMs: startTimeout });
      const r = parseResumo(sa.stdout);

      // F) commit/retry por SLOT (sucesso vem como nº de slot no RESULTADO_JSON).
      //    Lote leaseado que NÃO foi distribuído (sem slot) volta SEM penalizar.
      const semSlot = units.filter((u) => !unitSlot.has(u.key));
      const comSlot = units.filter((u) => unitSlot.has(u.key));
      const ativos = [...new Set(unitSlot.values())];
      let okUnits, badUnits;
      if (r) {
        const okSet = new Set(r.sucesso);
        okUnits = comSlot.filter((u) => okSet.has(unitSlot.get(u.key)));
        badUnits = comSlot.filter((u) => !okSet.has(unitSlot.get(u.key)));
        // só os slots ATIVOS que falharam trocam de session na próxima onda
        // (os vazios/inativos o movimenta-sessions já preenche sozinho).
        failedSlots = ativos.filter((s) => !okSet.has(s));
        log(`${tag} ${okUnits.length}/${comSlot.length} enviados | falharam slots: [${failedSlots.join(',')}]`);
      } else {
        okUnits = []; badUnits = comSlot; acc.semResumo++;
        failedSlots = ativos;                                // sem resumo -> troca session dos que rodaram
        log(`${tag} ⚠ SEM RESUMO (start-all code=${sa.code}) — números voltam p/ retry`);
      }
      if (semSlot.length) await returnLease(batch, semSlot); // não rodou -> volta sem gastar tentativa
      await commitUnits(batch, okUnits.map((u) => u.key));
      const rr = await retryLease(batch, badUnits, maxRetries);
      acc.enviados += okUnits.length; acc.retry += rr.requeued.length; acc.descartados += rr.exhausted.length;
      if (rr.requeued.length) log(`${tag} ↺ ${rr.requeued.length} número(s) de volta à fila p/ retry`);
      if (rr.exhausted.length) log(`${tag} ✖ ${rr.exhausted.length} esgotaram ${maxRetries} tentativas`);

      // grava a onda no banco + vínculo session↔telefone↔resultado e inventário.
      // filtra o resumo p/ só os slots ATIVOS (os vazios falham na hora e
      // poluiriam as estatísticas com "erro" falso).
      const ativoSet = new Set(ativos);
      const rDb = r ? {
        sucesso: (r.sucesso || []).filter((s) => ativoSet.has(s)),
        travado: (r.travado || []).filter((s) => ativoSet.has(s)),
        erro: (r.erro || []).filter((s) => ativoSet.has(s)),
        slots: (r.slots || []).filter((x) => ativoSet.has(x.slot)),
      } : r;
      const st = await queueStatus(batch);
      recordWave({
        tenant: args.tenant || 'default', batch, agent, wave,
        leased: comSlot.map((u) => u.key), pendingAfter: st.pending, resumo: rDb,
        slotUnits: slotUnit,                            // slot -> telefone (key) REAL desta onda
        slotSessions: parseSlotSessions(ms.stdout),     // slot -> subsession movida nesta onda
        committed: okUnits.map((u) => u.key),
        exhausted: rr.exhausted,
      });

      // circuit breaker: se várias ondas seguidas não enviam NADA, as sessions
      // provavelmente estão mortas -> desiste em vez de moer o pool inteiro.
      ondasSemSucesso = okUnits.length ? 0 : ondasSemSucesso + 1;
      if (ondasSemSucesso >= maxSemSucesso) {
        acc.desistiu = true;
        log(`${tag} 🛑 desistindo: ${ondasSemSucesso} onda(s) seguidas com 0 envio (sessions provavelmente mortas)`);
        break;
      }
    }
    } finally {
      // fecha as janelas de log da VPS no fim (mesmo se algo deu erro no meio)
      if (wantWindows) { try { await run(agent, ps('fecha-logs.ps1')); } catch { /* best-effort */ } }
    }
    log(`[${agent}] fim: ${acc.ondas} onda(s) | enviados=${acc.enviados} retry=${acc.retry} descartados=${acc.descartados}${acc.poolSeco ? ' | POOL SECO' : ''}${acc.desistiu ? ' | DESISTIU (sessions mortas)' : ''}`);
    return acc;
  };

  const resumos = await Promise.all(ags.map(loopAgente));
  const fim = await queueStatus(batch);
  const tot = resumos.reduce((a, r) => ({
    ondas: a.ondas + r.ondas, enviados: a.enviados + r.enviados, retry: a.retry + r.retry, descartados: a.descartados + r.descartados,
  }), { ondas: 0, enviados: 0, retry: 0, descartados: 0 });
  const secou = resumos.filter((r) => r.poolSeco).map((r) => r.agent);
  log(`✔ fim | pendentes=${fim.pending} | total: ${tot.ondas} ondas, enviados=${tot.enviados} retry=${tot.retry} descartados=${tot.descartados}${secou.length ? ` | sessions secaram em: ${secou.join(', ')}` : ''}`);
  return { batch, resumos, total: tot, fila: fim, sessionsSecaram: secou };
}
