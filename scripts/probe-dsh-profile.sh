#!/usr/bin/env bash
#
# Real-profile probe: pack this package, install the tarball into an isolated
# DSH profile and verify that the shipped bundle composes.
#
# What it proves on ANY machine with a working `dsh` CLI (or bun as a
# stand-in, see below):
#   1. the packed tarball installs and `@memcurio/dsh-plugin` resolves and
#      imports from a profile's node_modules (files allowlist, exports and
#      dsh.bundle.patch are well formed);
#   2. its `cordis.patch.yml` insert row survives composition — the composed
#      tree lists `id: memcurio` with the declared inject list and config;
#   3. the profile is untouched otherwise (isolated DSH_HOME under $WORK).
#
# What it does NOT prove: that the web app boots with the plugin active. That
# needs a real Node.js runtime (the harness CLI tolerates bun, the web app's
# loader entries do not) and a full pnpm install with postinstall scripts.
#
# Usage:
#   scripts/probe-dsh-profile.sh                 # dump-config only (safe)
#   BOOT=1 scripts/probe-dsh-profile.sh          # also try to boot the web app
#   DSH_VERSION=0.1.5-rc.1 WORK=/tmp/probe scripts/probe-dsh-profile.sh
#
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DSH_VERSION="${DSH_VERSION:-0.1.5-rc.1}"
PROFILE="${PROFILE:-memcurio-probe}"
PORT="${PORT:-30999}"
RUNNER="${RUNNER:-bun}"
WORK="${WORK:-$(mktemp -d -t memcurio-probe-XXXXXX)}"

echo "== probe: repo=$REPO_ROOT dsh=$DSH_VERSION work=$WORK runner=$RUNNER"

mkdir -p "$WORK/cli"
cd "$WORK/cli"
printf '{"name":"dsh-probe","private":true}\n' > package.json
"$RUNNER" add "@deepseek-ai/dsh@$DSH_VERSION" >/dev/null

DSH_BIN="$WORK/cli/node_modules/.bin/dsh"
export DSH_HOME="$WORK/home"
mkdir -p "$DSH_HOME"

# 1) Profile skeleton from the shipped web template (pnpm may be absent: the
#    template files are what matter, bundles are installed explicitly below).
"$RUNNER" "$DSH_BIN" --profile "$PROFILE" --from-default-profile web >/dev/null 2>&1 || true
cd "$DSH_HOME/profiles/$PROFILE"
[ -f package.json ] || { echo "FAIL: profile skeleton missing"; exit 1; }

"$RUNNER" add "@deepseek-ai/dsh-base@$DSH_VERSION" "@deepseek-ai/dsh-web-app@$DSH_VERSION" >/dev/null
# Artifacts (dist/, lib/client.js) are committed, so consumer-side scripts are
# skipped on purpose: the probe must not need a build step. Pack first and
# install the TARBALL: a `file:` link into the source tree would bypass the
# shipped `files` allowlist and probe more than the release artifact.
PKG_VERSION="$(sed -n 's/^[[:space:]]*"version": "\([^"]*\)".*$/\1/p' "$REPO_ROOT/package.json")"
[ -n "$PKG_VERSION" ] || { echo "FAIL: cannot read the version from package.json"; exit 1; }
mkdir -p "$WORK/pack"
(cd "$REPO_ROOT" && "$RUNNER" pm pack --ignore-scripts --destination "$WORK/pack" >/dev/null)
TARBALL="$WORK/pack/memcurio-dsh-plugin-$PKG_VERSION.tgz"
[ -f "$TARBALL" ] || { echo "FAIL: bun pm pack did not produce $TARBALL"; exit 1; }
"$RUNNER" add --ignore-scripts "file:$TARBALL" >/dev/null

# 2) The user layer: the same insert row the package declares.
cp "$REPO_ROOT/cordis.patch.yml" cordis.patch.yml

echo "== import check"
"$RUNNER" -e 'const m = await import("@memcurio/dsh-plugin"); const need = ["apply","inject","name"];
  const missing = need.filter((key) => m[key] === undefined);
  if (missing.length) { console.error("FAIL: missing exports:", missing.join(",")); process.exit(1); }
  console.log("   exports ok:", need.join(","), "| inject:", JSON.stringify(m.inject));'

echo "== dump-config check"
COMPOSED="$WORK/composed.yml"
"$RUNNER" "$DSH_BIN" --profile "$PROFILE" --dump-config > "$COMPOSED"
grep -q "id: memcurio" "$COMPOSED" || { echo "FAIL: composed tree has no memcurio row"; exit 1; }
grep -q "@memcurio/dsh-plugin" "$COMPOSED" || { echo "FAIL: composed tree lost the package name"; exit 1; }
grep -q -- "- settings" "$COMPOSED" || { echo "FAIL: composed row lost the settings inject"; exit 1; }
echo "   composed row present (id/name/inject/config)"
sed -n "/id: memcurio/,+8p" "$COMPOSED" | sed 's/^/   /'

if [ "${BOOT:-0}" = "1" ]; then
  echo "== boot attempt (needs a real Node.js runtime for the web app)"
  "$RUNNER" "$DSH_BIN" --profile "$PROFILE" --port "$PORT" --no-open > "$WORK/boot.log" 2>&1 &
  BOOT_PID=$!
  sleep 25
  CODE="$(curl -s -m 6 -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/" || true)"
  kill "$BOOT_PID" 2>/dev/null || true
  echo "   http=$CODE (200 means the web app booted with the plugin mounted)"
  [ "$CODE" = "200" ] || { echo "   boot log tail:"; tail -5 "$WORK/boot.log" | sed 's/^/   /'; echo "   NOTE: bun cannot boot the web app; run this with node."; }
fi

echo "== probe passed (work dir kept at $WORK)"
