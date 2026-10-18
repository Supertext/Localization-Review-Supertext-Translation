#!/usr/bin/env bash
# Checks the production image: starts it twice against a Postgres server (creating its own
# database the first time) and the Supertext stand-in, then checks health, the login redirect,
# a translation through the proxy, a repeat answered from the memory and the logs.
# Needs the image "review-proxy", Node.js 22 and Postgres on 127.0.0.1:5432 (postgres/postgres).
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
PORT=8092
STAND_IN_PORT=8765
PASSWORD="ci-$(head -c 18 /dev/urandom | base64 | tr -d '/+=')"
SECRET="ci-$(head -c 30 /dev/urandom | base64 | tr -d '/+=')"
KEY="ci-key-$(head -c 9 /dev/urandom | base64 | tr -d '/+=')"
PG_URL="${PG_URL:-postgresql://postgres:postgres@127.0.0.1:5432/postgres}"
BASE="http://127.0.0.1:$PORT"

PORT=$STAND_IN_PORT STAND_IN_SAMPLES="$here/fixtures" node "$here/stand-in/stand-in.mjs" >/dev/null 2>&1 &
stand_in=$!
trap 'kill $stand_in 2>/dev/null || true' EXIT

start() {
  docker rm -f review-proxy >/dev/null 2>&1 || true
  docker run -d --name review-proxy --network host \
    -e PORT=$PORT -e DATABASE_URL="$PG_URL" -e REVIEW_DB_NAME=review_ci \
    -e REVIEW_ADMIN_PASSWORD="$PASSWORD" -e REVIEW_LINK_SECRET="$SECRET" \
    -e SUPERTEXT_API_URL="http://127.0.0.1:$STAND_IN_PORT/v1/" \
    review-proxy >/dev/null
  for _ in $(seq 1 60); do
    if curl -fsS "$BASE/health" >/dev/null 2>&1; then return 0; fi
    sleep 1
  done
  echo "the proxy did not become healthy"; return 1
}

doc="$(mktemp)"
printf '<!DOCTYPE html>\n<html><head><meta charset="utf-8"></head><body>\n<div data-st-id="0">Welcome to our shop</div>\n</body></html>\n' > "$doc"

# Uploads the document, polls until done and prints the translated document.
translate() {
  local id status
  id=$(curl -fsS -H "Authorization: Supertext-Auth-Key $KEY" -F target_lang=de-CH -F source_lang=en \
    -F "file=@$doc;type=text/html" "$BASE/v1/translate/ai/file" | sed -E 's/.*"file_id":"([0-9a-f]+)".*/\1/')
  for _ in $(seq 1 10); do
    status=$(curl -fsS -H "Authorization: Supertext-Auth-Key $KEY" "$BASE/v1/translate/ai/file/$id/status")
    [[ "$status" == *'"done"'* ]] && break
    sleep 1
  done
  curl -fsS -H "Authorization: Supertext-Auth-Key $KEY" "$BASE/v1/translate/ai/file/$id/translation"
  curl -fsS -X DELETE -H "Authorization: Supertext-Auth-Key $KEY" "$BASE/v1/translate/ai/file/$id" >/dev/null
}

submitted() {
  curl -fsS "http://127.0.0.1:$STAND_IN_PORT/__stand-in/stats" | sed -E 's/.*"submitted":([0-9]+).*/\1/'
}

start
code=$(curl -s -o /dev/null -w '%{http_code} %{redirect_url}' "$BASE/")
[[ "$code" == "307 $BASE/login" ]] || { echo "expected a redirect to /login, got: $code"; exit 1; }
curl -fsS "$BASE/login" | grep -q 'name="password"' || { echo "login page has no password field"; exit 1; }

out=$(translate)
grep -qF 'Willkommen in unserem Shop' <<< "$out" || { echo "translation missing: $out"; exit 1; }
[[ "$(submitted)" == 1 ]] || { echo "expected 1 upload to Supertext"; exit 1; }

# Second start: migrations are a no-op, the memory is still there and answers the repeat.
start
out=$(translate)
grep -qF 'Willkommen in unserem Shop' <<< "$out" || { echo "translation from the memory missing: $out"; exit 1; }
[[ "$(submitted)" == 1 ]] || { echo "the repeat went to Supertext again"; exit 1; }
logs=$(docker logs review-proxy 2>&1)
grep -qF 'migrate: database is up to date' <<< "$logs" || { echo "no migration message in the log"; exit 1; }
for secret in "$PASSWORD" "$SECRET" "$KEY"; do
  if grep -qF "$secret" <<< "$logs"; then echo "a secret appears in the log"; exit 1; fi
done

echo "image check passed"
