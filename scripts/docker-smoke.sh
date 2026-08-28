#!/usr/bin/env bash
# End-to-end smoke against the compose stack: health, tool list, write → read → search → file on disk.
set -euo pipefail
BASE="${BASE_URL:-http://localhost:3000}"
INSPECTOR=(npx -y @modelcontextprotocol/inspector --cli "$BASE/mcp")

echo "[1/5] health"; curl -fsS "$BASE/health" | grep -q '"status":"ok"'
echo "[2/5] tools/list has 20 vault tools"
COUNT=$("${INSPECTOR[@]}" --method tools/list | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).tools.filter(t=>t.name.startsWith("vault_")).length))')
[ "$COUNT" = "20" ] || { echo "expected 20 vault tools, got $COUNT"; exit 1; }
echo "[3/5] vault_write then vault_read"
"${INSPECTOR[@]}" --method tools/call --tool-name vault_write --tool-arg path=00-inbox/smoke.md --tool-arg content=$'---\ntype: smoke\n---\n# Smoke\n' >/dev/null
"${INSPECTOR[@]}" --method tools/call --tool-name vault_read --tool-arg path=00-inbox/smoke.md | grep -qE '"type":[[:space:]]*"smoke"'
echo "[4/5] vault_search finds the note"
"${INSPECTOR[@]}" --method tools/call --tool-name vault_search --tool-arg query=Smoke | grep -q '00-inbox/smoke.md'
echo "[5/5] file landed in ./vault-dev"; test -f vault-dev/00-inbox/smoke.md
echo "docker smoke OK"
