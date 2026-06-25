// =====================================================================
//  SLOT-POOL — modo PIPELINE: cada slot é um WORKER independente.
//  Substitui o start-all (que sobe os 16 e ESPERA todos). Aqui cada worker
//  roda em loop sem esperar os vizinhos:
//     garante session (claim atômico do pool) -> lease 1 telefone (HTTP) ->
//     monta o slot (/file + TEXTO.txt) -> roda o SUPERVISOR (index.js, intacto)
//     -> sucesso: commit + mantém session | falha: requeue + troca session.
//  Reusa: slot-supervisor.js (detecção), convenções de pasta, gera-texto.
//  Fala com o hub por HTTP (herda HUB_URL + HUB_TOKEN do agente).
//
//  Env (do agente):   HUB_URL, HUB_TOKEN, DESKTOP_DIR, AGENT_ID
//  Env (do playbook): BATCH, TENANT, SLOTS(16), ENTRY(index.js), INACTIVITY_MS,
//                     STAGGER_MS(1500), STATE_POLL_MS(5000), IDLE_MS(4000),
//                     POOL_WAIT_MS(120000), POOL_POLL_MS(5000)
//  Termina quando: a fila seca (sem in-flight) | pausa/encerra | pool seco > POOL_WAIT_MS.
// =====================================================================
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";

const HUB = (process.env.HUB_URL || "").replace(/\/$/, "");
const TOKEN = process.env.HUB_TOKEN || "";
const DESKTOP = process.env.DESKTOP_DIR || path.join(os.homedir(), "Desktop");
const BATCH = process.env.BATCH || "";
const TENANT = process.env.TENANT || "default";
const AGENT = process.env.AGENT || process.env.AGENT_ID || os.hostname();
const SLOTS = Number(process.env.SLOTS || 16);
const ENTRY = process.env.ENTRY || "index.js";
const INACTIVITY_MS = Number(process.env.INACTIVITY_MS || 240000);
const STAGGER_MS = Number(process.env.STAGGER_MS || 1500);
const STATE_POLL_MS = Number(process.env.STATE_POLL_MS || 5000);
const IDLE_MS = Number(process.env.IDLE_MS || 4000);
const POOL_WAIT_MS = Number(process.env.POOL_WAIT_MS || 120000);
const POOL_POLL_MS = Number(process.env.POOL_POLL_MS || 5000);

