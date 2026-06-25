#!/usr/bin/env bash
# ====================================================================
#  PIPELINE FASE 2 — slot-pool.js (worker por slot)
#  Hub FAKE (node http) + supervisor FAKE (index.js) num Desktop temporário.
#  Prova: drenar a fila (session-keeping), falha->requeue (número preservado),
#  claim concorrente de session, abort, e pool seco -> encerra sem perder número.
# ====================================================================
set -u
cd "$(dirname "$0")/.."
ROOT="$(pwd)"
PASS=0; FAIL=0
ok(){ [ "$1" = "0" ] && { echo "  ✓ $2"; PASS=$((PASS+1)); } || { echo "  ✗ $2"; FAIL=$((FAIL+1)); }; }
T=$(mktemp -d)
trap 'rm -rf "$T"; pkill -f "[f]ake-hub-$$" 2>/dev/null' EXIT

# hub FAKE -----------------------------------------------------------------
cat > "$T/fake-hub-$$.mjs" <<'JS'
import http from "node:http";
const PORT=+process.env.FAKE_PORT, N=+process.env.FAKE_UNITS||0;
let aborted=process.env.FAKE_ABORTED==="1";
let pending=Array.from({length:N},(_,i)=>({key:`num-${i+1}`,num:i+1,files:[{rel:`TELEFONES-${i+1}.txt`}]}));
const leased=new Map(); let done=0, events=[];
const body=req=>new Promise(r=>{let b="";req.on("data",d=>b+=d);req.on("end",()=>r(b?JSON.parse(b):{}));});
const J=(res,o)=>{res.writeHead(200,{"content-type":"application/json"});res.end(JSON.stringify(o));};
http.createServer(async(req,res)=>{
  const u=new URL(req.url,"http://x"); const p=u.pathname;
  if(p==="/q/lease"){const b=await body(req);const take=pending.splice(0,b.n||1);for(const x of take)leased.set(x.key,x);return J(res,{units:take});}
  if(p==="/q/commit"){const b=await body(req);for(const k of b.keys||[]){if(leased.delete(k))done++;}return J(res,{ok:true});}
  if(p==="/q/requeue"){const b=await body(req);for(const k of b.keys||[]){const v=leased.get(k);if(v){leased.delete(k);pending.push(v);}}return J(res,{ok:true});}
  if(p==="/slot/event"){const b=await body(req);events.push(b);return J(res,{ok:true});}
  if(p==="/campaign/state")return J(res,{running:!aborted,aborted,pending:pending.length,leased:leased.size,done});
  if(p==="/file"){res.writeHead(200);return res.end("5511999\n");}
  if(p==="/_stats")return J(res,{pending:pending.length,leased:leased.size,done,events:events.length,travados:events.filter(e=>e.status==="travado").length});
  if(p==="/_abort"){aborted=true;return J(res,{ok:true});}
  res.writeHead(404);res.end("{}");
}).listen(PORT,()=>console.log("fakehub on "+PORT));
JS

# supervisor FAKE: emite SLOT_RESULT conforme POOL_TEST_RESULT (sucesso|travado)
mkfakeindex(){ printf '%s' 'const r=process.env.POOL_TEST_RESULT||"sucesso";console.log(`SLOT_RESULT {"slot":"${process.env.SLOT_ID||"x"}","status":"${r}"}`);process.exit(r==="sucesso"?0:r==="travado"?2:1);' > "$1/index.js"; }

