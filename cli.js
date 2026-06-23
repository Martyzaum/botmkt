// =====================================================================
//  CLI — manda comandos para o hub e busca o resultado.
//  Uso:
//    node cli.js agents
//    node cli.js run <VPS01|all> "<comando>"      (espera e mostra o resultado)
//    node cli.js enqueue <VPS01|all> "<comando>"  (só enfileira, não espera)
//    node cli.js job <jobId>
//    node cli.js playbooks                         (lista playbooks)
//    node cli.js play <nome> ['{"arg":"val"}']     (roda playbook e acompanha o log)
//    node cli.js runs                              (histórico de execuções)
//    node cli.js runlog <runId>                    (log de uma execução)
//  Config (.env): HUB_URL, HUB_TOKEN
// =====================================================================
import 'dotenv/config';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

const HUB_URL = (process.env.HUB_URL || 'http://localhost:8787').replace(/\/$/, '');
const TOKEN = process.env.HUB_TOKEN;
const headers = { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(method, path, body) {
  const res = await fetch(`${HUB_URL}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${res.status}: ${json.error || 'erro'}`);
  return json;
}

async function waitJob(jobId, timeoutMs = 5 * 60 * 1000) {
  const t0 = Date.now();
  for (;;) {
    const job = await api('GET', `/job/${jobId}`);
    if (job.status === 'done' || job.status === 'error') return job;
    if (Date.now() - t0 > timeoutMs) throw new Error('timeout esperando o job');
    await sleep(1000);
  }
}

function printJob(job) {
  console.log(`\n===== ${job.agent} [${job.status}] exit=${job.result?.code ?? '-'} =====`);
  if (job.result?.stdout) console.log(job.result.stdout.trimEnd());
  if (job.result?.stderr) console.error('[stderr] ' + job.result.stderr.trimEnd());
}

async function main() {
  const [, , cmd, ...rest] = process.argv;

  if (cmd === 'agents') {
    const tenant = rest[0];
    const { agents } = await api('GET', `/agents${tenant ? `?tenant=${encodeURIComponent(tenant)}` : ''}`);
    if (!agents.length) return console.log(`(nenhum agente${tenant ? ` no tenant '${tenant}'` : ''} registrado ainda)`);
    for (const a of agents) {
      const ageS = Math.round((Date.now() - Date.parse(a.lastSeen)) / 1000);
      const on = a.online ? 'ONLINE ' : 'offline';
      const j = a.job ? ` (${a.job.type || a.job.shell || 'job'}${a.job.jobId ? ' ' + a.job.jobId.slice(0, 8) : ''})` : '';
      console.log(`${a.id}\t[${a.tenant || 'default'}]\t${on}\t${a.status || '-'}${j}\tvisto há ${ageS}s\tip=${a.ip || '-'}`);
    }
    return;
  }

  if (cmd === 'enqueue' || cmd === 'run') {
    const target = rest[0];
    const command = rest.slice(1).join(' ');
    if (!target || !command) {
      console.error(`Uso: node cli.js ${cmd} <VPS01|all> "<comando>"`);
      process.exit(1);
    }
    const { created } = await api('POST', '/enqueue', { agent: target, command });
    console.log(`enfileirado: ${created.map((c) => `${c.agent}=${c.jobId}`).join(', ')}`);
    if (cmd === 'run') {
      const results = await Promise.allSettled(created.map((c) => waitJob(c.jobId)));
      results.forEach((r, i) => {
        if (r.status === 'fulfilled') printJob(r.value);
        else console.error(`\n===== ${created[i].agent} FALHOU: ${r.reason.message}`);
      });
    }
    return;
  }

  if (cmd === 'job') {
    printJob(await api('GET', `/job/${rest[0]}`));
    return;
  }

  if (cmd === 'upload') {
    const [batch, kind, localDir] = rest;
    if (!batch || !['sessions', 'telefones'].includes(kind) || !localDir) {
      console.error('Uso: node cli.js upload <batch> <sessions|telefones> <pastaLocal>');
      process.exit(1);
    }
    const files = await readdir(localDir, { recursive: true, withFileTypes: true });
    const onlyFiles = files.filter((f) => f.isFile());
    let n = 0;
    for (const f of onlyFiles) {
      const abs = path.join(f.parentPath || f.path, f.name);
      const rel = path.relative(localDir, abs).replaceAll(path.sep, '/');
      const buf = await readFile(abs);
      const res = await fetch(`${HUB_URL}/upload?batch=${encodeURIComponent(batch)}&kind=${kind}&rel=${encodeURIComponent(rel)}`, {
        method: 'POST', headers: { ...headers, 'content-type': 'application/octet-stream' }, body: buf,
      });
      if (!res.ok) { console.error(`falhou ${rel}: HTTP ${res.status}`); continue; }
      n++;
      if (n % 25 === 0) console.log(`  ${n}/${onlyFiles.length}...`);
    }
    console.log(`upload concluído: ${n}/${onlyFiles.length} arquivo(s) em batch '${batch}' (${kind})`);
    return;
  }

  if (cmd === 'playbooks') {
    const { playbooks } = await api('GET', '/playbooks');
    console.log(playbooks.length ? playbooks.join('\n') : '(nenhum playbook em /playbooks)');
    return;
  }

  if (cmd === 'play') {
    const name = rest[0];
    if (!name) { console.error('Uso: node cli.js play <nome> [\'{"arg":"val"}\']'); process.exit(1); }
    let pbArgs = {};
    if (rest[1]) { try { pbArgs = JSON.parse(rest[1]); } catch { console.error('args inválidos (JSON)'); process.exit(1); } }
    const { runId } = await api('POST', `/play/${name}`, { args: pbArgs });
    console.log(`run ${runId} iniciado — acompanhando...\n`);
    // segue o log até terminar
    let shown = 0;
    for (;;) {
      const run = await api('GET', `/run/${runId}`);
      for (; shown < run.log.length; shown++) {
        const l = run.log[shown];
        console.log(`  ${l.t.slice(11, 19)}  ${l.msg}`);
      }
      if (run.status !== 'running') {
        console.log(`\n[${run.status}]${run.error ? ' ' + run.error : ''}`);
        if (run.result !== undefined && run.result !== null) console.log('result: ' + JSON.stringify(run.result));
        break;
      }
      await sleep(800);
    }
    return;
  }

  if (cmd === 'runs') {
    const { runs } = await api('GET', '/runs');
    if (!runs.length) return console.log('(nenhuma execução ainda)');
    for (const r of runs) console.log(`${r.id}\t${r.playbook}\t[${r.status}]\t${r.startedAt}`);
    return;
  }

  if (cmd === 'runlog') {
    const run = await api('GET', `/run/${rest[0]}`);
    console.log(`playbook=${run.playbook} status=${run.status}`);
    for (const l of run.log) console.log(`  ${l.t.slice(11, 19)}  ${l.msg}`);
    if (run.result) console.log('result: ' + JSON.stringify(run.result));
    return;
  }

  if (cmd === 'stats') {
    const batch = rest[0], tenant = rest[1];
    if (!batch) { console.error('Uso: node cli.js stats <batch> [tenant]'); process.exit(1); }
    const s = await api('GET', `/stats?batch=${encodeURIComponent(batch)}${tenant ? `&tenant=${encodeURIComponent(tenant)}` : ''}`);
    console.log(`batch=${s.batch} tenant=${s.tenant}`);
    console.log(`  ondas=${s.ondas}  sucesso=${s.sucesso}  travado=${s.travado}  erro=${s.erro}  restantes=${s.restantes ?? '-'}`);
    console.log(`  início=${s.inicio || '-'}  fim=${s.fim || '-'}`);
    return;
  }

  if (cmd === 'erros') {
    const batch = rest[0], tenant = rest[1];
    if (!batch) { console.error('Uso: node cli.js erros <batch> [tenant]'); process.exit(1); }
    const { erros } = await api('GET', `/erros?batch=${encodeURIComponent(batch)}${tenant ? `&tenant=${encodeURIComponent(tenant)}` : ''}`);
    if (!erros.length) return console.log('(nenhum erro registrado)');
    for (const e of erros) console.log(`${e.ts.slice(0, 19)}  ${e.agent}#${e.slot}  ${e.status}\t${e.numero || '-'}\t${e.motivo || ''}`);
    return;
  }

  if (cmd === 'waves') {
    const batch = rest[0];
    if (!batch) { console.error('Uso: node cli.js waves <batch>'); process.exit(1); }
    const { waves } = await api('GET', `/waves?batch=${encodeURIComponent(batch)}`);
    if (!waves.length) return console.log('(nenhuma onda registrada)');
    for (const w of waves) console.log(`${w.ts.slice(0, 19)}  ${w.agent} onda ${w.wave}\tok=${w.sucesso} trav=${w.travado} err=${w.erro}\trestam=${w.pending_after ?? '-'}`);
    return;
  }

  console.log('Comandos: agents [tenant] | run <alvo> "<cmd>" | enqueue <alvo> "<cmd>" | job <id> | playbooks | play <nome> [args] | runs | runlog <id> | stats <batch> [tenant] | erros <batch> [tenant] | waves <batch>');
}

main().catch((e) => {
  console.error('Erro:', e.message);
  process.exit(1);
});
