/* Exercises the movie assistant with the network stubbed out: TMDB, OpenAI and
   Google AI responses are all faked, so this runs with no API keys and no
   quota. The chat loop is checked against BOTH providers, since they shape
   their conversation items very differently. */

for (const key of ['OPENAI_API_KEY', 'GEMINI_API_KEY', 'TMDB_API_KEY', 'TMDB_ACCESS_TOKEN', 'LLM_PROVIDER']) {
  delete process.env[key];
}

const { chatStatus, ask, activeProvider } = await import('../server/chat.js');
const { runTool, TOOL_DECLARATIONS, TOOL_NAMES } = await import('../server/tmdb.js');
const { isTransientError } = await import('../server/http.js');

let pass = 0,
  fail = 0;
const check = (label, cond, extra = '') => {
  if (cond) {
    pass++;
    console.log(`  PASS  ${label}`);
  } else {
    fail++;
    console.log(`  FAIL  ${label} ${extra}`);
  }
};

// --- fetch stub -------------------------------------------------------------

const realFetch = globalThis.fetch;
let calls = { tmdb: [], llm: [] };
let tmdbResponder = () => ({ status: 200, body: {} });
let llmQueue = [];

const makeResponse = ({ status = 200, body = {} }) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});

globalThis.fetch = async (url, options = {}) => {
  const href = String(url);

  if (href.includes('api.openai.com') || href.includes('generativelanguage.googleapis.com')) {
    calls.llm.push({ href, body: JSON.parse(options.body), headers: options.headers });
    return makeResponse(llmQueue.shift() ?? { status: 200, body: {} });
  }
  if (href.includes('api.themoviedb.org')) {
    calls.tmdb.push({ href, headers: options.headers ?? {} });
    return makeResponse(tmdbResponder(new URL(href)));
  }
  return realFetch(url, options);
};

const reset = () => {
  calls = { tmdb: [], llm: [] };
  llmQueue = [];
};

// --- per-provider response builders ----------------------------------------

const SHAPES = {
  openai: {
    key: 'OPENAI_API_KEY',
    endpoint: 'api.openai.com',
    sayText: (text) => ({
      status: 200,
      body: { output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }] },
    }),
    callTool: (name, args, callId = 'call_1') => ({
      status: 200,
      body: {
        output: [
          { type: 'reasoning', id: 'rs_1', summary: [] },
          { type: 'function_call', id: 'fc_1', call_id: callId, name, arguments: JSON.stringify(args) },
        ],
      },
    }),
    twoCalls: (name) => ({
      status: 200,
      body: {
        output: [
          { type: 'function_call', id: 'fc_a', call_id: 'a', name, arguments: '{"query":"One"}' },
          { type: 'function_call', id: 'fc_b', call_id: 'b', name, arguments: '{"query":"Two"}' },
        ],
      },
    }),
    resultType: 'function_call_output',
    resultId: (item) => item.call_id,
    resultData: (item) => JSON.parse(item.output),
    replayedThinking: (input) => input.some((i) => i.type === 'reasoning'),
    userItemText: (item) => item.content,
    instructionsField: 'instructions',
  },
  gemini: {
    key: 'GEMINI_API_KEY',
    endpoint: 'generativelanguage.googleapis.com',
    sayText: (text) => ({
      status: 200,
      body: { steps: [{ type: 'model_output', content: [{ type: 'text', text }] }] },
    }),
    callTool: (name, args, callId = 'call_1') => ({
      status: 200,
      body: {
        steps: [
          { type: 'thought', signature: 'sig_abc' },
          { type: 'function_call', id: callId, name, arguments: args },
        ],
      },
    }),
    twoCalls: (name) => ({
      status: 200,
      body: {
        steps: [
          { type: 'function_call', id: 'a', name, arguments: { query: 'One' } },
          { type: 'function_call', id: 'b', name, arguments: { query: 'Two' } },
        ],
      },
    }),
    resultType: 'function_result',
    resultId: (item) => item.call_id,
    resultData: (item) => JSON.parse(item.result[0].text),
    replayedThinking: (input) => input.some((i) => i.type === 'thought' && i.signature === 'sig_abc'),
    userItemText: (item) => item.content[0].text,
    instructionsField: 'system_instruction',
  },
};

