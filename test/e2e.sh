#!/usr/bin/env bash
# =====================================================================
#  E2E botmkt — testa o ciclo completo SEM VPS Windows:
#   A) upload (sessions+telefones) -> embed do link + cópia + inventário
#   B) distribuição: subpastas espalhadas entre 2 VPS, link viaja junto
#   C) ONDA com os scripts REAIS (na ordem do playbook) num Desktop simulado
#      -> prova: TEXTO.txt de cada slot = link DA SESSION daquele slot + base
#   D) rastreio: recordWave -> inventário usado/erro + vínculo no /erros
#
#  Pré: container 'botmkt' no ar; Node 22; usuário 'guilherme/Mito123@'.
#  Roda na raiz do repo:  bash test/e2e.sh
#  Usa ~/Desktop como sandbox da onda (limpa no fim).
# =====================================================================
set -uo pipefail
cd "$(dirname "$0")/.."
REPO="$(pwd)"
HUB="http://127.0.0.1:80"
TENANT="guilherme"; LOGIN='{"username":"guilherme","password":"Mito123@"}'
TOKEN="$(grep -E '^HUB_TOKEN=' .env | cut -d= -f2)"
BATCH="e2e-$(date +%s)"
NEY="$REPO/scripts/neymarlol-scripts"
DESK="$HOME/Desktop"
PASS=0; FAIL=0
ok(){ echo "  ✓ $1"; PASS=$((PASS+1)); }
no(){ echo "  ✗ $1"; FAIL=$((FAIL+1)); }
chk(){ [ "$2" = "$3" ] && ok "$1 ($2)" || no "$1: esperava '$3', veio '$2'"; }
py(){ python3 -c "import sys,json;d=json.load(sys.stdin);print($1)"; }

web(){ curl -s -H "Host: bot.atomoz.io" -H "Cookie: wpsid=$SID" "$@"; }
api(){ curl -s -H "Host: apibot.atomoz.io" -H "authorization: Bearer $TOKEN" "$@"; }

echo "== E2E batch=$BATCH =="
SID="$(curl -s -D - -o /dev/null -H "Host: bot.atomoz.io" -H "content-type: application/json" -d "$LOGIN" "$HUB/auth/login" | sed -n 's/.*wpsid=\([a-f0-9]*\).*/\1/p')"
[ -n "$SID" ] && ok "login guilherme" || { no "login falhou"; exit 1; }

# ---------- fixtures ----------
TMP="$(mktemp -d)"
python3 - "$TMP" <<'PY'
import sys,zipfile,os
t=sys.argv[1]
# 2 sessions: telefone A (links AAA) e B (links BBB), cada um com 2 subsessions
for tel,_ in [('5511111111111',0),('5522222222222',0)]:
    z=zipfile.ZipFile(f'{t}/s_{tel}.zip','w',zipfile.ZIP_DEFLATED)
    for n in (1,2):
        z.writestr(f'{tel}/{tel}-{n}/Default/Cookies', b'cookie')
    z.close()
# telefones: 4 números, SÓ originais (testa criação da cópia). número DENTRO do txt.
z=zipfile.ZipFile(f'{t}/tel.zip','w',zipfile.ZIP_DEFLATED)
for n in (1,2,3,4):
    z.writestr(f'TELEFONES-{n}.txt', f'5511999990{n:03d}\n'.encode())
z.close()
print('fixtures ok')
PY

# ================= A) UPLOAD + EMBED + INVENTÁRIO =================
echo "-- A) upload + embed + inventário --"
web -H "content-type: application/zip" --data-binary @"$TMP/s_5511111111111.zip" "$HUB/upload-zip?batch=$BATCH&kind=sessions&link=https://oferta/AAA" >/dev/null
web -H "content-type: application/zip" --data-binary @"$TMP/s_5522222222222.zip" "$HUB/upload-zip?batch=$BATCH&kind=sessions&link=https://oferta/BBB" >/dev/null
TELR="$(web -H "content-type: application/zip" --data-binary @"$TMP/tel.zip" "$HUB/upload-zip?batch=$BATCH&kind=telefones")"
chk "cópias de telefone criadas" "$(echo "$TELR" | py "d['copias']")" "4"

INV="$(web "$HUB/inventory?batch=$BATCH")"
chk "sessions no inventário (pending)" "$(echo "$INV" | py "d['sessions']['pending']")" "4"
chk "telefones no inventário (pending)" "$(echo "$INV" | py "d['telefones']['pending']")" "4"
chk "phone lido de dentro do txt" "$(echo "$INV" | py "sorted(x['phone'] for x in d['telefones']['pendingList'])[0]")" "5511999990001"
# embed: cada subpasta tem session-link.txt com o link certo
LK="$(docker exec botmkt sh -c "cat '/app/hub/storage/$BATCH/sessions/5511111111111/5511111111111-1/session-link.txt'")"
chk "session-link.txt embutido (AAA)" "$LK" "https://oferta/AAA"

