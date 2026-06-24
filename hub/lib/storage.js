// =====================================================================
//  Abstração de storage: local (disco) ou S3. Escolhida pelo config/aws.js.
//  Chaves: <batch>/<kind>/<rel>   (kind = sessions|telefones)
// =====================================================================
import path from 'node:path';
import fs from 'node:fs';
import { mkdir, readdir, readFile, writeFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { AWS_CONFIG } from '../../config/aws.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STORAGE_DIR = path.join(__dirname, '..', 'storage');

const safeRel = (rel) =>
  String(rel || '').replaceAll('\\', '/').replace(/^\/+/, '')
    .split('/').filter((p) => p && p !== '.' && p !== '..').join('/');

// ---- LOCAL --------------------------------------------------------------
const local = {
  async put(batch, kind, rel, buffer) {
    const dest = path.join(STORAGE_DIR, safeRel(batch), kind, safeRel(rel).replaceAll('/', path.sep));
    await mkdir(path.dirname(dest), { recursive: true });
    await writeFile(dest, buffer);
  },
  async getBuffer(batch, kind, rel) {
    const file = path.join(STORAGE_DIR, safeRel(batch), kind, safeRel(rel).replaceAll('/', path.sep));
    return readFile(file); // lança se não existe
  },
  // unidades de 1º nível: sessions -> pastas; telefones -> arquivos
  async listUnits(batch, kind) {
    const base = path.join(STORAGE_DIR, safeRel(batch), kind);
    let ents = [];
    try { ents = await readdir(base, { withFileTypes: true }); } catch { return []; }
    return kind === 'sessions'
      ? ents.filter((e) => e.isDirectory()).map((e) => e.name)
      : ents.filter((e) => e.isFile()).map((e) => e.name);
  },
  // arquivos (rel relativo ao kind) dentro de uma session
  async listSessionFiles(batch, sessionName) {
    const base = path.join(STORAGE_DIR, safeRel(batch), 'sessions');
    const dir = path.join(base, safeRel(sessionName));
    let ents = [];
    try { ents = await readdir(dir, { recursive: true, withFileTypes: true }); } catch { return []; }
    return ents.filter((f) => f.isFile()).map((f) =>
      path.relative(base, path.join(f.parentPath || f.path, f.name)).replaceAll('\\', '/'));
  },
  // todos os arquivos (recursivo) de um kind — usado p/ conteúdo (texto+video)
  async listFiles(batch, kind) {
    const base = path.join(STORAGE_DIR, safeRel(batch), kind);
    let ents = [];
    try { ents = await readdir(base, { recursive: true, withFileTypes: true }); } catch { return []; }
    return ents.filter((f) => f.isFile()).map((f) =>
      path.relative(base, path.join(f.parentPath || f.path, f.name)).replaceAll('\\', '/'));
  },
  // nomes lógicos de batch (pastas de 1º nível; tira o sufixo __<agent> das sessions)
  async listBatches() {
    let ents = [];
    try { ents = await readdir(STORAGE_DIR, { withFileTypes: true }); } catch { return []; }
    const set = new Set();
    for (const e of ents) if (e.isDirectory()) set.add(e.name.split('__')[0]);
    return [...set];
  },
  // unidades distribuíveis de session = subpasta <telefone>/<numero>-<n>
  async listSessionUnits(batch) {
    const base = path.join(STORAGE_DIR, safeRel(batch), 'sessions');
    let tels = [];
    try { tels = await readdir(base, { withFileTypes: true }); } catch { return []; }
    const out = [];
    for (const t of tels) {
      if (!t.isDirectory()) continue;
      let subs = [];
      try { subs = await readdir(path.join(base, t.name), { withFileTypes: true }); } catch { continue; }
      for (const s of subs) if (s.isDirectory() && /^\d+-\d+$/.test(s.name)) out.push(`${t.name}/${s.name}`);
    }
    return out;
  },
};

// ---- S3 -----------------------------------------------------------------
function makeS3() {
  let client;
  const key = (batch, kind, rel) => `${safeRel(batch)}/${kind}/${safeRel(rel)}`;
  const lazy = async () => {
    if (client) return client;
    const { S3Client } = await import('@aws-sdk/client-s3');
    client = new S3Client({
      region: AWS_CONFIG.region,
      credentials: { accessKeyId: AWS_CONFIG.accessKeyId, secretAccessKey: AWS_CONFIG.secretAccessKey },
    });
    return client;
  };
  return {
    async put(batch, kind, rel, buffer) {
      const { PutObjectCommand } = await import('@aws-sdk/client-s3');
      await (await lazy()).send(new PutObjectCommand({ Bucket: AWS_CONFIG.s3Bucket, Key: key(batch, kind, rel), Body: buffer }));
    },
    async getBuffer(batch, kind, rel) {
      const { GetObjectCommand } = await import('@aws-sdk/client-s3');
      const r = await (await lazy()).send(new GetObjectCommand({ Bucket: AWS_CONFIG.s3Bucket, Key: key(batch, kind, rel) }));
      return Buffer.from(await r.Body.transformToByteArray());
    },
    async listUnits(batch, kind) {
      const { ListObjectsV2Command } = await import('@aws-sdk/client-s3');
      const Prefix = `${safeRel(batch)}/${kind}/`;
      const r = await (await lazy()).send(new ListObjectsV2Command({ Bucket: AWS_CONFIG.s3Bucket, Prefix, Delimiter: '/' }));
      return kind === 'sessions'
        ? (r.CommonPrefixes || []).map((p) => p.Prefix.slice(Prefix.length).replace(/\/$/, ''))
        : (r.Contents || []).map((c) => c.Key.slice(Prefix.length)).filter(Boolean);
    },
    async listSessionFiles(batch, sessionName) {
      const { ListObjectsV2Command } = await import('@aws-sdk/client-s3');
      const root = `${safeRel(batch)}/sessions/`;
      const Prefix = `${root}${safeRel(sessionName)}/`;
      const out = [];
      let token;
      do {
        const r = await (await lazy()).send(new ListObjectsV2Command({ Bucket: AWS_CONFIG.s3Bucket, Prefix, ContinuationToken: token }));
        for (const c of r.Contents || []) out.push(c.Key.slice(root.length));
        token = r.IsTruncated ? r.NextContinuationToken : undefined;
      } while (token);
      return out;
    },
    async listFiles(batch, kind) {
      const { ListObjectsV2Command } = await import('@aws-sdk/client-s3');
      const Prefix = `${safeRel(batch)}/${kind}/`;
      const out = [];
      let token;
      do {
        const r = await (await lazy()).send(new ListObjectsV2Command({ Bucket: AWS_CONFIG.s3Bucket, Prefix, ContinuationToken: token }));
        for (const c of r.Contents || []) out.push(c.Key.slice(Prefix.length));
        token = r.IsTruncated ? r.NextContinuationToken : undefined;
      } while (token);
      return out.filter(Boolean);
    },
    async listBatches() {
      const { ListObjectsV2Command } = await import('@aws-sdk/client-s3');
      const set = new Set();
      let token;
      do {
        const r = await (await lazy()).send(new ListObjectsV2Command({ Bucket: AWS_CONFIG.s3Bucket, Delimiter: '/', ContinuationToken: token }));
        for (const cp of r.CommonPrefixes || []) set.add(cp.Prefix.replace(/\/$/, '').split('__')[0]);
        token = r.IsTruncated ? r.NextContinuationToken : undefined;
      } while (token);
      return [...set];
    },
    async listSessionUnits(batch) {
      const { ListObjectsV2Command } = await import('@aws-sdk/client-s3');
      const root = `${safeRel(batch)}/sessions/`;
      const tels = [];
      let token;
      do {
        const r = await (await lazy()).send(new ListObjectsV2Command({ Bucket: AWS_CONFIG.s3Bucket, Prefix: root, Delimiter: '/', ContinuationToken: token }));
        for (const p of r.CommonPrefixes || []) tels.push(p.Prefix);
        token = r.IsTruncated ? r.NextContinuationToken : undefined;
      } while (token);
      const out = [];
      for (const tel of tels) {
        let t2;
        do {
          const r = await (await lazy()).send(new ListObjectsV2Command({ Bucket: AWS_CONFIG.s3Bucket, Prefix: tel, Delimiter: '/', ContinuationToken: t2 }));
          for (const p of r.CommonPrefixes || []) {
            const unit = p.Prefix.slice(root.length).replace(/\/$/, '');
            if (/^\d+-\d+$/.test(unit.split('/')[1] || '')) out.push(unit);
          }
          t2 = r.IsTruncated ? r.NextContinuationToken : undefined;
        } while (t2);
      }
      return out;
    },
  };
}

export const store = AWS_CONFIG.enabled ? makeS3() : local;
export const usingS3 = AWS_CONFIG.enabled;
export { STORAGE_DIR, safeRel };