const useProvider = (id) => {
  process.env.LLM_PROVIDER = id;
  for (const shape of Object.values(SHAPES)) delete process.env[shape.key];
  process.env[SHAPES[id].key] = `fake-${id}-key`;
};

// ===========================================================================
console.log('\n-- configuration --');
// ===========================================================================

check('unconfigured status is not ready', chatStatus().ready === false, JSON.stringify(chatStatus()));
check('it defaults to OpenAI', chatStatus().provider === 'openai', chatStatus().provider);

process.env.OPENAI_API_KEY = 'fake-openai-key';
check('the model key alone is not enough', chatStatus().ready === false);
check('status reports which half is missing',
  chatStatus().llm === true && chatStatus().tmdb === false, JSON.stringify(chatStatus()));
check('status names the key to set', chatStatus().providerKey === 'OPENAI_API_KEY');

process.env.TMDB_API_KEY = 'deadbeefdeadbeefdeadbeefdeadbeef';
check('both keys make it ready', chatStatus().ready === true, JSON.stringify(chatStatus()));

delete process.env.OPENAI_API_KEY;
process.env.GEMINI_API_KEY = 'fake-gemini-key';
check('it falls back to Google AI when only that key is set',
  chatStatus().provider === 'gemini' && chatStatus().ready === true, JSON.stringify(chatStatus()));

process.env.OPENAI_API_KEY = 'fake-openai-key';
check('OpenAI wins when both keys are present', chatStatus().provider === 'openai', chatStatus().provider);

process.env.LLM_PROVIDER = 'gemini';
check('LLM_PROVIDER overrides the preference', chatStatus().provider === 'gemini', chatStatus().provider);
check('an unknown provider name falls back sensibly',
  ((process.env.LLM_PROVIDER = 'nonsense'), chatStatus().provider === 'openai'), chatStatus().provider);
check('the active provider reports a model', typeof activeProvider().model() === 'string');

// ===========================================================================
console.log('\n-- tool declarations --');
// ===========================================================================

check('every declared tool has a handler', TOOL_DECLARATIONS.every((t) => TOOL_NAMES.includes(t.name)));
check('every handler is declared to the model',
  TOOL_NAMES.every((n) => TOOL_DECLARATIONS.some((t) => t.name === n)));
check('declarations use the shared function shape',
  TOOL_DECLARATIONS.every((t) => t.type === 'function' && t.name && t.description && t.parameters?.type === 'object'));
check('required params are listed in properties',
  TOOL_DECLARATIONS.every((t) => (t.parameters.required ?? []).every((r) => r in t.parameters.properties)));

// ===========================================================================
console.log('\n-- TMDB tools --');
// ===========================================================================

reset();
tmdbResponder = () => ({
  status: 200,
  body: {
    total_results: 2,
    results: [
      { id: 550, title: 'Fight Club', original_title: 'Fight Club', release_date: '1999-10-15',
        original_language: 'en', overview: 'Insomniac.', vote_average: 8.438, vote_count: 27000, poster_path: '/poster.jpg' },
      { id: 999, title: 'Some Hindi Film', original_title: 'कोई', release_date: '1995-01-01',
        original_language: 'hi', overview: '', vote_average: 7.1, vote_count: 400, poster_path: null },
    ],
  },
});

const search = await runTool('search_movies', { query: 'Fight Club' });
check('search returns shaped results', search.results.length === 2 && search.results[0].title === 'Fight Club');
check('search extracts the year', search.results[0].year === '1999', search.results[0].year);
check('search rounds the rating', search.results[0].rating === 8.4, String(search.results[0].rating));
check('search builds a full poster url',
  search.results[0].poster === 'https://image.tmdb.org/t/p/w500/poster.jpg');
check('a missing poster stays null', search.results[1].poster === null);
check('a v3 key goes in the query', calls.tmdb[0].href.includes('api_key=deadbeef'));

const hindiOnly = await runTool('search_movies', { query: 'film', language: 'hi' });
check('language filter narrows results', hindiOnly.results.length === 1 && hindiOnly.results[0].language === 'hi');

reset();
process.env.TMDB_ACCESS_TOKEN = 'eyJhbGciOi.eyJhdWQi.signature';
await runTool('search_movies', { query: 'x' });
check('a JWT token is sent as a Bearer header',
  calls.tmdb[0].headers.Authorization === 'Bearer eyJhbGciOi.eyJhdWQi.signature' &&
    !calls.tmdb[0].href.includes('api_key='));
