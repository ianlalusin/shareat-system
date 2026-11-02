/**
 * T-455 S9a items 2, 4, 5, 6 -- the files that put the customer lobby on the production host: Caddy block, nightly purge unit + timer + script, the
 * customer unit, deploy.yml's customer blocks (executed with bash against a temp dir, like deploy-pos-failed-build.test.ts) and the runbook.
 * docs/tasks/455-customer-lobby.md "S9 rulings". No database, no network, never touches a host.
 *
 * MUTANT INDEX: Caddy block without header_up X-Real-IP / pointing at the wrong port / still saying nginx; customer unit on a public interface, as root, without
 * MemoryMax, without EnvironmentFile, building on the box; the timer at the wrong hour or not Persistent; the script exiting 0 after a failure; the customer build
 * able to fail the ERP deploy; packaging on .next instead of the marker; a restart before the unit exists; the demo flag in the deploy build; a runbook with a real
 * secret, a missing step, or an nginx mention; sudoers without the customer restart.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(__dirname, '..', '..');
const rd = (...p: string[]) => readFileSync(path.join(root, ...p), 'utf8').replace(/\r\n/g, '\n');
const directives = (text: string) => text.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#') && !l.startsWith(';'));
const deploy = rd('.github', 'workflows', 'deploy.yml');
const p = (s: string) => s.split(path.sep).join('/');

describe('S9a-2 Caddy sets the client address', () => {
  const prov = rd('docs', 'ops', 'provision.sh');
  const block = () => {
    const at = prov.indexOf('order.shareat.net {');
    expect(at, 'an order.shareat.net block').toBeGreaterThan(0);
    return prov.slice(at, prov.indexOf('\nEOF', at));
  };

  it('C1 order.shareat.net proxies to 127.0.0.1:9010 and OVERWRITES X-Real-IP with the real peer address, and caps the body [kills: no header_up; X-Forwarded-For used; wrong port; an unbounded body]', () => {
    const b = block();
    expect(b).toMatch(/reverse_proxy 127\.0\.0\.1:9010 \{\s*header_up X-Real-IP \{remote_host\}\s*\}/);
    expect(b).toMatch(/max_size\s+\S+/);
    expect(b).not.toMatch(/X-Forwarded-For/i);
  });

  it('C2 the existing ERP and POS blocks are untouched and the lobby block is appended, not a rewrite [kills: clobbering pos2 or the ERP domain]', () => {
    expect(prov).toContain('reverse_proxy 127.0.0.1:9008');
    expect(prov).toContain('pos2.shareat.net {');
    expect(prov.indexOf('order.shareat.net {')).toBeGreaterThan(prov.indexOf('pos2.shareat.net {'));
    expect(prov.match(/cat > \/etc\/caddy\/Caddyfile/g)?.length).toBe(1);
  });

  it('C3 the deploy user may restart shareat-customer.service (exact command) beside erp and pos [kills: sudoers without the customer restart; a wildcard]', () => {
    expect(prov).toContain('shareat ALL=(root) NOPASSWD: /usr/bin/systemctl restart shareat-customer.service');
    expect(prov).toContain('shareat ALL=(root) NOPASSWD: /usr/bin/systemctl restart shareat-erp.service');
    expect(prov).not.toMatch(/NOPASSWD:[^\n]*\*/);
  });

  it('C4 no document or source comment still says nginx for the lobby [kills: a stale proxy name that sends the next reader to the wrong file]', () => {
    for (const f of [['docs', 'tasks', '455-customer-lobby.md'], ['apps', 'customer', 'src', 'server', 'lobby', 'secrets.ts'], ['apps', 'customer', 'src', 'server', 'lobby', 'cookie.ts']]) {
      // the S9 ruling's own sentences that EXPLAIN the change ("Caddy, not nginx", "every nginx mention") are allowed
      const stale = rd(...f).split(/\r?\n/).filter((l) => /nginx/i.test(l) && !/not nginx|nginx mention/i.test(l));
      expect(stale, f.join('/')).toEqual([]);
    }
  });
});