# ================= B) DISTRIBUIÇÃO ENTRE VPS =================
echo "-- B) distribuição (2 VPS fake) --"
IP="$(docker inspect -f '{{.NetworkSettings.Networks.infra.IPAddress}}' botmkt)"
rm -rf /tmp/e2e_vps01 /tmp/e2e_vps02
for n in 01 02; do
  HUB_URL="http://$IP:8787" HUB_TOKEN="$TOKEN" TENANT_ID="$TENANT" AGENT_ID="e2e-vps$n" DESKTOP_DIR="/tmp/e2e_vps$n" \
    setsid nohup node agent/agent.js >/tmp/e2e_a$n.log 2>&1 &
done
# espera os 2 ficarem online
for i in $(seq 1 15); do
  ON="$(api "$HUB/agents?tenant=$TENANT" | py "sum(1 for a in d['agents'] if a['id'].startswith('e2e-') and a['online'])")"
  [ "$ON" = "2" ] && break; sleep 1
done
chk "2 VPS fake online" "${ON:-0}" "2"
cat > playbooks/_e2e_dist.js <<'EOF'
export default async function ({ distribute, args }) {
  const ds = await distribute(args.batch, 'sessions', { agents: args.agents });
  return ds.results.map((r) => ({ agent: r.agent, units: r.units }));
}
EOF
DR="$(api -H "content-type: application/json" -d "{\"args\":{\"batch\":\"$BATCH\",\"agents\":[\"e2e-vps01\",\"e2e-vps02\"]}}" "$HUB/play/_e2e_dist")"
RID="$(echo "$DR" | py "d['runId']")"
for i in $(seq 1 10); do
  st="$(api "$HUB/run/$RID" | py "d['status']")"; [ "$st" = "done" ] && break; sleep 1
done
# 4 subpastas espalhadas: 2 + 2
U1="$(api "$HUB/run/$RID" | py "[r['units'] for r in d['result']][0] if d.get('result') else 0")"
TOTL="$(find /tmp/e2e_vps01/SESSIONS /tmp/e2e_vps02/SESSIONS -name session-link.txt 2>/dev/null | wc -l)"
chk "4 session-link.txt entregues nas VPS" "$TOTL" "4"
V1="$(find /tmp/e2e_vps01/SESSIONS -name session-link.txt 2>/dev/null | wc -l)"
V2="$(find /tmp/e2e_vps02/SESSIONS -name session-link.txt 2>/dev/null | wc -l)"
[ "$V1" -ge 1 ] && [ "$V2" -ge 1 ] && ok "subpastas espalhadas (vps01=$V1 vps02=$V2)" || no "não espalhou (vps01=$V1 vps02=$V2)"

# ================= C) ONDA com scripts REAIS (match link↔session) =================
echo "-- C) onda real no Desktop simulado (invariante do link) --"
rm -rf "$DESK"; mkdir -p "$DESK/CONTEUDO" "$DESK/sessions" "$DESK/TELEFONES CAMPANHA"
printf 'PROMO BASE' > "$DESK/CONTEUDO/TEXTO-BASE.txt"
for k in $(seq 1 16); do mkdir -p "$DESK/$k/DADOS"; done
# pool de sessions (como o sync entrega): <tel>/<tel>-1 com session-link.txt
mk_sess(){ mkdir -p "$DESK/sessions/$1/$1-1/Default"; printf 'c' > "$DESK/sessions/$1/$1-1/Default/Cookies"; printf '%s' "$2" > "$DESK/sessions/$1/$1-1/session-link.txt"; }
mk_sess 5511111111111 "https://oferta/AAA"   # menor número -> slot 1
mk_sess 5522222222222 "https://oferta/BBB"   # -> slot 2
# pool de telefones (par original+copia)
for n in 1 2; do printf '5511999990%03d\n' "$n" > "$DESK/TELEFONES CAMPANHA/TELEFONES-$n.txt"; cp "$DESK/TELEFONES CAMPANHA/TELEFONES-$n.txt" "$DESK/TELEFONES CAMPANHA/TELEFONES-$n - Copia.txt"; done

