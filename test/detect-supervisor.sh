#!/usr/bin/env bash
# =====================================================================
#  Teste do SUPERVISOR (slot-supervisor.js) — prova a detecção do fim
#  da onda SEM precisar do hub nem do bot real. Roda o supervisor com um
#  main.js fake em 3 cenários e confere o veredito:
#    A) terminou com o marcador de sucesso        -> sucesso (exit 0)
#    B) enviou alguns e TRAVOU (ficou mudo)        -> travado (exit 2)
#    C) crashou (exit!=0) sem marcador             -> erro    (exit 1)
#  Tambem cobre o falha-rapido sem session.
#
#  Roda:  bash test/detect-supervisor.sh
# =====================================================================
set -uo pipefail
cd "$(dirname "$0")/.."
SUP="$PWD/scripts/neymarlol-scripts/slot-supervisor.js"
T="$(mktemp -d)"; DESK="$T/desk"; mkdir -p "$DESK"
PASS=0; FAIL=0
chk(){ [ "$2" = "$3" ] && { echo "  ✓ $1 ($2)"; PASS=$((PASS+1)); } || { echo "  ✗ $1: esperava '$3', veio '$2'"; FAIL=$((FAIL+1)); }; }

mkslot(){ mkdir -p "$DESK/$1/session"; echo link > "$DESK/$1/session/session-link.txt"; printf '%s' "$2" > "$DESK/$1/main.js"; cp "$SUP" "$DESK/$1/index.js"; }
status(){ python3 -c "import json;print(json.load(open('$DESK/_logs/slot-$1.result.json'))['status'])" 2>/dev/null || echo "SEM_RESULT"; }
run(){ ( cd "$DESK/$1" && DESKTOP_DIR="$DESK" SLOT_ID="$1" INACTIVITY_MS=2000 MAX_RESTARTS=2 node index.js >/dev/null 2>&1 ); }

# A) sucesso pelo marcador
mkslot A 'console.log("BroadCast iniciado");for(const n of ["551","552","553"])console.log("enviado "+n);console.log("NENHUM NÚMERO RESTANTE.");'
run A; chk "A: terminou com marcador -> sucesso" "$(status A)" "sucesso"

# B) enviou alguns e travou (mudo) -> travado por inatividade
mkslot B 'console.log("BroadCast iniciado");console.log("enviado 551");console.log("enviado 552");setInterval(()=>{},1e9);'
run B; chk "B: enviou e travou -> travado" "$(status B)" "travado"

# C) crashou sem marcador -> erro apos restarts
mkslot C 'console.log("BroadCast iniciado");process.exit(1);'
run C; chk "C: crashou sem marcador -> erro" "$(status C)" "erro"

# D) sem session -> falha na hora (nao espera inatividade)
mkdir -p "$DESK/D"; printf 'console.log("nao deveria rodar");' > "$DESK/D/main.js"; cp "$SUP" "$DESK/D/index.js"
( cd "$DESK/D" && DESKTOP_DIR="$DESK" SLOT_ID="D" node index.js >/dev/null 2>&1 )
chk "D: sem session -> erro na hora" "$(status D)" "erro"

# o outro marcador de sucesso tambem vale
mkslot E 'console.log("processando");console.log("ENVIO DA BROADCAST TERMINADO");'
run E; chk "E: marcador 'BROADCAST TERMINADO' -> sucesso" "$(status E)" "sucesso"

# F) session em LOOP de reconexao -> desiste rapido pelo contador (nao pelo timeout)
mkslot F 'console.log("BroadCast iniciado");for(let i=0;i<3;i++)console.log("Digite seu numero ... CONEXAO FECHADA - RECONECTANDO");setInterval(()=>{},1e9);'
run F; chk "F: loop de reconexao -> travado" "$(status F)" "travado"
motivoF="$(python3 -c "import json;print(json.load(open('$DESK/_logs/slot-F.result.json'))['motivo'])" 2>/dev/null)"
case "$motivoF" in *caindo*) echo "  ✓ F: detectou pela queda, nao pelo timeout ($motivoF)"; PASS=$((PASS+1));; *) echo "  ✗ F: esperava motivo 'session caindo', veio: $motivoF"; FAIL=$((FAIL+1));; esac

rm -rf "$T"
echo ""
echo "================= DETECT: $PASS ok / $FAIL falha(s) ================="
[ "$FAIL" -eq 0 ] && echo "✅ DETECÇÃO OK" || echo "❌ FALHOU"
exit "$FAIL"
