#!/usr/bin/env bash
# T-472 S3 - copy Ian's read-only POS bridge service-account key to the production droplet. Run from Git Bash on Ian's laptop.
#
#   bash docs/ops/install-pos-bridge-key.sh [path-to-key.json]
#
# Default key path: C:\Users\ianla\shareat-master-data\keys\pos-bridge-reader.json (Git Bash: /c/Users/ianla/...).
# Target: 159.223.46.224 (erp2.shareat.net, the shareat-erp host) at /srv/shareat-shared/secrets/pos-bridge-reader.json,
# owner shareat, mode 600. The key has Cloud Datastore Viewer only.
# The script NEVER prints the key: it prints the project id check and a short SHA-256 prefix from each side to compare.
set -euo pipefail

HOST="${POS_BRIDGE_HOST:-root@159.223.46.224}"
SRC="${1:-/c/Users/ianla/shareat-master-data/keys/pos-bridge-reader.json}"
DEST="/srv/shareat-shared/secrets/pos-bridge-reader.json"
EXPECT_PROJECT="shareat-hub-v2"

[ -f "$SRC" ] || { echo "No key file at $SRC" >&2; exit 1; }

# Check it is a service-account key for the POS project; only the project id is ever read out.
PROJECT="$(node -e 'const k=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));if(k.type!=="service_account"||!k.private_key||!k.client_email)process.exit(2);process.stdout.write(String(k.project_id));' "$SRC")" \
  || { echo "That file is not a service-account key." >&2; exit 1; }
[ "$PROJECT" = "$EXPECT_PROJECT" ] || { echo "The key belongs to project '$PROJECT', expected $EXPECT_PROJECT. Not copied." >&2; exit 1; }

LOCAL_SUM="$(sha256sum "$SRC" | cut -c1-12)"
TMP="/tmp/pos-bridge-reader.$$.json"

scp -q "$SRC" "$HOST:$TMP"
# Owner shareat, mode 600, inside a 700 directory; the temp copy is removed whatever happens.
REMOTE_SUM="$(ssh "$HOST" "set -e; trap 'rm -f $TMP' EXIT; install -d -m 700 -o shareat -g shareat /srv/shareat-shared/secrets; install -o shareat -g shareat -m 600 $TMP $DEST; sha256sum $DEST | cut -c1-12")"

echo "Installed $DEST on ${HOST#*@} (owner shareat, mode 600)."
echo "SHA-256 prefix  laptop: $LOCAL_SUM   droplet: $REMOTE_SUM"
if [ "$LOCAL_SUM" != "$REMOTE_SUM" ]; then echo "THEY DO NOT MATCH - do not enable the timer." >&2; exit 1; fi
echo "They match. Next: docs/ops/pos-receipt-bridge-runbook.md (dry run in December, timer live from 2 Jan)."
