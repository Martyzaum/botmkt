// =====================================================================
//  DEPLOY INDEX  — copia o supervisor (slot-supervisor.js) para o
//  index.js de cada slot 1..16, pra todos os slots usarem a mesma
//  logica de captura de logs / watchdog.
//
//  Faz backup do index.js antigo (index.js.bak) na primeira vez.
//
//  Rode:  node deploy-index.js
//  Env:   DESKTOP_DIR (opcional), SLOTS (default 16)
// =====================================================================
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const desktop = process.env.DESKTOP_DIR || path.join(os.homedir(), "Desktop");
const SLOTS = Number(process.env.SLOTS || 16);
const template = path.join(__dirname, "slot-supervisor.js");

if (!fs.existsSync(template)) {
  console.error("Template nao encontrado: " + template);
  process.exit(1);
}
const conteudo = fs.readFileSync(template);

let ok = 0;
const avisos = [];
for (let i = 1; i <= SLOTS; i++) {
  const slot = path.join(desktop, String(i));
  if (!fs.existsSync(slot)) {
    avisos.push(`slot ${i}: pasta nao encontrada`);
    continue;
  }
  const destino = path.join(slot, "index.js");
  const backup = path.join(slot, "index.js.bak");
  if (fs.existsSync(destino) && !fs.existsSync(backup)) {
    fs.copyFileSync(destino, backup); // guarda o original uma vez
  }
  fs.writeFileSync(destino, conteudo);
  console.log(`slot ${i}: index.js atualizado`);
  ok++;
}

console.log("");
for (const a of avisos) console.log("AVISO " + a);
console.log(`Deploy: ${ok}/${SLOTS} slots`);
process.exit(ok === 0 ? 1 : 0);
