// =====================================================================
//  Hub / Orquestrador — jobs (shell/sync), upload de arquivos, distribuição
//  round-robin com teto por VPS e playbooks.
//  Storage (local|S3) e fila (memória|SQS) são plugáveis via config/aws.js.
//  Rode: node hub/server.js     Config: HUB_PORT (8787), HUB_TOKEN (obrig.)
// =====================================================================
import http from 'node:http';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readdir, readFile } from 'node:fs/promises';
import { store, safeRel, usingS3 } from './lib/storage.js';
import { queue, usingSqs } from './lib/queue.js';
import * as workqueue from './lib/workqueue.js';
import * as db from './lib/db.js';
import * as users from './lib/auth.js';
import { unzip } from './lib/unzip.js';

const PORT = Number(process.env.HUB_PORT || 8787);
const TOKEN = process.env.HUB_TOKEN;
if (!TOKEN) { console.error('FALTA HUB_TOKEN no ambiente (.env).'); process.exit(1); }

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PLAYBOOKS_DIR = path.join(ROOT, 'playbooks');
const LIMITS_FILE = path.join(ROOT, 'config', 'distribution.json');

// ---- estado em memória --------------------------------------------------
const agents = new Map();  // id -> { id, lastSeen, ip, info }
const jobs = new Map();    // jobId -> job (status/result + _receipt p/ ack)
const pending = new Map(); // jobId -> resolve()
const runs = new Map();    // runId -> run
const agentLogs = new Map(); // agent -> { tenant, lines: [] }  (logs ao vivo dos slots)
const LOG_CAP = Number(process.env.LOG_CAP || 800);

const now = () => new Date().toISOString();
// guarda as linhas novas de um agente (ring buffer) p/ o painel acompanhar ao vivo.
function pushAgentLines(agent, tenant, lines) {
  let rec = agentLogs.get(agent);
  if (!rec) { rec = { tenant: tenant || 'default', lines: [] }; agentLogs.set(agent, rec); }
  if (tenant) rec.tenant = tenant;
  for (const l of lines) if (l != null) rec.lines.push(String(l));
  if (rec.lines.length > LOG_CAP) rec.lines.splice(0, rec.lines.length - LOG_CAP);
}
const knownAgents = () => [...new Set([...agents.keys(), ...queue.knownAgents()])];
// agentes de um tenant (registrados via poll/heartbeat). tenant null = todos.
const agentsOf = (tenant) =>
  !tenant || tenant === 'all'
    ? knownAgents()
    : [...agents.values()].filter((a) => (a.tenant || 'default') === tenant).map((a) => a.id);

// agente é "online" se foi visto há menos de AGENT_STALE_MS (default 30s).
const STALE_MS = Number(process.env.AGENT_STALE_MS || 30000);
const isOnline = (a) => Date.now() - Date.parse(a.lastSeen) < STALE_MS;
// atualiza/cria o registro do agente preservando os campos não enviados.
function touchAgent(id, ip, patch = {}) {
  const prev = agents.get(id) || { id };
  agents.set(id, { ...prev, id, lastSeen: now(), ip, ...patch });
}
const agentView = (a) => ({ ...a, online: isOnline(a) });
// IP real do cliente atrás de reverse proxy (X-Forwarded-For) ou direto.
const clientIp = (req) => {
  const xff = req.headers['x-forwarded-for'];
  return (xff ? String(xff).split(',')[0].trim() : '') || req.socket.remoteAddress;
};

