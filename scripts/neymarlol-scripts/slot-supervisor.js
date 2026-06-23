// =====================================================================
//  SUPERVISOR DE SLOT  (vira o index.js de cada pasta 1..16)
//
//  Roda o bot (main.js), CARIMBA cada log com timestamp e detecta o
//  fim da onda olhando os 2 logs de sucesso. Se o bot ficar mudo
//  (sem imprimir nada) por muito tempo => considera TRAVADO. Se o
//  main.js sair sozinho sem sucesso => tenta reiniciar (crash) ate um
//  teto; estourou o teto => ERRO.
//
//  Sai com codigo:  0 = sucesso | 1 = erro | 2 = travado
//  E imprime no fim uma linha estavel pro orquestrador parsear:
//     SLOT_RESULT {"slot":"1","status":"sucesso",...}
//
//  Env (todas opcionais):
//    SLOT_ID        rotulo do slot (default: nome da pasta atual)
//    BOT_ENTRY      arquivo do bot (default: main.js)
//    INACTIVITY_MS  tempo sem log = travado (default: 240000 = 4min)
//    MAX_RESTARTS   restarts em caso de crash (default: 3)
//    HEARTBEAT_MS   sinal de vida do supervisor (default: 30000)
//
//  >>> Fonte unica. Deploy para os slots com deploy-index.js <<<
// =====================================================================
import { spawn, spawnSync } from "node:child_process";
import path from "node:path";

const SLOT = process.env.SLOT_ID || path.basename(process.cwd());
const ENTRY = process.env.BOT_ENTRY || "main.js";
const INACTIVITY_MS = Number(process.env.INACTIVITY_MS || 4 * 60 * 1000);
const MAX_RESTARTS = Number(process.env.MAX_RESTARTS || 3);
const HEARTBEAT_MS = Number(process.env.HEARTBEAT_MS || 30 * 1000);

// Os 2 logs que significam "onda terminou com sucesso".
const SUCESSO = ["ENVIO DA BROADCAST TERMINADO", "NENHUM NÚMERO RESTANTE."];

// compara ignorando acento/caixa (robusto a problema de encoding no console)
const norm = (s) =>
  s.normalize("NFD").replace(/[̀-ͯ]/g, "").toUpperCase();
const SUCESSO_N = SUCESSO.map(norm);
const isSucesso = (line) => {
  const n = norm(line);
  return SUCESSO_N.some((m) => n.includes(m));
};

const ts = () => new Date().toISOString();
const emit = (tag, msg) => console.log(`[${ts()}][slot ${SLOT}][${tag}] ${msg}`);

// morto de fora: mata o main.js (arvore) ANTES de sair, sem deixar orfao.
function onSignal(sig) {
  try { if (child?.pid) spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true }); } catch {}
  process.exit(sig === "SIGINT" ? 130 : 143);
}
process.on("SIGTERM", () => onSignal("SIGTERM"));
process.on("SIGINT", () => onSignal("SIGINT"));

let lastActivity = Date.now();
let restarts = 0;
let done = false;
let child = null;

function killChild() {
  try {
    if (child?.pid)
      spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
        windowsHide: true,
      });
  } catch {}
}

function finish(status, code, motivo) {
  if (done) return;
  done = true;
  clearInterval(watch);
  clearInterval(beat);
  emit("STATUS", `${status}${motivo ? " | " + motivo : ""}`);
  // linha final estavel pro orquestrador:
  console.log(
    "SLOT_RESULT " +
      JSON.stringify({ slot: SLOT, status, motivo: motivo || null, restarts })
  );
  killChild();
  process.exit(code);
}

function handleLine(line) {
  if (!line.trim()) return;
  lastActivity = Date.now();
  console.log(`[${ts()}][slot ${SLOT}] ${line}`); // relay carimbado
  if (!done && isSucesso(line)) finish("sucesso", 0, line.trim());
}

function start() {
  emit("SUP", `iniciando ${ENTRY} (restart ${restarts}/${MAX_RESTARTS})`);
  child = spawn("node", [ENTRY], { windowsHide: true });
  let acc = "";
  const onData = (d) => {
    acc += d.toString("utf8");
    let i;
    while ((i = acc.indexOf("\n")) >= 0) {
      handleLine(acc.slice(0, i).replace(/\r$/, ""));
      acc = acc.slice(i + 1);
    }
  };
  child.stdout.on("data", onData);
  child.stderr.on("data", onData);

  child.on("error", (e) => {
    if (!done) finish("erro", 1, "falha ao iniciar: " + e.message);
  });

  child.on("exit", (code, signal) => {
    if (done) return;
    if (acc.trim()) handleLine(acc); // flush do que sobrou
    if (done) return; // o flush pode ter detectado sucesso
    // main.js saiu sem sucesso -> crash. Tenta reiniciar ate o teto.
    if (restarts < MAX_RESTARTS) {
      restarts++;
      emit(
        "SUP",
        `${ENTRY} saiu (code=${code} signal=${signal || "-"}) sem sucesso; reiniciando...`
      );
      lastActivity = Date.now();
      setTimeout(start, 1000);
    } else {
      finish("erro", 1, `saiu sem sucesso apos ${restarts} restart(s) (code=${code})`);
    }
  });
}

// watchdog: bot mudo por muito tempo = travado
const watch = setInterval(() => {
  if (done) return;
  const inativo = Date.now() - lastActivity;
  if (inativo > INACTIVITY_MS)
    finish(
      "travado",
      2,
      `sem log ha ${Math.round(inativo / 1000)}s (limite ${Math.round(
        INACTIVITY_MS / 1000
      )}s)`
    );
}, 5000);

// heartbeat do supervisor (NAO conta como atividade do bot)
const beat = setInterval(() => {
  if (!done)
    emit("HB", `vivo, ultimo log do bot ha ${Math.round((Date.now() - lastActivity) / 1000)}s`);
}, HEARTBEAT_MS);

emit("SUP", `supervisor on | entry=${ENTRY} | inatividade=${Math.round(INACTIVITY_MS / 1000)}s`);
start();
