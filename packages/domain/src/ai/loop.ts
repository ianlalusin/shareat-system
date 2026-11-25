/**
 * The tool loop. T-641 (docs/tasks/641-ask-erp.md). A model that is given tools answers in rounds: it asks for tools, our code runs them and hands the results back, and it goes on
 * until it answers in words. Every round is ONE `callAi`, so every round has the privacy guard over the WHOLE conversation (the earlier tool results included), the switches, the
 * monthly cap, its own reservation and its own log row. Round 2 onward is logged as `<feature>.step` and is not another question against the person's daily limit.
 *
 * ⛔ The loop runs nothing itself. `runTool` is the feature's own function, and it is that function (not this loop, and not the model) that authorizes and scopes what a tool reads.
 * ⛔ The number of rounds is capped. A model that keeps asking for tools is stopped, told to answer from what it has, and, if it still will not, given a plain sentence.
 * ⚠️ Like `callAi`, this does not authorize the FEATURE: the caller does, before calling (the census in t640-callai-callers.test.ts watches both names).
 */
import type { Actor } from '@shareat/auth';
import type { ChatMessage, ToolCall, ToolDef, ToolResult } from '@shareat/ai';
import { callAi, type AiCallInput, type AiCallOutput } from './call';
import type { HubDeps, TxRunner } from './shared';

/** How many rounds of tool calls one question may take. A technical ceiling, like MAX_OUTPUT_TOKENS: six is more than any question here needs, and a runaway loop must not become a bill. */
export const MAX_TOOL_ROUNDS = 6;
/** The most characters of one tool result sent back to the model. A longer result is cut and says so, so a huge list can neither cost a fortune nor bury the question. */
export const MAX_TOOL_RESULT_CHARS = 12_000;

const OUT_OF_ROUNDS = 'You have used all the tool calls you are allowed for this question. Do not call any tool. Answer now, in words, from what the tools already returned, and say what you could not find.';
const GAVE_UP = 'I could not finish looking that up. Please ask a narrower question, for example one store and one period.';
const TOOL_FAILED = 'That lookup failed and returned nothing. Say you could not get it; do not guess a figure.';

export interface AiLoopInput extends Omit<AiCallInput, 'tools' | 'continuation'> {
  tools: readonly ToolDef[];
  /** Runs one tool and returns the text the model will read. It must turn a refusal into a sentence itself; anything it throws becomes a generic "that lookup failed". */
  runTool: (call: ToolCall) => Promise<string>;
}

export interface AiToolTrace {
  readonly name: string;
  readonly args: Readonly<Record<string, unknown>>;
  /** The text handed to the model (the cut one when it was cut). */
  readonly result: string;
}

export interface AiLoopOutput extends AiCallOutput {
  /** Model calls made for this question (1 = it answered at once). */
  rounds: number;
  /** Every tool call, in order, with the text it returned. */
  trace: readonly AiToolTrace[];
  /** True when the model had to be stopped (too many rounds) and its last words are used as they came. */
  stopped: boolean;
}

function cut(text: string): string {
  return text.length <= MAX_TOOL_RESULT_CHARS ? text : `${text.slice(0, MAX_TOOL_RESULT_CHARS)}\n[The rest was cut: the result was too long. Ask for a narrower period or one store.]`;
}

export async function callAiWithTools(run: TxRunner, actor: Actor, input: AiLoopInput, deps: HubDeps = {}): Promise<AiLoopOutput> {
  const { tools, runTool, ...rest } = input;
  const messages: ChatMessage[] = [...input.messages];
  const trace: AiToolTrace[] = [];
  let tokensIn = 0;
  let tokensOut = 0;
  let costMicroPhp = 0;
  const redactions: Record<string, number> = {};
  let last: AiCallOutput | null = null;
  let stopped = false;
  let rounds = 0;

  for (let round = 1; round <= MAX_TOOL_ROUNDS + 1; round++) {
    rounds = round;
    const outOfRounds = round > MAX_TOOL_ROUNDS;
    const out: AiCallOutput = await callAi(
      run,
      actor,
      {
        ...rest,
        messages,
        tools,
        continuation: round > 1,
        // the round after the last allowed one still lists the tools (a provider refuses a conversation that holds tool turns but names no tools), but is told not to use them
        ...(outOfRounds ? { system: `${rest.system ? `${rest.system}\n\n` : ''}${OUT_OF_ROUNDS}` } : {}),
      },
      deps,
    );
    tokensIn += out.tokensIn;
    tokensOut += out.tokensOut;
    costMicroPhp += out.costMicroPhp;
    for (const [k, n] of Object.entries(out.redactions)) redactions[k] = (redactions[k] ?? 0) + n;
    last = out;
    if (out.toolCalls.length === 0) break;
    if (outOfRounds) {
      stopped = true;
      break;
    }
    const results: ToolResult[] = [];
    for (const call of out.toolCalls) {
      let content: string;
      try {
        content = cut(await runTool(call));
      } catch {
        // never the error's own text: a thrown message could carry anything
        content = TOOL_FAILED;
      }
      trace.push({ name: call.name, args: call.args, result: content });
      results.push({ id: call.id, name: call.name, content });
    }
    messages.push({ role: 'assistant', content: out.text, toolCalls: out.toolCalls }, { role: 'tool', results });
  }

  // `last` is set on the first pass; the loop always runs at least once
  const final = last as AiCallOutput;
  return {
    ...final,
    text: stopped && final.text.trim().length === 0 ? GAVE_UP : final.text,
    tokensIn,
    tokensOut,
    costMicroPhp,
    redactions,
    rounds,
    trace,
    stopped,
  };
}
