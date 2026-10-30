#!/usr/bin/env bash
# T-205 — one-time provisioning for Shareat System's OWN dedicated droplet.
#
# ⚠️ 2026-09-04: Ian decided on a NEW droplet, separate from the old 159.223.78.207 (ERPNext +
# POS archive DB) — that box gets fully retired later, but only once v2 grows its own POS/Customer
# apps and everything is migrated off it; that is a distant, separate task, not T-205. This script
# assumes a fresh Ubuntu droplet with NOTHING else running on it.
#
# ⛔ IAN RUNS THIS. No agent runs it. `IAN-SETUP-CHECKLIST.md` §4b's principle — no standing
# credentials pass through an agent — extends to provisioning production, not just to deploys.
# Idempotent (safe to re-run).
#
# Run as root, once, on the new droplet. This script installs the *.service/*.timer files that
# live BESIDE it in docs/ops/ (step 5 below) — copy the whole directory, not just this file:
#   scp -r docs/ops root@<NEW_DROPLET_IP>:/root/shareat-ops
#   ssh root@<NEW_DROPLET_IP> 'bash /root/shareat-ops/provision.sh [your-domain.example.com]'
#
# The optional domain argument sets up Caddy as a reverse proxy on 80/443 with automatic Let's
# Encrypt TLS (Ian's call — standard ports now that nothing else is on this box). Omit it to
# provision everything except public exposure, and run this again later once DNS is pointed here.
#
# What this does NOT do (deliberately out of scope — T-205's own Scope section):
#   - Does not install Node — assumes Node 22 is available.
#   - Does not touch anything on the OLD droplet — this script never runs there.

set -euo pipefail

DOMAIN="${1:-}"

echo "== T-205 provisioning: shareat user, directories, systemd units =="

# --- 1. The shareat user — key-only SSH auth, no password, owns the app --------------------
# ⚠️ NOT nologin. The deploy workflow runs non-interactive commands via `ssh shareat@host "cmd"`,
# and a nologin shell refuses those exactly like it refuses an interactive login ("This account
# is currently not available") — found the hard way testing the deploy key against a live droplet.
# The actual security boundary is key-only auth + the narrow sudoers rule below, not "no shell".
if ! id -u shareat >/dev/null 2>&1; then
  useradd --system --create-home --home-dir /home/shareat --shell /bin/bash shareat
  echo "created user 'shareat'"
else
  echo "user 'shareat' already exists — skipping"
fi
# Idempotent fix for a droplet provisioned before this correction:
usermod -s /bin/bash shareat

# --- 2. Directories -----------------------------------------------------------------------
mkdir -p /srv/shareat-releases
mkdir -p /srv/shareat-shared/secrets
mkdir -p /var/log/shareat
# T-393: the nightly dump is staged here, not in a small /tmp (BACKUP_TMP_DIR in shareat-db-backup.service).
mkdir -p /var/lib/shareat-backup/tmp
chown -R shareat:shareat /var/lib/shareat-backup
chmod 700 /var/lib/shareat-backup /var/lib/shareat-backup/tmp
chown -R shareat:shareat /srv/shareat-releases /srv/shareat-shared /var/log/shareat
chmod 700 /srv/shareat-shared/secrets
# POS v2 log (shareat-pos.service appends here; runbook section 4). Idempotent.
touch /var/log/shareat/pos.log
chown shareat:shareat /var/log/shareat/pos.log
chmod 640 /var/log/shareat/pos.log

# The deploy's releases/current-symlink swap creates/replaces /srv/shareat itself, which needs
# WRITE on the containing directory (/srv), not on shareat-releases or shareat-shared — found the
# hard way on a live deploy ("ln: failed to create symbolic link '/srv/shareat.new': Permission
# denied"). Group-write only, root keeps ownership — nothing else lives in /srv on this droplet.
chgrp shareat /srv
chmod g+w /srv

if [ ! -f /srv/shareat-shared/.env.local ]; then
  touch /srv/shareat-shared/.env.local
  chown shareat:shareat /srv/shareat-shared/.env.local
  chmod 600 /srv/shareat-shared/.env.local
  echo "created empty /srv/shareat-shared/.env.local — Ian fills this in by hand (T-205 Phase 4)."
  echo "It is NEVER shipped by the deploy workflow and NEVER passes through an agent or chat."
