// =====================================================================
//  Login simples por sessão (SQLite nativo, zero deps).
//  - users:    username único, senha com hash scrypt, tenant, role.
//  - sessions: token aleatório -> usuário, com expiração.
//  O HUB_TOKEN continua sendo a "chave mestra" (agentes/CLI + criar users).
//
//  Mesmo arquivo de banco do db.js (hub/storage/wppbot.db). WAL + busy_timeout
//  pra conviver com o outro handle e com `docker exec ... useradd`.
// =====================================================================
import path from 'node:path';
import crypto from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_FILE = process.env.DB_FILE || path.join(__dirname, '..', 'storage', 'wppbot.db');
mkdirSync(path.dirname(DB_FILE), { recursive: true });

export const SESSION_TTL_MS = Number(process.env.SESSION_TTL_MS || 7 * 24 * 60 * 60 * 1000); // 7 dias

const db = new DatabaseSync(DB_FILE);
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA busy_timeout = 5000');
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    pass TEXT NOT NULL,
    tenant TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'user',
    created_at TEXT
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    created_at TEXT,
    expires_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_sessions_exp ON sessions(expires_at);
`);

const now = () => new Date().toISOString();
const normUser = (u) => String(u || '').trim().toLowerCase();

// ---- hashing (scrypt nativo) -------------------------------------------
function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(pw), salt, 64);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}
function verifyPassword(pw, stored) {
  try {
    const [alg, saltHex, hashHex] = String(stored).split('$');
    if (alg !== 'scrypt') return false;
    const salt = Buffer.from(saltHex, 'hex');
    const expected = Buffer.from(hashHex, 'hex');
    const got = crypto.scryptSync(String(pw), salt, expected.length);
    return expected.length === got.length && crypto.timingSafeEqual(expected, got);
  } catch { return false; }
}

// ---- usuários -----------------------------------------------------------
const _ins = db.prepare(`
  INSERT INTO users (username, pass, tenant, role, created_at) VALUES (?,?,?,?,?)
  ON CONFLICT(username) DO UPDATE SET pass=excluded.pass, tenant=excluded.tenant, role=excluded.role
`);
export function addUser({ username, password, tenant, role = 'user' }) {
  const u = normUser(username);
  if (!u || !password || !tenant) throw new Error('username, password e tenant são obrigatórios');
  _ins.run(u, hashPassword(password), String(tenant).trim(), role === 'admin' ? 'admin' : 'user', now());
  return { username: u, tenant: String(tenant).trim(), role };
}
export function listUsers() {
  return db.prepare(`SELECT username, tenant, role, created_at FROM users ORDER BY username`).all();
}
export function deleteUser(username) {
  const r = db.prepare(`DELETE FROM users WHERE username=?`).run(normUser(username));
  db.prepare(`DELETE FROM sessions WHERE user_id NOT IN (SELECT id FROM users)`).run();
  return { deleted: r.changes };
}
export function countUsers() {
  return db.prepare(`SELECT COUNT(*) AS n FROM users`).get().n;
}

// ---- autenticação -------------------------------------------------------
export function authenticate(username, password) {
  const row = db.prepare(`SELECT * FROM users WHERE username=?`).get(normUser(username));
  // verifica sempre (tempo ~constante mesmo sem usuário)
  const ok = verifyPassword(password, row ? row.pass : 'scrypt$00$00');
  if (!row || !ok) return null;
  return { id: row.id, username: row.username, tenant: row.tenant, role: row.role };
}

// ---- sessões ------------------------------------------------------------
export function createSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const expires = new Date(Date.now() + SESSION_TTL_MS).toISOString();
  db.prepare(`INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?,?,?,?)`)
    .run(token, userId, now(), expires);
  return { token, expires };
}
export function getSession(token) {
  if (!token) return null;
  const row = db.prepare(`
    SELECT s.expires_at, u.id AS user_id, u.username, u.tenant, u.role
    FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?
  `).get(token);
  if (!row) return null;
  if (Date.parse(row.expires_at) < Date.now()) { destroySession(token); return null; }
  return { userId: row.user_id, username: row.username, tenant: row.tenant, role: row.role };
}
export function destroySession(token) {
  if (token) db.prepare(`DELETE FROM sessions WHERE token=?`).run(token);
}
export function cleanupSessions() {
  db.prepare(`DELETE FROM sessions WHERE expires_at < ?`).run(now());
}
