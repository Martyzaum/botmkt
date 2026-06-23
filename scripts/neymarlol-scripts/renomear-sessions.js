// =====================================================================
//  RENOMEAR SESSIONS (versao node, sem pause / sem janela).
//  Em cada slot 1..16, renomeia a subpasta de sessao para "session".
//
//  O .bat antigo procurava pastas que comecam com "6*", mas o que o
//  MOVIMENTA SESSIONS coloca no slot e uma pasta no formato <numero>-<n>
//  (ex: 5511979947607-1). Entao aqui renomeamos a subpasta que casa com
//  esse padrao -> "session". (DADOS e outras pastas sao ignoradas.)
//
//  Rode:  node renomear-sessions.js
//  Env:   DESKTOP_DIR (opcional), SLOTS (default 16)
// =====================================================================
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const desktop = process.env.DESKTOP_DIR || path.join(os.homedir(), "Desktop");
const SLOTS = Number(process.env.SLOTS || 16);

// pasta de sessao distribuida: <numero>-<n>  (ex: 5511979947607-1)
const patternSessao = /^\d+-\d+$/;

function listarPastas(caminho) {
  return fs
    .readdirSync(caminho, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);
}

let renomeados = 0;
const avisos = [];

for (let i = 1; i <= SLOTS; i++) {
  const slot = path.join(desktop, String(i));
  if (!fs.existsSync(slot)) {
    avisos.push(`slot ${i}: pasta nao encontrada`);
    continue;
  }

  const destino = path.join(slot, "session");
  if (fs.existsSync(destino)) {
    avisos.push(`slot ${i}: 'session' ja existe (pulado)`);
    continue;
  }

  const pasta = listarPastas(slot).find((nome) => patternSessao.test(nome));
  if (!pasta) {
    avisos.push(`slot ${i}: nenhuma subpasta <numero>-<n> encontrada`);
    continue;
  }

  fs.renameSync(path.join(slot, pasta), destino);
  console.log(`slot ${i}: ${pasta} -> session`);
  renomeados++;
}

console.log("");
for (const a of avisos) console.log("AVISO " + a);
console.log(`Renomeados: ${renomeados}/${SLOTS}`);

process.exit(renomeados === 0 ? 1 : 0);
