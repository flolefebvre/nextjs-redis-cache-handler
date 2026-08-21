#!/usr/bin/env bash
# PROTOTYPE driver: runs two `next start` instances on one build and walks a
# scenario, writing markers so the report can slice the handler log per step.
set -euo pipefail
cd "$(dirname "$0")/.."
STORE=.fixture-store
mkdir -p "$STORE"
MARKERS="$STORE/markers.jsonl"
: > "$MARKERS"
rm -f "$STORE"/log-3000-* "$STORE"/log-3001-*

mark() { echo "{\"t\":$(date +%s%3N),\"op\":\"MARK\",\"step\":\"$1\"}" >> "$MARKERS"; echo "== $1"; }
get()  { curl -s -o /dev/null -w "%{http_code} %{size_download}B %{time_total}s  $1\n" "$1"; }
ACTION_ID=$(node -e "const m=require('./.next/server/server-reference-manifest.json');const id=Object.keys(m.node).find(k=>m.node[k].exportedName==='invalidatePosts'||/invalidatePosts/.test(JSON.stringify(m.node[k])));console.log(id)")
action() { # $1 = origin, $2 = action id, $3 = json args
  curl -s -o /dev/null -w "%{http_code} action $2 @ $1\n" -X POST "$1/" \
    -H "Next-Action: $2" -H 'Content-Type: text/plain;charset=UTF-8' -H 'Accept: text/x-component' --data "$3"
}

PORT=3000 NEXT_TELEMETRY_DISABLED=1 node_modules/.bin/next start -p 3000 > "$STORE/server-3000.log" 2>&1 &
A=$!
PORT=3001 NEXT_TELEMETRY_DISABLED=1 node_modules/.bin/next start -p 3001 > "$STORE/server-3001.log" 2>&1 &
B=$!
trap 'kill $A $B 2>/dev/null || true' EXIT
for p in 3000 3001; do until curl -sf "http://localhost:$p/api/revalidate" >/dev/null; do sleep 0.2; done; done
sleep 0.5

mark "1 cold list page on A (prerendered at build)";      get http://localhost:3000/
mark "2 cold detail /posts/1 on A (dynamic, nested)";     get http://localhost:3000/posts/1
mark "3 same detail on B (entries written by A)";         get http://localhost:3001/posts/1
mark "4 RSC navigation payload for /posts/1 on B";        curl -s -o /dev/null -w "%{http_code} %{size_download}B RSC\n" -H 'RSC: 1' http://localhost:3001/posts/1
mark "5 big page on A";                                   get http://localhost:3000/big
mark "6 server action updateTag('posts') on A";           action http://localhost:3000 "$ACTION_ID" '[]'
mark "7 detail /posts/1 on B after updateTag on A";       get http://localhost:3001/posts/1
mark "8 list page on B after updateTag on A";             get http://localhost:3001/
mark "9 route revalidateTag('comments:1','max') on B";    get "http://localhost:3001/api/revalidate?tag=comments:1"
mark "10 detail on A: comments stale -> SWR";             get http://localhost:3000/posts/1
sleep 1.5
mark "11 detail on A again: refreshed in background?";    get http://localhost:3000/posts/1
mark "12 route revalidatePath('/posts/1') on B";          get "http://localhost:3001/api/revalidate?path=/posts/1"
mark "13 detail on A after revalidatePath";               get http://localhost:3000/posts/1
mark "14 route revalidateTag('big',{expire:0}) on A";     get "http://localhost:3000/api/revalidate?tag=big&expire=0"
mark "15 big on B after expire:0";                        get http://localhost:3001/big
mark "16 route revalidatePath('/', 'layout') on A";       get "http://localhost:3000/api/revalidate?path=/&type=layout"
mark "17 detail on B after layout revalidatePath";        get http://localhost:3001/posts/1
mark "18 detail /posts/2 on B (fresh key, same fns)";     get http://localhost:3001/posts/2
sleep 1
mark "end"
