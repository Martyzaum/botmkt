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
//    MAX_RECONEXOES quedas/reconexões antes de desistir (default: 3)
//    HEARTBEAT_MS   sinal de vida do supervisor (default: 30000)
//
//  >>> Fonte unica. Deploy para os slots com deploy-index.js <<<
// =====================================================================
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const SLOT = process.env.SLOT_ID || path.basename(process.cwd());
const ENTRY = process.env.BOT_ENTRY || "main.js";
const INACTIVITY_MS = Number(process.env.INACTIVITY_MS || 4 * 60 * 1000);
const MAX_RESTARTS = Number(process.env.MAX_RESTARTS || 3);
const HEARTBEAT_MS = Number(process.env.HEARTBEAT_MS || 30 * 1000);

// ---- log em arquivo (visibilidade) ----------------------------------
//  Cada slot grava TUDO em Desktop\_logs\slot-<N>.log e o veredito final
//  em slot-<N>.result.json. Assim da pra acompanhar ao vivo (ver-logs.ps1)
//  e inspecionar depois, MESMO rodando escondido pelo agente.
const DESKTOP = process.env.DESKTOP_DIR || path.join(os.homedir(), "Desktop");
const LOGDIR = path.join(DESKTOP, "_logs");
try { fs.mkdirSync(LOGDIR, { recursive: true }); } catch {}
const LOGFILE = path.join(LOGDIR, `slot-${SLOT}.log`);
const RESULTFILE = path.join(LOGDIR, `slot-${SLOT}.result.json`);
// escrita SINCRONA (fd) — sobrevive ao process.exit() sem perder o final do log.
let logFd = null;
try { logFd = fs.openSync(LOGFILE, "a"); } catch {}
const writeLog = (s) => { try { if (logFd !== null) fs.writeSync(logFd, s + "\n"); } catch {} };
const out = (line) => { console.log(line); writeLog(line); };
try { fs.rmSync(RESULTFILE, { force: true }); } catch {} // limpa veredito velho

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

// Session CAINDO/MORTA: o bot fica pedindo "Digite seu numero" / "CONEXAO
// FECHADA - RECONECTANDO" em loop. Como ele IMPRIME, a inatividade nunca
// dispara e sem isto só morreria no teto global (45min). Conta as quedas e
// desiste rápido. Uma session VIVA conecta direto e nunca imprime isso.
const MORTE = /RECONECTANDO|CONEX\S* FECHADA|DIGITE SEU N/i;
const MAX_RECONEXOES = Number(process.env.MAX_RECONEXOES || 3);
let reconexoes = 0;

const ts = () => new Date().toISOString();
const emit = (tag, msg) => out(`[${ts()}][slot ${SLOT}][${tag}] ${msg}`);

// morto de fora: mata o main.js (arvore) ANTES de sair, sem deixar orfao.
function onSignal(sig) {
  try { if (child?.pid) spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true }); } catch {}
  process.exit(sig === "SIGINT" ? 130 : 143);
}
process.on("SIGTERM", () => onSignal("SIGTERM"));
process.on("SIGINT", () => onSignal("SIGINT"));

let lastActivity = Date.now();
let restarts = 0;          // crashes SEGUIDOS (saida != 0); zera a cada saida limpa
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
  const result = { slot: SLOT, status, motivo: motivo || null, restarts };
  // linha final estavel pro orquestrador:
  out("SLOT_RESULT " + JSON.stringify(result));
  // veredito tambem em arquivo (start-all/agente consegue ler sem capturar stdout)
  try { fs.writeFileSync(RESULTFILE, JSON.stringify({ ...result, ts: ts() })); } catch {}
  killChild();
  process.exit(code);
}

function handleLine(line) {
  if (!line.trim()) return;
  lastActivity = Date.now();
  out(`[${ts()}][slot ${SLOT}] ${line}`); // relay carimbado
  if (done) return;
  if (isSucesso(line)) { finish("sucesso", 0, line.trim()); return; }
  // session caindo em loop -> desiste rápido (em vez de esperar o teto global)
  if (MORTE.test(line) && ++reconexoes >= MAX_RECONEXOES) {
    finish("travado", 2, `session caindo: ${reconexoes} queda(s)/reconexao(oes)`);
  }
}

function start() {
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
    // O main.js SAI sozinho por design (manda um lote e sai; o index.js antigo
    // o reiniciava em loop). O sucesso só vem pelo MARCADOR lá no fim (~20min).
    // Então: saída LIMPA (code 0) = lote normal -> reinicia e zera o contador.
    // Saída != 0 = crash; N crashes SEGUIDOS -> erro. O sucesso (marcador), a
    // inatividade (mudo) e o teto global seguem como rede de segurança.
    const progrediu = code === 0;
    if (progrediu) {
      restarts = 0;
    } else if (++restarts >= MAX_RESTARTS) {
      finish("erro", 1, `crashou ${restarts}x seguidas sem progresso (code=${code})`);
      return;
    } else {
      emit("SUP", `crash (code=${code} sig=${signal || "-"}) sem progresso; restart ${restarts}/${MAX_RESTARTS}`);
    }
    lastActivity = Date.now();
    setTimeout(start, progrediu ? 150 : 1000);
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

out(`\n===== START slot ${SLOT} @ ${ts()} | log=${LOGFILE} =====`);
emit("SUP", `supervisor on | entry=${ENTRY} | inatividade=${Math.round(INACTIVITY_MS / 1000)}s`);
// sem 'session' provisionada => o bot ficaria pedindo "Digite seu numero" no
// stdin pra sempre. Falha RÁPIDO (slot vazio / pool seco) em vez de travar
// INACTIVITY_MS inteiro. (SKIP_SESSION_CHECK=1 desliga, se o bot criar a session.)
if (process.env.SKIP_SESSION_CHECK !== "1" && !fs.existsSync(path.join(process.cwd(), "session"))) {
  finish("erro", 1, "sem session (slot vazio / pool seco)");
} else {
  start();
}
