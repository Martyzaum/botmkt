// =====================================================================
//  Persistência (SQLite nativo — node:sqlite, zero deps).
//  Registra o resultado de cada ONDA: por slot (sucesso/travado/erro,
//  com o número quando dá pra mapear) e o total de restantes na fila.
//
//  Arquivo: hub/storage/wppbot.db  (ou DB_FILE no ambiente)
// =====================================================================
import path from 'node:path';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_FILE = process.env.DB_FILE || path.join(__dirname, '..', 'storage', 'wppbot.db');
mkdirSync(path.dirname(DB_FILE), { recursive: true });

const db = new DatabaseSync(DB_FILE);
db.exec(`
  CREATE TABLE IF NOT EXISTS waves (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts TEXT, tenant TEXT, batch TEXT, agent TEXT, wave INTEGER,
    leased TEXT, pending_after INTEGER,
    sucesso INTEGER, travado INTEGER, erro INTEGER
  );
  CREATE TABLE IF NOT EXISTS slot_results (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    wave_id INTEGER, ts TEXT, tenant TEXT, batch TEXT, agent TEXT,
    wave INTEGER, slot INTEGER, status TEXT, numero TEXT, motivo TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_slot_batch ON slot_results(batch, status);
  CREATE INDEX IF NOT EXISTS idx_wave_batch ON waves(batch);
`);

// migração: colunas novas no slot_results (vínculo session + número real). Idempotente.
for (const col of ['session TEXT', 'phone TEXT']) {
  try { db.exec(`ALTER TABLE slot_results ADD COLUMN ${col}`); } catch { /* coluna já existe */ }
}

// inventário do que foi subido (1x por upload) — base do "pending".
db.exec(`
  CREATE TABLE IF NOT EXISTS sessions_inv (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    batch TEXT, tenant TEXT, telefone TEXT, subsession TEXT, link TEXT,
    status TEXT DEFAULT 'pending', result TEXT,
    agent TEXT, wave INTEGER, slot INTEGER, created_at TEXT, used_at TEXT,
    UNIQUE(batch, subsession)
  );
  CREATE TABLE IF NOT EXISTS telefones_inv (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    batch TEXT, tenant TEXT, unit TEXT, phone TEXT,
    status TEXT DEFAULT 'pending', attempts INTEGER DEFAULT 0,
    agent TEXT, wave INTEGER, slot INTEGER, created_at TEXT, used_at TEXT,
    UNIQUE(batch, unit)
  );
  CREATE INDEX IF NOT EXISTS idx_sinv_batch ON sessions_inv(batch, status);
  CREATE INDEX IF NOT EXISTS idx_tinv_batch ON telefones_inv(batch, status);
`);

const now = () => new Date().toISOString();

// número (chave da unidade) que caiu em cada slot: lease e movimenta ordenam
// ambos por número asc, então slot s (1-based) -> leased[s-1]. Best-effort.
const numeroDoSlot = (leased, slot) => (leased && leased[slot - 1]) || null;

const insWave = db.prepare(
  `INSERT INTO waves (ts, tenant, batch, agent, wave, leased, pending_after, sucesso, travado, erro)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
);
const insSlot = db.prepare(
  `INSERT INTO slot_results (wave_id, ts, tenant, batch, agent, wave, slot, status, numero, motivo, session, phone)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
);
const phoneOf = db.prepare(`SELECT phone FROM telefones_inv WHERE batch = ? AND unit = ?`);
const markSessUsed = db.prepare(
  `UPDATE sessions_inv SET status='usada', result=?, agent=?, wave=?, slot=?, used_at=?
   WHERE batch=? AND subsession=? AND status!='usada'`
);
const bumpTel = db.prepare(
  `UPDATE telefones_inv SET attempts=attempts+1, agent=?, wave=?, slot=?, used_at=? WHERE batch=? AND unit=?`
);
const setTelStatus = db.prepare(`UPDATE telefones_inv SET status=? WHERE batch=? AND unit=?`);
const insSessInv = db.prepare(
  `INSERT OR IGNORE INTO sessions_inv (batch, tenant, telefone, subsession, link, status, created_at)
   VALUES (?, ?, ?, ?, ?, 'pending', ?)`
);
const insTelInv = db.prepare(
  `INSERT OR IGNORE INTO telefones_inv (batch, tenant, unit, phone, status, created_at)
   VALUES (?, ?, ?, ?, 'pending', ?)`
);

