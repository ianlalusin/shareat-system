# Self-hosted GitHub Actions runner on Ian's PC

> ## ⭐ Current setup — 2026-10-25 (read this first)
>
> ⛔ **ROLLED BACK 2026-10-25: `CI_RUNNER` is UNSET — CI runs on GitHub-hosted runners.** The desktop's
> first full run (main, run 40170053417) took **2 h 46 min** against ~23 min hosted: integration tests
> alone ran 2 h 39 min and 5 timed out (backup/restore drill, scratch-DB migration tests), so the
> deploy was skipped. Unit tests and typecheck were fine (~5 min). Do not set `CI_RUNNER` again until
> the desktop is fixed and a full run passes in reasonable time.
>
> **Cause and decision:** the desktop's disk is an HDD (spinning disk); the integration suite's constant
> database create/drop is disk-bound. Ian, 2026-10-25: drop the desktop runner (option B); CI stays on
> GitHub-hosted. Revisit only with an SSD fitted (and ideally native Linux), proven by one full run.
>
> | | |
> |---|---|
> | Machine | Spare Dell desktop, i5, 8 GB RAM, Windows, nothing else running on it |
> | Runner | `shareat-desktop`, label `shareat-local`, in WSL distro `shareat-runner` (Ubuntu 24.04), user `shareat` |
> | Linux memory | `.wslconfig`: `memory=5GB`, `swap=4GB`, `vmIdleTimeout=-1` |
> | Kept alive by | Task Scheduler `shareat-runner keepalive` at logon (`wsl -d shareat-runner --exec sleep infinity`). Its black `wsl.exe` window must stay open — **closing it stops Linux and the runner** (that killed the first run on 25 Oct) |
> | Laptop | The old laptop runner (`ians-pc`, distro `shareat-runner` on the laptop) is **unregistered and deleted**; its 13.9 GB disk is gone. Do not recreate it |
>
> **Why (Ian, 2026-10-25):** the laptop had 0.2–0.4 GB free of 15.6 GB. Measured: agents' type checks
> and `npm ci` ≈ 3.5–4 GB at peak, Claude ≈ 3 GB, the idle old runner VM 1.6 GB. After removing the
> old VM: 1.5 GB free; with no heavy checks running: 2.4 GB free.
>
> **What agents on the laptop should do:**
> - Let CI (the desktop) run the **full** integration suite and the full build. Locally, run only the
>   typecheck and the tests your change touches; do not run several full type checks or `npm ci` in
>   parallel worktrees at once.
> - **CI waiting on "Waiting for a runner"?** The desktop is off, asleep, or its `wsl.exe` window was
>   closed. Tell Ian. To fall back at once: `gh variable delete CI_RUNNER` (jobs go to GitHub-hosted
>   runners); set it back with `gh variable set CI_RUNNER --body shareat-local` once
>   `gh api repos/{owner}/{repo}/actions/runners` shows `shareat-desktop online`.
> - **"The self-hosted runner lost communication"** = the desktop's Linux stopped (window closed,
>   sleep, or out of memory). Not a code failure. Re-run once it is back online.
> - The runner does one job at a time, so a PR's jobs queue behind each other.
> - ⚠️ `deploy.yml` also follows `CI_RUNNER`, so **deploys now run on the desktop** and the
>   production SSH key passes through it during a deploy (see below).
>
> The sections below are the original laptop guide (2026-10-11); the steps are the same on the desktop.

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
