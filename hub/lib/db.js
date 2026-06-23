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

const now = () => new Date().toISOString();

// número (chave da unidade) que caiu em cada slot: lease e movimenta ordenam
// ambos por número asc, então slot s (1-based) -> leased[s-1]. Best-effort.
const numeroDoSlot = (leased, slot) => (leased && leased[slot - 1]) || null;

const insWave = db.prepare(
  `INSERT INTO waves (ts, tenant, batch, agent, wave, leased, pending_after, sucesso, travado, erro)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
);
const insSlot = db.prepare(
  `INSERT INTO slot_results (wave_id, ts, tenant, batch, agent, wave, slot, status, numero, motivo)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
);

// rec: { tenant, batch, agent, wave, leased:[keys], pendingAfter, resumo }
// resumo = RESULTADO_JSON do start-all: { sucesso:[], travado:[], erro:[], slots:[{slot,status,motivo}] }
export function recordWave(rec) {
  const ts = now();
  const r = rec.resumo || {};
  const leased = rec.leased || [];
  const wid = insWave.run(
    ts, rec.tenant || 'default', rec.batch, rec.agent, rec.wave | 0,
    JSON.stringify(leased), rec.pendingAfter ?? null,
    (r.sucesso || []).length, (r.travado || []).length, (r.erro || []).length
  ).lastInsertRowid;

  for (const s of r.slots || []) {
    insSlot.run(
      wid, ts, rec.tenant || 'default', rec.batch, rec.agent, rec.wave | 0,
      s.slot, s.status, numeroDoSlot(leased, s.slot), s.motivo || null
    );
  }
  return wid;
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

// números que falharam (erro/travado), com motivo e contexto
export function errosByBatch(batch, tenant, limit = 200) {
  const cond = tenant
    ? "WHERE batch = ? AND tenant = ? AND status IN ('erro','travado')"
    : "WHERE batch = ? AND status IN ('erro','travado')";
  const args = tenant ? [batch, tenant] : [batch];
  return db.prepare(
    `SELECT ts, agent, wave, slot, status, numero, motivo FROM slot_results
     ${cond} ORDER BY id DESC LIMIT ?`
  ).all(...args, limit);
}

export function recentWaves(batch, limit = 50) {
  return db.prepare(
    `SELECT id, ts, tenant, agent, wave, sucesso, travado, erro, pending_after
     FROM waves WHERE batch = ? ORDER BY id DESC LIMIT ?`
  ).all(batch, limit);
}

export { DB_FILE };