// inventário no upload (idempotente — pending). rows: sessions [{telefone,subsession,link}] | tel [{unit,phone}]
export function inventSessions(batch, tenant, rows) {
  for (const r of rows || []) insSessInv.run(batch, tenant || 'default', r.telefone || null, r.subsession, r.link || null, now());
}
export function inventTelefones(batch, tenant, rows) {
  for (const r of rows || []) insTelInv.run(batch, tenant || 'default', r.unit, r.phone || null, now());
}

// rec: { tenant, batch, agent, wave, leased:[keys], pendingAfter, resumo,
//        slotUnits:{slot:key}, slotSessions:{slot:subsession}, committed:[units], exhausted:[units] }
// resumo = RESULTADO_JSON do start-all: { sucesso:[], travado:[], erro:[], slots:[{slot,status,motivo}] }
export function recordWave(rec) {
  const ts = now();
  const r = rec.resumo || {};
  const leased = rec.leased || [];
  const tenant = rec.tenant || 'default';
  const wave = rec.wave | 0;
  const slotSessions = rec.slotSessions || {};
  // slot -> telefone (key): mapa REAL desta onda (session-aware). Sem ele, cai no
  // positional leased[slot-1] (compat com playbooks antigos).
  const slotUnits = rec.slotUnits || null;
  const unitOfSlot = (slot) => (slotUnits ? (slotUnits[slot] ?? null) : numeroDoSlot(leased, slot));
  const wid = insWave.run(
    ts, tenant, rec.batch, rec.agent, wave,
    JSON.stringify(leased), rec.pendingAfter ?? null,
    (r.sucesso || []).length, (r.travado || []).length, (r.erro || []).length
  ).lastInsertRowid;

  for (const s of r.slots || []) {
    const unit = unitOfSlot(s.slot);
    const subsession = slotSessions[s.slot] || null;
    const phone = unit ? (phoneOf.get(rec.batch, unit)?.phone ?? null) : null;
    insSlot.run(wid, ts, tenant, rec.batch, rec.agent, wave, s.slot, s.status, unit, s.motivo || null, subsession, phone);
    if (subsession) markSessUsed.run(s.status, rec.agent, wave, s.slot, ts, rec.batch, subsession);
    if (unit) bumpTel.run(rec.agent, wave, s.slot, ts, rec.batch, unit);
  }
  for (const u of rec.committed || []) setTelStatus.run('enviado', rec.batch, u);
  for (const u of rec.exhausted || []) setTelStatus.run('erro', rec.batch, u);
  return wid;
}

// PIPELINE: grava 1 evento de slot (sem onda). status = sucesso|travado|erro.
// rec: { tenant, batch, agent, slot, status, key, session, motivo }
// telefones_inv só vira 'enviado' no sucesso (falha = requeue -> fica 'pending',
// igual ao modelo de onda; número não é descartado). sessions_inv vira 'usada'.
export function recordSlotEvent(rec) {
  const ts = now();
  const tenant = rec.tenant || 'default';
  const unit = rec.key || null;
  const subsession = rec.session || null;
  const slot = rec.slot | 0;
  const phone = unit ? (phoneOf.get(rec.batch, unit)?.phone ?? null) : null;
  insSlot.run(null, ts, tenant, rec.batch, rec.agent || null, 0, slot, rec.status, unit, rec.motivo || null, subsession, phone);
  if (subsession) markSessUsed.run(rec.status, rec.agent || null, 0, slot, ts, rec.batch, subsession);
  if (unit) {
    bumpTel.run(rec.agent || null, 0, slot, ts, rec.batch, unit);
    if (rec.status === 'sucesso') setTelStatus.run('enviado', rec.batch, unit);
  }
  return true;
}