delete process.env.TMDB_ACCESS_TOKEN;

tmdbResponder = () => ({
  status: 200,
  body: {
    id: 550, title: 'Fight Club', release_date: '1999-10-15', original_language: 'en',
    runtime: 139, budget: 63000000, revenue: 100853753, genres: [{ id: 18, name: 'Drama' }],
    production_countries: [], vote_average: 8.4, vote_count: 27000, poster_path: '/p.jpg',
    credits: {
      crew: [
        { job: 'Director', name: 'David Fincher' },
        { job: 'Screenplay', name: 'Jim Uhls' },
        { job: 'Gaffer', name: 'Nobody Important' },
      ],
      cast: Array.from({ length: 30 }, (_, i) => ({ name: `Actor ${i}`, character: `Role ${i}` })),
    },
    videos: { results: [{ site: 'YouTube', type: 'Trailer', key: 'BdJKm16Co6M' }] },
  },
});

const details = await runTool('get_movie_details', { movie_id: 550 });
check('details pull out the director', JSON.stringify(details.directors) === '["David Fincher"]');
check('details pull out the writers', details.writers.includes('Jim Uhls'));
check('details keep budget and revenue', details.budget_usd === 63000000 && details.revenue_usd === 100853753);
check('details cap the cast list', details.cast.length === 12, String(details.cast.length));
check('details find a YouTube trailer', details.trailer_youtube_id === 'BdJKm16Co6M');
check('details drop irrelevant crew', !JSON.stringify(details).includes('Nobody Important'));

tmdbResponder = () => ({ status: 401, body: {} });
check('a rejected TMDB key surfaces as data',
  /API key/i.test((await runTool('search_movies', { query: 'x' })).error ?? ''));
tmdbResponder = () => ({ status: 404, body: {} });
check('an unknown movie id is reported', Boolean((await runTool('get_movie_details', { movie_id: 1 })).error));
check('an unknown tool name is refused', /Unknown tool/.test((await runTool('drop_database', {})).error));

// ===========================================================================
console.log('\n-- transient network failures --');
// ===========================================================================

const resetError = () => {
  const err = new TypeError('fetch failed');
  err.cause = Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' });
  return err;
};

check('an ECONNRESET is recognised as transient', isTransientError(resetError()));
check('a plain "fetch failed" is treated as transient', isTransientError(new TypeError('fetch failed')));
check('an ordinary error is not retried', !isTransientError(new Error('bad key')));

reset();
let attempts = 0;
tmdbResponder = () => {
  attempts += 1;
  if (attempts === 1) throw resetError();
  return { status: 200, body: { total_results: 1, results: [{ id: 1, title: 'Sholay', release_date: '1975-08-15', original_language: 'hi', vote_average: 8, vote_count: 500, poster_path: null }] } };
};
const recovered = await runTool('search_movies', { query: 'Sholay' });
check('a dropped TMDB connection is retried', attempts === 2, `attempts: ${attempts}`);
check('the retry result reaches the caller', recovered.results?.[0]?.title === 'Sholay');

reset();
attempts = 0;
tmdbResponder = () => {
  attempts += 1;
  throw resetError();
};
const gaveUp = await runTool('search_movies', { query: 'Sholay' });
check('retries eventually stop', attempts === 6, `attempts: ${attempts}`);
check('a persistent reset gets a human message', /connection kept dropping/i.test(gaveUp.error ?? ''));
check('the raw "fetch failed" never reaches the model', !/fetch failed/i.test(gaveUp.error ?? ''));

reset();
attempts = 0;
tmdbResponder = () => {
  attempts += 1;
  return attempts < 3 ? { status: 503, body: {} } : { status: 200, body: { results: [] } };
};
await runTool('search_movies', { query: 'x' });
check('a 503 is retried', attempts === 3, `attempts: ${attempts}`);

reset();
attempts = 0;
tmdbResponder = () => {
  attempts += 1;
  return { status: 401, body: {} };
};
await runTool('search_movies', { query: 'x' });
check('a rejected key is not retried', attempts === 1, `attempts: ${attempts}`);

// ===========================================================================
// The loop, run identically against both providers
// ===========================================================================

