import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// true = só testa
// false = move de verdade
const TESTE = false;

const desktop = path.join(os.homedir(), "Desktop");
const origem = path.join(desktop, "TELEFONES CAMPANHA");

if (!fs.existsSync(origem)) {
  console.error("Pasta de origem nao encontrada: " + origem);
  process.exit(1);
}

// Valida se as pastas 1\DADOS a 16\DADOS existem
for (let i = 1; i <= 16; i++) {
  const pastaDados = path.join(desktop, String(i), "DADOS");
  if (!fs.existsSync(pastaDados)) {
    console.error("Pasta nao encontrada: " + pastaDados);
    process.exit(1);
  }
}

// Aceita SOMENTE:
// TELEFONES-85.txt
// TELEFONES-85 - Copia.txt
const pattern = /^TELEFONES-(\d+)(?: - Copia)?\.txt$/i;

const arquivos = fs
  .readdirSync(origem)
  .filter(function (nome) {
    const caminho = path.join(origem, nome);
    return fs.statSync(caminho).isFile() && pattern.test(nome);
  });

const grupos = new Map();
for (const arquivo of arquivos) {
  const match = arquivo.match(pattern);
  const numero = Number(match[1]);
  if (!grupos.has(numero)) {
    grupos.set(numero, []);
  }
  grupos.get(numero).push(arquivo);
}

// Ordena pelos numeros e pega somente os primeiros 16 grupos completos
const gruposOrdenados = Array.from(grupos.entries())
  .sort(function (a, b) {
    return a[0] - b[0];
  })
  .filter(function ([numero, lista]) {
    const temOriginal = lista.some(function (nome) {
      return /^TELEFONES-\d+\.txt$/i.test(nome);
    });
    const temCopia = lista.some(function (nome) {
      return /^TELEFONES-\d+ - Copia\.txt$/i.test(nome);
    });
    if (!temOriginal || !temCopia) {
      console.log(
        "IGNORADO numero " +
          numero +
          ": precisa ter original e copia. Encontrado: " +
          lista.join(", ")
      );
      return false;
    }
    return true;
  })
  .slice(0, 16);

if (gruposOrdenados.length === 0) {
  console.log("Nenhum par completo encontrado para mover.");
  process.exit(0);
}

console.log("Pares que serao processados nesta rodada: " + gruposOrdenados.length);
console.log("");

for (let i = 0; i < gruposOrdenados.length; i++) {
  const [numero, lista] = gruposOrdenados[i];
  const pastaNumero = i + 1;
  const pastaDestino = path.join(desktop, String(pastaNumero), "DADOS");

  lista.sort(function (a, b) {
    return a.localeCompare(b, "pt-BR", { numeric: true });
  });

  console.log("Numero " + numero + " -> pasta " + pastaNumero + "/DADOS");

  for (const arquivo of lista) {
    const caminhoAtual = path.join(origem, arquivo);
    let caminhoDestino = path.join(pastaDestino, arquivo);

    if (fs.existsSync(caminhoDestino)) {
      const ext = path.extname(arquivo);
      const base = path.basename(arquivo, ext);
      caminhoDestino = path.join(
        pastaDestino,
        base + "" + Date.now() + "" + i + ext
      );
    }

    if (TESTE) {
      console.log("  [TESTE] " + arquivo);
    } else {
      fs.renameSync(caminhoAtual, caminhoDestino);
      console.log("  MOVIDO " + arquivo);
    }
  }

  console.log("");
}

console.log("Rodada finalizada.");

if (TESTE) {
  console.log("");
  console.log("Modo TESTE ativo.");
  console.log("Para mover de verdade, troque:");
  console.log("const TESTE = true;");
  console.log("por:");
  console.log("const TESTE = false;");
}