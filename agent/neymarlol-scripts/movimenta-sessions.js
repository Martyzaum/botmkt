import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// true = só testa
// false = move de verdade
const TESTE = false;

const desktop = path.join(os.homedir(), "Desktop");
const origem = path.join(desktop, "sessions");

if (!fs.existsSync(origem)) {
  console.error("Pasta de origem nao encontrada: " + origem);
  process.exit(1);
}

// Valida se as pastas de destino 1 a 16 existem
for (let i = 1; i <= 16; i++) {
  const pastaDestino = path.join(desktop, String(i));
  if (!fs.existsSync(pastaDestino)) {
    console.error("Pasta de destino nao encontrada: " + pastaDestino);
    process.exit(1);
  }
}

// Aceita SOMENTE subpastas no formato <numero>-<n>
// ex: 5511979947607-1, 5511979947607-2
const patternSessao = /^\d+-\d+$/;

// helper: lista só diretorios dentro de um caminho
function listarPastas(caminho) {
  return fs.readdirSync(caminho).filter(function (nome) {
    return fs.statSync(path.join(caminho, nome)).isDirectory();
  });
}

// 1) percorre cada pasta de telefone dentro de sessions
// 2) dentro de cada uma, coleta as subpastas <numero>-<n>
const candidatos = [];
for (const pastaTelefone of listarPastas(origem)) {
  const caminhoTelefone = path.join(origem, pastaTelefone);
  for (const nome of listarPastas(caminhoTelefone)) {
    if (!patternSessao.test(nome)) continue;
    const partes = nome.split("-");
    candidatos.push({
      numero: BigInt(partes[0]),
      sessao: Number(partes[1]),
      nome: nome,
      telefone: pastaTelefone,
      caminho: path.join(caminhoTelefone, nome),
    });
  }
}

// ordena por numero do telefone, depois pelo indice da sessao (-1, -2, ...)
candidatos.sort(function (a, b) {
  if (a.numero < b.numero) return -1;
  if (a.numero > b.numero) return 1;
  return a.sessao - b.sessao;
});

// pega só os 16 primeiros (um por pasta destino)
const lote = candidatos.slice(0, 16);

if (lote.length === 0) {
  console.log("Nenhuma subpasta <numero>-<n> encontrada para mover.");
  process.exit(0);
}

console.log("Pastas que serao processadas nesta rodada: " + lote.length);
console.log("");

// guarda as pastas de telefone tocadas pra checar se ficaram vazias depois
const telefonesTocados = new Set();

for (let i = 0; i < lote.length; i++) {
  const item = lote[i];
  const pastaNumero = i + 1;
  const pastaDestino = path.join(desktop, String(pastaNumero));

  let caminhoDestino = path.join(pastaDestino, item.nome);
  if (fs.existsSync(caminhoDestino)) {
    caminhoDestino = path.join(
      pastaDestino,
      item.nome + "" + Date.now() + "" + i
    );
  }

  console.log(item.telefone + "/" + item.nome + " -> pasta " + pastaNumero);
  telefonesTocados.add(item.telefone);

  if (TESTE) {
    console.log("  [TESTE] " + item.caminho + " => " + caminhoDestino);
  } else {
    // copia recursivo + apaga original
    fs.cpSync(item.caminho, caminhoDestino, { recursive: true });
    fs.rmSync(item.caminho, { recursive: true, force: true });
    console.log("  MOVIDO " + item.nome);
  }
}

console.log("");

// Apaga as pastas de telefone que ficaram vazias
console.log("Verificando pastas de telefone vazias...");
for (const telefone of telefonesTocados) {
  const caminhoTelefone = path.join(origem, telefone);
  if (!fs.existsSync(caminhoTelefone)) continue;

  const restante = fs.readdirSync(caminhoTelefone);
  if (restante.length === 0) {
    if (TESTE) {
      console.log("  [TESTE] apagaria pasta vazia: " + telefone);
    } else {
      fs.rmSync(caminhoTelefone, { recursive: true, force: true });
      console.log("  APAGADA pasta vazia: " + telefone);
    }
  } else {
    console.log(
      "  MANTIDA " + telefone + " (ainda tem " + restante.length + " item(ns))"
    );
  }
}

console.log("");
console.log("Rodada finalizada.");

if (TESTE) {
  console.log("");
  console.log("Modo TESTE ativo.");
  console.log("Para mover de verdade, troque:");
  console.log("const TESTE = true;");
  console.log("por:");
  console.log("const TESTE = false;");
}