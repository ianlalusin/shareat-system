/**
 * T-425 slice T - the 50,000 peso warning and the update-link gating. Acceptance 12, 14 (code half; the runbook half is in the tree guards).
 *
 * CONTRACT for the builder (S5):
 * file `apps/pos/src/lib/outbox/unsentBanner.ts` (pure)
 *   UNSENT_WARNING_THRESHOLD_CENTAVOS = 5_000_000
 *   shouldShowUnsentBanner(unsentTotalCentavos: number): boolean      - true when >= the threshold (exactly 50,000.00 shows; 49,999.99 does not)
 *   unsentBannerText(unsentTotalCentavos: number): string             - `₱52,340.00 in sales not yet sent. Keep selling. Tell the manager.`
 *   (The banner is shown on every screen from the ledger's unsentTotalCentavos(); selling is never blocked - see ledger.test.ts.)
 * file `apps/pos/src/lib/outbox/updateGate.ts` (pure)
 *   unsentSalesWarningText(unsentCount: number): string   - `Unsent sales: ${n} — do not uninstall, clear data or install a different build until this is 0`
 *   canShowUpdateLink(i: { unsentCount: number; currentVersion: string; latestVersion: string | null }): boolean
 *        - true only when unsentCount === 0 AND latestVersion is a non-empty string different from currentVersion
 *   checkForUpdate(d: { fetch: typeof fetch; apiBase: string; currentVersion: string }): Promise<{ latestVersion: string | null; reachable: boolean }>
 *        - GET `${apiBase}/api/pos2/health`; latestVersion = the body's `version` when the body is `{ok:true,...}`; { latestVersion: null, reachable: false } otherwise
 *          (never throws). The caller combines it with canShowUpdateLink.
 */
import { describe, expect, it, vi } from 'vitest';
import * as banner from '@/lib/outbox/unsentBanner';
import * as gate from '@/lib/outbox/updateGate';

describe('the 50,000 peso banner (Acceptance 12)', () => {
  it('threshold is 5,000,000 centavos', () => {
    expect(banner.UNSENT_WARNING_THRESHOLD_CENTAVOS).toBe(5_000_000);
  });
  it('shows at exactly 50,000.00 unsent and above; does not show at 49,999.99 or below. Mutant: > instead of >=, or pesos vs centavos', () => {
    expect(banner.shouldShowUnsentBanner(5_000_000)).toBe(true);
    expect(banner.shouldShowUnsentBanner(5_000_001)).toBe(true);
    expect(banner.shouldShowUnsentBanner(9_999_999)).toBe(true);
    expect(banner.shouldShowUnsentBanner(4_999_999)).toBe(false);
    expect(banner.shouldShowUnsentBanner(0)).toBe(false);
    expect(banner.shouldShowUnsentBanner(50_000)).toBe(false); // 500.00 pesos is not 50,000
  });
  it('the words are the planner\'s, with thousands separators and two decimals', () => {
    expect(banner.unsentBannerText(5_234_000)).toBe('₱52,340.00 in sales not yet sent. Keep selling. Tell the manager.');
    expect(banner.unsentBannerText(5_000_000)).toBe('₱50,000.00 in sales not yet sent. Keep selling. Tell the manager.');
    expect(banner.unsentBannerText(12_345_678)).toBe('₱123,456.78 in sales not yet sent. Keep selling. Tell the manager.');
  });
});

describe('update gating (Ruling 8; Acceptance 14)', () => {
  it('the Settings warning names the count and the three things not to do', () => {
    expect(gate.unsentSalesWarningText(3)).toBe('Unsent sales: 3 — do not uninstall, clear data or install a different build until this is 0');
    expect(gate.unsentSalesWarningText(0)).toContain('Unsent sales: 0');
  });

  it('the update link is hidden while unsent > 0, even when a newer version exists. Mutant: link shown with unsent sales on the tablet', () => {
    expect(gate.canShowUpdateLink({ unsentCount: 1, currentVersion: '1.0.0', latestVersion: '1.1.0' })).toBe(false);
    expect(gate.canShowUpdateLink({ unsentCount: 250, currentVersion: '1.0.0', latestVersion: '1.1.0' })).toBe(false);
  });

  it('shown only at 0 unsent AND a different latest version', () => {
    expect(gate.canShowUpdateLink({ unsentCount: 0, currentVersion: '1.0.0', latestVersion: '1.1.0' })).toBe(true);
    expect(gate.canShowUpdateLink({ unsentCount: 0, currentVersion: '1.1.0', latestVersion: '1.1.0' })).toBe(false);
    expect(gate.canShowUpdateLink({ unsentCount: 0, currentVersion: '1.0.0', latestVersion: null })).toBe(false);
    expect(gate.canShowUpdateLink({ unsentCount: 0, currentVersion: '1.0.0', latestVersion: '' })).toBe(false);
  });

  it('checkForUpdate reads `version` from the health route; an HTML/failed answer is "not reachable" and never throws', async () => {
    const ok = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ ok: true, version: '2.0.0' }) }) as unknown as Response);
    await expect(gate.checkForUpdate({ fetch: ok as any, apiBase: 'https://pos.example.test', currentVersion: '1.0.0' })).resolves.toEqual({ latestVersion: '2.0.0', reachable: true });
    expect(String((ok.mock.calls[0] as any[])[0])).toBe('https://pos.example.test/api/pos2/health');
    const html = async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('x'); } }) as unknown as Response;
    await expect(gate.checkForUpdate({ fetch: html as any, apiBase: '', currentVersion: '1.0.0' })).resolves.toEqual({ latestVersion: null, reachable: false });
    const boom = async () => { throw new TypeError('Failed to fetch'); };
    await expect(gate.checkForUpdate({ fetch: boom as any, apiBase: '', currentVersion: '1.0.0' })).resolves.toEqual({ latestVersion: null, reachable: false });
  });
});
