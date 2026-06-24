// =====================================================================
//  LIMPAR SESSIONS (versao node) — apaga a pasta 'session' dos slots E as
//  subsessions '<numero>-<n>' que tenham sobrado (movimenta sem renomear, run
//  anterior interrompido). Sem isso, uma '<numero>-<n>' solta faz o
//  movimenta-sessions contar o slot como ativo sem casar telefone -> bot crasha
//  no TELEFONES.txt. NÃO mexe no pool Desktop\sessions.
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

const patternSub = /^\d+-\d+$/; // subsession solta: 5511979947607-1
let apagados = 0;
for (const i of slots) {
  const slot = path.join(desktop, String(i));
  const alvo = path.join(slot, "session");
  if (fs.existsSync(alvo)) {
    fs.rmSync(alvo, { recursive: true, force: true });
    console.log(`slot ${i}: session apagada`);
    apagados++;
  }
  // apaga subsessions <numero>-<n> que sobraram (senao baguncam a contagem)
  try {
    for (const d of fs.readdirSync(slot, { withFileTypes: true })) {
      if (d.isDirectory() && patternSub.test(d.name)) {
        fs.rmSync(path.join(slot, d.name), { recursive: true, force: true });
        console.log(`slot ${i}: ${d.name} (subsession solta) apagada`);
        apagados++;
      }
    }
  } catch { /* slot sem pasta, ignora */ }
}

console.log("");
console.log(`Slots: ${slots.join(", ")} | sessions apagadas: ${apagados}`);
