#!/usr/bin/env bash
# ====================================================================
#  PIPELINE FASE 4 — chart envios/erro por hora + switch de modo
#  A) db.hourly: agrega slot_results (enviados=sucesso, erros=travado+erro).
#  B) hub local: GET /hourly devolve a agregação; o HTML servido tem o chart,
#     o seletor de modo e o botão migrar.
# ====================================================================
set -u
cd "$(dirname "$0")/.."
SQLITE="--experimental-sqlite"
PASS=0; FAIL=0
ok(){ [ "$1" = "0" ] && { echo "  ✓ $2"; PASS=$((PASS+1)); } || { echo "  ✗ $2"; FAIL=$((FAIL+1)); }; }
trap '[ -n "${HUBPID:-}" ] && kill $HUBPID 2>/dev/null' EXIT

echo "===== A) db.hourly agrega slot_results ====="
node $SQLITE --input-type=module -e '
import * as db from "./hub/lib/db.js"; import {store} from "./hub/lib/storage.js";
let f=0; const ok=(c,m)=>{console.log((c?"  ✓ ":"  ✗ ")+m);if(!c)f++;};
const B="zzpanelA-"+Date.now();
db.inventTelefones(B,"zz",[{unit:"num-1"},{unit:"num-2"},{unit:"num-3"}]);
db.recordSlotEvent({batch:B,tenant:"zz",slot:1,status:"sucesso",key:"num-1"});
db.recordSlotEvent({batch:B,tenant:"zz",slot:2,status:"sucesso",key:"num-2"});
db.recordSlotEvent({batch:B,tenant:"zz",slot:3,status:"travado",key:"num-3"});
const h=db.hourly(B,"zz");
ok(h.length>=1,"retornou bucket(s) por hora");
const t=h.reduce((a,r)=>({e:a.e+r.enviados,x:a.x+r.erros}),{e:0,x:0});
ok(t.e===2,"enviados=2 (sucesso) — veio "+t.e);
ok(t.x===1,"erros=1 (travado) — veio "+t.x);
db.deleteBatch(B); await store.removeBatch(B);
process.exit(f?1:0);
'
ok "$?" "Parte A (db.hourly)"

echo "===== B) hub local: /hourly + HTML servido ====="
PORT=$((19800 + RANDOM % 150)); TOK="t-$$"; B="zzpanelB-$(date +%s)"
node $SQLITE --input-type=module -e '
import * as db from "./hub/lib/db.js"; const B=process.argv[1];
db.inventTelefones(B,"zz",[{unit:"num-1"},{unit:"num-2"}]);
db.recordSlotEvent({batch:B,tenant:"zz",slot:1,status:"sucesso",key:"num-1"});
db.recordSlotEvent({batch:B,tenant:"zz",slot:2,status:"erro",key:"num-2"});
' "$B" 2>/dev/null
HUB_PORT=$PORT HUB_TOKEN="$TOK" node $SQLITE hub/server.js >/tmp/pipe-panel-hub.log 2>&1 &
HUBPID=$!
for i in $(seq 1 30); do curl -s "http://127.0.0.1:$PORT/health" 2>/dev/null | grep -q '"ok":true' && break; sleep 0.3; done
HR=$(curl -s -H "authorization: Bearer $TOK" "http://127.0.0.1:$PORT/hourly?batch=$B&tenant=zz")
EN=$(echo "$HR" | python3 -c "import sys,json;d=json.load(sys.stdin)['hourly'];print(sum(r['enviados'] for r in d))" 2>/dev/null)
ER=$(echo "$HR" | python3 -c "import sys,json;d=json.load(sys.stdin)['hourly'];print(sum(r['erros'] for r in d))" 2>/dev/null)
[ "$EN" = "1" ] && [ "$ER" = "1" ]; ok "$?" "/hourly: enviados=$EN erros=$ER (esperado 1/1)"
HTML=$(curl -s "http://127.0.0.1:$PORT/")
for el in "mon-mode" "mon-migrate" "mon-hourly" "Envios / erro por hora" "function renderHourly"; do
  echo "$HTML" | grep -q "$el"; ok "$?" "HTML servido tem: $el"
done
kill $HUBPID 2>/dev/null; HUBPID=""
node $SQLITE --input-type=module -e 'import * as db from "./hub/lib/db.js"; db.deleteBatch(process.argv[1]);' "$B" 2>/dev/null

echo ""
echo "================= PIPELINE FASE 4: $PASS ok / $FAIL falha(s) ================="
[ "$FAIL" -eq 0 ] && echo "✅ FASE 4 OK" || { echo "❌ FALHOU (log: /tmp/pipe-panel-hub.log)"; exit 1; }
