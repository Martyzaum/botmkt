// =====================================================================
//  Leitor de ZIP mínimo (zero deps, via node:zlib). Suporta entries
//  "stored" (0) e "deflate" (8) — o que o Compress-Archive / qualquer
//  zipador comum gera. Sem ZIP64 (ok p/ nosso caso).
//  unzip(buffer) -> [{ name, data:Buffer }]  (diretórios ignorados)
// =====================================================================
import zlib from 'node:zlib';

export function unzip(buf) {
  const EOCD = 0x06054b50; // End Of Central Directory
  let i = buf.length - 22;
  const min = Math.max(0, buf.length - 22 - 65536);
  for (; i >= min; i--) if (buf.readUInt32LE(i) === EOCD) break;
  if (i < min) throw new Error('zip inválido (EOCD não encontrado)');

  const cdCount = buf.readUInt16LE(i + 10);
  let p = buf.readUInt32LE(i + 16); // offset do central directory

  const out = [];
  for (let n = 0; n < cdCount; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break; // assinatura de entry do CD
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOff = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;

    if (name.endsWith('/')) continue; // diretório

    if (buf.readUInt32LE(localOff) !== 0x04034b50) continue; // local header
    const lNameLen = buf.readUInt16LE(localOff + 26);
    const lExtraLen = buf.readUInt16LE(localOff + 28);
    const dataStart = localOff + 30 + lNameLen + lExtraLen;
    const comp = buf.subarray(dataStart, dataStart + compSize);

    let data;
    if (method === 0) data = Buffer.from(comp);
    else if (method === 8) data = zlib.inflateRawSync(comp);
    else throw new Error(`método de compressão ${method} não suportado (${name})`);
    out.push({ name, data });
  }
  return out;
}
