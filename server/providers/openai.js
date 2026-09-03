/* OpenAI Responses API driver.
 *
 * Conversation items are passed in full on every request (no `previous_response_id`),
 * so nothing depends on state held at OpenAI's end.
 */

import { describeNetworkError, fetchWithRetry } from '../http.js';

const ENDPOINT = 'https://api.openai.com/v1/responses';
const REQUEST_TIMEOUT_MS = 60000;

export const openai = {
  id: 'openai',
  label: 'OpenAI',
  keyName: 'OPENAI_API_KEY',
  signupUrl: 'https://platform.openai.com/api-keys',

  configured: () => Boolean(process.env.OPENAI_API_KEY),
  model: () => process.env.OPENAI_MODEL || 'gpt-5.6',

  /** A new question from the user. */
  userItem: (text) => ({ role: 'user', content: text }),

  /** Where one turn begins, for trimming history safely. */
  isTurnStart: (item) => item?.role === 'user',

  /** The result of a tool call, fed back to the model. */
  toolResultItem: (call, data) => ({
    type: 'function_call_output',
    call_id: call.callId,
    output: JSON.stringify(data),
  }),

  async send({ instructions, tools, input }) {
    let response;
    try {
      response = await fetchWithRetry(
        ENDPOINT,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model: openai.model(),
            instructions,
            tools,
            input,
            store: false,
          }),
        },
        {
          retries: 2,
          timeoutMs: REQUEST_TIMEOUT_MS,
          // A slow generation is normal; re-sending it would only pile on.
          retryTimeouts: false,
          onRetry: ({ attempt, reason }) =>
            console.warn(`[openai] retry ${attempt + 1}/2 after ${reason}`),
        },
      );
    } catch (err) {
      throw new Error(describeNetworkError(err, 'OpenAI'));
    }

    const body = await response.json().catch(() => null);

    if (!response.ok) {
      throw new Error(explainError(response.status, body?.error?.message));
    }

    const output = Array.isArray(body?.output) ? body.output : [];
    return {
      // Reasoning and tool-call items must be replayed as received.
      items: output,
      calls: output.filter((item) => item.type === 'function_call').map(toCall),
      text: textFrom(output),
    };
  },
};

function toCall(item) {
  let args = {};
  try {
    // OpenAI sends arguments as a JSON-encoded string, not an object.
    args = item.arguments ? JSON.parse(item.arguments) : {};
  } catch {
    args = {};
  }
  return { callId: item.call_id, name: item.name, args };
}

function textFrom(output) {
  return output
    .filter((item) => item.type === 'message')
    .flatMap((item) => item.content ?? [])
    .filter((block) => block.type === 'output_text')
    .map((block) => block.text)
    .join('\n')
    .trim();
}

function explainError(status, detail) {
  if (status === 401) return 'OpenAI rejected the API key. Check OPENAI_API_KEY.';
  if (status === 429) {
    return /quota|billing/i.test(detail ?? '')
      ? 'Your OpenAI account is out of credit — top it up at platform.openai.com/billing.'
      : 'OpenAI is rate limiting right now — try again in a moment.';
  }
  if (status === 404 && /model/i.test(detail ?? '')) {
    return `OpenAI does not recognise the model "${openai.model()}". Set OPENAI_MODEL to one your account can use.`;
  }
  return `OpenAI error: ${detail ?? `HTTP ${status}`}`;
}