fi

# --- 3. The deploy-only SSH key's authorized_keys -----------------------------------------
mkdir -p /home/shareat/.ssh
chmod 700 /home/shareat/.ssh
touch /home/shareat/.ssh/authorized_keys
chmod 600 /home/shareat/.ssh/authorized_keys
chown -R shareat:shareat /home/shareat/.ssh
echo "Append the deploy key's PUBLIC half to /home/shareat/.ssh/authorized_keys yourself —"
echo "this script does not fetch it or take it as an argument, on purpose."

# --- 4. Narrow, single-command sudo — the deploy user restarts exactly one unit, nothing else -
SUDOERS_FILE=/etc/sudoers.d/shareat-deploy
cat > "$SUDOERS_FILE" <<'EOF'
# T-205 — deploy needs to restart the web process after shipping a release. Nothing else.
shareat ALL=(root) NOPASSWD: /usr/bin/systemctl restart shareat-erp.service
shareat ALL=(root) NOPASSWD: /usr/bin/systemctl restart shareat-pos.service
EOF
chmod 440 "$SUDOERS_FILE"
visudo -cf "$SUDOERS_FILE"

# --- 5. Install the systemd units ----------------------------------------------------------
UNIT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# ⛔ A GLOB, not a list — DEF-231. This was eleven hand-written filenames while THIRTEEN unit files
# shipped, so T-216's recurring-expense-draft pair had been sitting in this directory unarmed, and
# README's promise that re-running this installs a shipped unit was false for it. The same drift
# DEF-194 recorded one task earlier. A list has to be edited by whoever adds a unit; a glob cannot be
# forgotten. ⚠️ shareat-erp.service matches too — the web unit is installed by the same line.
for f in "$UNIT_DIR"/shareat-*.service "$UNIT_DIR"/shareat-*.timer; do
  # An unmatched glob stays literal in sh, so without this a directory with no timers would try to
  # install a path containing '*' — a failure that reads as a missing file rather than as "none".
  [ -e "$f" ] || continue
  install -m 644 "$f" "/etc/systemd/system/$(basename "$f")"
done
systemctl daemon-reload

# --- 5b. PostgreSQL 18 client for the nightly backup (T-393) -------------------------------
# pg_dump refuses a server NEWER than itself and production is PostgreSQL 18.x, so Ubuntu's stock client will
# not do: this adds PGDG's apt repository and installs postgresql-client-18 (the client only, no server).
# Placed AFTER the unit install and NON-FATAL on purpose: a PGDG outage or a key mismatch must never stop the
# units and the Caddy step above/below from being set up. It warns and carries on. Idempotent. Installing the
# client arms nothing: shareat-db-backup.timer is enabled by Ian, later (docs/ops/README.md, "Switching backups on").
install_pg_client() (
  set -euo pipefail
  if [ -x /usr/lib/postgresql/18/bin/pg_dump ]; then
    echo "postgresql-client-18 already installed - skipping"
    return 0
  fi
  apt-get update -y
  apt-get install -y curl ca-certificates gnupg
  install -d /usr/share/postgresql-common/pgdg
  KEY=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc
  curl -fsSL -o "$KEY.tmp" https://www.postgresql.org/media/keys/ACCC4CF8.asc
  # Do not trust a downloaded key blindly: its fingerprint must be PGDG's published one (ACCC4CF8).
  if ! gpg --show-keys --with-colons "$KEY.tmp" | grep -q '^fpr:::::::::B97B0AFCAA1A47F044F244A07FCC7D46ACCC4CF8:'; then
    rm -f "$KEY.tmp"
    echo "PGDG key fingerprint does not match ACCC4CF8 - refusing to trust it" >&2
    return 1
  fi
  mv "$KEY.tmp" "$KEY"
  . /etc/os-release
  echo "deb [signed-by=$KEY] https://apt.postgresql.org/pub/repos/apt ${VERSION_CODENAME}-pgdg main" > /etc/apt/sources.list.d/pgdg.list
  apt-get update -y
  apt-get install -y postgresql-client-18
)
if ! install_pg_client; then
  echo "WARNING: could not install postgresql-client-18 (T-393). The backup cannot run until it is installed; everything else continues." >&2
fi

