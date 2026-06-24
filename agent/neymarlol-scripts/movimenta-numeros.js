// =====================================================================
//  MOVIMENTA NÚMEROS — move os pares (TELEFONES-<n>.txt + " - Copia") do
//  pool Desktop\TELEFONES CAMPANHA para os slots.
//
//  >>> Mudança importante: vai SÓ pros slots que têm session ('session'
//      ou '<numero>-<n>' pendente). <<<  Antes era posicional (1..16), mas
//      com session-keeping os slots ativos ficam espalhados — telefone tem
//      que cair NO slot que tem session, senão um falha e o outro fica sem
//      número.
//
//  Imprime, por par, "Numero X -> pasta N" (o orquestrador lê isto p/ mapear
//  slot<->numero) e no fim:
//     RESULTADO_NUMEROS pares=A ativos=B movidos=C
//
//  Env: DESKTOP_DIR (opcional), SLOTS (default 16)
// =====================================================================
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const TESTE = false;
const desktop = process.env.DESKTOP_DIR || path.join(os.homedir(), "Desktop");
const SLOTS = Number(process.env.SLOTS || 16);
const origem = path.join(desktop, "TELEFONES CAMPANHA");

if (!fs.existsSync(origem)) {
  console.error("Pasta de origem nao encontrada: " + origem);
  process.exit(1);
}

const patternSessao = /^\d+-\d+$/;
function listarPastas(caminho) {
  if (!fs.existsSync(caminho)) return [];
  return fs.readdirSync(caminho, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
}

// 1) slots ATIVOS = têm session ('session' já renomeada OU '<numero>-<n>' pendente).
//    Só esses recebem telefone. DADOS precisa existir.
const slotsAtivos = [];
for (let i = 1; i <= SLOTS; i++) {
  const slot = path.join(desktop, String(i));
  const dados = path.join(slot, "DADOS");
  if (!fs.existsSync(dados)) {
    console.error("Pasta nao encontrada: " + dados);
    process.exit(1);
  }
  const temSession = fs.existsSync(path.join(slot, "session")) || listarPastas(slot).some((n) => patternSessao.test(n));
  if (temSession) slotsAtivos.push(i);
}

// 2) pares completos (original + copia) no pool, ordenados por numero
const pattern = /^TELEFONES-(\d+)(?: - Copia)?\.txt$/i;
const arquivos = fs.readdirSync(origem).filter((nome) => fs.statSync(path.join(origem, nome)).isFile() && pattern.test(nome));
const grupos = new Map();
for (const arquivo of arquivos) {
  const numero = Number(arquivo.match(pattern)[1]);
  if (!grupos.has(numero)) grupos.set(numero, []);
  grupos.get(numero).push(arquivo);
}
const gruposOrdenados = Array.from(grupos.entries())
  .sort((a, b) => a[0] - b[0])
  .filter(([numero, lista]) => {
    const temOriginal = lista.some((n) => /^TELEFONES-\d+\.txt$/i.test(n));
    const temCopia = lista.some((n) => /^TELEFONES-\d+ - Copia\.txt$/i.test(n));
    if (!temOriginal || !temCopia) {
      console.log(`IGNORADO numero ${numero}: precisa ter original e copia. Encontrado: ${lista.join(", ")}`);
      return false;
    }
    return true;
  });

const fim = (movidos) => {
  console.log("");
  console.log(`RESULTADO_NUMEROS pares=${gruposOrdenados.length} ativos=${slotsAtivos.length} movidos=${movidos}`);
};

console.log(`Slots ativos (com session): ${slotsAtivos.length} (${slotsAtivos.join(", ") || "-"}) | pares no pool: ${gruposOrdenados.length}`);
console.log("");

if (slotsAtivos.length === 0) {
  console.log("Nenhum slot ativo (sem session) — nao movi nenhum par.");
  fim(0);
  process.exit(0);
}
if (gruposOrdenados.length === 0) {
  console.log("Nenhum par completo encontrado para mover.");
  fim(0);
  process.exit(0);
}

// 3) 1 par por slot ATIVO, na ordem (ativos[k] recebe grupos[k])
const n = Math.min(slotsAtivos.length, gruposOrdenados.length);
let movidos = 0;
for (let k = 0; k < n; k++) {
  const slotNum = slotsAtivos[k];
  const [numero, lista] = gruposOrdenados[k];
  const pastaDestino = path.join(desktop, String(slotNum), "DADOS");
  lista.sort((a, b) => a.localeCompare(b, "pt-BR", { numeric: true }));

  console.log("Numero " + numero + " -> pasta " + slotNum + "/DADOS");
  for (const arquivo of lista) {
    const caminhoAtual = path.join(origem, arquivo);
    let caminhoDestino = path.join(pastaDestino, arquivo);
    if (fs.existsSync(caminhoDestino)) {
      const ext = path.extname(arquivo);
      caminhoDestino = path.join(pastaDestino, path.basename(arquivo, ext) + "" + Date.now() + "" + k + ext);
    }
    if (TESTE) console.log("  [TESTE] " + arquivo);
    else { fs.renameSync(caminhoAtual, caminhoDestino); console.log("  MOVIDO " + arquivo); }
  }
  movidos++;
  console.log("");
}

console.log("Rodada finalizada.");
fim(movidos);
