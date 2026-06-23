// =====================================================================
//  SETUP CONTEUDO — espalha o conteúdo da campanha (texto + vídeo) que
//  veio pro Desktop\CONTEUDO em TODOS os slots:
//    - Desktop\CONTEUDO\TEXTO.txt   -> <slot>\DADOS\TEXTO.txt   (igual p/ todos)
//    - Desktop\CONTEUDO\VIDEO\*     -> <slot>\DADOS\VIDEO\*      (substitui)
//
//  Sobrescreve o TEXTO.txt e LIMPA o VIDEO antes de copiar (pra não
//  sobrar vídeo de campanha antiga). NÃO mexe em session-link.txt.
//
//  Rode:  node setup-conteudo.js
//  Env:   DESKTOP_DIR (opcional), SLOTS (default 16)
// =====================================================================
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const desktop = process.env.DESKTOP_DIR || path.join(os.homedir(), "Desktop");
const TOTAL = Number(process.env.SLOTS || 16);

const src = path.join(desktop, "CONTEUDO");
const textoSrc = path.join(src, "TEXTO.txt");
const videoSrc = path.join(src, "VIDEO");

const temTexto = fs.existsSync(textoSrc) && fs.statSync(textoSrc).isFile();
const videos = (fs.existsSync(videoSrc) && fs.statSync(videoSrc).isDirectory())
  ? fs.readdirSync(videoSrc).filter((n) => fs.statSync(path.join(videoSrc, n)).isFile())
  : [];

if (!temTexto && !videos.length) {
  console.log("Nada em Desktop\\CONTEUDO (TEXTO.txt / VIDEO). Nada a fazer.");
  process.exit(0);
}

let okTexto = 0;
let okVideo = 0;
const avisos = [];

for (let i = 1; i <= TOTAL; i++) {
  const dados = path.join(desktop, String(i), "DADOS");
  if (!fs.existsSync(dados)) { avisos.push(`slot ${i}: DADOS nao encontrado`); continue; }

  if (temTexto) {
    fs.copyFileSync(textoSrc, path.join(dados, "TEXTO.txt"));
    okTexto++;
  }

  if (videos.length) {
    const vdest = path.join(dados, "VIDEO");
    fs.rmSync(vdest, { recursive: true, force: true }); // limpa vídeo antigo
    fs.mkdirSync(vdest, { recursive: true });
    for (const v of videos) fs.copyFileSync(path.join(videoSrc, v), path.join(vdest, v));
    okVideo++;
  }
}

console.log("");
for (const a of avisos) console.log("AVISO " + a);
console.log(`TEXTO.txt em ${okTexto} slot(s) | VIDEO em ${okVideo} slot(s) | videos: ${videos.join(", ") || "-"}`);