const COOKIE = 'wpsid';
function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
// Contexto de auth: token mestre (agentes/CLI) OU sessão de browser (cookie).
//  kind 'token'   -> acesso total, tenant decidido pelo request (query/body).
//  kind 'session' -> usuário logado; tenant FIXADO pela conta.
function getAuth(req) {
  const h = req.headers['authorization'] || '';
  const tok = h.startsWith('Bearer ') ? h.slice(7) : h;
  if (tok && tok === TOKEN) return { ok: true, kind: 'token', tenant: null, user: null };
  const sess = users.getSession(parseCookies(req)[COOKIE]);
  if (sess) return { ok: true, kind: 'session', tenant: sess.tenant, user: sess };
  return { ok: false };
}
// cookie Secure exceto em host local (pra testar via http no preview).
function sessionCookie(req, token, maxAgeS) {
  const host = req.headers.host || '';
  const local = /^(localhost|127\.|\[?::1)/.test(host);
  const secure = local ? '' : ' Secure;';
  return `${COOKIE}=${token}; HttpOnly; Path=/; SameSite=Lax;${secure} Max-Age=${maxAgeS}`;
}
function send(res, code, obj) {
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(JSON.stringify(obj));
}
function readBody(req) {
  return new Promise((resolve) => {
    let d = '';
    req.on('data', (c) => (d += c));
    req.on('end', () => { try { resolve(d ? JSON.parse(d) : {}); } catch { resolve({}); } });
  });
}
function readRaw(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// ---- sessions: extrair archive (zip|rar) + ingerir ---------------------
// detecta rar pelo magic "Rar!"; senão trata como zip (unzip próprio zero-dep).
async function extractArchive(buf) {
  if (buf.length >= 4 && buf[0] === 0x52 && buf[1] === 0x61 && buf[2] === 0x72 && buf[3] === 0x21) {
    const { createExtractorFromData } = await import('node-unrar-js');
    const extractor = await createExtractorFromData({ data: Uint8Array.from(buf) });
    const { files } = extractor.extract();
    const out = [];
    for (const f of files) {
      if (f.fileHeader.flags.directory || !f.extraction) continue;
      out.push({ name: f.fileHeader.name, data: Buffer.from(f.extraction) });
    }
    return out;
  }
  return unzip(buf); // zip -> [{name,data}] (diretórios ignorados)
}

// grava as subsessions <telefone>/<numero>-<n> no pool do batch, embute o link em
// cada uma e inventaria. entries = [{name,data}]. retorna { novas:[unit], files }.
async function ingestSessions(batch, tenant, entries, link) {
  const norm = (s) => String(s).replaceAll('\\', '/');
  const have = new Set(entries.map((e) => norm(e.name)));
  const data = link ? Buffer.from(String(link).trim(), 'utf8') : null;
  const seen = new Set(), sessInv = [], extraL = [], novas = [];
  for (const e of entries) {
    const parts = norm(e.name).split('/');
    if (parts.length < 2 || !/^\d+-\d+$/.test(parts[1])) continue;
    const unit = `${parts[0]}/${parts[1]}`;
    if (seen.has(unit)) continue;
    seen.add(unit); novas.push(unit);
    sessInv.push({ telefone: parts[0], subsession: parts[1], link: link || null });
    if (data) { const lname = `${unit}/session-link.txt`; if (!have.has(lname)) { have.add(lname); extraL.push({ name: lname, data }); } }
  }
  if (!novas.length) return { novas: [], files: 0 };
  const all = [...entries, ...extraL];
  try { db.inventSessions(batch, tenant, sessInv); } catch { /* inventário best-effort */ }
  for (const e of all) await store.put(batch, 'sessions', e.name, e.data);
  return { novas, files: all.length };
}

// ---- limites de distribuição -------------------------------------------
async function loadLimits() {
  try { return JSON.parse(await readFile(LIMITS_FILE, 'utf8')); } catch { return {}; }
}
const capOf = (limits, agent, kind) => {
  const v = limits?.[agent]?.[kind] ?? limits?.default?.[kind] ?? null;
  return v == null ? Infinity : Number(v);
};

// ---- jobs ---------------------------------------------------------------
async function createJob(agent, spec) {
  const job = { id: crypto.randomUUID(), agent, status: 'queued', result: null, createdAt: now(), finishedAt: null, ...spec };
  jobs.set(job.id, job);
  await queue.send(agent, job);
  return job;
}
async function enqueueAndWait(agent, spec, { timeoutMs = 15 * 60 * 1000, abortCheck } = {}) {
  const job = await createJob(agent, spec);
  return new Promise((resolve) => {
    let done = false;
    const finish = (r) => {
      if (done) return; done = true;
      clearTimeout(timer); if (ab) clearInterval(ab); pending.delete(job.id);
      resolve(r);
    };
    const timer = setTimeout(() => {
      job.status = 'timeout'; job.finishedAt = now();
      finish({ agent, stdout: '', stderr: 'timeout esperando o agente', code: 124 });
    }, timeoutMs);
    // abortCheck: se o run foi parado/encerrado no painel, larga o job AGORA em vez
    // de pendurar até o timeout (resolve run travado com agente morto, sem restart).
    const ab = abortCheck
      ? setInterval(() => {
          if (abortCheck()) { job.status = 'aborted'; job.finishedAt = now(); finish({ agent, stdout: '', stderr: 'encerrado pelo painel', code: 137 }); }
        }, 800)
      : null;
    pending.set(job.id, (result) => finish({ agent, ...result }));
  });
}
const runOnAgent = (agent, command, opts = {}) =>
  enqueueAndWait(agent, { type: 'shell', command, shell: opts.shell || 'powershell', timeoutMs: opts.timeoutMs, abortCheck: opts.abortCheck }, opts);

// ---- distribuição round-robin com teto por VPS -------------------------
async function distributeKind(batch, kind, targetAgents, log, limitsOverride, onlyUnits) {
  const destFolder = kind === 'sessions' ? 'SESSIONS' : 'TELEFONES CAMPANHA';
  const ags = targetAgents.length ? targetAgents : knownAgents();
  if (!ags.length) throw new Error('nenhum agente disponível para distribuir');

  // Monta as UNIDADES de distribuição -> arquivos. Cada unidade vai inteira p/ 1 VPS.
  //  sessions:  unidade = pasta <telefone> (todos os arquivos recursivos juntos)
  //  telefones: unidade = NÚMERO (par TELEFONES-<n>.txt + " - Copia"), pra não quebrar o par
  const unitFiles = new Map(); // unit -> [{rel}]
  if (kind === 'sessions') {
    // unidade = subpasta <telefone>/<numero>-<n> (espalha as sessions entre as VPS)
    for (const u of await store.listSessionUnits(batch)) {
      unitFiles.set(u, (await store.listSessionFiles(batch, u)).map((rel) => ({ rel })));
    }
  } else {
    const pat = /^TELEFONES-(\d+)(?: - Copia)?\.txt$/i;
    for (const f of await store.listUnits(batch, 'telefones')) {
      const m = f.match(pat);
      const key = m ? `num-${m[1]}` : f; // par agrupado pelo número; avulso = ele mesmo
      if (!unitFiles.has(key)) unitFiles.set(key, []);
      unitFiles.get(key).push({ rel: f });
    }
  }
  let units = [...unitFiles.keys()];
  // onlyUnits: distribui SÓ essas units (ex.: sessions recém-adicionadas com a
  // campanha rodando — não re-empurra as que já estão nas VPS).
  if (onlyUnits && onlyUnits.length) {
    const want = new Set(onlyUnits);
    units = units.filter((u) => want.has(u));
  }
  if (!units.length) throw new Error(`nada para distribuir em ${kind} (batch ${batch})`);

  const limits = limitsOverride || (await loadLimits());
  const buckets = new Map(ags.map((a) => [a, []]));
  const leftover = [];
  for (const u of units) {
    let pick = null;
    for (const a of ags) {
      if (buckets.get(a).length >= capOf(limits, a, kind)) continue;
      if (pick === null || buckets.get(a).length < buckets.get(pick).length) pick = a;
    }
    if (pick === null) leftover.push(u);
    else buckets.get(pick).push(u);
  }
  if (leftover.length) log?.(`⚠ ${leftover.length} ${kind} não distribuído(s) (tetos atingidos): ${leftover.slice(0, 10).join(', ')}${leftover.length > 10 ? '...' : ''}`);

  const jobsPlan = [];
  for (const ag of ags) {
    const myUnits = buckets.get(ag);
    const files = [];
    for (const u of myUnits) files.push(...unitFiles.get(u));
    jobsPlan.push({ agent: ag, units: myUnits.length, files });
  }

  log?.(`distribuindo ${kind}: ${units.length} unidade(s) -> ${ags.map((a) => `${a}:${buckets.get(a).length}`).join(' ')}`);

  const results = await Promise.all(jobsPlan.map((p) =>
    enqueueAndWait(p.agent, { type: 'sync', kind, destFolder, batch: safeRel(batch), files: p.files })
      .then((r) => ({ ...r, units: p.units, files: p.files.length }))
  ));
  return { results, leftover };
}

// ---- playbooks ----------------------------------------------------------
let importCounter = 0;
async function loadPlaybook(name) {
  const safe = path.basename(name).replace(/[^a-z0-9._-]/gi, '');
  const file = path.join(PLAYBOOKS_DIR, safe.endsWith('.js') ? safe : `${safe}.js`);
  const url = pathToFileURL(file).href + `?v=${++importCounter}`;
  const mod = await import(url);
  if (typeof mod.default !== 'function') throw new Error(`playbook '${name}' sem export default function`);
  return mod;
}
async function runPlaybook(name, args) {
  const mod = await loadPlaybook(name);
  const run = { id: crypto.randomUUID(), playbook: name, args: args || {}, status: 'running', log: [], startedAt: now(), finishedAt: null, error: null, result: null, aborted: false };
  runs.set(run.id, run);
  const log = (msg) => { const line = { t: now(), msg: String(msg) }; run.log.push(line); console.log(`[run ${run.id.slice(0, 8)}] ${line.msg}`); };
  const ctx = {
    args: args || {},
    log,
    isAborted: () => run.aborted,   // o playbook checa isto p/ pausar entre ondas
    // todo job carrega o abortCheck do run -> parar/encerrar no painel larga os
    // jobs em voo na hora (não espera o timeout de 45min com agente morto).
    run: (agent, command, opts = {}) => runOnAgent(agent, command, { ...opts, abortCheck: () => run.aborted }),
    runAll: (command, opts = {}) => Promise.all(knownAgents().map((a) => runOnAgent(a, command, { ...opts, abortCheck: () => run.aborted }))),
    distribute: (batch, kind, opts = {}) => distributeKind(batch, kind, opts.agents || [], log, opts.limits),
    agents: knownAgents,
    tenantAgents: agentsOf,
    // --- fila de ondas (pull) ---
    lease: (batch, agent, n) => workqueue.lease(batch, agent, n),
    commitUnits: (batch, keys) => workqueue.commit(batch, keys),
    queueStatus: (batch) => workqueue.status(batch),
    resetQueue: (batch) => workqueue.reset(batch),
    returnLease: (batch, units) => workqueue.returnLease(batch, units),
    retryLease: (batch, units, max) => workqueue.retryLease(batch, units, max),
    requeue: (batch, units) => workqueue.requeue(batch, units), // volta pro fim sem penalizar (session ruim)
    recordWave: (rec) => { try { return db.recordWave(rec); } catch (e) { log(`⚠ db: ${e.message}`); return null; } },
    syncTelefones: (agent, batch, units, opts = {}) =>
      enqueueAndWait(
        agent,
        { type: 'sync', kind: 'telefones', destFolder: 'TELEFONES CAMPANHA', batch: safeRel(batch), files: units.flatMap((u) => u.files) },
        { timeoutMs: opts.timeoutMs || 10 * 60 * 1000, abortCheck: () => run.aborted }
      ),
    // conteúdo global (TEXTO-BASE.txt + VIDEO) -> Desktop\CONTEUDO da VPS.
    //  O TEXTO.txt de cada slot é gerado por onda pelo gera-texto.js (link da
    //  session + TEXTO-BASE.txt); o setup-conteudo só espalha o VIDEO.
    syncConteudo: async (agent, batch, opts = {}) => {
      const files = (await store.listFiles(batch, 'conteudo')).map((rel) => ({ rel }));
      if (!files.length) return { skipped: true, stdout: '(sem conteudo)', code: 0 };
      return enqueueAndWait(
        agent,
        { type: 'sync', kind: 'conteudo', destFolder: 'CONTEUDO', batch: safeRel(batch), files },
        { timeoutMs: opts.timeoutMs || 10 * 60 * 1000, abortCheck: () => run.aborted }
      );
    },
  };
  (async () => {
    try {
      log(`▶ iniciando playbook '${name}'`);
      run.result = (await mod.default(ctx)) ?? null;
      run.status = 'done';
      log('✔ concluído');
    } catch (e) { run.status = 'error'; run.error = e.message; log(`✖ erro: ${e.message}`); }
    finally { run.finishedAt = now(); }
  })();
  return run;
}

// ---- página de upload (HTML estático em hub/upload.html, sem auth p/ carregar) -------------
// Carregado uma vez no boot. Editou o HTML? `docker restart botmkt` (ou reinicie o hub).
const UPLOAD_HTML = await readFile(path.join(__dirname, 'upload.html'), 'utf8');

// ---- roteamento ---------------------------------------------------------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;
  if (p === '/health') return send(res, 200, { ok: true, time: now(), storage: usingS3 ? 's3' : 'local', queue: usingSqs ? 'sqs' : 'memory' });
  if ((p === '/' || p === '/upload-ui') && req.method === 'GET') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    return res.end(UPLOAD_HTML);
  }

  // --- login por sessão (público; agentes/CLI seguem no HUB_TOKEN) ---
  if (p === '/auth/login' && req.method === 'POST') {
    const b = await readBody(req);
    const u = users.authenticate(b.username, b.password);
    if (!u) return send(res, 401, { error: 'usuário ou senha inválidos' });
    users.cleanupSessions();
    const { token } = users.createSession(u.id);
    res.setHeader('Set-Cookie', sessionCookie(req, token, Math.floor(users.SESSION_TTL_MS / 1000)));
    return send(res, 200, { ok: true, username: u.username, tenant: u.tenant, role: u.role });
  }
  if (p === '/auth/me' && req.method === 'GET') {
    const sess = users.getSession(parseCookies(req)[COOKIE]);
    if (!sess) return send(res, 401, { error: 'não autenticado' });
    return send(res, 200, { username: sess.username, tenant: sess.tenant, role: sess.role });
  }
  if (p === '/auth/logout' && req.method === 'POST') {
    users.destroySession(parseCookies(req)[COOKIE]);
    res.setHeader('Set-Cookie', sessionCookie(req, '', 0));
    return send(res, 200, { ok: true });
  }

  const A = getAuth(req);
  if (!A.ok) return send(res, 401, { error: 'unauthorized' });

  // --- agente ---
  if (p === '/agent/poll' && req.method === 'POST') {
    const b = await readBody(req);
    if (!b.id) return send(res, 400, { error: 'id obrigatório' });
    touchAgent(b.id, clientIp(req), { ...(b.tenant ? { tenant: b.tenant } : {}), ...(b.info ? { info: b.info } : {}) });
    const job = await queue.receive(b.id);
    if (job) {
      const existing = jobs.get(job.id);
      if (existing) { existing.status = 'running'; existing._receipt = job._receipt; existing._agent = b.id; }
      else { job.status = 'running'; jobs.set(job.id, job); }
    }
    return send(res, 200, { job });
  }
  if (p === '/agent/heartbeat' && req.method === 'POST') {
    const b = await readBody(req);
    if (!b.id) return send(res, 400, { error: 'id obrigatório' });
    touchAgent(b.id, clientIp(req), { status: b.status || 'idle', job: b.job || null, ...(b.tenant ? { tenant: b.tenant } : {}) });
    return send(res, 200, { ok: true });
  }
  // o agente empurra as linhas novas dos _logs/slot-*.log p/ o painel acompanhar ao vivo
  if (p === '/agent/logs' && req.method === 'POST') {
    const b = await readBody(req);
    if (!b.id) return send(res, 400, { error: 'id obrigatório' });
    touchAgent(b.id, clientIp(req), b.tenant ? { tenant: b.tenant } : {});
    if (Array.isArray(b.lines) && b.lines.length) pushAgentLines(b.id, b.tenant, b.lines);
    return send(res, 200, { ok: true });
  }
  if (p === '/agent/result' && req.method === 'POST') {
    const b = await readBody(req);
    const job = jobs.get(b.jobId);
    if (job) {
      job.status = b.code === 0 ? 'done' : 'error';
      job.result = { stdout: b.stdout, stderr: b.stderr, code: b.code };
      job.finishedAt = now();
      try { await queue.ack(job); } catch (e) { console.error('ack falhou:', e.message); }
      const resolve = pending.get(job.id);
      if (resolve) { pending.delete(job.id); resolve(job.result); }
    }
    return send(res, 200, { ok: true });
  }

  // --- arquivos ---
  if (p === '/upload' && req.method === 'POST') {
    const batch = url.searchParams.get('batch'), kind = url.searchParams.get('kind'), rel = url.searchParams.get('rel');
    const agent = url.searchParams.get('agent');
    if (!batch || !['sessions', 'telefones', 'conteudo'].includes(kind) || !rel) return send(res, 400, { error: 'batch, kind(sessions|telefones|conteudo) e rel obrigatórios' });
    // conteúdo por-VPS (ex.: TEXTO.txt com o link daquela VPS) -> <batch>__<agent>/conteudo
    const storeBatch = (kind === 'conteudo' && agent) ? `${safeRel(batch)}__${safeRel(agent)}` : batch;
    try { await store.put(storeBatch, kind, rel, await readRaw(req)); return send(res, 200, { ok: true, rel: safeRel(rel), agent: agent || null }); }
    catch (e) { return send(res, 500, { error: e.message }); }
  }
  if (p === '/upload-zip' && req.method === 'POST') {
    const batch = url.searchParams.get('batch'), kind = url.searchParams.get('kind'), agent = url.searchParams.get('agent'), link = url.searchParams.get('link');
    if (!batch || !['sessions', 'telefones'].includes(kind)) return send(res, 400, { error: 'batch e kind(sessions|telefones) obrigatórios' });
    try {
      // sessions: sem agent = pool COMPARTILHADO (<batch>/sessions, espalhado depois
      // entre as VPS). Com agent = legado por-VPS (<batch>__<agent>).
      const storageBatch = (kind === 'sessions' && agent) ? `${safeRel(batch)}__${safeRel(agent)}` : batch;
      const entries = unzip(await readRaw(req));
      // telefones: o movimenta-numeros (na VPS) só move o número se houver o PAR
      // (TELEFONES-<n>.txt + "TELEFONES-<n> - Copia.txt"). Se o zip veio só com os
      // originais, cria a cópia aqui pra cada um que estiver sem par.
      let copias = 0;
      if (kind === 'telefones') {
        const norm = (s) => String(s).replaceAll('\\', '/');
        const have = new Set(entries.map((e) => norm(e.name)));
        const extra = [], telInv = [];
        for (const e of entries) {
          const name = norm(e.name), slash = name.lastIndexOf('/');
          const dir = slash >= 0 ? name.slice(0, slash + 1) : '', base = slash >= 0 ? name.slice(slash + 1) : name;
          const m = base.match(/^TELEFONES-(\d+)\.txt$/i);
          if (!m) continue;
          telInv.push({ unit: `num-${m[1]}`, phone: e.data.toString('utf8').trim() }); // inventário: o número dentro do txt
          const copia = `${dir}TELEFONES-${m[1]} - Copia.txt`;
          if (!have.has(copia)) { have.add(copia); extra.push({ name: copia, data: e.data }); copias++; }
        }
        entries.push(...extra);
        try { db.inventTelefones(batch, A.tenant, telInv); } catch (e) { /* inventário best-effort */ }
      }
      // sessions: inventaria cada subpasta <telefone>/<numero>-<n> e, se houver link,
      // grava session-link.txt DENTRO dela (o link viaja junto da session no
      // movimenta/renomeia → vira <slot>\session\session-link.txt).
      let links = 0;
      if (kind === 'sessions') {
        const norm = (s) => String(s).replaceAll('\\', '/');
        const have = new Set(entries.map((e) => norm(e.name)));
        const data = link ? Buffer.from(String(link).trim(), 'utf8') : null;
        const seen = new Set(), sessInv = [], extraL = [];
        for (const e of entries) {
          const parts = norm(e.name).split('/');
          if (parts.length < 2 || !/^\d+-\d+$/.test(parts[1])) continue;
          const unit = `${parts[0]}/${parts[1]}`;
          if (seen.has(unit)) continue;
          seen.add(unit);
          sessInv.push({ telefone: parts[0], subsession: parts[1], link: link || null });
          if (data) { const lname = `${unit}/session-link.txt`; if (!have.has(lname)) { have.add(lname); extraL.push({ name: lname, data }); links++; } }
        }
        entries.push(...extraL);
        try { db.inventSessions(batch, A.tenant, sessInv); } catch (e) { /* inventário best-effort */ }
      }
      let n = 0;
      for (const e of entries) { await store.put(storageBatch, kind, e.name, e.data); n++; }
      if (kind === 'telefones') { try { await workqueue.reset(batch); } catch { /* fila recria no play */ } }
      return send(res, 200, { ok: true, kind, agent: agent || null, files: n, copias, links });
    } catch (e) { return send(res, 500, { error: e.message }); }
  }
  // adicionar sessions COM a campanha rodando: sobe no pool + distribui SÓ as
  // novas pras VPS ONLINE do tenant (a próxima onda do movimenta-sessions já pega).
  if (p === '/sessions/add' && req.method === 'POST') {
    const batch = url.searchParams.get('batch'), link = url.searchParams.get('link');
    if (!batch) return send(res, 400, { error: 'batch obrigatório' });
    const tenant = A.kind === 'session' ? A.tenant : (url.searchParams.get('tenant') || 'default');
    if (A.kind === 'session' && batch !== A.tenant && !batch.startsWith(A.tenant + '-')) return send(res, 403, { error: 'batch de outro tenant' });
    try {
      const { novas } = await ingestSessions(batch, tenant, unzip(await readRaw(req)), link);
      if (!novas.length) return send(res, 400, { error: 'nenhuma subsession <numero>-<n> encontrada no zip' });
      // distribui SÓ as novas pras VPS online do tenant (não re-empurra as que já estão lá)
      const ativos = [...agents.values()].filter((a) => (a.tenant || 'default') === tenant && isOnline(a)).map((a) => a.id);
      if (!ativos.length) return send(res, 200, { ok: true, novas: novas.length, distribuido: 0, aviso: 'sessions subidas, mas nenhuma VPS online p/ distribuir' });
      const ds = await distributeKind(batch, 'sessions', ativos, () => {}, undefined, novas);
      const distribuido = (ds.results || []).reduce((s, r) => s + (r.units || 0), 0);
      return send(res, 200, { ok: true, novas: novas.length, distribuido, agentes: ativos });
    } catch (e) { return send(res, 500, { error: e.message }); }
  }
  // importar archive CRU (zip/rar) — "repack no servidor": extrai, lê a URL do .txt
  // (vira o link), tira o wrapper, ingere as sessions e distribui. Link automático.
  if (p === '/sessions/import' && req.method === 'POST') {
    const batch = url.searchParams.get('batch');
    if (!batch) return send(res, 400, { error: 'batch obrigatório' });
    const tenant = A.kind === 'session' ? A.tenant : (url.searchParams.get('tenant') || 'default');
    if (A.kind === 'session' && batch !== A.tenant && !batch.startsWith(A.tenant + '-')) return send(res, 403, { error: 'batch de outro tenant' });
    try {
      const norm = (s) => String(s).replaceAll('\\', '/');
      const entries = await extractArchive(await readRaw(req));
      // content root = nível do .txt mais RASO (a URL); o resto são as sessions.
      const txts = entries.filter((e) => /\.txt$/i.test(norm(e.name))).sort((a, b) => norm(a.name).split('/').length - norm(b.name).split('/').length);
      if (!txts.length) return send(res, 400, { error: 'nenhum .txt (URL) dentro do arquivo' });
      const link = String(txts[0].data.toString('utf8')).trim().split(/\r?\n/)[0].trim();
      if (!link) return send(res, 400, { error: '.txt vazio (sem URL)' });
      // pega <telefone>/<numero>-<n>/... de CADA caminho, tirando qualquer wrapper
      // antes (NÃO depende de onde o .txt está -> robusto a 1+ pastas externas no
      // zip/rar e a backslash do Windows).
      const reUnit = /(?:^|\/)(\d+\/\d+-\d+\/.*)$/;
      const sess = entries
        .filter((e) => !/\.txt$/i.test(norm(e.name)))
        .map((e) => { const m = norm(e.name).match(reUnit); return m ? { name: m[1], data: e.data } : null; })
        .filter(Boolean);
      const { novas } = sess.length ? await ingestSessions(batch, tenant, sess, link) : { novas: [] };
      if (!novas.length) {
        // diagnóstico: mostra o que saiu da extração pra achar a causa (estrutura x extração)
        const ex = entries.filter((e) => !/\.txt$/i.test(norm(e.name))).slice(0, 6).map((e) => norm(e.name));
        return send(res, 400, { error: 'nenhuma session <telefone>/<numero>-<n> no arquivo', link, entradas: entries.length, exemplos: ex });
      }
      const ativos = [...agents.values()].filter((a) => (a.tenant || 'default') === tenant && isOnline(a)).map((a) => a.id);
      const ds = ativos.length ? await distributeKind(batch, 'sessions', ativos, () => {}, undefined, novas) : { results: [] };
      const distribuido = (ds.results || []).reduce((s, r) => s + (r.units || 0), 0);
      return send(res, 200, { ok: true, link, novas: novas.length, distribuido });
    } catch (e) { return send(res, 500, { error: e.message }); }
  }
  if (p === '/file' && req.method === 'GET') {
    const batch = url.searchParams.get('batch'), kind = url.searchParams.get('kind'), rel = url.searchParams.get('rel');
    try {
      const buf = await store.getBuffer(batch, kind, rel);
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      res.end(buf);
    } catch { send(res, 404, { error: 'arquivo não encontrado' }); }
    return;
  }

  // --- comandos avulsos ---
  if (p === '/enqueue' && req.method === 'POST') {
    const b = await readBody(req);
    if (!b.command) return send(res, 400, { error: 'command obrigatório' });
    const targets = b.agent && b.agent !== 'all' ? [b.agent] : knownAgents();
    if (!targets.length) return send(res, 409, { error: 'nenhum agente conhecido ainda' });
    const created = [];
    for (const t of targets) { const j = await createJob(t, { type: 'shell', command: b.command, shell: b.shell || 'powershell' }); created.push({ jobId: j.id, agent: t }); }
    return send(res, 200, { created });
  }
  if (p.startsWith('/job/') && req.method === 'GET') {
    const job = jobs.get(p.slice('/job/'.length));
    return job ? send(res, 200, job) : send(res, 404, { error: 'job desconhecido' });
  }
  if (p === '/agents' && req.method === 'GET') {
    // usuário logado: tenant FIXO pela conta. token mestre: tenant pelo query.
    const tenant = A.kind === 'session' ? A.tenant : url.searchParams.get('tenant');
    let list = [...agents.values()];
    if (tenant && tenant !== 'all') list = list.filter((a) => (a.tenant || 'default') === tenant);
    return send(res, 200, { agents: list.map(agentView) });
  }

  // --- batches existentes (p/ sugerir o próximo número do dia) ---
  if (p === '/batches' && req.method === 'GET') {
    const prefix = url.searchParams.get('prefix') || '';
    let all = await store.listBatches();
    // sessão: só batches do próprio tenant (convenção <tenant>-...).
    if (A.kind === 'session') all = all.filter((b) => b === A.tenant || b.startsWith(A.tenant + '-'));
    if (prefix) all = all.filter((b) => b.startsWith(prefix));
    return send(res, 200, { batches: all.sort() });
  }

  // --- usuários (admin: só via HUB_TOKEN) ---
  if (p === '/auth/users' && req.method === 'GET') {
    if (A.kind !== 'token') return send(res, 403, { error: 'somente admin (HUB_TOKEN)' });
    return send(res, 200, { users: users.listUsers() });
  }
  if (p === '/auth/users' && req.method === 'POST') {
    if (A.kind !== 'token') return send(res, 403, { error: 'somente admin (HUB_TOKEN)' });
    const b = await readBody(req);
    try { return send(res, 200, users.addUser(b)); } catch (e) { return send(res, 400, { error: e.message }); }
  }
  if (p.startsWith('/auth/users/') && req.method === 'DELETE') {
    if (A.kind !== 'token') return send(res, 403, { error: 'somente admin (HUB_TOKEN)' });
    return send(res, 200, users.deleteUser(decodeURIComponent(p.slice('/auth/users/'.length))));
  }

  // --- stats (sqlite) ---
  if (p === '/stats' && req.method === 'GET') {
    const batch = url.searchParams.get('batch');
    if (!batch) return send(res, 400, { error: 'batch obrigatório' });
    const tenant = A.kind === 'session' ? A.tenant : url.searchParams.get('tenant');
    return send(res, 200, db.statsByBatch(batch, tenant));
  }
  if (p === '/erros' && req.method === 'GET') {
    const batch = url.searchParams.get('batch');
    if (!batch) return send(res, 400, { error: 'batch obrigatório' });
    const tenant = A.kind === 'session' ? A.tenant : url.searchParams.get('tenant');
    return send(res, 200, { erros: db.errosByBatch(batch, tenant) });
  }
  if (p === '/inventory' && req.method === 'GET') {
    const batch = url.searchParams.get('batch');
    if (!batch) return send(res, 400, { error: 'batch obrigatório' });
    const tenant = A.kind === 'session' ? A.tenant : url.searchParams.get('tenant');
    return send(res, 200, db.inventoryByBatch(batch, tenant));
  }
  if (p === '/waves' && req.method === 'GET') {
    const batch = url.searchParams.get('batch');
    if (!batch) return send(res, 400, { error: 'batch obrigatório' });
    return send(res, 200, { waves: db.recentWaves(batch) });
  }
  // contadores AO VIVO da fila: pending / leased(processando) / retrying / done
  if (p === '/queue' && req.method === 'GET') {
    const batch = url.searchParams.get('batch');
    if (!batch) return send(res, 400, { error: 'batch obrigatório' });
    // sessão só vê batch do próprio tenant (convenção <tenant>-...)
    if (A.kind === 'session' && batch !== A.tenant && !batch.startsWith(A.tenant + '-')) return send(res, 403, { error: 'batch de outro tenant' });
    try { return send(res, 200, await workqueue.status(batch)); }
    catch (e) { return send(res, 500, { error: e.message }); }
  }
  // logs ao vivo dos slots, por VPS do tenant (o agente empurra via /agent/logs)
  if (p === '/logs' && req.method === 'GET') {
    const tenant = A.kind === 'session' ? A.tenant : url.searchParams.get('tenant');
    const wantAgent = url.searchParams.get('agent');
    const tail = Math.min(Math.max(Number(url.searchParams.get('tail') || 300), 1), LOG_CAP);
    const out = [];
    for (const [agent, rec] of agentLogs) {
      if (tenant && tenant !== 'all' && (rec.tenant || 'default') !== tenant) continue;
      if (wantAgent && agent !== wantAgent) continue;
      out.push({ agent, online: agents.has(agent) && isOnline(agents.get(agent)), lines: rec.lines.slice(-tail) });
    }
    return send(res, 200, { agents: out });
  }

  // --- playbooks ---
  if (p === '/playbooks' && req.method === 'GET') {
    let files = [];
    try { files = await readdir(PLAYBOOKS_DIR); } catch { /* vazio */ }
    return send(res, 200, { playbooks: files.filter((f) => f.endsWith('.js')).map((f) => f.replace(/\.js$/, '')) });
  }
  if (p.startsWith('/play/') && req.method === 'POST') {
    if (A.kind !== 'token') return send(res, 403, { error: 'somente admin (HUB_TOKEN); pelo painel use /campaign/start' });
    const b = await readBody(req);
    try { const run = await runPlaybook(p.slice('/play/'.length), b.args); return send(res, 200, { runId: run.id, status: run.status }); }
    catch (e) { return send(res, 400, { error: e.message }); }
  }
  // iniciar campanha pelo painel: tenant FIXADO pela sessão; trava anti-duplicado por batch.
  if (p === '/campaign/start' && req.method === 'POST') {
    const b = await readBody(req);
    const batch = b.batch;
    if (!batch) return send(res, 400, { error: 'batch obrigatório' });
    const tenant = A.kind === 'session' ? A.tenant : (b.tenant || 'default');
    const running = [...runs.values()].find((r) => r.playbook === 'campanha-fila' && r.status === 'running' && r.args?.batch === batch && (r.args?.tenant || 'default') === tenant);
    if (running) return send(res, 409, { error: 'já há uma campanha rodando nesse batch', runId: running.id });
    try { const run = await runPlaybook('campanha-fila', { batch, tenant, skipSetup: !!b.skipSetup }); return send(res, 200, { runId: run.id, status: run.status }); }
    catch (e) { return send(res, 400, { error: e.message }); }
  }
  // pausar campanha pelo painel: sinaliza o(s) run(s) desse batch p/ parar entre
  // ondas (a onda atual fecha, dá commit, e o loop encerra; a fila fica intacta).
  if (p === '/campaign/stop' && req.method === 'POST') {
    const b = await readBody(req);
    const batch = b.batch;
    if (!batch) return send(res, 400, { error: 'batch obrigatório' });
    const tenant = A.kind === 'session' ? A.tenant : (b.tenant || 'default');
    const alvos = [...runs.values()].filter((r) =>
      r.status === 'running' && r.playbook === 'campanha-fila' &&
      r.args?.batch === batch && (r.args?.tenant || 'default') === tenant &&
      (A.kind === 'token' || (r.args?.tenant || 'default') === A.tenant)); // sessão só para o próprio tenant
    for (const r of alvos) r.aborted = true;
    return send(res, 200, { ok: true, parando: alvos.length });
  }
  if (p.startsWith('/run/') && req.method === 'GET') {
    const run = runs.get(p.slice('/run/'.length));
    if (!run) return send(res, 404, { error: 'run desconhecido' });
    if (A.kind === 'session' && (run.args?.tenant || 'default') !== A.tenant) return send(res, 403, { error: 'run de outro tenant' });
    return send(res, 200, run);
  }
  if (p === '/runs' && req.method === 'GET') {
    let list = [...runs.values()];
    if (A.kind === 'session') list = list.filter((r) => (r.args?.tenant || 'default') === A.tenant);
    return send(res, 200, { runs: list.map(({ log, ...r }) => ({ ...r, logCount: log.length })) });
  }

  return send(res, 404, { error: 'rota desconhecida' });
});

server.listen(PORT, () => console.log(`Hub na porta ${PORT} | storage=${usingS3 ? 'S3' : 'local'} | fila=${usingSqs ? 'SQS' : 'memória'}`));