const MOVIE_RESULT = {
  status: 200,
  body: { total_results: 1, results: [{ id: 550, title: 'Fight Club', release_date: '1999-10-15', original_language: 'en', vote_average: 8.4, vote_count: 100, poster_path: null }] },
};

for (const [id, shape] of Object.entries(SHAPES)) {
  console.log(`\n-- the chat loop (${id}) --`);
  useProvider(id);
  process.env.TMDB_API_KEY = 'deadbeefdeadbeefdeadbeefdeadbeef';

  reset();
  tmdbResponder = () => MOVIE_RESULT;
  llmQueue = [shape.callTool('search_movies', { query: 'Fight Club' }), shape.sayText('Fight Club came out in 1999.')];

  const first = await ask([], 'When did Fight Club come out?');
  check(`[${id}] the loop returns the final text`, first.reply === 'Fight Club came out in 1999.', first.reply);
  check(`[${id}] the reply names the provider used`, first.provider === id, first.provider);
  check(`[${id}] the loop reports which tools ran`, JSON.stringify(first.toolCalls) === '["search_movies"]');
  check(`[${id}] it took two model calls`, calls.llm.length === 2, String(calls.llm.length));
  check(`[${id}] TMDB was actually called`, calls.tmdb.length === 1);
  check(`[${id}] it hit the right endpoint`, calls.llm[0].href.includes(shape.endpoint), calls.llm[0].href);

  const firstBody = calls.llm[0].body;
  check(`[${id}] instructions are sent`, /Never answer from memory/.test(firstBody[shape.instructionsField] ?? ''));
  check(`[${id}] tools are declared`, firstBody.tools.length === TOOL_DECLARATIONS.length);
  check(`[${id}] the request is stateless`, firstBody.store === false, JSON.stringify(firstBody.store));
  check(`[${id}] the user message is the last input item`,
    shape.userItemText(firstBody.input.at(-1)) === 'When did Fight Club come out?',
    JSON.stringify(firstBody.input.at(-1)));

  const secondBody = calls.llm[1].body;
  const resultItem = secondBody.input.find((i) => i.type === shape.resultType);
  check(`[${id}] the tool result is sent back`, Boolean(resultItem),
    JSON.stringify(secondBody.input.map((i) => i.type ?? i.role)));
  check(`[${id}] the result carries the matching call id`, shape.resultId(resultItem) === 'call_1');
  check(`[${id}] the result carries the TMDB data`,
    shape.resultData(resultItem).results[0].title === 'Fight Club');
  check(`[${id}] reasoning items are replayed verbatim`, shape.replayedThinking(secondBody.input),
    JSON.stringify(secondBody.input.map((i) => i.type ?? i.role)));

  // Multi-turn.
  reset();
  llmQueue = [shape.sayText('David Fincher directed it.')];
  const second = await ask(first.history, 'Who directed it?');
  check(`[${id}] history is carried into the next turn`, calls.llm[0].body.input.length > 2);
  check(`[${id}] a turn needing no tools takes one call`, calls.llm.length === 1);
  check(`[${id}] the follow-up reply comes back`, second.reply === 'David Fincher directed it.');

  // Parallel tool calls.
  reset();
  llmQueue = [shape.twoCalls('search_movies'), shape.sayText('Both are 1999 films.')];
  const parallel = await ask([], 'Compare these two');
  check(`[${id}] parallel tool calls all run`, calls.tmdb.length === 2, String(calls.tmdb.length));
  check(`[${id}] every parallel result is returned`,
    calls.llm[1].body.input.filter((i) => i.type === shape.resultType).length === 2);
  check(`[${id}] parallel results keep their own call ids`,
    JSON.stringify(calls.llm[1].body.input.filter((i) => i.type === shape.resultType).map(shape.resultId)) === '["a","b"]');
  check(`[${id}] both calls are reported`, parallel.toolCalls.length === 2);

  // Guard rails.
  reset();
  llmQueue = Array.from({ length: 10 }, () => shape.callTool('search_movies', { query: 'loop' }));
  const looped = await ask([], 'go forever');
  check(`[${id}] a runaway tool loop is cut off`, calls.llm.length <= 7, String(calls.llm.length));
  check(`[${id}] a cut-off loop still returns a reply`, looped.reply.length > 0);

  reset();
  let threw = null;
  try {
    await ask([], '   ');
  } catch (err) {
    threw = err.message;
  }
  check(`[${id}] an empty message is refused`, Boolean(threw));
  check(`[${id}] an empty message costs nothing`, calls.llm.length === 0);

  // History hygiene.
  reset();
  llmQueue = [shape.sayText('ok')];
  await ask([null, 'nonsense', { nope: true }, shape.sayText('x').body], 'hi');
  check(`[${id}] malformed history entries are dropped`,
    calls.llm[0].body.input.every((i) => i && typeof i === 'object' && (i.type || i.role)));

  reset();
  llmQueue = [shape.sayText('ok')];
  const longHistory = Array.from({ length: 80 }, (_, i) =>
    i % 4 === 0 ? { ...activeProvider().userItem(`turn ${i}`) } : { type: 'model_output', content: [] },
  );
  await ask(longHistory, 'and now?');
  const trimmed = calls.llm[0].body.input;
  check(`[${id}] long history is trimmed`, trimmed.length < 82, String(trimmed.length));
  check(`[${id}] trimming starts at a turn boundary`, activeProvider().isTurnStart(trimmed[0]),
    JSON.stringify(trimmed[0]).slice(0, 60));
}

