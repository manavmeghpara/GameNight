/* The movie assistant: an LLM for conversation, TMDB for facts.
 *
 * The provider is swappable (OpenAI or Google AI) because the two APIs shape
 * their conversation items differently; everything else — the tools, the loop,
 * the grounding rules — is shared.
 *
 * The loop: send history -> model asks for a tool -> we call TMDB -> send the
 * result back -> repeat until the model answers in words.
 */

import { runTool, tmdbConfigured, TOOL_DECLARATIONS } from './tmdb.js';
import { openai } from './providers/openai.js';
import { gemini } from './providers/gemini.js';

const PROVIDERS = { openai, gemini };

/** Stop runaway tool loops — a well-formed answer needs only a few lookups. */
const MAX_TOOL_ROUNDS = 6;
const MAX_TOOL_CALLS = 12;

/** Keep the request small; older turns matter less than the last few. */
const MAX_HISTORY_ITEMS = 60;
const MAX_MESSAGE_LENGTH = 1000;

const INSTRUCTIONS = `You are a film expert helping someone build a movie trivia quiz in an app called GameNight.

Grounding rules, which matter more than anything else:
- Every fact you state about a film or a person must come from a tool result in this conversation. Never answer from memory.
- If the tools return nothing useful, say plainly that you could not find it. Do not guess, and never invent a title, year, name or number.
- When a title is ambiguous, search first and ask which one they meant rather than assuming.
- TMDB data can be incomplete. If a field is missing, say it is not listed rather than estimating.

You cover world cinema — Hollywood, Bollywood and everything else. For Indian films, pass the right original_language code ('hi' Hindi, 'ta' Tamil, 'te' Telugu, 'ml' Malayalam, 'kn' Kannada, 'bn' Bengali, 'mr' Marathi, 'pa' Punjabi).

Be efficient with lookups — each one costs the user time and money. Search once with a good query rather than retrying variations, and when you need several independent facts, request those tool calls together in one turn instead of one at a time. Only call get_movie_details when the question needs detail that search does not already give you; search results already include the year, rating and plot summary.

Style: conversational and brief. Two or three sentences for a simple question. Use a short markdown list when giving several films, each with its year. Do not dump raw JSON or mention TMDB ids unless asked.

You are inside a quiz builder, so lean towards details that make good trivia — a memorable line, a casting fact, a box office number, who directed what. If asked to suggest questions, give the question and the correct answer plus plausible wrong options, and say which is correct.`;

/**
 * Which provider to use. An explicit LLM_PROVIDER wins; otherwise whichever
 * key is present, preferring OpenAI.
 */
export function activeProvider() {
  const named = PROVIDERS[(process.env.LLM_PROVIDER || '').toLowerCase().trim()];
  if (named) return named;
  if (openai.configured()) return openai;
  if (gemini.configured()) return gemini;
  return openai; // nothing configured — report against the default
}

export const chatConfigured = () => activeProvider().configured() && tmdbConfigured();

/** What the panel needs to tell the user what is missing. */
export function chatStatus() {
  const provider = activeProvider();
  return {
    ready: chatConfigured(),
    provider: provider.id,
    providerLabel: provider.label,
    providerKey: provider.keyName,
    providerSignup: provider.signupUrl,
    llm: provider.configured(),
    tmdb: tmdbConfigured(),
    model: provider.model(),
  };
}

/**
 * Runs one user turn to completion.
 *
 * @param {Array} history prior conversation items, as returned by a previous call
 * @param {string} message the user's new message
 * @returns {{reply: string, history: Array, toolCalls: string[], provider: string}}
 */
export async function ask(history, message) {
  const provider = activeProvider();
  if (!chatConfigured()) throw new Error('The movie assistant is not configured.');

  const text = String(message ?? '').trim().slice(0, MAX_MESSAGE_LENGTH);
  if (!text) throw new Error('Ask me something about a movie.');

  // Model-generated items must be replayed exactly as received, so we only
  // ever append to this array — never rewrite what came back.
  const input = [...trimHistory(history, provider), provider.userItem(text)];
  const toolCalls = [];

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const result = await provider.send({
      instructions: INSTRUCTIONS,
      tools: TOOL_DECLARATIONS,
      input,
    });
    input.push(...result.items);

    if (result.calls.length === 0) {
      return {
        reply: result.text || 'I could not find an answer to that.',
        history: input,
        toolCalls,
        provider: provider.id,
      };
    }

    if (toolCalls.length + result.calls.length > MAX_TOOL_CALLS) {
      return {
        reply: 'That turned into a lot of lookups — could you narrow the question down?',
        history: input,
        toolCalls,
        provider: provider.id,
      };
    }

    // Run the requested lookups in parallel and feed every result back.
    const results = await Promise.all(
      result.calls.map(async (call) => {
        toolCalls.push(call.name);
        const data = await runTool(call.name, call.args);
        return provider.toolResultItem(call, data);
      }),
    );
    input.push(...results);
  }

  return {
    reply: 'I got stuck looking that up. Try asking it a different way.',
    history: input,
    toolCalls,
    provider: provider.id,
  };
}

/**
 * Caps how much history goes back to the model. Trimming from the front can
 * orphan a tool result whose call was dropped, so we always cut back to the
 * start of a turn.
 */
function trimHistory(history, provider) {
  const items = Array.isArray(history) ? history.filter(isPlausibleItem) : [];
  if (items.length <= MAX_HISTORY_ITEMS) return items;

  const tail = items.slice(-MAX_HISTORY_ITEMS);
  const firstTurn = tail.findIndex((item) => provider.isTurnStart(item));
  return firstTurn === -1 ? [] : tail.slice(firstTurn);
}

/** The history comes from the browser, so treat it as untrusted. */
function isPlausibleItem(item) {
  return Boolean(item) && typeof item === 'object' && (typeof item.type === 'string' || typeof item.role === 'string');
}
