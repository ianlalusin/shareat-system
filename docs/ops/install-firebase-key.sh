#!/usr/bin/env bash
# T-625 S3 - copy Ian's `shareat-system` Firebase admin key to the production droplet. Run from Git Bash on Ian's laptop.
#
#   bash docs/ops/install-firebase-key.sh [path-to-key.json]
#
# Default key path: C:\Users\ianla\webapps\PK\shareat-system\ (Git Bash: /c/Users/ianla/webapps/PK/shareat-system/) - pass the file name as the argument.
# Target: 159.223.46.224 (erp2.shareat.net, the shareat-erp host) at /srv/shareat-shared/secrets/shareat-system-admin.json,
# owner shareat, mode 600. A NEW file name on purpose: the old key file stays where it is, so rollback is "put the old env values back".
# The script NEVER prints the key: it prints the project id check and a short SHA-256 prefix from each side to compare.
# The key is written to a temporary name first and moved into place only when its SHA-256 matches, so a failed run never
# removes or replaces a key that was already installed and good.
set -euo pipefail

HOST="${FIREBASE_KEY_HOST:-root@159.223.46.224}"
SRC="${1:-}"
DEST="/srv/shareat-shared/secrets/shareat-system-admin.json"
TMP="$DEST.new"
EXPECT_PROJECT="shareat-system"

[ -n "$SRC" ] || { echo "Give the key file path: bash docs/ops/install-firebase-key.sh /c/Users/ianla/webapps/PK/shareat-system/<file>.json" >&2; exit 1; }
[ -f "$SRC" ] || { echo "No key file at $SRC" >&2; exit 1; }

# Check it is a service-account key for the new project; only the project id is ever read out.
PROJECT="$(node -e 'const k=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));if(k.type!=="service_account"||!k.private_key||!k.client_email)process.exit(2);process.stdout.write(String(k.project_id));' "$SRC")" \
  || { echo "That file is not a service-account key." >&2; exit 1; }
[ "$PROJECT" = "$EXPECT_PROJECT" ] || { echo "The key belongs to project '$PROJECT', expected $EXPECT_PROJECT. Not copied." >&2; exit 1; }

LOCAL_FULL="$(sha256sum "$SRC" | cut -d' ' -f1)"
LOCAL_SUM="${LOCAL_FULL:0:12}"
# Streamed over ssh on stdin: no scp, no copy in /tmp. umask 077 so nothing is ever group/world-readable. It lands in $TMP (owner
# shareat, mode 600, in a 700 directory); only if the full SHA-256 equals the laptop's is it moved over $DEST in one step. On any
# failure the trap removes $TMP and leaves $DEST exactly as it was.
REMOTE_SUM="$(ssh "$HOST" "umask 077; set -e; trap 'rm -f $TMP' EXIT; install -d -m 700 -o shareat -g shareat /srv/shareat-shared/secrets; install -o shareat -g shareat -m 600 /dev/stdin $TMP; [ \"\$(sha256sum $TMP | cut -d' ' -f1)\" = '$LOCAL_FULL' ] || { echo MISMATCH; exit 3; }; mv -f $TMP $DEST; sha256sum $DEST | cut -c1-12" < "$SRC")" \
  || { echo "The copy failed or did not match. The key already on the server (if any) was NOT touched. Run it again." >&2; exit 1; }

echo "Installed $DEST on ${HOST#*@} (owner shareat, mode 600)."
echo "SHA-256 prefix  laptop: $LOCAL_SUM   droplet: $REMOTE_SUM"
if [ "$LOCAL_SUM" != "$REMOTE_SUM" ]; then echo "THEY DO NOT MATCH - do not edit .env.local." >&2; exit 1; fi
echo "They match. Next: docs/ops/firebase-move-runbook.md, the step that edits /srv/shareat-shared/.env.local."
