'use server';

/**
 * Server action for the Ask ERP side panel. T-641 (docs/tasks/641-ask-erp.md).
 *
 * ⛔ No rule lives here. `askErp` authorizes the asker FIRST (`use_ask_erp`), checks the question, and reads every record through its own capability, as the person asking.
 * This returns DATA, not a redirect: a chat reply is not a page change, so nothing typed goes into an address and no flash is set. A refusal or a failure comes back as one
 * sentence in `error`, never an exception to the browser.
 */
import { askErp, type AskSource, type TxRunner } from '@shareat/domain';
import { requireActor } from '../../lib/session';
import { errorMessage } from '../../lib/constraint-messages';
import { withOrgPrincipal } from '../expenses/lib';

export type AskReply = { ok: true; answer: string; sources: AskSource[]; warning: string | null } | { ok: false; error: string };

export async function askErpAction(question: string, history: { role: 'user' | 'assistant'; content: string }[]): Promise<AskReply> {
  const actor = await requireActor('/');
  const run: TxRunner = (fn) => withOrgPrincipal(actor.orgId, fn);
  try {
    // the client's history is untrusted text: the domain keeps only well-formed turns, the last ten, cut to length
    const turns = Array.isArray(history) ? history : [];
    const r = await askErp(run, actor, { question: typeof question === 'string' ? question : '', history: turns });
    return { ok: true, answer: r.answer, sources: r.sources, warning: r.warning };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}
