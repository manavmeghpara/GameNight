/* Google Gemini (Interactions API) driver.
 *
 * Kept as an alternative to OpenAI — it has a free tier, though the quota is
 * tight enough that a few questions can exhaust it. Select it with
 * LLM_PROVIDER=gemini.
 */

import { describeNetworkError, fetchWithRetry } from '../http.js';

const ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/interactions';
const REQUEST_TIMEOUT_MS = 45000;

/**
 * Looking a fact up needs little reasoning, and thinking tokens dominate both
 * latency and free-tier quota. Allowed values: low, medium, high.
 */
const thinkingLevel = () => process.env.GEMINI_THINKING || 'low';

export const gemini = {
  id: 'gemini',
  label: 'Google AI',
  keyName: 'GEMINI_API_KEY',
  signupUrl: 'https://aistudio.google.com/apikey',

  configured: () => Boolean(process.env.GEMINI_API_KEY),

  /**
   * The lite model gets a noticeably larger free-tier allowance than the full
   * flash model, and one question here costs several calls (one per tool
   * round trip) — enough that the bigger model rate-limits mid-answer. Picking
   * a tool and summarising its result does not need the extra capability.
   */
  model: () => process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite',

  userItem: (text) => ({ type: 'user_input', content: [{ type: 'text', text }] }),

  isTurnStart: (item) => item?.type === 'user_input',

  toolResultItem: (call, data) => ({
    type: 'function_result',
    name: call.name,
    call_id: call.callId,
    result: [{ type: 'text', text: JSON.stringify(data) }],
  }),

  async send({ instructions, tools, input }) {
    let response;
    try {
      response = await fetchWithRetry(
        ENDPOINT,
        {
          method: 'POST',
          headers: {
            'x-goog-api-key': process.env.GEMINI_API_KEY,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model: gemini.model(),
            // Stateless: we send the full history, Google keeps nothing.
            store: false,
            system_instruction: instructions,
            tools,
            generation_config: { thinking_level: thinkingLevel() },
            input,
          }),
        },
        {
          retries: 2,
          timeoutMs: REQUEST_TIMEOUT_MS,
          retryTimeouts: false,
          onRetry: ({ attempt, reason }) =>
            console.warn(`[gemini] retry ${attempt + 1}/2 after ${reason}`),
        },
      );
    } catch (err) {
      throw new Error(describeNetworkError(err, 'Google AI'));
    }

    const body = await response.json().catch(() => null);

    if (!response.ok) {
      throw new Error(explainError(response.status, body?.error?.message ?? body?.message));
    }

    const steps = Array.isArray(body?.steps) ? body.steps : [];
    return {
      // Thought steps carry signatures and must be replayed as received.
      items: steps,
      calls: steps
        .filter((step) => step.type === 'function_call')
        .map((step) => ({ callId: step.id, name: step.name, args: step.arguments ?? {} })),
      text: textFrom(steps),
    };
  },
};

function textFrom(steps) {
  return steps
    .filter((step) => step.type === 'model_output')
    .flatMap((step) => step.content ?? [])
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n')
    .trim();
}

function explainError(status, detail) {
  if (status === 429) {
    // Already retried with backoff by this point, so the quota is genuinely spent.
    return "Google AI's free tier quota is used up for now. It resets on a rolling basis — try again in a minute.";
  }
  if (status === 400 && /API key/i.test(detail ?? '')) {
    return 'Google AI rejected the API key. Check GEMINI_API_KEY.';
  }
  return `Google AI error: ${detail ?? `HTTP ${status}`}`;
}
