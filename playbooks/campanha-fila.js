// =====================================================================
//  Playbook CAMPANHA-FILA — modelo PULL em ondas.
//
//  A fila do batch (1 número = 1 par) é consumida por TODAS as VPS em
//  paralelo: cada VPS faz lease(16) -> roda a onda -> commit -> repete,
//  até a fila secar. Balanceia sozinho (VPS rápida puxa mais ondas).
//
//  Ciclo de uma onda (por VPS):
//    sync 16 pares -> limpar-telefones -> movimenta -> renomear
//                  -> start-all -> tratar-erros -> commit
//
//  Aciona:
//     node cli.js play campanha-fila '{"batch":"camp-2026-06-23"}'
//  Pré-req: ter subido os telefones do batch (cli.js upload ... telefones)
//  e as VPS já com sessions/slots prontos (setup).
//
//  Args opcionais:
//     tenant       processa só as VPS desse tenant (default: todas)
//     wave         pares por onda (default 16 = um por slot)
//     inactivity   ms sem log p/ o supervisor marcar TRAVADO (default 240000)
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

export const meta = { name: 'campanha-fila', description: 'Consome a fila de telefones em ondas, em paralelo nas VPS' };

export default async function ({ agents, tenantAgents, lease, syncTelefones, commitUnits, queueStatus, recordWave, run, log, args }) {
  const batch = args.batch;
  if (!batch) throw new Error('passe o batch: play campanha-fila \'{"batch":"..."}\'');
  const WAVE = Number(args.wave || 16);
  const inactivity = Number(args.inactivity || 4 * 60 * 1000);
  const startTimeout = Number(args.startTimeout || 45 * 60 * 1000);
  // seleção de VPS: agents explícito > tenant > todas
  const ags = args.agents && args.agents.length
    ? args.agents
    : (args.tenant ? tenantAgents(args.tenant) : agents());
  if (!ags.length) throw new Error(`nenhum agente disponível${args.tenant ? ` para o tenant '${args.tenant}'` : ''}`);

  const st0 = await queueStatus(batch);
  log(`fila '${batch}'${args.tenant ? ` | tenant=${args.tenant}` : ''}: ${st0.pending} par(es) pendente(s) | ${ags.length} VPS (${ags.join(', ')}) | ondas de ${WAVE}`);
  if (!st0.pending) { log('fila vazia — nada a fazer'); return { batch, vazio: true }; }

  // loop de UMA VPS: puxa 16, roda a onda, trata erro, repete até secar
  const loopAgente = async (agent) => {
    const acc = { agent, ondas: 0, sucesso: 0, travado: 0, erro: 0, semResumo: 0 };
    for (;;) {
      const units = await lease(batch, agent, WAVE);
      if (!units.length) break;
      acc.ondas++;
      const tag = `[${agent} onda ${acc.ondas}]`;
      log(`${tag} ${units.length} par(es): ${units.map((u) => u.key).join(', ')}`);

      // 1) manda os arquivos pra TELEFONES CAMPANHA da VPS
      const sy = await syncTelefones(agent, batch, units);
      if (sy.code) log(`${tag} ⚠ sync code=${sy.code} ${sy.stderr || ''}`);

      // 2) prepara os slots e roda a onda
      await run(agent, node('limpar-telefones.js'));
      await run(agent, node('movimenta-numeros.js'));
      await run(agent, node('renomear-numeros.js'));
      const sa = await run(agent, node('start-all.js', `$env:INACTIVITY_MS=${inactivity};`), { timeoutMs: startTimeout });

      // 3) lê o veredito e trata os slots ruins
      const r = parseResumo(sa.stdout);
      if (r) {
        acc.sucesso += r.sucesso.length;
        acc.travado += r.travado.length;
        acc.erro += r.erro.length;
        log(`${tag} sucesso=${r.sucesso.length} travado=[${r.travado.join(',')}] erro=[${r.erro.join(',')}]`);
        const ruins = [...r.travado, ...r.erro];
        if (ruins.length) {
          await run(agent, node('tratar-erros.js', `$env:SLOTS_ERRO='${ruins.join(',')}';`));
        }
      } else {
        acc.semResumo++;
        log(`${tag} ⚠ SEM RESUMO (start-all code=${sa.code})`);
      }

      // 4) confirma a onda (os números saem da fila de qualquer forma:
      //    sucesso = enviados; erro = parqueados em TELEFONES ERRO)
      await commitUnits(batch, units.map((u) => u.key));

      // 5) grava no banco (sucessos/erros + restantes)
      const st = await queueStatus(batch);
      recordWave({
        tenant: args.tenant || 'default', batch, agent, wave: acc.ondas,
        leased: units.map((u) => u.key), pendingAfter: st.pending, resumo: r,
      });
    }
    log(`[${agent}] fim: ${acc.ondas} onda(s) | sucesso=${acc.sucesso} travado=${acc.travado} erro=${acc.erro}`);
    return acc;
  };

  const resumos = await Promise.all(ags.map(loopAgente));
  const fim = await queueStatus(batch);
  const tot = resumos.reduce((a, r) => ({
    ondas: a.ondas + r.ondas, sucesso: a.sucesso + r.sucesso, travado: a.travado + r.travado, erro: a.erro + r.erro,
  }), { ondas: 0, sucesso: 0, travado: 0, erro: 0 });
  log(`✔ fila '${batch}' drenada | pendentes=${fim.pending} | total: ${tot.ondas} ondas, sucesso=${tot.sucesso} travado=${tot.travado} erro=${tot.erro}`);
  return { batch, resumos, total: tot, fila: fim };
}