// agregados por batch (opcionalmente filtrando tenant)
export function statsByBatch(batch, tenant) {
  const cond = tenant ? 'WHERE batch = ? AND tenant = ?' : 'WHERE batch = ?';
  const args = tenant ? [batch, tenant] : [batch];
  const w = db.prepare(
    `SELECT COUNT(*) ondas, COALESCE(SUM(sucesso),0) sucesso, COALESCE(SUM(travado),0) travado,
            COALESCE(SUM(erro),0) erro, MIN(ts) inicio, MAX(ts) fim
     FROM waves ${cond}`
  ).get(...args);
  const pend = db.prepare(
    `SELECT pending_after FROM waves ${cond} ORDER BY id DESC LIMIT 1`
  ).get(...args);
  return { batch, tenant: tenant || 'all', ...w, restantes: pend?.pending_after ?? null };
}

// inventário (pending/usado/erro) + listas de pending por batch
export function inventoryByBatch(batch, tenant) {
  const cond = tenant ? 'WHERE batch = ? AND tenant = ?' : 'WHERE batch = ?';
  const a = tenant ? [batch, tenant] : [batch];
  const sess = db.prepare(
    `SELECT COUNT(*) total, COALESCE(SUM(status='pending'),0) pending, COALESCE(SUM(status='usada'),0) usada,
            COALESCE(SUM(result='sucesso'),0) sucesso, COALESCE(SUM(result='travado'),0) travado,
            COALESCE(SUM(result='erro'),0) erro
     FROM sessions_inv ${cond}`
  ).get(...a);
  const tel = db.prepare(
    `SELECT COUNT(*) total, COALESCE(SUM(status='pending'),0) pending, COALESCE(SUM(status='enviado'),0) enviado,
            COALESCE(SUM(status='erro'),0) erro, COALESCE(SUM(attempts),0) tentativas,
            COALESCE(SUM(CASE WHEN phone IS NULL OR phone='' THEN 0
                         ELSE length(phone) - length(replace(phone, char(10), '')) + 1 END),0) numeros
     FROM telefones_inv ${cond}`
  ).get(...a);
  const sessPending = db.prepare(`SELECT subsession, telefone, link FROM sessions_inv ${cond} AND status='pending' ORDER BY subsession LIMIT 500`).all(...a);
  const telPending = db.prepare(`SELECT unit, phone FROM telefones_inv ${cond} AND status='pending' ORDER BY unit LIMIT 500`).all(...a);
  return { sessions: { ...sess, pendingList: sessPending }, telefones: { ...tel, pendingList: telPending } };
}

// números que falharam (erro/travado), com motivo e contexto
export function errosByBatch(batch, tenant, limit = 200) {
  const cond = tenant
    ? "WHERE batch = ? AND tenant = ? AND status IN ('erro','travado')"
    : "WHERE batch = ? AND status IN ('erro','travado')";
  const args = tenant ? [batch, tenant] : [batch];
  return db.prepare(
    `SELECT ts, agent, wave, slot, status, numero, phone, session, motivo FROM slot_results
     ${cond} ORDER BY id DESC LIMIT ?`
  ).all(...args, limit);
}

export function recentWaves(batch, limit = 50) {
  return db.prepare(
    `SELECT id, ts, tenant, agent, wave, sucesso, travado, erro, pending_after
     FROM waves WHERE batch = ? ORDER BY id DESC LIMIT ?`
  ).all(batch, limit);
}

// apaga TODO o rastro do batch no SQLite (ondas + resultados + inventários)
export function deleteBatch(batch) {
  const out = {};
  db.exec('BEGIN');
  try {
    for (const t of ['waves', 'slot_results', 'sessions_inv', 'telefones_inv']) {
      out[t] = db.prepare(`DELETE FROM ${t} WHERE batch = ?`).run(batch).changes;
    }
    db.exec('COMMIT');
  } catch (e) { try { db.exec('ROLLBACK'); } catch { /* nada */ } throw e; }
  return out;
}

export { DB_FILE };
