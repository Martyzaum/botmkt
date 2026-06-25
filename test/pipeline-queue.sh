#!/usr/bin/env bash
# ====================================================================
#  PIPELINE FASE 1 — fila por HTTP + lease TTL + slot/event
#  Parte A: unit (node) das funções novas da workqueue + db (isolado).
#  Parte B: smoke HTTP de um hub LOCAL (porta de teste) — /q/* + /campaign/state.
#  Não toca no container/produção. Limpa o batch de teste no fim.
# ====================================================================
set -u
cd "$(dirname "$0")/.."
SQLITE="--experimental-sqlite"
PASS=0; FAIL=0
ok(){ [ "$1" = "0" ] && { echo "  ✓ $2"; PASS=$((PASS+1)); } || { echo "  ✗ $2"; FAIL=$((FAIL+1)); }; }

echo "===== A) unit: workqueue + db ====="
node $SQLITE --input-type=module -e '
import * as wq from "./hub/lib/workqueue.js";
import * as db from "./hub/lib/db.js";
import { store } from "./hub/lib/storage.js";
let f=0; const ok=(c,m)=>{ console.log((c?"  ✓ ":"  ✗ ")+m); if(!c)f++; };
const B="zzpipeU-"+Date.now();
for(const n of [1,2,3]) await store.put(B,"telefones",`TELEFONES-${n}.txt`,Buffer.from("551"+n+"\n"));
let st=await wq.status(B); ok(st.total===3&&st.pending===3,"seed 3 pendentes");
const u=await wq.lease(B,"vpsA",2); ok(u.length===2,"lease 2");
st=await wq.status(B); ok(st.leased===2&&st.pending===1,"2 leased / 1 pending");
await wq.commit(B,[u[0].key]); st=await wq.status(B); ok(st.done===1&&st.leased===1,"commit -> done 1");
const rq=await wq.requeueKeys(B,[u[1].key]); ok(rq.requeued.length===1,"requeueKeys 1");
st=await wq.status(B); ok(st.leased===0&&st.pending===2&&st.retrying===0,"requeueKeys: volta sem penalizar");
const ub=await wq.lease(B,"vpsA",1); await wq.setTtl(B,1); await new Promise(r=>setTimeout(r,6));
let rp=await wq.reapStale(B,()=>true); ok(rp.reaped.length===1&&rp.reaped[0]===ub[0].key,"reapStale por TTL expirado");
await wq.lease(B,"vpsA",1); await wq.setTtl(B,Infinity);
rp=await wq.reapStale(B,()=>true); ok(rp.reaped.length===0,"online + TTL Infinity -> NAO reapa (wave seguro)");
rp=await wq.reapStale(B,()=>false); ok(rp.reaped.length===1,"agente offline -> reapa (mesmo Infinity)");
db.inventTelefones(B,"zz",[{unit:"num-1",phone:"5511"},{unit:"num-2",phone:"5522"}]);
db.recordSlotEvent({batch:B,tenant:"zz",agent:"vpsA",slot:1,status:"sucesso",key:"num-1",session:"5511/5511-1"});
db.recordSlotEvent({batch:B,tenant:"zz",agent:"vpsA",slot:2,status:"travado",key:"num-2",session:"x",motivo:"sem log"});
const inv=db.inventoryByBatch(B,"zz");
ok((inv.telefones.enviado||0)===1,"slot/event sucesso -> telefone enviado");
ok((inv.telefones.erro||0)===0,"slot/event travado -> NAO marca telefone erro (requeue)");
const er=db.errosByBatch(B,"zz",10);
ok(er.some(e=>e.status==="travado"&&e.numero==="num-2"),"slot/event aparece em erros (problema)");
await store.removeBatch(B); await wq.remove(B); db.deleteBatch(B);
process.exit(f?1:0);
'
ok "$?" "Parte A (unit) passou"