# monta um Desktop: $1=dir $2=nSessions $3=nSlots
setup(){
  local D="$1" ns="$2" nslots="$3"; rm -rf "$D"; mkdir -p "$D/CONTEUDO" "$D/sessions"
  echo "mensagem base" > "$D/CONTEUDO/TEXTO-BASE.txt"
  for i in $(seq 1 "$ns"); do local tel="551199000$i"; mkdir -p "$D/sessions/$tel/$tel-1"; echo "https://link/$i" > "$D/sessions/$tel/$tel-1/session-link.txt"; echo "{}" > "$D/sessions/$tel/$tel-1/creds.json"; done
  for i in $(seq 1 "$nslots"); do mkdir -p "$D/$i/DADOS"; mkfakeindex "$D/$i"; done
}
runpool(){ # $1=desktop $2=slots $3=result $4=units $5=aborted$  extra env via globals
  FAKE_PORT=$PORT FAKE_UNITS=$4 FAKE_ABORTED=${5:-0} node "$T/fake-hub-$$.mjs" >/dev/null 2>&1 &
  HUBPID=$!; sleep 0.6
  HUB_URL="http://127.0.0.1:$PORT" HUB_TOKEN=x DESKTOP_DIR="$1" BATCH=tb TENANT=zz AGENT=vps1 \
    SLOTS=$2 ENTRY=index.js POOL_TEST_RESULT=$3 STAGGER_MS=50 IDLE_MS=300 STATE_POLL_MS=300 \
    POOL_WAIT_MS=1500 POOL_POLL_MS=300 \
    node scripts/neymarlol-scripts/slot-pool.js >/dev/null 2>&1
  STATS=$(curl -s "http://127.0.0.1:$PORT/_stats"); kill $HUBPID 2>/dev/null; wait $HUBPID 2>/dev/null
}
JV(){ echo "$STATS" | python3 -c "import sys,json;print(json.load(sys.stdin)['$1'])" 2>/dev/null; }

PORT=$((19000 + RANDOM % 500))

echo "===== 1) drenar a fila (session-keeping) ====="
setup "$T/d1" 4 4
runpool "$T/d1" 4 sucesso 6 0
[ "$(JV done)" = "6" ] && [ "$(JV pending)" = "0" ]; ok "$?" "6 unidades drenadas com 4 sessions (done=$(JV done) pending=$(JV pending)) — reusou session"

echo "===== 2) falha -> requeue (número preservado, troca session) ====="
PORT=$((PORT+1)); setup "$T/d2" 2 2
runpool "$T/d2" 2 travado 3 0
[ "$(JV done)" = "0" ] && [ "$(JV pending)" = "3" ]; ok "$?" "0 enviado, 3 de volta na fila (done=$(JV done) pending=$(JV pending)) — nada perdido"
[ "$(JV travados)" -ge 1 ]; ok "$?" "registrou evento(s) travado ($(JV travados))"

echo "===== 3) claim concorrente: 1 session, 2 workers ====="
PORT=$((PORT+1)); setup "$T/d3" 1 2
runpool "$T/d3" 2 sucesso 0 0
nsess=$(find "$T/d3"/1/session "$T/d3"/2/session -maxdepth 0 2>/dev/null | wc -l)
poolrest=$(find "$T/d3/sessions" -name "session-link.txt" 2>/dev/null | wc -l)
[ "$nsess" = "1" ] && [ "$poolrest" = "0" ]; ok "$?" "exatamente 1 slot pegou a session, pool zerado (slots=$nsess pool=$poolrest) — sem corromper"

echo "===== 4) abort encerra rápido ====="
PORT=$((PORT+1)); setup "$T/d4" 4 4
START=$(date +%s)
runpool "$T/d4" 4 sucesso 50 1
DUR=$(( $(date +%s) - START ))
[ "$DUR" -lt 15 ]; ok "$?" "runner encerrou com abort em ${DUR}s (<15s)"

echo "===== 5) pool seco + fila cheia -> encerra sem perder número ====="
PORT=$((PORT+1)); setup "$T/d5" 0 2
runpool "$T/d5" 2 sucesso 2 0
[ "$(JV done)" = "0" ] && [ "$(JV pending)" = "2" ]; ok "$?" "pool seco: 0 enviado, 2 preservados (done=$(JV done) pending=$(JV pending))"

echo ""
echo "================= PIPELINE FASE 2: $PASS ok / $FAIL falha(s) ================="
[ "$FAIL" -eq 0 ] && echo "✅ FASE 2 OK" || { echo "❌ FALHOU"; exit 1; }
