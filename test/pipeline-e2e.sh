#!/usr/bin/env bash
# ====================================================================
#  PIPELINE FASE 3 — playbook em modo pipeline + integração com hub REAL
#  A) unit: campanha-fila.js com mode:'pipeline' toma o caminho do slot-pool
#     (setTtl + run slot-pool por VPS + retorna modo:'pipeline'); wave NÃO.
#  B) integração: hub REAL local + slot-pool dreno a fila de verdade
#     (workqueue + db.recordSlotEvent reais; só o supervisor/main.js é fake).
# ====================================================================
set -u
cd "$(dirname "$0")/.."
SQLITE="--experimental-sqlite"
PASS=0; FAIL=0
ok(){ [ "$1" = "0" ] && { echo "  ✓ $2"; PASS=$((PASS+1)); } || { echo "  ✗ $2"; FAIL=$((FAIL+1)); }; }
T=$(mktemp -d); trap 'rm -rf "$T"; [ -n "${HUBPID:-}" ] && kill $HUBPID 2>/dev/null' EXIT

echo "===== A) unit: playbook toma o caminho pipeline ====="
node $SQLITE --input-type=module -e '
import pb from "./playbooks/campanha-fila.js";
let f=0; const ok=(c,m)=>{console.log((c?"  ✓ ":"  ✗ ")+m); if(!c)f++;};
const calls={ttl:0,run:[]};
let qn=0;
const ctx={
  agents:()=>["vA","vB"], tenantAgents:()=>["vA","vB"], distribute:async()=>({results:[]}),
  lease:async()=>[], returnLease:async()=>{}, retryLease:async()=>({}), requeue:async()=>({}),
  syncTelefones:async()=>({}), syncConteudo:async()=>({skipped:true}), commitUnits:async()=>{},
  queueStatus:async()=>({pending: qn++<1?5:0, leased:0, done:5, total:5}), recordWave:()=>1,
  run:async(agent,cmd)=>{ calls.run.push({agent,cmd}); return {code:0,stdout:""}; },
  log:()=>{}, isAborted:()=>false, setTtl:async()=>{calls.ttl++;},
  args:{ batch:"tb", tenant:"zz", mode:"pipeline", agents:["vA","vB"], skipSetup:true },
};
const r=await pb(ctx);
ok(r&&r.modo==="pipeline","retornou modo=pipeline");
ok(calls.ttl===1,"chamou setTtl 1x");
ok(calls.run.length===2 && calls.run.every(c=>/slot-pool\.js/.test(c.cmd)),"rodou slot-pool nas 2 VPS");
process.exit(f?1:0);
'
ok "$?" "Parte A (unit do playbook)"

echo "===== B) integração: hub REAL local + slot-pool dreno a fila ====="
PORT=$((19500 + RANDOM % 300)); TOK="t-$$"; B="zzpipeE-$(date +%s)"
# seed 5 telefones no storage (fila) + inventário (igual o upload de produção faz)
node $SQLITE --input-type=module -e 'import {store} from "./hub/lib/storage.js"; import * as db from "./hub/lib/db.js"; const B=process.argv[1]; const rows=[]; for(const n of [1,2,3,4,5]){ await store.put(B,"telefones",`TELEFONES-${n}.txt`,Buffer.from("5511"+n+"\n")); rows.push({unit:`num-${n}`,phone:"5511"+n}); } db.inventTelefones(B,"zz",rows);' "$B" 2>/dev/null
# Desktop fake: 3 sessions no pool, 3 slots com supervisor fake (sempre sucesso) + CONTEUDO
D="$T/desk"; mkdir -p "$D/CONTEUDO" "$D/sessions"; echo base > "$D/CONTEUDO/TEXTO-BASE.txt"
for i in 1 2 3; do tel="55119900$i"; mkdir -p "$D/sessions/$tel/$tel-1"; echo "https://l/$i" > "$D/sessions/$tel/$tel-1/session-link.txt"; echo "{}" > "$D/sessions/$tel/$tel-1/c.json"; mkdir -p "$D/$i/DADOS"; printf '%s' 'console.log(`SLOT_RESULT {"slot":"${process.env.SLOT_ID}","status":"sucesso"}`);process.exit(0);' > "$D/$i/index.js"; done
# sobe o hub real
HUB_PORT=$PORT HUB_TOKEN="$TOK" node $SQLITE hub/server.js >/tmp/pipe-e2e-hub.log 2>&1 &
HUBPID=$!
for i in $(seq 1 30); do curl -s "http://127.0.0.1:$PORT/health" 2>/dev/null | grep -q '"ok":true' && break; sleep 0.3; done
# roda o slot-pool (1 VPS, 3 slots) contra o hub real
HUB_URL="http://127.0.0.1:$PORT" HUB_TOKEN="$TOK" DESKTOP_DIR="$D" BATCH="$B" TENANT=zz AGENT=vpsE \
  SLOTS=3 ENTRY=index.js STAGGER_MS=50 IDLE_MS=300 STATE_POLL_MS=400 POOL_WAIT_MS=2000 POOL_POLL_MS=300 \
  node scripts/neymarlol-scripts/slot-pool.js >/tmp/pipe-e2e-pool.log 2>&1
STATE=$(curl -s -H "authorization: Bearer $TOK" "http://127.0.0.1:$PORT/campaign/state?batch=$B&tenant=zz")
DONE=$(echo "$STATE" | python3 -c "import sys,json;print(json.load(sys.stdin)['done'])" 2>/dev/null)
PEND=$(echo "$STATE" | python3 -c "import sys,json;print(json.load(sys.stdin)['pending'])" 2>/dev/null)
[ "$DONE" = "5" ] && [ "$PEND" = "0" ]; ok "$?" "fila REAL drenada: done=$DONE pending=$PEND (esperado 5/0)"
# os eventos foram pro slot_results (db real)?
EV=$(node $SQLITE --input-type=module -e 'import * as db from "./hub/lib/db.js"; const inv=db.inventoryByBatch(process.argv[1],"zz"); console.log(inv.telefones.enviado||0);' "$B" 2>/dev/null)
[ "$EV" = "5" ]; ok "$?" "slot_results/inventário: $EV telefones marcados enviado (esperado 5)"
kill $HUBPID 2>/dev/null; HUBPID=""
node $SQLITE --input-type=module -e 'import {store} from "./hub/lib/storage.js"; import * as wq from "./hub/lib/workqueue.js"; import * as db from "./hub/lib/db.js"; await store.removeBatch(process.argv[1]); await wq.remove(process.argv[1]); db.deleteBatch(process.argv[1]);' "$B" 2>/dev/null

echo ""
echo "================= PIPELINE FASE 3: $PASS ok / $FAIL falha(s) ================="
[ "$FAIL" -eq 0 ] && echo "✅ FASE 3 OK" || { echo "❌ FALHOU (logs em /tmp/pipe-e2e-*.log)"; exit 1; }