echo "===== B) smoke HTTP (hub local) ====="
PORT=18799
TOK="testtoken-$$"
B="zzpipeH-$(date +%s)"
# seed o batch ANTES de subir (o hub constrói a fila do storage no 1o lease)
node $SQLITE --input-type=module -e '
import { store } from "./hub/lib/storage.js";
for(const n of [1,2]) await store.put(process.argv[1],"telefones",`TELEFONES-${n}.txt`,Buffer.from("55"+n+"\n"));
' "$B" 2>/dev/null
HUB_PORT=$PORT HUB_TOKEN="$TOK" node $SQLITE hub/server.js >/tmp/pipehub.log 2>&1 &
HUBPID=$!
trap 'kill $HUBPID 2>/dev/null' EXIT
for i in $(seq 1 30); do curl -s "http://127.0.0.1:$PORT/health" 2>/dev/null | grep -q '"ok":true' && break; sleep 0.3; done
api(){ curl -s -H "authorization: Bearer $TOK" "$@"; }
J(){ python3 -c "import sys,json;d=json.load(sys.stdin);print($1)" 2>/dev/null; }

LEASE=$(api -H "content-type: application/json" -d "{\"batch\":\"$B\",\"agent\":\"vpsH\",\"n\":2}" "http://127.0.0.1:$PORT/q/lease")
n=$(echo "$LEASE" | J "len(d['units'])"); K1=$(echo "$LEASE" | J "d['units'][0]['key']"); K2=$(echo "$LEASE" | J "d['units'][1]['key']")
[ "$n" = "2" ]; ok "$?" "/q/lease tirou 2 (veio: $n)"
K=$(api -H "content-type: application/json" -d "{\"batch\":\"$B\",\"agent\":\"vpsH\",\"n\":2}" "http://127.0.0.1:$PORT/q/lease" | J "len(d['units'])")
[ "${K:-0}" = "0" ]; ok "$?" "/q/lease 2a vez vazia (todas leased)"
state=$(api "http://127.0.0.1:$PORT/campaign/state?batch=$B&tenant=zz")
L=$(echo "$state" | J "d['leased']"); R=$(echo "$state" | J "d['running']")
[ "$L" = "2" ] && [ "$R" = "False" ]; ok "$?" "/campaign/state: leased=2 running=false (veio leased=$L running=$R)"
api -H "content-type: application/json" -d "{\"batch\":\"$B\",\"keys\":[\"$K1\"]}" "http://127.0.0.1:$PORT/q/commit" >/dev/null
api -H "content-type: application/json" -d "{\"batch\":\"$B\",\"keys\":[\"$K2\"]}" "http://127.0.0.1:$PORT/q/requeue" >/dev/null
state=$(api "http://127.0.0.1:$PORT/campaign/state?batch=$B&tenant=zz")
D=$(echo "$state" | J "d['done']"); P=$(echo "$state" | J "d['pending']"); L=$(echo "$state" | J "d['leased']")
[ "$D" = "1" ] && [ "$P" = "1" ] && [ "$L" = "0" ]; ok "$?" "commit+requeue: done=1 pending=1 leased=0 (veio d=$D p=$P l=$L)"
api -H "content-type: application/json" -d "{\"batch\":\"$B\",\"tenant\":\"zz\",\"agent\":\"vpsH\",\"slot\":1,\"status\":\"sucesso\",\"key\":\"$K1\"}" "http://127.0.0.1:$PORT/slot/event" | grep -q '"ok":true'
ok "$?" "/slot/event aceitou"

kill $HUBPID 2>/dev/null; trap - EXIT
node $SQLITE --input-type=module -e 'import {store} from "./hub/lib/storage.js"; import * as wq from "./hub/lib/workqueue.js"; import * as db from "./hub/lib/db.js"; await store.removeBatch(process.argv[1]); await wq.remove(process.argv[1]); db.deleteBatch(process.argv[1]);' "$B" 2>/dev/null

echo ""
echo "================= PIPELINE FASE 1: $PASS ok / $FAIL falha(s) ================="
[ "$FAIL" -eq 0 ] && echo "✅ FASE 1 OK" || { echo "❌ FALHOU (log do hub: /tmp/pipehub.log)"; exit 1; }
