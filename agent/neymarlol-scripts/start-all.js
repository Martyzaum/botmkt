// =====================================================================
//  START-ALL (versao node, orquestravel, sem janela / sem pause)
//
//  Sobe os slots 1..16 (roda `node index.js` em cada pasta), RELAY do
//  stdout ja carimbado pelo supervisor, e classifica cada slot pelo
//  veredito que o supervisor imprime:
//     SLOT_RESULT {"status":"sucesso|travado|erro",...}
//  ou, na falta dele, pelo codigo de saida (0=sucesso 2=travado outro=erro).
//
//  Tem um teto global por slot como rede de seguranca (caso o proprio
//  index.js morra sem reportar).
//
//  Rode:  node start-all.js
//  Env:   DESKTOP_DIR, SLOTS (16), ENTRY (index.js), STAGGER_MS (1000),
//         GLOBAL_MS (2700000 = 45min)
//
//  Saida final pro orquestrador:
//     RESULTADO_JSON {"sucesso":[...],"travado":[...],"erro":[...]}
//  Exit code 0 se todos sucesso; 1 se houve travado/erro.
// =====================================================================
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const desktop = process.env.DESKTOP_DIR || path.join(os.homedir(), "Desktop");
const SLOTS = Number(process.env.SLOTS || 16);
const ENTRY = process.env.ENTRY || "index.js";
const STAGGER_MS = Number(process.env.STAGGER_MS || 1000);
const GLOBAL_MS = Number(process.env.GLOBAL_MS || 45 * 60 * 1000);
const TICK_MS = 5000;

const slots = [];
let launched = 0;

// se o start-all for morto de fora (timeout do agente, Ctrl-C), mata a arvore
// de cada slot ANTES de sair — senao os node main.js ficam orfaos no Windows.
function cleanupAll(signal) {
  for (const s of slots) {
    if (s.child && s.child.pid && !s.killed) {
      s.killed = true;
      try { spawnSync("taskkill", ["/PID", String(s.child.pid), "/T", "/F"], { windowsHide: true }); } catch {}
    }
  }
  process.exit(signal === "SIGINT" ? 130 : 143);
}
process.on("SIGTERM", () => cleanupAll("SIGTERM"));
process.on("SIGINT", () => cleanupAll("SIGINT"));

function killTree(s) {
  if (s.child && s.child.pid && !s.killed) {
    s.killed = true;
    try {
      spawn("taskkill", ["/PID", String(s.child.pid), "/T", "/F"], {
        windowsHide: true,
      });
    } catch {}
  }
}

function finalize(s) {
  if (s.status !== "running") return;
  let status = s.result && s.result.status;
  if (!status)
    status = s.exitCode === 0 ? "sucesso" : s.exitCode === 2 ? "travado" : "erro";
  s.status = status;
  s.finishedAt = Date.now();
  const motivo = s.result && s.result.motivo;
  console.log(`[start-all] slot ${s.i} -> ${status}${motivo ? " (" + motivo + ")" : ""}`);
  killTree(s);
  maybeFinish();
}

function launch(i) {
  const cwd = path.join(desktop, String(i));
  const s = { i, status: "running", startedAt: Date.now(), result: null, exitCode: null };
  slots.push(s);

  if (!fs.existsSync(path.join(cwd, ENTRY))) {
    s.status = "erro";
    s.result = { status: "erro", motivo: `sem ${ENTRY}` };
    s.finishedAt = Date.now();
    console.log(`[start-all] slot ${i}: ${ENTRY} nao encontrado em ${cwd}`);
    return;
  }

  const child = spawn("node", [ENTRY], { cwd, windowsHide: true });
  s.child = child;
  let acc = "";
  const onData = (d) => {
    acc += d.toString("utf8");
    let k;
    while ((k = acc.indexOf("\n")) >= 0) {
      const line = acc.slice(0, k).replace(/\r$/, "");
      acc = acc.slice(k + 1);
      if (line.trim()) console.log(line); // relay (ja carimbado pelo supervisor)
      const m = line.match(/^SLOT_RESULT (\{.*\})\s*$/);
      if (m) {
        try {
          s.result = JSON.parse(m[1]);
        } catch {}
      }
    }
  };
  child.stdout.on("data", onData);
  child.stderr.on("data", onData);
  child.on("exit", (code) => {
    if (acc.trim()) console.log(acc.trim());
    s.exitCode = code;
    finalize(s);
  });
  child.on("error", (e) => {
    if (!s.result) s.result = { status: "erro", motivo: e.message };
    finalize(s);
  });
}

const timer = setInterval(() => {
  const now = Date.now();
  for (const s of slots) {
    if (s.status === "running" && now - s.startedAt > GLOBAL_MS) {
      s.result = { status: "travado", motivo: `teto global ${Math.round(GLOBAL_MS / 60000)}min` };
      finalize(s);
    }
  }
  maybeFinish();
}, TICK_MS);

function maybeFinish() {
  if (launched < SLOTS) return;
  if (slots.some((s) => s.status === "running")) return;
  clearInterval(timer);

  const by = (k) => slots.filter((s) => s.status === k).map((s) => s.i);
  const sucesso = by("sucesso"),
    travado = by("travado"),
    erro = by("erro");

  console.log("");
  console.log("================ RESUMO START-ALL ================");
  console.log(`sucesso (${sucesso.length}): ${sucesso.join(", ") || "-"}`);
  console.log(`travado (${travado.length}): ${travado.join(", ") || "-"}`);
  console.log(`erro    (${erro.length}): ${erro.join(", ") || "-"}`);
  const resumo = {
    total: slots.length,
    sucesso,
    travado,
    erro,
    slots: slots
      .slice()
      .sort((a, b) => a.i - b.i)
      .map((s) => ({ slot: s.i, status: s.status, motivo: (s.result && s.result.motivo) || null })),
  };
  console.log("RESULTADO_JSON " + JSON.stringify(resumo));
  process.exit(travado.length || erro.length ? 1 : 0);
}

// sobe os slots em escada (1 por vez, com intervalo) p/ nao saturar login
(function next(i) {
  launch(i);
  launched++;
  maybeFinish();
  if (i < SLOTS) setTimeout(() => next(i + 1), STAGGER_MS);
})(1);
