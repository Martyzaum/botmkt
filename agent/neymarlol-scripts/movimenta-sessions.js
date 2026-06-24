// =====================================================================
//  MOVIMENTA SESSIONS — enche com session do pool (Desktop\sessions) SÓ
//  os slots que estão VAZIOS (sem 'session' e sem '<numero>-<n>').
//
//  >>> Mudança importante: NÃO mexe nos slots que já têm session. <<<
//  Assim a session que funcionou numa onda é MANTIDA e manda vários lotes
//  (o orquestrador limpa a session só do slot que falhou). Isso faz o pool
//  durar MUITO mais — antes rotacionava as 16 toda onda e secava na hora.
//
//  Pool: Desktop\sessions\<telefone>\<numero>-<n>  (subpasta = 1 subsession)
//  Move 1 subsession por slot vazio (ordenado por numero/indice).
//
//  Imprime no fim uma linha estável pro orquestrador:
//     RESULTADO_SESSIONS vazios=X movidas=Y comSession=K poolRestante=Z
//
//  Env: DESKTOP_DIR (opcional), SLOTS (default 16)
// =====================================================================
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const TESTE = false; // true = só simula
const desktop = process.env.DESKTOP_DIR || path.join(os.homedir(), "Desktop");
const SLOTS = Number(process.env.SLOTS || 16);
const origem = path.join(desktop, "sessions");

// Aceita SOMENTE subpastas no formato <numero>-<n> (ex: 5511979947607-1)
const patternSessao = /^\d+-\d+$/;

if (!fs.existsSync(origem)) {
  // sem pool: ainda reporta quantos slots já têm session (pode estar tudo mantido)
  console.error("Pasta de origem nao encontrada: " + origem);
}

function listarPastas(caminho) {
  if (!fs.existsSync(caminho)) return [];
  return fs
    .readdirSync(caminho, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);
}

// 1) quais slots PRECISAM de session (sem 'session' e sem '<numero>-<n>' pendente).
//    Slots que JÁ têm session (funcionaram) são MANTIDOS.
const slotsVazios = [];
let comSessionExistente = 0;
for (let i = 1; i <= SLOTS; i++) {
  const slot = path.join(desktop, String(i));
  if (!fs.existsSync(slot)) {
    console.error("Pasta de destino nao encontrada: " + slot);
    process.exit(1);
  }
  const temSession = fs.existsSync(path.join(slot, "session"));
  const temPendente = listarPastas(slot).some((n) => patternSessao.test(n));
  if (temSession || temPendente) {
    comSessionExistente++;
  } else {
    slotsVazios.push(i);
  }
}

// 2) candidatos do pool, ordenados por numero do telefone e depois pelo indice
const candidatos = [];
for (const pastaTelefone of listarPastas(origem)) {
  const caminhoTelefone = path.join(origem, pastaTelefone);
  for (const nome of listarPastas(caminhoTelefone)) {
    if (!patternSessao.test(nome)) continue;
    const partes = nome.split("-");
    candidatos.push({
      numero: BigInt(partes[0]),
      sessao: Number(partes[1]),
      nome,
      telefone: pastaTelefone,
      caminho: path.join(caminhoTelefone, nome),
    });
  }
}
candidatos.sort((a, b) => (a.numero < b.numero ? -1 : a.numero > b.numero ? 1 : a.sessao - b.sessao));

const reporta = (movidas) => {
  const comSession = comSessionExistente + movidas;
  const poolRestante = candidatos.length - movidas;
  const faltam = slotsVazios.length - movidas;
  console.log("");
  console.log(
    `Movidas: ${movidas} | faltaram (sem session): ${faltam} | ` +
      `slots com session agora: ${comSession}/${SLOTS} | pool restante: ${poolRestante}`
  );
  console.log(`RESULTADO_SESSIONS vazios=${slotsVazios.length} movidas=${movidas} comSession=${comSession} poolRestante=${poolRestante}`);
};

console.log(
  `Slots que precisam de session: ${slotsVazios.length} (${slotsVazios.join(", ") || "-"}) | ` +
    `mantidos (ja tem): ${comSessionExistente} | pool disponivel: ${candidatos.length}`
);
console.log("");

if (slotsVazios.length === 0) {
  console.log("Nenhum slot precisa de session — todas mantidas.");
  reporta(0);
  process.exit(0);
}

// 3) move 1 candidato por slot vazio, até acabar um dos dois
const n = Math.min(slotsVazios.length, candidatos.length);
const telefonesTocados = new Set();
let movidas = 0;
for (let k = 0; k < n; k++) {
  const slotNum = slotsVazios[k];
  const item = candidatos[k];
  const pastaDestino = path.join(desktop, String(slotNum));

  let caminhoDestino = path.join(pastaDestino, item.nome);
  if (fs.existsSync(caminhoDestino)) {
    caminhoDestino = path.join(pastaDestino, item.nome + "" + Date.now() + "" + k);
  }

  // mantém o formato "<telefone>/<numero>-<n> -> pasta N" (o orquestrador lê isto)
  console.log(item.telefone + "/" + item.nome + " -> pasta " + slotNum);
  telefonesTocados.add(item.telefone);

  if (TESTE) {
    console.log("  [TESTE] " + item.caminho + " => " + caminhoDestino);
  } else {
    fs.cpSync(item.caminho, caminhoDestino, { recursive: true });
    fs.rmSync(item.caminho, { recursive: true, force: true });
    console.log("  MOVIDO " + item.nome);
    movidas++;
  }
}

// 4) limpa pastas de telefone que ficaram vazias no pool
for (const telefone of telefonesTocados) {
  const caminhoTelefone = path.join(origem, telefone);
  if (!fs.existsSync(caminhoTelefone)) continue;
  if (fs.readdirSync(caminhoTelefone).length === 0 && !TESTE) {
    fs.rmSync(caminhoTelefone, { recursive: true, force: true });
    console.log("APAGADA pasta vazia: " + telefone);
  }
}

reporta(movidas);
process.exit(0);
