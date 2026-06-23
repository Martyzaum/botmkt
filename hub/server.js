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

const now = () => new Date().toISOString();
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

function auth(req) {
  const h = req.headers['authorization'] || '';
  const tok = h.startsWith('Bearer ') ? h.slice(7) : h;
  return tok === TOKEN;
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
async function enqueueAndWait(agent, spec, { timeoutMs = 15 * 60 * 1000 } = {}) {
  const job = await createJob(agent, spec);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(job.id); job.status = 'timeout'; job.finishedAt = now();
      resolve({ agent, stdout: '', stderr: 'timeout esperando o agente', code: 124 });
    }, timeoutMs);
    pending.set(job.id, (result) => { clearTimeout(timer); resolve({ agent, ...result }); });
  });
}
const runOnAgent = (agent, command, opts = {}) =>
  enqueueAndWait(agent, { type: 'shell', command, shell: opts.shell || 'powershell', timeoutMs: opts.timeoutMs }, opts);

// ---- distribuição round-robin com teto por VPS -------------------------
async function distributeKind(batch, kind, targetAgents, log, limitsOverride) {
  const destFolder = kind === 'sessions' ? 'SESSIONS' : 'TELEFONES CAMPANHA';
  const ags = targetAgents.length ? targetAgents : knownAgents();
  if (!ags.length) throw new Error('nenhum agente disponível para distribuir');

  // Monta as UNIDADES de distribuição -> arquivos. Cada unidade vai inteira p/ 1 VPS.
  //  sessions:  unidade = pasta <telefone> (todos os arquivos recursivos juntos)
  //  telefones: unidade = NÚMERO (par TELEFONES-<n>.txt + " - Copia"), pra não quebrar o par
  const unitFiles = new Map(); // unit -> [{rel}]
  if (kind === 'sessions') {
    for (const s of await store.listUnits(batch, 'sessions')) {
      unitFiles.set(s, (await store.listSessionFiles(batch, s)).map((rel) => ({ rel })));
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
  const units = [...unitFiles.keys()];
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
  const run = { id: crypto.randomUUID(), playbook: name, status: 'running', log: [], startedAt: now(), finishedAt: null, error: null, result: null };
  runs.set(run.id, run);
  const log = (msg) => { const line = { t: now(), msg: String(msg) }; run.log.push(line); console.log(`[run ${run.id.slice(0, 8)}] ${line.msg}`); };
  const ctx = {
    args: args || {},
    log,
    run: (agent, command, opts) => runOnAgent(agent, command, opts),
    runAll: (command, opts) => Promise.all(knownAgents().map((a) => runOnAgent(a, command, opts))),
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
    recordWave: (rec) => { try { return db.recordWave(rec); } catch (e) { log(`⚠ db: ${e.message}`); return null; } },
    syncTelefones: (agent, batch, units, opts = {}) =>
      enqueueAndWait(
        agent,
        { type: 'sync', kind: 'telefones', destFolder: 'TELEFONES CAMPANHA', batch: safeRel(batch), files: units.flatMap((u) => u.files) },
        { timeoutMs: opts.timeoutMs || 10 * 60 * 1000 }
      ),
    // conteúdo (texto + video) -> Desktop\CONTEUDO da VPS (depois setup-conteudo espalha nos DADOS)
    syncConteudo: async (agent, batch, opts = {}) => {
      const files = (await store.listFiles(batch, 'conteudo')).map((rel) => ({ rel }));
      if (!files.length) return { skipped: true, stdout: '(sem conteudo)', code: 0 };
      return enqueueAndWait(
        agent,
        { type: 'sync', kind: 'conteudo', destFolder: 'CONTEUDO', batch: safeRel(batch), files },
        { timeoutMs: opts.timeoutMs || 10 * 60 * 1000 }
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

// ---- página de upload (HTML estático, sem auth p/ carregar) -------------
const UPLOAD_HTML = `<!doctype html><html lang="pt-br"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>wppbot — upload</title>
<style>
  body{font:15px system-ui,sans-serif;max-width:620px;margin:40px auto;padding:0 16px;color:#1a1a1a}
  h1{font-size:20px} label{display:block;margin:14px 0 4px;font-weight:600}
  input{width:100%;padding:9px;border:1px solid #cbd5e1;border-radius:8px;box-sizing:border-box}
  input[type=file]{padding:6px}
  textarea{width:100%;padding:9px;border:1px solid #cbd5e1;border-radius:8px;box-sizing:border-box;font:inherit}
  hr{border:0;border-top:1px solid #e2e8f0;margin:22px 0}
  button{margin-top:20px;padding:11px 18px;border:0;border-radius:8px;background:#2563eb;color:#fff;font-weight:600;cursor:pointer}
  button:disabled{opacity:.5;cursor:default}
  .row{display:flex;gap:12px} .row>div{flex:1}
  #out{margin-top:18px;white-space:pre-wrap;font-family:ui-monospace,monospace;font-size:13px}
  .ok{color:#15803d} .err{color:#b91c1c} small{color:#64748b}
</style></head><body>
<h1>wppbot — enviar batch</h1>
<label>Token do hub</label><input id="tok" type="password" placeholder="HUB_TOKEN">
<div class="row">
  <div><label>Tenant</label><input id="tenant" placeholder="acme"></div>
  <div><label>Batch <small>(ex.: acme-2026-06-23)</small></label><input id="batch" placeholder="acme-2026-06-23"></div>
</div>
<button id="load" style="background:#475569">Carregar VPS do tenant</button>
<div id="vps"><small>carregue as VPS para enviar 1 zip de sessions por VPS.</small></div>
<label>Link da session</label><input id="link" placeholder="(opcional)">
<hr>
<label>telefones.zip</label><input id="ztel" type="file" accept=".zip">
<hr>
<label>Texto da campanha <small>(igual p/ TODOS os slots → DADOS/TEXTO.txt)</small></label>
<textarea id="texto" rows="5" placeholder="mensagem que vai pra toda a campanha"></textarea>
<label>Vídeo <small>(vai pra DADOS/VIDEO de todos os slots)</small></label>
<input id="video" type="file" accept="video/*">
<button id="go">Enviar</button>
<div id="out"></div>
<script>
const $=id=>document.getElementById(id), out=$('out');
$('tok').value=localStorage.getItem('hubtok')||''; $('batch').value=localStorage.getItem('batch')||''; $('tenant').value=localStorage.getItem('tenant')||'';
function line(msg,cls){const d=document.createElement('div');if(cls)d.className=cls;d.textContent=msg;out.appendChild(d);}
function save(){localStorage.setItem('hubtok',$('tok').value);localStorage.setItem('batch',$('batch').value.trim());localStorage.setItem('tenant',$('tenant').value.trim());}
$('load').onclick=async()=>{
  save();
  const t=$('tenant').value.trim();
  const r=await fetch('/agents'+(t?'?tenant='+encodeURIComponent(t):''),{headers:{authorization:'Bearer '+$('tok').value}});
  const j=await r.json().catch(()=>({agents:[]}));
  const ags=(j.agents||[]).sort((a,b)=>a.id.localeCompare(b.id));
  if(!ags.length){$('vps').innerHTML='<small class=err>nenhuma VPS encontrada (confira token/tenant).</small>';return;}
  $('vps').innerHTML='';
  for(const a of ags){
    const id=a.id, on=a.online?'online':'offline';
    const wrap=document.createElement('div');
    wrap.innerHTML='<label>sessions.zip de <b>'+id+'</b> <small>('+on+')</small></label>';
    const inp=document.createElement('input');inp.type='file';inp.accept='.zip';inp.dataset.agent=id;inp.className='zsess';
    wrap.appendChild(inp);$('vps').appendChild(wrap);
  }
};
async function sendZip(batch,kind,file,agent){
  const q='/upload-zip?batch='+encodeURIComponent(batch)+'&kind='+kind+(agent?'&agent='+encodeURIComponent(agent):'');
  line('enviando '+kind+(agent?(' ['+agent+']'):'')+': '+file.name+' ('+(file.size/1048576).toFixed(1)+' MB)...');
  const r=await fetch(q,{method:'POST',headers:{authorization:'Bearer '+$('tok').value,'content-type':'application/zip'},body:file});
  const j=await r.json().catch(()=>({}));
  if(r.ok) line('OK '+kind+(agent?(' ['+agent+']'):'')+': '+j.files+' arquivo(s)','ok');
  else line('ERRO '+kind+(agent?(' ['+agent+']'):'')+': '+(j.error||('HTTP '+r.status)),'err');
}
async function sendConteudo(batch,rel,body,label){
  line('enviando '+label+'...');
  const r=await fetch('/upload?batch='+encodeURIComponent(batch)+'&kind=conteudo&rel='+encodeURIComponent(rel),
    {method:'POST',headers:{authorization:'Bearer '+$('tok').value},body});
  const j=await r.json().catch(()=>({}));
  if(r.ok) line('OK '+label,'ok'); else line('ERRO '+label+': '+(j.error||('HTTP '+r.status)),'err');
}
$('go').onclick=async()=>{
  out.innerHTML='';
  const batch=$('batch').value.trim();
  if(!batch){line('informe o batch','err');return;}
  save();
  // monta o TEXTO.txt final: 👉🏻 link 👈🏻 + linha em branco + texto
  const texto=$('texto').value, link=$('link').value.trim();
  const partes=[];
  if(link) partes.push('👉🏻 '+link+' 👈🏻');
  if(texto.trim()) partes.push(texto);
  const finalTexto=partes.join('\\n\\n');
  // trava de segurança: confirma a MENSAGEM FINAL que vai pra TODA a campanha
  if(finalTexto && !confirm('Enviar ESTA mensagem para TODA a campanha (todos os slots)?\\n\\n'+finalTexto)){ line('cancelado pelo usuário'); return; }
  $('go').disabled=true;
  try{
    let enviou=false;
    for(const inp of document.querySelectorAll('.zsess')){
      if(inp.files[0]){ await sendZip(batch,'sessions',inp.files[0],inp.dataset.agent); enviou=true; }
    }
    if($('ztel').files[0]){ await sendZip(batch,'telefones',$('ztel').files[0]); enviou=true; }
    if(finalTexto){ await sendConteudo(batch,'TEXTO.txt',finalTexto,'texto da campanha'); enviou=true; }
    const vid=$('video').files[0];
    if(vid){ await sendConteudo(batch,'VIDEO/'+vid.name,vid,'vídeo ('+vid.name+')'); enviou=true; }
    line(enviou?'concluído.':'nada selecionado.', enviou?null:'err');
  }catch(e){line('erro: '+e.message,'err');}
  $('go').disabled=false;
};
</script></body></html>`;

// ---- roteamento ---------------------------------------------------------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;
  if (p === '/health') return send(res, 200, { ok: true, time: now(), storage: usingS3 ? 's3' : 'local', queue: usingSqs ? 'sqs' : 'memory' });
  if ((p === '/' || p === '/upload-ui') && req.method === 'GET') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    return res.end(UPLOAD_HTML);
  }
  if (!auth(req)) return send(res, 401, { error: 'unauthorized' });

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
    if (!batch || !['sessions', 'telefones', 'conteudo'].includes(kind) || !rel) return send(res, 400, { error: 'batch, kind(sessions|telefones|conteudo) e rel obrigatórios' });
    try { await store.put(batch, kind, rel, await readRaw(req)); return send(res, 200, { ok: true, rel: safeRel(rel) }); }
    catch (e) { return send(res, 500, { error: e.message }); }
  }
  if (p === '/upload-zip' && req.method === 'POST') {
    const batch = url.searchParams.get('batch'), kind = url.searchParams.get('kind'), agent = url.searchParams.get('agent');
    if (!batch || !['sessions', 'telefones'].includes(kind)) return send(res, 400, { error: 'batch e kind(sessions|telefones) obrigatórios' });
    if (kind === 'sessions' && !agent) return send(res, 400, { error: 'sessions exige agent (1 zip por VPS)' });
    try {
      // sessions são por VPS: guarda num batch derivado <batch>__<agent> p/ sincronizar só àquela VPS.
      const storageBatch = kind === 'sessions' ? `${safeRel(batch)}__${safeRel(agent)}` : batch;
      const entries = unzip(await readRaw(req));
      let n = 0;
      for (const e of entries) { await store.put(storageBatch, kind, e.name, e.data); n++; }
      if (kind === 'telefones') { try { await workqueue.reset(batch); } catch { /* fila recria no play */ } }
      return send(res, 200, { ok: true, kind, agent: agent || null, files: n });
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
    const tenant = url.searchParams.get('tenant');
    let list = [...agents.values()];
    if (tenant && tenant !== 'all') list = list.filter((a) => (a.tenant || 'default') === tenant);
    return send(res, 200, { agents: list.map(agentView) });
  }

  // --- stats (sqlite) ---
  if (p === '/stats' && req.method === 'GET') {
    const batch = url.searchParams.get('batch');
    if (!batch) return send(res, 400, { error: 'batch obrigatório' });
    return send(res, 200, db.statsByBatch(batch, url.searchParams.get('tenant')));
  }
  if (p === '/erros' && req.method === 'GET') {
    const batch = url.searchParams.get('batch');
    if (!batch) return send(res, 400, { error: 'batch obrigatório' });
    return send(res, 200, { erros: db.errosByBatch(batch, url.searchParams.get('tenant')) });
  }
  if (p === '/waves' && req.method === 'GET') {
    const batch = url.searchParams.get('batch');
    if (!batch) return send(res, 400, { error: 'batch obrigatório' });
    return send(res, 200, { waves: db.recentWaves(batch) });
  }

  // --- playbooks ---
  if (p === '/playbooks' && req.method === 'GET') {
    let files = [];
    try { files = await readdir(PLAYBOOKS_DIR); } catch { /* vazio */ }
    return send(res, 200, { playbooks: files.filter((f) => f.endsWith('.js')).map((f) => f.replace(/\.js$/, '')) });
  }
  if (p.startsWith('/play/') && req.method === 'POST') {
    const b = await readBody(req);
    try { const run = await runPlaybook(p.slice('/play/'.length), b.args); return send(res, 200, { runId: run.id, status: run.status }); }
    catch (e) { return send(res, 400, { error: e.message }); }
  }
  if (p.startsWith('/run/') && req.method === 'GET') {
    const run = runs.get(p.slice('/run/'.length));
    return run ? send(res, 200, run) : send(res, 404, { error: 'run desconhecido' });
  }
  if (p === '/runs' && req.method === 'GET')
    return send(res, 200, { runs: [...runs.values()].map(({ log, ...r }) => ({ ...r, logCount: log.length })) });

  return send(res, 404, { error: 'rota desconhecida' });
});

server.listen(PORT, () => console.log(`Hub na porta ${PORT} | storage=${usingS3 ? 'S3' : 'local'} | fila=${usingSqs ? 'SQS' : 'memória'}`));
