// =====================================================================
//  GERA TEXTO — monta o DADOS\TEXTO.txt de cada slot a partir do link da
//  session que caiu nele (<slot>\session\session-link.txt) + o texto base
//  (Desktop\CONTEUDO\TEXTO-BASE.txt).
//
//  Roda a CADA onda, DEPOIS de movimenta/renomear-sessions (a session ja
//  esta como <slot>\session). Assim o link sempre bate com a session do slot.
//
//    TEXTO.txt = "👉🏻 <link> 👈🏻\n\n<base>"   (sem link -> so o base)
//
//  Rode:  node gera-texto.js
//  Env:   DESKTOP_DIR (opcional), SLOTS (default 16)
// =====================================================================
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const desktop = process.env.DESKTOP_DIR || path.join(os.homedir(), "Desktop");
const SLOTS = Number(process.env.SLOTS || 16);

const baseFile = path.join(desktop, "CONTEUDO", "TEXTO-BASE.txt");
const base = fs.existsSync(baseFile) ? fs.readFileSync(baseFile, "utf8") : "";

let ok = 0;
let comLink = 0;
const avisos = [];

for (let i = 1; i <= SLOTS; i++) {
  const dados = path.join(desktop, String(i), "DADOS");
  if (!fs.existsSync(dados)) { avisos.push(`slot ${i}: DADOS nao encontrado`); continue; }

  const linkFile = path.join(desktop, String(i), "session", "session-link.txt");
  let link = "";
  try { if (fs.existsSync(linkFile)) link = fs.readFileSync(linkFile, "utf8").trim(); } catch {}

  const partes = [];
  if (link) partes.push("👉🏻 " + link + " 👈🏻");
  if (base.trim()) partes.push(base);
  const texto = partes.join("\n\n");

  fs.writeFileSync(path.join(dados, "TEXTO.txt"), texto);
  console.log(`slot ${i}: TEXTO.txt ${link ? "com link da session" : "(sem link, so base)"}`);
  if (link) comLink++;
  ok++;
}

console.log("");
for (const a of avisos) console.log("AVISO " + a);
console.log(`TEXTO.txt gerado em ${ok}/${SLOTS} slot(s) | com link: ${comLink}`);
process.exit(ok === 0 ? 1 : 0);
