#!/usr/bin/env bash
# Copies the test dependencies from Supertext-API-SDK-and-Guide into test/:
#   test/stand-in/stand-in.mjs   the stand-in for the Supertext API
#   test/spec/languages.json     the language list it reads
#   test/sdk/                    the TypeScript SDK's sources (the client the plugins use)
# Usage: scripts/vendor-test-deps.sh [commit-or-branch]   (default main)
#        SDK_DIR=/path/to/clone scripts/vendor-test-deps.sh   uses a local clone as it is
# Never edit the copies: fix the SDK repo and run this again.
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
ref="${1:-main}"
if [ -n "${SDK_DIR:-}" ]; then
  src="$SDK_DIR"
else
  src="$(mktemp -d)"
  trap 'rm -rf "$src"' EXIT
  git clone --quiet https://github.com/Supertext/Supertext-API-SDK-and-Guide "$src"
  git -C "$src" checkout --quiet "$ref"
fi
commit="$(git -C "$src" rev-parse --short HEAD)"
rm -rf "$here/test/stand-in" "$here/test/spec" "$here/test/sdk"
mkdir -p "$here/test/stand-in" "$here/test/spec" "$here/test/sdk"
cp "$src/stand-in/stand-in.mjs" "$here/test/stand-in/"
cp "$src/spec/languages.json" "$here/test/spec/"
cp -r "$src/sdk/typescript/src/." "$here/test/sdk/"
cp "$src/LICENSE" "$here/test/sdk/LICENSE"
for d in stand-in sdk; do
  echo "$commit" > "$here/test/$d/COMMIT"
done
cat > "$here/test/sdk/README.md" <<MD
# Bundled copy of the Supertext TypeScript SDK (tests only, don't edit)

From [Supertext-API-SDK-and-Guide](https://github.com/Supertext/Supertext-API-SDK-and-Guide) \`sdk/typescript/src\`, commit \`$commit\` (see \`COMMIT\`). The integration tests drive the proxy with the same client the plugins use. Update with \`scripts/vendor-test-deps.sh [ref]\`.
MD
echo "Vendored stand-in, languages and SDK at $commit"
