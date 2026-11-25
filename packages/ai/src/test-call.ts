/**
 * T-640 - the "Test" call an admin presses before a model may be used: a tiny prompt and one tool call. It proves the key works, the model
 * name is real, and says whether the model can call a tool (`toolCalling` comes from this reply, not from a table anyone typed).
 */
import type { ChatRequest, ChatResult } from './types';

export const TEST_TOOL_NAME = 'ping';

export function testRequest(model: string): ChatRequest {
  return {
    model,
    system: 'You are being tested. Be brief.',
    messages: [{ role: 'user', content: `Call the tool "${TEST_TOOL_NAME}" with value "ok". If you cannot call tools, just reply with the word ok.` }],
    tools: [
      {
        name: TEST_TOOL_NAME,
        description: 'Reports that the test worked.',
        parameters: { type: 'object', properties: { value: { type: 'string', description: 'The word ok' } }, required: ['value'] },
      },
    ],
    maxOutputTokens: 256,
    timeoutMs: 20_000,
  };
}

/** A reply passes when the model answered with something: words or a tool call. Whether it called the tool is what `toolCalling` records. */
export function judgeTestReply(r: ChatResult): { passed: boolean; toolCalling: boolean } {
  const toolCalling = r.toolCalls.some((c) => c.name === TEST_TOOL_NAME);
  return { passed: toolCalling || r.text.trim().length > 0, toolCalling };
}
