// =====================================================================
//  Fila de trabalho por batch — alimenta o loop de ondas.
//  Unidade = 1 NÚMERO (par TELEFONES-<n>.txt + " - Copia"). Cada VPS
//  faz lease(16) -> processa a onda -> commit, em loop, até secar.
//
//  Hub único = lease síncrono e atômico (sem broker). Persiste o estado
//  restante em storage/queues/<batch>.json pra sobreviver a restart:
//  no restore, o que estava "leased" (onda interrompida) volta pra fila.
// =====================================================================
import path from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { store, safeRel } from './storage.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATE_DIR = path.join(__dirname, '..', 'storage', 'queues');

// batch -> { pending: [{key,num,files}], leased: Map(key->{agent,at}), doneCount, total }
const queues = new Map();
const pat = /^TELEFONES-(\d+)(?: - Copia)?\.txt$/i;

const stateFile = (batch) => path.join(STATE_DIR, safeRel(batch).replaceAll('/', '_') + '.json');

async function persist(batch, q) {
  try {
    await mkdir(STATE_DIR, { recursive: true });
    const data = {
      total: q.total,
      doneCount: q.doneCount,
      pending: q.pending,
      leased: [...q.leased.entries()].map(([key, v]) => ({ key, ...v })),
      attempts: [...q.attempts.entries()],
    };
    await writeFile(stateFile(batch), JSON.stringify(data));
  } catch { /* persistência é best-effort */ }
}

async function restore(batch) {
  try {
    const data = JSON.parse(await readFile(stateFile(batch), 'utf8'));
    // onda interrompida no restart: leased volta pra frente da fila
    const leasedUnits = (data.leased || []).map((l) => ({ key: l.key, num: l.num, files: l.files }))
      .filter((u) => u.files); // só se temos os arquivos persistidos
    const pending = [...leasedUnits, ...(data.pending || [])];
    return { pending, leased: new Map(), doneCount: data.doneCount || 0, total: data.total || pending.length, attempts: new Map(data.attempts || []) };
  } catch { return null; }
}

async function build(batch) {
  const files = await store.listUnits(batch, 'telefones'); // nomes de arquivo
  const byNum = new Map();
  for (const f of files) {
    const m = f.match(pat);
    const key = m ? `num-${m[1]}` : f; // avulso = ele mesmo
    if (!byNum.has(key)) byNum.set(key, { key, num: m ? Number(m[1]) : Number.POSITIVE_INFINITY, files: [] });
    byNum.get(key).files.push({ rel: f });
  }
  const pending = [...byNum.values()].sort((a, b) => a.num - b.num || a.key.localeCompare(b.key));
  return { pending, leased: new Map(), doneCount: 0, total: pending.length, attempts: new Map() };
}

export async function ensure(batch) {
  if (!queues.has(batch)) {
    const q = (await restore(batch)) || (await build(batch));
    queues.set(batch, q);
  }
  return queues.get(batch);
}

// tira até n unidades da frente da fila (FIFO) e marca como leased
export async function lease(batch, agent, n) {
  const q = await ensure(batch);
  const take = q.pending.splice(0, Math.max(0, n | 0));
  for (const u of take) q.leased.set(u.key, { agent, at: Date.now(), num: u.num, files: u.files });
  await persist(batch, q);
  return take; // [{key,num,files}]
}

// devolve unidades leased pra frente da fila SEM penalizar (ex.: pool de sessions secou)
export async function returnLease(batch, units) {
  const q = await ensure(batch);
  for (const u of units) q.leased.delete(u.key);
  q.pending.unshift(...units);
  await persist(batch, q);
}

// erro num número: conta a tentativa e devolve pro FIM da fila p/ retry com
// outra session. Esgotou maxAttempts -> descarta (conta como done).
export async function retryLease(batch, units, maxAttempts = 3) {
  const q = await ensure(batch);
  const requeued = [], exhausted = [];
  for (const u of units) {
    q.leased.delete(u.key);
    const a = (q.attempts.get(u.key) || 0) + 1;
    q.attempts.set(u.key, a);
    if (a < maxAttempts) { q.pending.push(u); requeued.push(u.key); }
    else { q.doneCount++; exhausted.push(u.key); }
  }
  await persist(batch, q);
  return { requeued, exhausted };
}

// confirma que as unidades terminaram (sucesso ou parqueadas em TELEFONES ERRO)
export async function commit(batch, keys) {
  const q = await ensure(batch);
  for (const k of keys) if (q.leased.delete(k)) q.doneCount++;
  await persist(batch, q);
}

export async function status(batch) {
  const q = await ensure(batch);
  return { total: q.total, pending: q.pending.length, leased: q.leased.size, done: q.doneCount };
}

// força reconstrução a partir do storage (ex.: subiu mais arquivos no batch)
export async function reset(batch) {
  queues.delete(batch);
  const q = await build(batch);
  queues.set(batch, q);
  await persist(batch, q);
  return status(batch);
}
