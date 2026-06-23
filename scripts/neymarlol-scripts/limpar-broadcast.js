import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// true = só testa
// false = limpa de verdade
const TESTE = false;

const desktop = path.join(os.homedir(), "Desktop");

console.log("Procurando BROADCAST.txt nas pastas 1 a 16...");
console.log("");

for (let i = 1; i <= 16; i++) {
  const arquivo = path.join(desktop, String(i), "DADOS", "BROADCAST.txt");

  if (!fs.existsSync(arquivo)) {
    console.log("  IGNORADO pasta " + i + ": BROADCAST.txt nao encontrado");
    continue;
  }

  if (TESTE) {
    const tamanho = fs.statSync(arquivo).size;
    console.log(
      "  [TESTE] pasta " + i + ": esvaziaria BROADCAST.txt (" + tamanho + " bytes)"
    );
  } else {
    fs.writeFileSync(arquivo, "");
    console.log("  LIMPO pasta " + i + ": BROADCAST.txt");
  }
}

console.log("");
console.log("Rodada finalizada.");

if (TESTE) {
  console.log("");
  console.log("Modo TESTE ativo.");
  console.log("Para limpar de verdade, troque:");
  console.log("const TESTE = true;");
  console.log("por:");
  console.log("const TESTE = false;");
}