'use server';

/**
 * Server action for the Ask ERP side panel. T-641 (docs/tasks/641-ask-erp.md).
 *
 * ⛔ No rule lives here. `askErp` authorizes the asker FIRST (`use_ask_erp`), then asserts the question's field rule (`ASK_ERP_RULES`, 1 to 500 characters), and reads every record
 * through its own capability, as the person asking. The form carries two fields: `question` (the ruled one) and `history` (the last turns as JSON, untrusted text the domain trims).
 * This returns DATA, not a redirect: a chat reply is not a page change, so nothing typed goes into an address and no flash is set. A refusal or a failure comes back as one
 * sentence in `error`, never an exception to the browser.
 */
import { askErp, type AskSource, type AskErpTurn, type TxRunner } from '@shareat/domain';
import { requireActor } from '../../lib/session';
import { errorMessage } from '../../lib/constraint-messages';
import { withOrgPrincipal } from '../expenses/lib';

export type AskReply = { ok: true; answer: string; sources: AskSource[]; warning: string | null } | { ok: false; error: string };

/** The history field: a JSON list of { role, content }. Anything else is no history; the domain keeps only well-formed turns, the last ten, cut to length. */
function turnsOf(raw: FormDataEntryValue | null): AskErpTurn[] {
  if (typeof raw !== 'string' || raw === '') return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as AskErpTurn[]) : [];
  } catch {
    return [];
  }
}

export async function askErpAction(formData: FormData): Promise<AskReply> {
  const actor = await requireActor('/');
  const run: TxRunner = (fn) => withOrgPrincipal(actor.orgId, fn);
  try {
    const question = formData.get('question');
    const r = await askErp(run, actor, { question: typeof question === 'string' ? question : '', history: turnsOf(formData.get('history')) });
    return { ok: true, answer: r.answer, sources: r.sources, warning: r.warning };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}

/**
 * The form's own action (T-440 S2 G3b traces it to the rules check in `askErp`). The panel normally takes a valid submit over on the client and calls
 * `askErpAction` for the reply; this runs only if the browser submits the form itself, and then the answer is simply not shown (the panel needs JavaScript).
 */
export async function askErpFormAction(formData: FormData): Promise<void> {
  await askErpAction(formData);
}
