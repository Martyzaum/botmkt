// =====================================================================
//  Agente — roda DENTRO de cada VPS (usuário 'vps' logado). Conecta para
//  fora no hub, pega jobs (shell ou sync), executa e devolve o resultado.
//  Zero dependências (Node nativo: fetch + child_process + fs).
//
//  Env (definidas pelo install-agent.ps1):
//    HUB_URL, HUB_TOKEN, AGENT_ID, POLL_MS (default 3000)
//    DESKTOP_DIR (opcional — default: <home>\Desktop)
// =====================================================================
import { exec, spawnSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const HUB_URL = (process.env.HUB_URL || '').replace(/\/$/, '');
const TOKEN = process.env.HUB_TOKEN;
const AGENT_ID = process.env.AGENT_ID || os.hostname();
const TENANT_ID = process.env.TENANT_ID || 'default';
const POLL_MS = Number(process.env.POLL_MS || 3000);
const HEARTBEAT_MS = Number(process.env.HEARTBEAT_MS || 10000);
const DESKTOP = process.env.DESKTOP_DIR || path.join(os.homedir(), 'Desktop');
const MAX_BACKOFF = 30000;

if (!HUB_URL || !TOKEN) { console.error('FALTA HUB_URL ou HUB_TOKEN no ambiente.'); process.exit(1); }

const headers = { authorization: `Bearer ${TOKEN}` };
const jsonHeaders = { ...headers, 'content-type': 'application/json' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => new Date().toISOString();

function runShell(command, shell, timeoutMs) {
  return new Promise((resolve) => {
    const cmd = shell === 'cmd'
      ? command
      : `powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "${command.replaceAll('"', '\\"')}"`;
    let timedOut = false;
    const child = exec(cmd, { windowsHide: true, maxBuffer: 20 * 1024 * 1024 }, (err, stdout, stderr) => {
      clearTimeout(timer);
      if (timedOut) {
        resolve({ stdout: stdout || '', stderr: (stderr || '') + '\n[agent] job morto por timeout (árvore encerrada)', code: 124 });
      } else {
        resolve({ stdout: stdout || '', stderr: (stderr || '') + (err && !stderr ? String(err.message) : ''), code: err ? (err.code ?? 1) : 0 });
      }
    });
    // timeout próprio: no Windows, mata a ÁRVORE (taskkill /T) — exec.timeout só
    // mataria o shell e deixaria node start-all/index/main órfãos.
    const timer = setTimeout(() => {
      timedOut = true;
      try { spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }); }
      catch { try { child.kill(); } catch { /* já morreu */ } }
    }, timeoutMs || 10 * 60 * 1000);
  });
}

async function runSync(job) {
  const destRoot = path.join(DESKTOP, job.destFolder);
  let ok = 0;
  const errs = [];
  for (const f of job.files) {
    try {
      const u = `${HUB_URL}/file?batch=${encodeURIComponent(job.batch)}&kind=${encodeURIComponent(job.kind)}&rel=${encodeURIComponent(f.rel)}`;
      const res = await fetch(u, { headers });
      if (!res.ok) { errs.push(`${f.rel} HTTP ${res.status}`); continue; }
      const buf = Buffer.from(await res.arrayBuffer());
      const dest = path.join(destRoot, f.rel.replaceAll('/', path.sep));
      await mkdir(path.dirname(dest), { recursive: true });
      await writeFile(dest, buf);
      ok++;
    } catch (e) { errs.push(`${f.rel} ${e.message}`); }
  }
  return { stdout: `sync ${ok}/${job.files.length} -> ${job.destFolder}`, stderr: errs.slice(0, 20).join('; '), code: errs.length ? 1 : 0 };
}

async function poll() {
  const res = await fetch(`${HUB_URL}/agent/poll`, {
    method: 'POST', headers: jsonHeaders,
    body: JSON.stringify({ id: AGENT_ID, tenant: TENANT_ID, info: { hostname: os.hostname(), platform: os.platform(), desktop: DESKTOP } }),
  });
  if (!res.ok) throw new Error(`poll HTTP ${res.status}`);
  return (await res.json()).job;
}
async function report(jobId, result) {
  await fetch(`${HUB_URL}/agent/result`, { method: 'POST', headers: jsonHeaders, body: JSON.stringify({ jobId, ...result }) });
}

// heartbeat independente do job: mantém o agente "online" mesmo durante um
// job longo (start-all) e informa o que está fazendo (idle/busy + job).
let current = null;
async function heartbeat() {
  try {
    await fetch(`${HUB_URL}/agent/heartbeat`, {
      method: 'POST', headers: jsonHeaders,
      body: JSON.stringify({ id: AGENT_ID, tenant: TENANT_ID, status: current ? 'busy' : 'idle', job: current }),
    });
  } catch { /* silencioso: o backoff do poll já reporta erro de rede */ }
}

async function handle(job) {
  if (job.type === 'sync') {
    console.log(`[job ${job.id}] sync ${job.kind}: ${job.files.length} arquivo(s)`);
    return runSync(job);
  }
  console.log(`[job ${job.id}] ${job.shell}: ${job.command}`);
  return runShell(job.command, job.shell, job.timeoutMs);
}

async function main() {
  console.log(`[agent ${AGENT_ID}] tenant=${TENANT_ID} -> ${HUB_URL} (desktop: ${DESKTOP})`);
  heartbeat();
  setInterval(heartbeat, HEARTBEAT_MS);
  let backoff = POLL_MS;
  for (;;) {
    try {
      const job = await poll();
      backoff = POLL_MS;
      if (job) {
        current = { jobId: job.id, type: job.type, shell: job.shell || null, command: (job.command || '').slice(0, 120) || null, started: now() };
        heartbeat(); // avisa "busy" na hora, sem esperar o próximo tick
        const result = await handle(job);
        current = null;
        await report(job.id, result);
        console.log(`[job ${job.id}] exit=${result.code}`);
        continue;
      }
    } catch (e) {
      console.error(`[agent] erro: ${e.message}`);
      backoff = Math.min(backoff * 2, MAX_BACKOFF);
    }
    await sleep(backoff);
  }
}
main();