runs(){ DESKTOP_DIR="$DESK" node "$NEY/$1" >/dev/null 2>&1; }   # roda 1 script da onda
# ordem EXATA do campanha-fila.js:
runs limpar-broadcast.js; runs limpar-telefones.js; runs renomear-numeros.js; runs limpar-telefones.js; runs limpar-sessions.js
runs movimenta-numeros.js; runs movimenta-sessions.js; runs renomear-sessions.js; runs renomear-numeros.js; runs gera-texto.js

# invariante: em cada slot, o link no TEXTO.txt == o link da session daquele slot
for slot in 1 2; do
  SLK="$(cat "$DESK/$slot/session/session-link.txt" 2>/dev/null)"
  TXT="$(cat "$DESK/$slot/DADOS/TEXTO.txt" 2>/dev/null)"
  [ -f "$DESK/$slot/session/session-link.txt" ] && ok "slot $slot tem session" || no "slot $slot sem session"
  [ -f "$DESK/$slot/DADOS/TELEFONES.txt" ] && ok "slot $slot tem TELEFONES.txt" || no "slot $slot sem TELEFONES.txt"
  case "$TXT" in
    *"$SLK"*) ok "slot $slot: TEXTO.txt contém o link da SUA session ($SLK)";;
    *) no "slot $slot: link NÃO bate! session=$SLK texto=[$TXT]";;
  esac
  case "$TXT" in *"PROMO BASE"*) ok "slot $slot: TEXTO tem o texto base";; *) no "slot $slot: sem texto base";; esac
done
# garante que NÃO cruzou (slot 1 não tem BBB, slot 2 não tem AAA)
grep -q BBB "$DESK/1/DADOS/TEXTO.txt" 2>/dev/null && no "slot 1 vazou link BBB" || ok "slot 1 sem link de outra session"
grep -q AAA "$DESK/2/DADOS/TEXTO.txt" 2>/dev/null && no "slot 2 vazou link AAA" || ok "slot 2 sem link de outra session"

# ================= D) RASTREIO (recordWave) =================
echo "-- D) rastreio: recordWave -> inventário usado/erro --"
cat > playbooks/_e2e_rec.js <<'EOF'
export default async function ({ recordWave, args }) { recordWave(args.rec); return { ok: true }; }
EOF
REC="$(python3 -c "import json;print(json.dumps({'rec':{'tenant':'$TENANT','batch':'$BATCH','agent':'e2e-vps01','wave':1,'leased':['num-1','num-2'],'pendingAfter':2,'resumo':{'sucesso':[1],'travado':[],'erro':[2],'slots':[{'slot':1,'status':'sucesso'},{'slot':2,'status':'erro','motivo':'travou'}]},'slotSessions':{'1':'5511111111111-1','2':'5522222222222-1'},'committed':['num-1'],'exhausted':['num-2']}}))")"
api -H "content-type: application/json" -d "{\"args\":$REC}" "$HUB/play/_e2e_rec" >/dev/null; sleep 1
INV2="$(web "$HUB/inventory?batch=$BATCH")"
chk "sessions usadas" "$(echo "$INV2" | py "d['sessions']['usada']")" "2"
chk "telefone enviado" "$(echo "$INV2" | py "d['telefones']['enviado']")" "1"
chk "telefone erro (esgotado)" "$(echo "$INV2" | py "d['telefones']['erro']")" "1"
ERR="$(web "$HUB/erros?batch=$BATCH")"
chk "/erros traz o vínculo (session)" "$(echo "$ERR" | py "d['erros'][0]['session']")" "5522222222222-1"
chk "/erros traz o phone real" "$(echo "$ERR" | py "d['erros'][0]['phone']")" "5511999990002"

# ---------- cleanup ----------
echo "-- cleanup --"
pkill -f "[a]gent/agent.js" 2>/dev/null
rm -f playbooks/_e2e_dist.js playbooks/_e2e_rec.js
rm -rf "$TMP" /tmp/e2e_vps01 /tmp/e2e_vps02 "$DESK"
docker exec botmkt sh -c "rm -rf '/app/hub/storage/$BATCH' '/app/hub/storage/queues/$BATCH.json'" 2>/dev/null
docker exec botmkt node --experimental-sqlite -e "const{DatabaseSync}=require('node:sqlite');const d=new DatabaseSync('/app/hub/storage/wppbot.db');for(const t of['sessions_inv','telefones_inv','slot_results','waves'])d.exec(\`DELETE FROM \${t} WHERE batch='$BATCH'\`);" 2>/dev/null
docker restart botmkt >/dev/null 2>&1   # limpa o mapa de agentes fake

echo ""
echo "================= RESULTADO: $PASS ok / $FAIL falha(s) ================="
[ "$FAIL" -eq 0 ] && echo "✅ E2E PASSOU" || echo "❌ E2E FALHOU"
exit "$FAIL"
