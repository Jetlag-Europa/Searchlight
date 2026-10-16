#!/usr/bin/env bash
# Summarise auth 401s from a running API container's logs.
#
# Groups 401s by client (address + User-Agent) and 3-second window, so the 5-9
# simultaneous failures produced by one unauthenticated page load appear as ONE
# wall rather than nine unrelated log lines — and reports the User-Agent and the
# pre-DB failure reason (no_cookie vs bad_signature), neither of which was
# previously recorded anywhere.
#
# Usage:
#   scripts/auth-walls.sh                      # production container, whole log
#   scripts/auth-walls.sh searchlight-test-api-1  # another container
#   scripts/auth-walls.sh writemap-api-1 30m   # the last 30 minutes
set -euo pipefail

CONTAINER="${1:-writemap-api-1}"
SINCE="${2:-}"

command -v jq >/dev/null || { echo "jq is required" >&2; exit 1; }

if [ -n "$SINCE" ]; then
  LOGS=$(docker logs "$CONTAINER" --since "$SINCE" 2>&1)
else
  LOGS=$(docker logs "$CONTAINER" 2>&1)
fi

# The api image's startup output (pnpm, prisma) is not JSON, so every line is
# parsed defensively.
PARSED=$(printf '%s\n' "$LOGS" | jq -Rc 'fromjson? // empty')

echo "=== 401s by reason ==="
printf '%s\n' "$PARSED" \
  | jq -rc 'select(.authFailure) | .authFailure' \
  | sort | uniq -c | sort -rn
echo

echo "=== 401s by User-Agent ==="
# Join each failure to its own request line via reqId: the reason is logged on a
# separate line from the request metadata, and reqId is the only shared key.
printf '%s\n' "$PARSED" | jq -rs '
  (map(select(.req) | {key: .reqId, value: .req}) | from_entries) as $reqs
  | map(select(.authFailure))
  | map($reqs[.reqId].userAgent // "(unlogged)")
  | group_by(.) | map({ua: .[0], n: length}) | sort_by(-.n)
  | .[] | "\(.n)\t\(.ua)"
'
echo

echo "=== walls (grouped by client and 3 s window) ==="
printf '%s\n' "$PARSED" | jq -rs '
  (map(select(.req) | {key: .reqId, value: .req}) | from_entries) as $reqs
  | map(select(.authFailure) | . + {r: $reqs[.reqId]})
  | group_by([(.r.remoteAddress // "?"), (.r.userAgent // "?"), ((.time | tonumber) / 3000 | floor)])
  | map({
      size: length,
      reasons: (map(.authFailure) | unique | join(",")),
      client: (.[0].r.remoteAddress // "(unlogged)"),
      ua: (.[0].r.userAgent // "(unlogged)"),
      urls: (map(.r.url) | unique | join(" ")),
      t: (.[0].time)
    })
  | sort_by(.t)
  | .[]
  | "\(.t | tonumber / 1000 | strftime("%H:%M:%S"))  size=\(.size)  \(.reasons)  client=\(.client)\n    ua=\(.ua)\n    urls=\(.urls)\n"
'
