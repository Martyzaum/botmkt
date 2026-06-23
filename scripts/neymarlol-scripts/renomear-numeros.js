// =====================================================================
//  RENOMEAR TELEFONES (versao node, sem pause / sem janela).
//  Em cada slot 1..16, dentro de DADOS, renomeia o TELEFONES-<n>.txt
//  (o original, NAO a copia) para TELEFONES.txt — que e o arquivo que
//  o bot le. A " - Copia" e deixada como esta (backup), igual ao .bat.
//
//  Rode:  node renomear-numeros.js
//  Env:   DESKTOP_DIR (opcional), SLOTS (default 16)
// =====================================================================
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const desktop = process.env.DESKTOP_DIR || path.join(os.homedir(), "Desktop");
const SLOTS = Number(process.env.SLOTS || 16);

// original = TELEFONES-<n>.txt  (a copia "TELEFONES-<n> - Copia.txt" e ignorada)
const patternOriginal = /^TELEFONES-\d+\.txt$/i;

let renomeados = 0;
const avisos = [];

for (let i = 1; i <= SLOTS; i++) {
  const dados = path.join(desktop, String(i), "DADOS");
  if (!fs.existsSync(dados)) {
    avisos.push(`slot ${i}: pasta DADOS nao encontrada`);
    continue;
  }

  const destino = path.join(dados, "TELEFONES.txt");
  if (fs.existsSync(destino)) {
    avisos.push(`slot ${i}: TELEFONES.txt ja existe (pulado)`);
    continue;
  }

  const original = fs
    .readdirSync(dados)
    .filter((nome) => patternOriginal.test(nome))
    .sort((a, b) => a.localeCompare(b, "pt-BR", { numeric: true }))[0];

  if (!original) {
    avisos.push(`slot ${i}: nenhum TELEFONES-<n>.txt encontrado`);
    continue;
  }

  fs.renameSync(path.join(dados, original), destino);
  console.log(`slot ${i}: ${original} -> TELEFONES.txt`);
  renomeados++;
}

console.log("");
for (const a of avisos) console.log("AVISO " + a);
console.log(`Renomeados: ${renomeados}/${SLOTS}`);

// codigo de saida != 0 se nenhum slot foi renomeado (provavel erro de setup)
process.exit(renomeados === 0 ? 1 : 0);
