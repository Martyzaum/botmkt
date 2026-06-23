// =====================================================================
//  TRATAR ERROS — para cada slot que falhou (travado/erro):
//    1) move o(s) TELEFONES-XXX.txt (o par com numero no nome, incl.
//       " - Copia") do slot para  Desktop\TELEFONES ERRO\
//    2) esvazia o BROADCAST.txt desse slot (limpeza broadcast do slot)
//
//  Os slots a tratar vem por:
//    - env SLOTS_ERRO="1,5,7"   (ou separado por espaco)
//    - ou argv:  node tratar-erros.js 1 5 7
//
//  Rode:  SLOTS_ERRO="1,5" node tratar-erros.js
//  Env:   DESKTOP_DIR (opcional)
//
//  Obs: NAO mexe no TELEFONES.txt (arquivo de trabalho). Se quiser que o
//  slot fique pronto pra proxima onda, rode tambem o LIMPAR TELEFONES.
// =====================================================================
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const desktop = process.env.DESKTOP_DIR || path.join(os.homedir(), "Desktop");
const erroDir = path.join(desktop, "TELEFONES ERRO");

// slots a tratar (argv + env), validados em 1..16, sem repetir
const brutos = [...process.argv.slice(2), ...(process.env.SLOTS_ERRO || "").split(/[,\s]+/)];
const slots = [
  ...new Set(
    brutos
      .map((s) => Number(String(s).trim()))
      .filter((n) => Number.isInteger(n) && n >= 1 && n <= 16)
  ),
];

if (!slots.length) {
  console.log("Nenhum slot informado (SLOTS_ERRO ou argv). Nada a fazer.");
  process.exit(0);
}

// arquivo com numero no nome: TELEFONES-735.txt  /  TELEFONES-735 - Copia.txt
const patternNum = /^TELEFONES-\d+(?: - Copia)?\.txt$/i;

fs.mkdirSync(erroDir, { recursive: true });

let movidos = 0;
let limpos = 0;
const avisos = [];

for (const i of slots) {
  const dados = path.join(desktop, String(i), "DADOS");
  if (!fs.existsSync(dados)) {
    avisos.push(`slot ${i}: DADOS nao encontrado`);
    continue;
  }

  // 1) move TELEFONES-XXX(.../ - Copia).txt -> TELEFONES ERRO
  const arquivos = fs.readdirSync(dados).filter((n) => patternNum.test(n));
  if (!arquivos.length) avisos.push(`slot ${i}: nenhum TELEFONES-<n>.txt para mover`);
  for (const a of arquivos) {
    const src = path.join(dados, a);
    let dest = path.join(erroDir, a);
    if (fs.existsSync(dest)) {
      // ja existe no destino: prefixa com o slot pra nao sobrescrever
      const ext = path.extname(a);
      dest = path.join(erroDir, `${path.basename(a, ext)} - slot${i}${ext}`);
    }
    fs.renameSync(src, dest);
    console.log(`slot ${i}: ${a} -> TELEFONES ERRO`);
    movidos++;
  }

  // 2) limpeza broadcast do slot
  const bc = path.join(dados, "BROADCAST.txt");
  if (fs.existsSync(bc)) {
    fs.writeFileSync(bc, "");
    console.log(`slot ${i}: BROADCAST.txt limpo`);
    limpos++;
  } else {
    avisos.push(`slot ${i}: BROADCAST.txt nao encontrado`);
  }
}

console.log("");
for (const a of avisos) console.log("AVISO " + a);
console.log(`Slots: ${slots.join(", ")} | movidos: ${movidos} | broadcast limpos: ${limpos}`);