# --- 6. Reverse proxy — Caddy, only if a domain was given ----------------------------------
if [ -n "$DOMAIN" ]; then
  echo "== Setting up Caddy for $DOMAIN (auto TLS via Let's Encrypt HTTP-01) =="
  if ! command -v caddy >/dev/null 2>&1; then
    apt-get update -y
    apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl gnupg
    curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
      | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
    curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
      > /etc/apt/sources.list.d/caddy-stable.list
    apt-get update -y
    apt-get install -y caddy
  fi
  cat > /etc/caddy/Caddyfile <<EOF
$DOMAIN {
  reverse_proxy 127.0.0.1:9008
}
EOF
  # POS v2 (pos2.shareat.net -> 127.0.0.1:9009), runbook section 3. The block above rewrites the whole
  # Caddyfile on every run and this appends the POS block, so a re-run stays idempotent. Caddy gets its TLS
  # cert only while DNS for pos2.shareat.net points here (it does: 159.223.46.224).
  cat >> /etc/caddy/Caddyfile <<EOF

pos2.shareat.net {
  encode zstd gzip
  request_body {
    max_size 1MB
  }
  reverse_proxy 127.0.0.1:9009
}
EOF
  systemctl reload caddy 2>/dev/null || systemctl restart caddy
  systemctl enable caddy
  echo "Caddy configured for $DOMAIN — requires DNS already pointing an A record at this droplet's IP,"
  echo "or the Let's Encrypt HTTP-01 challenge will fail. Check: journalctl -u caddy -n 50"
else
  echo "== No domain given — skipping Caddy/TLS setup. Re-run with a domain once DNS is ready. =="
fi

echo ""
echo "== Provisioning done. =="
# This block used to be static text printed on every run, including re-runs after a real deploy
# had already happened — misleading on a second invocation (e.g. adding a domain later). Check
# actual state instead.
if [ ! -L /srv/shareat ]; then
  echo "  - /srv/shareat does not exist yet — the first deploy creates it (see deploy.yml)."
  echo "  - No unit is enabled or started yet — nothing to point them at until the first deploy."
fi
if [ ! -s /srv/shareat-shared/.env.local ]; then
  echo "  - /srv/shareat-shared/.env.local is empty — fill it in before the first deploy runs,"
  echo "    or shareat-erp.service will fail closed on startup (bible §7 rule 9) — by design."
  echo "  - FIREBASE_SERVICE_ACCOUNT_KEY_FILE must be an ABSOLUTE path into"
  echo "    /srv/shareat-shared/secrets/ (T-205 blocker 2) — place the key file there first."
fi
if [ -L /srv/shareat ] && [ -s /srv/shareat-shared/.env.local ]; then
  echo "  - A deploy has already landed and .env.local is filled in — nothing further needed here."
  echo "    If the timers aren't enabled yet, run these — the list is DERIVED from the units just"
  echo "    installed, never hand-written (DEF-240):"
  # ⛔ DEF-240. This was a hand-written list of five while SIX timers shipped, so T-216's
  # recurring-expense-draft and T-178's order-wastage-backstop were installed by the glob above and
  # then omitted from the only instruction telling anyone to arm them. Exactly DEF-231's defect,
  # one line further down: the *install* loop was globbed and this list was not, so re-running the
  # script and following its own output still left two timers dead. A list has to be edited by
  # whoever adds a unit; a glob cannot be forgotten.
  # ⚠️ Only `shareat-erp.service` is enabled directly — every other *.service is started by its
  # matching *.timer, so enabling those too would run each job once at boot for no reason.
  echo "      systemctl enable --now shareat-erp.service"
  for f in "$UNIT_DIR"/shareat-*.timer; do
    [ -e "$f" ] || continue
    # T-393: backups are NOT switched on (Ian, bible row 306); see docs/ops/README.md "Switching backups on".
    [ "$(basename "$f")" = shareat-db-backup.timer ] && continue
    [ "$(basename "$f")" = shareat-restore-drill.timer ] && continue
    echo "      systemctl enable --now $(basename "$f")"
  done
  echo "    Then verify each is actually armed — 'systemctl list-timers' — per docs/ops/README.md."
  echo "    ⚠️ 'installed' is not 'armed': this script INSTALLS every unit and enables NONE of them."
fi