// ===========================================================================
console.log('\n-- provider error messages --');
// ===========================================================================

useProvider('openai');
reset();
llmQueue = [{ status: 401, body: { error: { message: 'Incorrect API key provided' } } }];
let err401 = null;
try {
  await ask([], 'hi');
} catch (e) {
  err401 = e.message;
}
check('a bad OpenAI key names the variable', /OPENAI_API_KEY/.test(err401 ?? ''), String(err401));

// OpenAI returns 429 for both burst limits and spent credit, so it is retried
// either way — the message only tells them apart once the retries are done.
reset();
llmQueue = Array.from({ length: 3 }, () => ({
  status: 429,
  body: { error: { message: 'You exceeded your current quota, please check your plan and billing' } },
}));
let noCredit = null;
try {
  await ask([], 'hi');
} catch (e) {
  noCredit = e.message;
}
check('an out-of-credit OpenAI account says so', /credit/i.test(noCredit ?? ''), String(noCredit));

reset();
llmQueue = [{ status: 429, body: { error: { message: 'Rate limit reached' } } }, SHAPES.openai.sayText('Back again.')];
const burst = await ask([], 'hi');
check('a one-off OpenAI rate limit is retried through', burst.reply === 'Back again.', burst.reply);

reset();
llmQueue = [{ status: 404, body: { error: { message: "The model 'gpt-nonsense' does not exist" } } }];
process.env.OPENAI_MODEL = 'gpt-nonsense';
let badModel = null;
try {
  await ask([], 'hi');
} catch (e) {
  badModel = e.message;
}
check('an unknown model is named in the error', /gpt-nonsense/.test(badModel ?? ''), String(badModel));
delete process.env.OPENAI_MODEL;

useProvider('gemini');
reset();
llmQueue = Array.from({ length: 3 }, () => ({ status: 429, body: { error: { message: 'Quota exceeded' } } }));
let quota = null;
try {
  await ask([], 'hi');
} catch (e) {
  quota = e.message;
}
check('an exhausted Google AI quota gives a readable message', /quota/i.test(quota ?? ''), String(quota));

// Malformed tool arguments must not crash the loop.
useProvider('openai');
reset();
tmdbResponder = () => MOVIE_RESULT;
llmQueue = [
  { status: 200, body: { output: [{ type: 'function_call', id: 'fc', call_id: 'c1', name: 'search_movies', arguments: '{not json' }] } },
  SHAPES.openai.sayText('Recovered.'),
];
const malformed = await ask([], 'hi');
check('malformed tool arguments do not crash the loop', malformed.reply === 'Recovered.', malformed.reply);

// --- unconfigured -----------------------------------------------------------

delete process.env.OPENAI_API_KEY;
delete process.env.GEMINI_API_KEY;
let unconfigured = null;
try {
  await ask([], 'hello');
} catch (e) {
  unconfigured = e.message;
}
check('asking without keys is refused', /not configured/i.test(unconfigured ?? ''), String(unconfigured));

console.log(`\n  ${pass} passed, ${fail} failed\n`);
globalThis.fetch = realFetch;
process.exit(fail ? 1 : 0);
