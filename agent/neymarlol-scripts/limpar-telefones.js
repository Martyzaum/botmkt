// =====================================================================
//  LIMPAR TELEFONES (versao node) — apaga TODOS os TELEFONES*.txt do
//  DADOS de cada slot (TELEFONES.txt de trabalho + leftovers
//  TELEFONES-XXX / " - Copia"), pra cada onda comecar limpa.
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

const patternTel = /^TELEFONES.*\.txt$/i; // TELEFONES.txt + TELEFONES-XXX(.../ - Copia).txt

let apagados = 0;
for (const i of slots) {
  const dados = path.join(desktop, String(i), "DADOS");
  if (!fs.existsSync(dados)) continue;
  for (const nome of fs.readdirSync(dados).filter((n) => patternTel.test(n))) {
    fs.rmSync(path.join(dados, nome), { force: true });
    console.log(`slot ${i}: ${nome} apagado`);
    apagados++;
  }
}

console.log("");
console.log(`Slots: ${slots.join(", ")} | arquivos TELEFONES* apagados: ${apagados}`);