describe('S9a-5 the customer unit', () => {
  const unit = rd('docs', 'ops', 'shareat-customer.service');
  const d = directives(unit);

  it('U1 runs apps/customer `npm run start` as shareat on 127.0.0.1:9010, always restarted, in production [kills: root; a public bind; no restart]', () => {
    expect(d).toContain('Type=simple');
    expect(d).toContain('WorkingDirectory=/srv/shareat/apps/customer');
    expect(d).toContain('ExecStart=/usr/bin/npm run start');
    expect(d).toContain('User=shareat');
    expect(d).toContain('Group=shareat');
    expect(d).toContain('Restart=always');
    expect(d).toContain('RestartSec=5');
    expect(d).toContain('Environment=NODE_ENV=production');
    const pkg = JSON.parse(rd('apps', 'customer', 'package.json'));
    expect(pkg.scripts.start).toMatch(/(?:-p|--port)[ =]9010\b/);
    expect(pkg.scripts.start).toMatch(/(?:-H|--hostname)[ =]127\.0\.0\.1/);
  });

  it('U2 reads /srv/shareat-shared/customer.env, is capped at 512M, logs to /var/log/shareat/customer.log [kills: no EnvironmentFile; no memory cap on a 4 GB box]', () => {
    expect(d).toContain('EnvironmentFile=/srv/shareat-shared/customer.env');
    expect(d).toContain('MemoryMax=512M');
    expect(d).toContain('StandardOutput=append:/var/log/shareat/customer.log');
    expect(d).toContain('StandardError=append:/var/log/shareat/customer.log');
  });

  it('U3 never builds on the droplet and does not wait on a local Postgres; never sets the demo flag [kills: a build in ExecStart; NEXT_PUBLIC_LOBBY_DEMO in the unit]', () => {
    for (const l of d.filter((x) => /^ExecStart\w*=/.test(x))) expect(l).not.toMatch(/\bbuild\b|npm\s+ci\b|npm\s+install\b|next\s+build/);
    expect(d.some((l) => /^(After|Requires|Wants|BindsTo)=.*postgres/i.test(l))).toBe(false);
    expect(d.join(' ')).not.toMatch(/LOBBY_DEMO/);
  });

  it('U4 provision.sh creates the log file the unit appends to [kills: a unit whose log path does not exist]', () => {
    expect(rd('docs', 'ops', 'provision.sh')).toMatch(/touch \/var\/log\/shareat\/customer\.log/);
  });
});

