#!/usr/bin/env bash
# End-to-end smoke against the compose stack: seed a bearer token, health, auth gate,
# tool list, write → read → search → file on disk, connection note.
set -euo pipefail
BASE="${BASE_URL:-http://localhost:3000}"
VAULT="${VAULT_PATH:-./vault-dev}"

echo "[0/6] seed bearer token into $VAULT/_brainstem/state.json"
TOKEN=$(node -e '
const fs=require("fs"),c=require("crypto"),f=process.argv[1];
const t=c.randomBytes(32).toString("base64url");
const d=fs.existsSync(f)?JSON.parse(fs.readFileSync(f,"utf8")):{version:1,clients:{},pending:{},codes:{},tokens:{}};
d.tokens[c.createHash("sha256").update(t).digest("hex")]={kind:"access",familyId:"smoke",clientId:"https://claude.ai/oauth/smoke",clientName:"smoke",resource:process.argv[2],scope:"vault",expiresAt:Date.now()+3600000};
fs.mkdirSync(require("path").dirname(f),{recursive:true});fs.writeFileSync(f,JSON.stringify(d));console.log(t)' "$VAULT/_brainstem/state.json" "$BASE/mcp")

INSPECTOR=(npx -y @modelcontextprotocol/inspector --cli "$BASE/mcp" --header "Authorization: Bearer $TOKEN")

echo "[1/6] health"; curl -fsS "$BASE/health" | grep -q '"status":"ok"'

echo "[2/6] unauthenticated POST /mcp is rejected with 401"
CODE=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/mcp" \
  -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}')
[ "$CODE" = "401" ] || { echo "expected 401 for unauthenticated /mcp, got $CODE"; exit 1; }

echo "[3/6] tools/list has 25 vault tools"
COUNT=$("${INSPECTOR[@]}" --method tools/list | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).tools.filter(t=>t.name.startsWith("vault_")).length))')
[ "$COUNT" = "25" ] || { echo "expected 25 vault tools, got $COUNT"; exit 1; }

echo "[4/6] vault_write then vault_read"
"${INSPECTOR[@]}" --method tools/call --tool-name vault_write --tool-arg path=00-inbox/smoke.md --tool-arg content=$'---\ntype: smoke\n---\n# Smoke\n' >/dev/null
"${INSPECTOR[@]}" --method tools/call --tool-name vault_read --tool-arg path=00-inbox/smoke.md | grep -qE '"type":[[:space:]]*"smoke"'

echo "[5/6] vault_search finds the note"
"${INSPECTOR[@]}" --method tools/call --tool-name vault_search --tool-arg query=Smoke | grep -q '00-inbox/smoke.md'

echo "[6/6] file landed in $VAULT, connection note was written"
test -f "$VAULT/00-inbox/smoke.md"
test -f "$VAULT/_brainstem/connection.md"
test -f "$VAULT/_brainstem/instructions.md"

echo "docker smoke OK"
