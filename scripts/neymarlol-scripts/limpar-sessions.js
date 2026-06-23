// =====================================================================
//  LIMPAR SESSIONS (versao node) — apaga a pasta 'session' dos slots,
//  pra cada onda começar limpa (o renomear-sessions pula slot que já
//  tem 'session'). NÃO mexe no pool Desktop\sessions.
//
//  Por padrão limpa os 16 slots. Subconjunto:
//    - env SLOTS_LIMPAR="1,5"  ou  argv: node limpar-sessions.js 1 5
//  Env: DESKTOP_DIR (opcional), SLOTS (default 16)
// =====================================================================
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const desktop = process.env.DESKTOP_DIR || path.join(os.homedir(), "Desktop");
const TOTAL = Number(process.env.SLOTS || 16);

const brutos = [...process.argv.slice(2), ...(process.env.SLOTS_LIMPAR || "").split(/[,\s]+/)];
let slots = [
  ...new Set(
    brutos.map((s) => Number(String(s).trim())).filter((n) => Number.isInteger(n) && n >= 1 && n <= TOTAL)
  ),
];
if (!slots.length) slots = Array.from({ length: TOTAL }, (_, k) => k + 1);

let apagados = 0;
for (const i of slots) {
  const alvo = path.join(desktop, String(i), "session");
  if (fs.existsSync(alvo)) {
    fs.rmSync(alvo, { recursive: true, force: true });
    console.log(`slot ${i}: session apagada`);
    apagados++;
  }
}

console.log("");
console.log(`Slots: ${slots.join(", ")} | sessions apagadas: ${apagados}`);