describe('S9a-4 the nightly purge: script, service, timer', () => {
  const svc = directives(rd('docs', 'ops', 'shareat-lobby-nightly.service'));
  const timer = directives(rd('docs', 'ops', 'shareat-lobby-nightly.timer'));

  it('N1 the service is a oneshot `npm run lobby-nightly` as shareat in production, and the npm script exists [kills: a missing package script; root]', () => {
    expect(svc).toContain('Type=oneshot');
    expect(svc).toContain('ExecStart=/usr/bin/npm run lobby-nightly');
    expect(svc).toContain('User=shareat');
    expect(svc).toContain('Environment=NODE_ENV=production');
    expect(svc.some((l) => /^ExecStart=.*\bbuild\b/.test(l))).toBe(false);
    expect(JSON.parse(rd('package.json')).scripts['lobby-nightly']).toBe('tsx scripts/lobby-nightly.ts');
  });

  it('N2 the timer fires at 05:30 Asia/Manila (after the 05:00 day roll), Persistent [kills: wrong hour; no catch-up after an outage]', () => {
    expect(timer).toContain('OnCalendar=*-*-* 05:30:00 Asia/Manila');
    expect(timer).toContain('Persistent=true');
    expect(timer).toContain('WantedBy=timers.target');
  });

  it('N3 the script runs the job, prints counts per org, exits non-zero on any failure, and closes the database [kills: exit 0 after a failure; no summary]', () => {
    const s = rd('scripts', 'lobby-nightly.ts');
    expect(s).toMatch(/runLobbyNightlyJob/);
    expect(s).toMatch(/hadFailures/);
    expect(s).toMatch(/return 1/);
    expect(s).toMatch(/closeDb\(\)/);
    expect(s).not.toMatch(/console\.\w+\([^)]*(displayName|display_name|holderName|idNumber)/);
  });

  it('N4 the scheduler-job-hosting guard knows lobby-nightly as a named platform job with a T- reason, and customer as a non-job service [kills: an unexplained unit pair]', () => {
    const g = rd('tests', 'unit', 'scheduler-job-hosting.test.ts');
    expect(g).toMatch(/'lobby-nightly':\s*\n?\s*'T-455/);
    expect(g).toMatch(/NAMED_NON_JOB_SERVICE = \['erp', 'pos', 'customer'\]/);
  });
});

describe('S9a-5 deploy.yml ships the customer app without ever blocking the ERP deploy', () => {
  /** The `# >>> Customer lobby` block whose opening line contains `needle`, markers excluded, dedented. */
  function block(needle: string): string {
    const lines = deploy.split('\n');
    const s = lines.findIndex((l) => l.includes('# >>> Customer lobby') && l.includes(needle));
    expect(s, `Customer lobby block "${needle}"`).toBeGreaterThanOrEqual(0);
    const e = lines.findIndex((l, i) => i > s && l.includes('# <<< Customer lobby'));
    const body = lines.slice(s + 1, e);
    const indent = Math.min(...body.filter((l) => l.trim()).map((l) => l.length - l.trimStart().length));
    return body.map((l) => l.slice(indent)).join('\n');
  }

  it('D1 the build step may fail and writes its marker only after a successful build; nothing in the deploy sets the demo flag [kills: a fatal customer build; a marker written before the build; NEXT_PUBLIC_LOBBY_DEMO in the build]', () => {
    expect(deploy).toMatch(/- name: Build customer lobby \(web\)\n\s+continue-on-error: true/);
    expect(deploy).toMatch(/rm -f apps\/customer\/\.customer-build-ok && npm run build -w @shareat\/customer && touch apps\/customer\/\.customer-build-ok/);
    expect(deploy).not.toMatch(/LOBBY_DEMO/);
    for (const f of ['.env', '.env.production', '.env.local', '.env.production.local']) {
      const fp = path.join(root, 'apps', 'customer', f);
      if (existsSync(fp)) expect(readFileSync(fp, 'utf8'), `apps/customer/${f}`).not.toMatch(/LOBBY_DEMO\s*=\s*['"]?1/);
    }
  });

  it('D2 the customer build runs after the ERP build and before the devDependency prune, and packaging is gated on the marker, not on .next [kills: building after the prune; packaging a failed build]', () => {
    expect(deploy.indexOf('- name: Build customer lobby (web)')).toBeGreaterThan(deploy.indexOf('- name: Build\n'));
    expect(deploy.indexOf('- name: Build customer lobby (web)')).toBeLessThan(deploy.indexOf('- name: Prune devDependencies'));
    expect(deploy).toMatch(/if \[ -f apps\/customer\/\.customer-build-ok \]; then/);
    expect(deploy).not.toMatch(/if \[ -d apps\/customer\/\.next \]; then/);
    expect(deploy).toMatch(/PATHS="\$PATHS apps\/customer\/\.next[^"]*apps\/customer\/\.customer-build-ok[^"]*apps\/customer\/package\.json/);
  });

  it('D3 the artifact ships every local file apps/customer/next.config.mjs imports, and the config itself [kills: a config import missing on the box, the 22 Oct POS crash]', () => {
    const cfg = rd('apps', 'customer', 'next.config.mjs');
    const local = [...cfg.matchAll(/from\s+['"]\.\/([^'"]+)['"]/g)].map((m) => m[1]!);
    const pathsLine = deploy.split('\n').find((l) => l.includes('PATHS="$PATHS apps/customer/.next'));
    expect(pathsLine, 'customer PATHS line').toBeDefined();
    const shipped = pathsLine!.match(/apps\/customer\/[^\s"]+/g) ?? [];
    for (const rel of local) expect(shipped).toContain(`apps/customer/${rel.split('/')[0]}`);
    expect(shipped).toContain('apps/customer/next.config.mjs');
  });

  // ---- execute the server-side blocks, as the POS test does ----
  const carry = () => block('carry-forward');
  const restart = () => block('restarts only once');

  function run(o: { newHasMarker: boolean; prev: 'marker' | 'none'; unit: boolean; cpFails?: boolean; restartFails?: boolean }) {
    const dir = mkdtempSync(path.join(tmpdir(), 'deploy-cust-'));
    try {
      const rel = path.join(dir, 'srv', 'shareat-releases', 'new');
      const prev = path.join(dir, 'srv', 'shareat-releases', 'prev');
      mkdirSync(path.join(rel, 'apps', 'erp'), { recursive: true });
      mkdirSync(path.join(prev, 'apps', 'erp'), { recursive: true });
      if (o.newHasMarker) {
        mkdirSync(path.join(rel, 'apps', 'customer', '.next'), { recursive: true });
        writeFileSync(path.join(rel, 'apps', 'customer', '.customer-build-ok'), '');
        writeFileSync(path.join(rel, 'apps', 'customer', '.next', 'id'), 'NEW');
      }
      if (o.prev === 'marker') {
        mkdirSync(path.join(prev, 'apps', 'customer', '.next'), { recursive: true });
        writeFileSync(path.join(prev, 'apps', 'customer', '.customer-build-ok'), '');
        writeFileSync(path.join(prev, 'apps', 'customer', '.next', 'id'), 'PREV');
      }
      spawnSync('bash', ['-c', `ln -s "${p(prev)}" "${p(dir)}/srv/shareat"`]);
      mkdirSync(path.join(dir, 'etc', 'systemd', 'system'), { recursive: true });
      if (o.unit) writeFileSync(path.join(dir, 'etc', 'systemd', 'system', 'shareat-customer.service'), '');
      const swap = (s: string) => s.replace(/\/srv\/shareat/g, `${p(dir)}/srv/shareat`).replace(/\/etc\/systemd/g, `${p(dir)}/etc/systemd`);
      const script = [
        'set -euo pipefail',
        `RELEASE="${p(rel)}"`,
        `sudo() { echo "sudo $*" >> "${p(dir)}/calls.log"; ${o.restartFails ? 'return 1' : 'return 0'}; }`,
        ...(o.cpFails ? ['cp() { return 1; }'] : []),
        swap(carry()),
        'echo ERP_SWAP_REACHED',
        swap(restart()),
        'echo AFTER_RESTART_REACHED',
      ].join('\n');
      const r = spawnSync('bash', ['-c', script], { encoding: 'utf8' });
      const calls = existsSync(path.join(dir, 'calls.log')) ? readFileSync(path.join(dir, 'calls.log'), 'utf8') : '';
      const idFile = path.join(rel, 'apps', 'customer', '.next', 'id');
      return {
        status: r.status, out: `${r.stdout}${r.stderr}`,
        restarted: /systemctl restart shareat-customer\.service/.test(calls),
        reached: r.stdout.includes('ERP_SWAP_REACHED') && r.stdout.includes('AFTER_RESTART_REACHED'),
        partial: existsSync(path.join(rel, 'apps', 'customer')),
        copied: existsSync(idFile) ? readFileSync(idFile, 'utf8') : null,
      };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it('D4 (a) no marker in the new release, a good one before: the previous build is copied in, no restart, a warning [kills: replacing a working lobby with a broken build]', () => {
    const r = run({ newHasMarker: false, prev: 'marker', unit: true });
    expect(r.status, r.out).toBe(0);
    expect(r.copied).toBe('PREV');
    expect(r.restarted).toBe(false);
    expect(r.out).toContain('::warning::');
  });

  it('D5 (b) a good new build: nothing copied over it; restarted only because its unit exists [kills: a carry-forward that overwrites a good build; no restart]', () => {
    const r = run({ newHasMarker: true, prev: 'marker', unit: true });
    expect(r.status, r.out).toBe(0);
    expect(r.copied).toBe('NEW');
    expect(r.restarted).toBe(true);
  });

  it('D6 (c) a good new build but the unit is not installed yet: shipped, not started, no error [kills: restarting a unit that is not there; a failed deploy before Ian installs it]', () => {
    const r = run({ newHasMarker: true, prev: 'none', unit: false });
    expect(r.status, r.out).toBe(0);
    expect(r.restarted).toBe(false);
    expect(r.reached).toBe(true);
  });

  it('D7 (d) neither release has a customer build: nothing copied, no restart, reason printed, deploy continues [kills: a fatal missing carry-forward]', () => {
    const r = run({ newHasMarker: false, prev: 'none', unit: true });
    expect(r.status, r.out).toBe(0);
    expect(r.copied).toBeNull();
    expect(r.restarted).toBe(false);
    expect(r.out).toMatch(/customer/i);
  });

  it('D8 (e) the carry-forward copy fails: warning, no partial copy left, the deploy continues, no restart [kills: a half-copied lobby; set -e aborting the ERP swap]', () => {
    const r = run({ newHasMarker: false, prev: 'marker', unit: true, cpFails: true });
    expect(r.status, r.out).toBe(0);
    expect(r.reached).toBe(true);
    expect(r.partial).toBe(false);
    expect(r.restarted).toBe(false);
    expect(r.out).toContain('::warning::');
  });

  it('D9 (f) the restart itself fails: said on stderr, the deploy still reaches the end [kills: a customer restart failure stopping the ERP deploy]', () => {
    const r = run({ newHasMarker: true, prev: 'none', unit: true, restartFails: true });
    expect(r.status, r.out).toBe(0);
    expect(r.reached).toBe(true);
    expect(r.out).toMatch(/restart failed/i);
  });

  it('D10 the health check hits http://127.0.0.1:9010/lobby, tries 6 times, is skipped when the unit is not installed, and comes after the ERP and POS checks [kills: the wrong URL; a customer failure hiding a healthy ERP]', () => {
    const at = deploy.indexOf('- name: Confirm customer lobby is up');
    expect(at).toBeGreaterThan(deploy.indexOf('- name: Confirm POS v2 is up'));
    const next = deploy.indexOf('\n      - name:', at + 10);
    const step = deploy.slice(at, next > 0 ? next : undefined);
    expect(step).toContain('http://127.0.0.1:9010/lobby');
    expect(step).toMatch(/for i in 1 2 3 4 5 6; do/);
    expect(step).toContain('/etc/systemd/system/shareat-customer.service');
    expect(step).toMatch(/not installed yet/);
  });

  it('D12 the release the running customer app lives in survives the keep-last-3 cleanup: good A, then three deploys whose customer build failed; A stays and .customer-running still names A [kills: no retention block; the running release deleted under next start]', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'deploy-cust-ret-'));
    try {
      const rels = path.join(dir, 'srv', 'shareat-releases');
      mkdirSync(rels, { recursive: true });
      mkdirSync(path.join(dir, 'etc', 'systemd', 'system'), { recursive: true });
      writeFileSync(path.join(dir, 'etc', 'systemd', 'system', 'shareat-customer.service'), '');
      const cleanup = deploy.split('\n').find((l) => l.includes('tail -n +4 | xargs -r rm -rf'))!.trim();
      const swap = (s: string) => s.replace(/\/srv\/shareat/g, `${p(dir)}/srv/shareat`).replace(/\/etc\/systemd/g, `${p(dir)}/etc/systemd`);
      let t = 100000;
      const deployRelease = (name: string, builds: boolean) => {
        const rel = path.join(rels, name);
        mkdirSync(path.join(rel, 'apps', 'erp'), { recursive: true });
        if (builds) {
          mkdirSync(path.join(rel, 'apps', 'customer', '.next'), { recursive: true });
          writeFileSync(path.join(rel, 'apps', 'customer', '.customer-build-ok'), '');
        }
        t += 100;
        const base = Math.floor(Date.now() / 1000) - 200000 + t;
        spawnSync('bash', ['-c', `touch -d @${base} "${p(rel)}"`]);
        const script = [
          'set -euo pipefail',
          `RELEASE="${p(rel)}"`,
          'sudo() { return 0; }',
          `readlink() { cat "${p(dir)}/current.txt" 2>/dev/null; }`,
          `touch() { shift; command touch -d @${base + 50} "$@"; }`,
          swap(carry()),
          `echo "$RELEASE" > "${p(dir)}/current.txt"`,
          swap(restart()),
          swap(block('retention')),
          swap(cleanup),
        ].join('\n');
        return spawnSync('bash', ['-c', script], { encoding: 'utf8' });
      };
      expect(deployRelease('A', true).status).toBe(0);
      for (const n of ['B', 'C', 'D']) {
        const r = deployRelease(n, false);
        expect(r.status, `${r.stdout}${r.stderr}`).toBe(0);
      }
      expect(existsSync(path.join(rels, 'A')), 'the running release must survive').toBe(true);
      expect(readFileSync(path.join(rels, '.customer-running'), 'utf8').trim()).toBe(p(path.join(rels, 'A')));
      expect(existsSync(path.join(rels, 'D')) && existsSync(path.join(rels, 'C'))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('D11 the customer blocks are balanced [kills: a stray marker that breaks the ERP-bytes pin]', () => {
    const opens = deploy.match(/# >>> Customer lobby/g)?.length ?? 0;
    expect(opens).toBeGreaterThanOrEqual(4);
    expect(deploy.match(/# <<< Customer lobby/g)?.length).toBe(opens);
  });
});

describe('S9a-6 the runbook', () => {
  const rb = rd('docs', 'ops', 'customer-lobby-runbook.md');

  it('B1 it has every step the ruling lists, each with its command, in the ruling\'s order [kills: a missing step; the Caddy block before the unit]', () => {
    for (const needle of [
      'order.shareat.net',
      'nslookup order.shareat.net',
      'openssl rand -base64 48',
      '/srv/shareat-shared/customer.env',
      'LOBBY_HASH_SECRET',
      'LOBBY_ORG_ID',
      'DATABASE_URL',
      'SESSION_SECRET',
      'FIREBASE_PROJECT_ID',
      'FIREBASE_SERVICE_ACCOUNT_KEY_FILE',
      'chmod 600 "$f"',
      'shareat-customer.service',
      'systemctl daemon-reload',
      'caddy validate',
      'systemctl reload caddy',
      'systemctl enable --now shareat-lobby-nightly.timer',
      'systemctl list-timers',
      'insert into lobby_stores',
      'systemctl status shareat-customer',
      'curl -s',
      'paused',
      'systemctl stop shareat-customer',
    ]) expect(rb, needle).toContain(needle);
    const at = (s: string) => rb.indexOf(s);
    expect(at('nslookup order.shareat.net')).toBeLessThan(at('openssl rand -base64 48'));
    expect(at('systemctl daemon-reload')).toBeLessThan(at('openssl rand -base64 48')); // the unit files are installed (step 2) before the settings file (step 3)
    expect(at('openssl rand -base64 48')).toBeLessThan(at('caddy validate'));
    expect(at('caddy validate')).toBeLessThan(at('systemctl enable --now shareat-lobby-nightly.timer'));
    expect(at('systemctl enable --now shareat-lobby-nightly.timer')).toBeLessThan(at('insert into lobby_stores'));
  });

  it('B2 it contains no real secret: LOBBY_HASH_SECRET is only ever a placeholder, no connection string with a password, no key material, never nginx or the old droplet [kills: a pasted secret; the wrong host]', () => {
    // The `asql` helper READS SYSTEM_DATABASE_URL in-process (the admin-connection pattern of docs/ops/pos2-switchon-2026-11-01.md 2.3); every OTHER mention must forbid copying it.
    for (const l of rb.split('\n').filter((x) => x.includes('SYSTEM_DATABASE_URL') && !x.trimStart().startsWith('U="$(grep'))) expect(l, 'the admin database login must never be copied into customer.env').toMatch(/never|not|admin connection|the same way/i);
    for (const l of rb.split('\n').filter((x) => x.includes('SYSTEM_DATABASE_URL'))) expect(l, 'no line may write SYSTEM_DATABASE_URL into a file').not.toMatch(/>>|tee /);
    for (const m of rb.matchAll(/(?:LOBBY_HASH_SECRET|SESSION_SECRET)\s*=\s*(\S+)/g)) expect(m[1], 'secret value must be a <placeholder>').toMatch(/^<[^>]+>$|^"?\$\(|^\$\{?[A-Z_]+/);
    expect(rb).not.toMatch(/postgres(ql)?:\/\/[^\s<]*:[^\s<@]+@/);
    expect(rb).not.toMatch(/BEGIN [A-Z ]*PRIVATE KEY|AKIA[0-9A-Z]{12,}/);
    expect(rb).not.toMatch(/[A-Za-z0-9+/]{40,}={0,2}\s*$/m);
    expect(rb).not.toMatch(/nginx/i);
    expect(rb).not.toContain('159.223.78.207');
    expect(rb).toContain('159.223.46.224');
  });

  it('B5 audit rulings: SQL runs as the admin connection and is never echoed; step 2 installs only the S9a files from merged main (no whole-folder copy, no provision.sh run); DNS is "DNS only"; customer.env is never truncated and re-running is safe [kills: SQL as the app login; scp -r docs/ops; provision.sh re-run; a proxied record; a truncating install]', () => {
    expect(rb).toContain('SYSTEM_DATABASE_URL');
    expect(rb).toContain('asql "insert into lobby_stores');
    expect(rb).not.toMatch(/psql|sudo -u shareat sh -c/); // the app login (DATABASE_URL) is not used for the SQL steps
    expect(rb).not.toMatch(/echo "?\$U|echo "?\$DATABASE_URL|printenv/);
    expect(rb).toContain('PR #131');
    expect(rb).toMatch(/origin\/main:docs\/ops\/shareat-customer\.service/);
    expect(rb).toMatch(/origin\/main:docs\/ops\/shareat-lobby-nightly\.timer/);
    expect(rb).not.toMatch(/scp -r docs\/ops|rm -rf \/root\/shareat-ops/);
    expect(rb).not.toMatch(/^bash \/root\/shareat-ops\/provision\.sh/m);
    expect(rb).toMatch(/visudo -cf/);
    expect(rb).toMatch(/DNS only/);
    expect(rb).toMatch(/\[ -e "\$f" \] \|\| install -m 600/); // create only if missing
    expect(rb).not.toMatch(/install -m 600 \/dev\/null \/srv/); // the old unconditional (truncating) form
    expect(rb).toMatch(/logged out/i); // regenerating LOBBY_HASH_SECRET logs every waiting diner out
  });

  it('B3 it says who runs what (Ian runs the SQL insert; nobody seeds company data for him), how to switch it off, and to record the memory reading [kills: an agent-run seed; no off switch]', () => {
    expect(rb).toMatch(/Ian runs/i);
    expect(rb).toMatch(/set paused = true/i);
    expect(rb).toMatch(/memory/i);
    expect(rb).toMatch(/MemoryMax=512M|512 ?M/);
  });

  it('B4 every command sits in a fenced block (balanced fences, at least 16 of them) and the file is LF only [kills: a wall of text; CRLF]', () => {
    const fences = rb.match(/^```/gm)?.length ?? 0;
    expect(fences % 2).toBe(0);
    expect(fences).toBeGreaterThanOrEqual(16);
    expect(readFileSync(path.join(root, 'docs', 'ops', 'customer-lobby-runbook.md'), 'utf8').includes('\r')).toBe(false);
  });
});
