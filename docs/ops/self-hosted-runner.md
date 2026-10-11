# Self-hosted GitHub Actions runner on Ian's PC

**Why:** Ian, 2026-10-11 — *"set up the self-hosted runner if this will lower the actions on my
account in github."* Jobs on a self-hosted runner do not use GitHub-hosted runner minutes. (GitHub
announced a small per-minute platform fee for self-hosted runners on private repos in December 2025
and then paused it; even if it returns, it is a fraction of the hosted rate.)

**What moves:** every job in `.github/workflows/ci.yml` (the `changes` check and the full
`verify` job: typecheck, unit, Postgres integration, build) and `.github/workflows/deploy.yml`.
Building on this PC still satisfies bible §2.10: the droplet only ever receives a finished artifact.

**The switch is one repository variable, `CI_RUNNER`.** Every job reads
`runs-on: ${{ vars.CI_RUNNER || 'ubuntu-latest' }}`.

| `CI_RUNNER` | Jobs run on |
|---|---|
| unset or empty | GitHub-hosted `ubuntu-latest` (today's behaviour) |
| `shareat-local` | this PC's runner |

Set it **only after** the runner shows as *Idle* in GitHub. Delete it to roll back instantly.

---

## ⚠️ Read before switching

- **The PC must be on.** While it is off or asleep, PR checks and deploys wait in the queue
  (GitHub cancels a queued job after 24 hours). A push to `main` deploys only once the runner picks it up.
- **One job at a time.** A single runner runs jobs one after another. That is fine for this repo's
  volume; add a second runner with the same label if the queue ever backs up.
- **Port 5435.** CI starts its own Postgres container on port 5435 *inside the runner's Linux*.
  Your dev Postgres (also 5435, bible §2.11) must therefore **not** run in the same WSL distro or
  the same Docker engine. Use a dedicated distro for the runner, as below.
- **Production secrets pass through this PC** during a deploy (`DEPLOY_SSH_KEY`). The deploy job
  deletes the key and the artifact at the end, pass or fail. Keep the runner under its own Linux
  user, and do not use this distro for anything else.
- **The repo is private**, which is what makes this safe: a self-hosted runner executes whatever
  a PR's code says, so it must never serve a public repo.

## 1. A dedicated Linux for the runner (Windows, WSL2)

In PowerShell **as Administrator**:

```powershell
wsl --install -d Ubuntu-24.04 --name shareat-runner
```

(If your WSL is older and rejects `--name`, install Ubuntu-24.04, then
`wsl --export Ubuntu-24.04 runner.tar` and `wsl --import shareat-runner C:\wsl\shareat-runner runner.tar`.)

Keep WSL from shutting the distro down when no terminal is open. Create or edit
`C:\Users\ianla\.wslconfig`:

```ini
[wsl2]
vmIdleTimeout=-1
```

Inside the distro (`wsl -d shareat-runner`), turn on systemd so the runner can be a service:

```bash
printf '[boot]\nsystemd=true\n' | sudo tee /etc/wsl.conf
```

Then in PowerShell: `wsl --shutdown`, and open the distro again.

## 2. Docker and tools (inside `shareat-runner`)

CI's Postgres runs as a service container, which needs Docker Engine inside this distro. Use
Docker Engine here, **not** Docker Desktop: Desktop shares one engine and its ports with Windows and
every distro, which is exactly the port-5435 clash above.

```bash
sudo apt-get update && sudo apt-get install -y curl git openssh-client tar ca-certificates
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker "$USER"
newgrp docker
docker run --rm hello-world   # must print "Hello from Docker!"
```

## 3. Register the runner

1. GitHub → `ianlalusin/shareat-system` → **Settings → Actions → Runners → New self-hosted runner**.
2. Choose **Linux**, **x64**. GitHub shows download and configure commands with a one-time token.
   Run the download commands inside `shareat-runner`, in `~/actions-runner`.
3. Run the configure command with these extra flags:

   ```bash
   ./config.sh --url https://github.com/ianlalusin/shareat-system --token <TOKEN-FROM-GITHUB> \
     --name ians-pc --labels shareat-local --unattended
   ```

   The token is shown only on that GitHub page and expires within an hour. Never paste it into a
   chat or commit it.
4. Install and start it as a service, so it survives reboots:

   ```bash
   sudo ./svc.sh install "$USER"
   sudo ./svc.sh start
   sudo ./svc.sh status   # active (running)
   ```

5. Back on the Runners page, `ians-pc` should show **Idle** with the label `shareat-local`.

## 4. Start the distro at Windows logon

`vmIdleTimeout=-1` keeps WSL up once it has started; something still has to start it after a reboot.
Task Scheduler → **Create Task**: trigger *At log on*; action program `wsl.exe`, arguments
`-d shareat-runner --exec /bin/true`; check *Run with highest privileges*. systemd then starts the
runner service by itself.

## 5. Flip the switch

GitHub → **Settings → Secrets and variables → Actions → Variables → New repository variable**:
name `CI_RUNNER`, value `shareat-local`.

Check it: open any PR (or re-run the latest CI run). The job page shows *Runner: ians-pc*. The
first run is slower while npm and Docker caches fill; later runs are usually faster than hosted.

## Caches on the runner

T-399. Two caches live on the runner's own disk, so jobs do not pull them over the slow link:

- **npm:** `~/.npm`. `setup-node` skips GitHub's cache service when `CI_RUNNER` is set.
- **Next build (CI only):** `~/.cache/shareat/next-ci`, saved after a green `Build` and restored before the next one.

Clear both with `rm -rf ~/.cache/shareat/next-ci ~/.npm`. The next job is slower, never broken.

Deploy builds are never cached, deliberately: the production artifact comes from a cold build, so a stale
CI cache can never reach production. `deploy.yml` also leaves `apps/erp/.next/cache` out of the artifact.

## Rollback

Delete the `CI_RUNNER` variable. The next job runs on GitHub-hosted runners again. Nothing else
changes. To remove the runner itself: `sudo ./svc.sh stop && sudo ./svc.sh uninstall`, then
`./config.sh remove --token <removal token from the Runners page>`.

## Troubleshooting

| Symptom | Cause |
|---|---|
| Jobs sit at *Waiting for a runner* | PC off or asleep, distro stopped, or the service is not running (`sudo ./svc.sh status`) |
| `Container operations are only supported on Linux runners` / Docker errors | Docker Engine not installed in this distro, or the runner user is not in the `docker` group |
| Integration tests fail to connect, or `port is already allocated` | Something else holds 5435 in this distro. Move dev Postgres out of it |
| `ssh-keyscan` or `scp` not found in deploy | `openssh-client` missing (step 2) |
