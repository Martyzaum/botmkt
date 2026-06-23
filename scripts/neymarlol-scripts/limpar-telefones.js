// =====================================================================
//  LIMPAR TELEFONES (versao node) — apaga o TELEFONES.txt (arquivo de
//  trabalho do bot) dos slots, pra cada onda comecar limpa. NAO mexe
//  no TELEFONES-XXX.txt (o par com numero no nome).
//
//  Por padrao limpa os 16 slots. Pra um subconjunto:
//    - env SLOTS_LIMPAR="1,5,7"  (ou espaco)
//    - ou argv:  node limpar-telefones.js 1 5 7
//
//  Rode:  node limpar-telefones.js
//  Env:   DESKTOP_DIR (opcional), SLOTS (default 16)
// =====================================================================
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const desktop = process.env.DESKTOP_DIR || path.join(os.homedir(), "Desktop");
const TOTAL = Number(process.env.SLOTS || 16);

const brutos = [...process.argv.slice(2), ...(process.env.SLOTS_LIMPAR || "").split(/[,\s]+/)];
let slots = [
  ...new Set(
    brutos
      .map((s) => Number(String(s).trim()))
      .filter((n) => Number.isInteger(n) && n >= 1 && n <= TOTAL)
  ),
];
if (!slots.length) slots = Array.from({ length: TOTAL }, (_, k) => k + 1);

let apagados = 0;
for (const i of slots) {
  const alvo = path.join(desktop, String(i), "DADOS", "TELEFONES.txt");
  if (fs.existsSync(alvo)) {
    fs.rmSync(alvo, { force: true });
    console.log(`slot ${i}: TELEFONES.txt apagado`);
    apagados++;
  }
}

console.log("");
console.log(`Slots: ${slots.join(", ")} | TELEFONES.txt apagados: ${apagados}`);