if (!HUB || !BATCH) { console.error("slot-pool: faltou HUB_URL ou BATCH"); process.exit(1); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isSub = (s) => /^\d+-\d+$/.test(s);
const slotDir = (i) => path.join(DESKTOP, String(i));
const ts = () => new Date().toISOString();
const log = (m) => console.log(`[${ts()}][pool] ${m}`);

// ---- HTTP (token) -------------------------------------------------------
async function api(pathq, { method = "GET", body } = {}) {
  const res = await fetch(`${HUB}${pathq}`, {
    method,
    headers: { authorization: `Bearer ${TOKEN}`, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} em ${pathq}`);
  return res;
}
const leaseOne = async () => (await (await api("/q/lease", { method: "POST", body: { batch: BATCH, agent: AGENT, n: 1 } })).json()).units || [];
const commitKey = (key) => api("/q/commit", { method: "POST", body: { batch: BATCH, keys: [key] } }).catch(() => {});
const requeueKey = (key) => api("/q/requeue", { method: "POST", body: { batch: BATCH, keys: [key] } }).catch(() => {});
const slotEvent = (rec) => api("/slot/event", { method: "POST", body: { batch: BATCH, tenant: TENANT, agent: AGENT, ...rec } }).catch(() => {});
async function fetchFile(rel, dest) {
  const res = await api(`/file?batch=${encodeURIComponent(BATCH)}&kind=telefones&rel=${encodeURIComponent(rel)}`);
  const buf = Buffer.from(await res.arrayBuffer());
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, buf);
}

// ---- session: claim ATÔMICO do pool Desktop\sessions --------------------
// pega 1 subsession <tel>/<numero>-<n> via fs.renameSync (o 1º a renomear ganha;
// ENOENT = outro worker levou -> tenta a próxima). Retorna o id da subsession.
function claimSession(slot) {
  const pool = path.join(DESKTOP, "sessions");
  let tels = [];
  try { tels = fs.readdirSync(pool); } catch { return null; }
  for (const tel of tels) {
    const telDir = path.join(pool, tel);
    let subs = [];
    try { subs = fs.readdirSync(telDir).filter(isSub); } catch { continue; }
    for (const sub of subs) {
      const dstSub = path.join(slotDir(slot), sub);
      try { fs.renameSync(path.join(telDir, sub), dstSub); }
      catch { continue; }                                   // perdeu a corrida -> próxima
      const session = path.join(slotDir(slot), "session");
      try { fs.rmSync(session, { recursive: true, force: true }); } catch {}
      fs.renameSync(dstSub, session);
      try { if (!fs.readdirSync(telDir).length) fs.rmdirSync(telDir); } catch {}
      return sub;
    }
  }
  return null;                                              // pool seco
}
function discardSession(slot) {
  const d = slotDir(slot);
  try { fs.rmSync(path.join(d, "session"), { recursive: true, force: true }); } catch {}
  for (const f of safeReaddir(d)) if (isSub(f)) try { fs.rmSync(path.join(d, f), { recursive: true, force: true }); } catch {}
  clearTelefones(slot);
}
function clearTelefones(slot) {
  const dados = path.join(slotDir(slot), "DADOS");
  for (const f of safeReaddir(dados)) if (/^TELEFONES.*\.txt$/i.test(f)) try { fs.rmSync(path.join(dados, f), { force: true }); } catch {}
}
const safeReaddir = (d) => { try { return fs.readdirSync(d); } catch { return []; } };

// ---- monta o slot p/ 1 envio (telefone + TEXTO.txt) ---------------------
async function buildSlot(slot, unit) {
  const dados = path.join(slotDir(slot), "DADOS");
  fs.mkdirSync(dados, { recursive: true });
  clearTelefones(slot);
  const rel = (unit.files && unit.files[0] && unit.files[0].rel) || null;
  if (!rel) throw new Error("unit sem arquivo");
  await fetchFile(rel, path.join(dados, "TELEFONES.txt"));   // bot lê TELEFONES.txt
  // gera-texto inline (mesma fórmula do gera-texto.js): link da session + base
  const baseFile = path.join(DESKTOP, "CONTEUDO", "TEXTO-BASE.txt");
  const base = fs.existsSync(baseFile) ? fs.readFileSync(baseFile, "utf8") : "";
  let link = "";
  try { const lf = path.join(slotDir(slot), "session", "session-link.txt"); if (fs.existsSync(lf)) link = fs.readFileSync(lf, "utf8").trim(); } catch {}
  const partes = [];
  if (link) partes.push("👉🏻 " + link + " 👈🏻");
  if (base.trim()) partes.push(base);
  fs.writeFileSync(path.join(dados, "TEXTO.txt"), partes.join("\n\n"));
}

// ---- roda o SUPERVISOR (index.js) p/ 1 envio e lê o resultado -----------
function runSupervisor(slot) {
  return new Promise((resolve) => {
    const child = spawn("node", [ENTRY], {
      cwd: slotDir(slot),
      env: { ...process.env, SLOT_ID: String(slot), DESKTOP_DIR: DESKTOP, INACTIVITY_MS: String(INACTIVITY_MS) },
      windowsHide: true,
    });
    let buf = "", result = null;
    child.stdout.on("data", (d) => {
      buf += d.toString();
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        const m = line.match(/SLOT_RESULT (\{.*\})/);
        if (m) { try { result = JSON.parse(m[1]); } catch {} }
      }
    });
    child.stderr.on("data", () => {});
    child.on("exit", (code) => resolve({ status: result?.status || (code === 0 ? "sucesso" : code === 2 ? "travado" : "erro"), motivo: result?.motivo || null }));
    child.on("error", () => resolve({ status: "erro", motivo: "falha ao spawnar supervisor" }));
  });
}

// ---- estado da campanha (abort) ----------------------------------------
const flag = { stop: false };
async function abortPoller() {
  while (!flag.stop) {
    try {
      const s = await (await api(`/campaign/state?batch=${encodeURIComponent(BATCH)}&tenant=${encodeURIComponent(TENANT)}`)).json();
      if (s.aborted || s.running === false) { flag.stop = true; log(`parando (aborted=${s.aborted} running=${s.running})`); break; }
    } catch {}
    await sleep(STATE_POLL_MS);
  }
}

// ---- worker por slot ----------------------------------------------------
const shared = { inFlight: 0 };
async function worker(slot, idx) {
  await sleep(idx * STAGGER_MS);                            // escada de login
  let curSession = null;                                    // id da subsession atual (best-effort)
  let haveSession = fs.existsSync(path.join(slotDir(slot), "session")); // reaproveita session do wave/anterior
  let poolDrySince = 0;
  let idle = 0;
  while (!flag.stop) {
    if (!haveSession) {
      const sub = claimSession(slot);
      if (!sub) {
        poolDrySince = poolDrySince || Date.now();
        if (Date.now() - poolDrySince > POOL_WAIT_MS) { log(`slot ${slot}: pool seco -> encerra`); break; }
        await sleep(POOL_POLL_MS); continue;
      }
      curSession = sub; haveSession = true; poolDrySince = 0;
    }
    const units = await leaseOne().catch(() => []);
    if (!units.length) {
      if (shared.inFlight === 0) { if (++idle >= 2) break; } // fila secou e ninguém vai re-enfileirar
      await sleep(IDLE_MS); continue;
    }
    idle = 0;
    const unit = units[0];
    shared.inFlight++;
    let res;
    try { await buildSlot(slot, unit); res = await runSupervisor(slot); }
    catch (e) { res = { status: "erro", motivo: e.message }; }
    shared.inFlight--;
    if (res.status === "sucesso") {
      await commitKey(unit.key);
      await slotEvent({ slot, status: "sucesso", key: unit.key, session: curSession });
      log(`slot ${slot}: ✓ ${unit.key} (mantém session)`);
      // mantém a session pro próximo lote
    } else {
      await requeueKey(unit.key);
      await slotEvent({ slot, status: res.status, key: unit.key, session: curSession, motivo: res.motivo });
      log(`slot ${slot}: ✗ ${unit.key} (${res.status}) -> requeue + troca session`);
      discardSession(slot); haveSession = false; curSession = null;
    }
  }
}

// ---- main ---------------------------------------------------------------
(async () => {
  log(`start | batch=${BATCH} agent=${AGENT} slots=${SLOTS} hub=${HUB}`);
  abortPoller();
  await Promise.all(Array.from({ length: SLOTS }, (_, k) => worker(k + 1, k)));
  flag.stop = true;
  log(`fim do runner (fila seca / pausa / pool seco)`);
  process.exit(0);
})();
