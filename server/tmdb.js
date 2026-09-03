/* TMDB client, exposed as a small set of tools the chat model can call.
 *
 * Every fact the assistant states should come from one of these calls — the
 * model supplies the conversation, TMDB supplies the truth.
 */

import { describeNetworkError, fetchWithRetry } from './http.js';

const BASE = 'https://api.themoviedb.org/3';
const IMAGE_BASE = 'https://image.tmdb.org/t/p/w500';
const REQUEST_TIMEOUT_MS = 12000;

/**
 * Generous, because these retries are nearly free. Between questions the
 * connection pool sits idle long enough for TMDB to close its keep-alive
 * sockets; Node does not notice, so the next few requests each grab a dead
 * socket and reset instantly. Every retry drains one, and the first retry
 * waits no time at all.
 */
const RETRIES = 5;

/** Trim results so a big cast list cannot swamp the model's context. */
const MAX_RESULTS = 10;
const MAX_CAST = 12;
const MAX_CREDITS = 25;

export function tmdbCredentials() {
  // TMDB shows two credentials on the same settings page. A v4 read access
  // token is a JWT (has dots) and goes in a header; a v3 key is a bare hex
  // string and goes in the query. Accept whichever the user pasted.
  const raw = (process.env.TMDB_ACCESS_TOKEN || process.env.TMDB_API_KEY || '').trim();
  if (!raw) return null;
  return raw.includes('.') ? { type: 'bearer', value: raw } : { type: 'key', value: raw };
}

export const tmdbConfigured = () => tmdbCredentials() !== null;

async function tmdbRequest(path, params = {}) {
  const credentials = tmdbCredentials();
  if (!credentials) throw new Error('TMDB is not configured.');

  const url = new URL(BASE + path);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') {
      url.searchParams.set(key, String(value));
    }
  }
  const headers = { accept: 'application/json' };
  if (credentials.type === 'bearer') {
    headers.Authorization = `Bearer ${credentials.value}`;
  } else {
    url.searchParams.set('api_key', credentials.value);
  }

  let response;
  try {
    response = await fetchWithRetry(
      url,
      { headers },
      {
        retries: RETRIES,
        timeoutMs: REQUEST_TIMEOUT_MS,
        onRetry: ({ attempt, reason }) =>
          console.warn(`[tmdb] ${path} retry ${attempt + 1}/${RETRIES} after ${reason}`),
      },
    );
  } catch (err) {
    throw new Error(describeNetworkError(err, 'TMDB'));
  }

  if (!response.ok) {
    if (response.status === 401) throw new Error('TMDB rejected the API key.');
    if (response.status === 404) return null;
    if (response.status === 429) throw new Error('TMDB is rate limiting — try again shortly.');
    throw new Error(`TMDB request failed (${response.status}).`);
  }
  return response.json();
}

// ---------------------------------------------------------------------------
// Shaping — keep only what is useful to answer a question
// ---------------------------------------------------------------------------

const posterUrl = (path) => (path ? IMAGE_BASE + path : null);
const year = (date) => (date ? date.slice(0, 4) : null);

function briefMovie(movie) {
  return {
    id: movie.id,
    title: movie.title ?? movie.name,
    original_title: movie.original_title !== movie.title ? movie.original_title : undefined,
    year: year(movie.release_date),
    language: movie.original_language,
    overview: movie.overview || undefined,
    rating: movie.vote_average ? Number(movie.vote_average.toFixed(1)) : undefined,
    votes: movie.vote_count || undefined,
    poster: posterUrl(movie.poster_path),
  };
}

function fullMovie(movie) {
  const crew = movie.credits?.crew ?? [];
  const pick = (job) => crew.filter((c) => c.job === job).map((c) => c.name);
  const trailer = (movie.videos?.results ?? []).find(
    (v) => v.site === 'YouTube' && v.type === 'Trailer',
  );

  return {
    ...briefMovie(movie),
    tagline: movie.tagline || undefined,
    runtime_minutes: movie.runtime || undefined,
    release_date: movie.release_date || undefined,
    genres: (movie.genres ?? []).map((g) => g.name),
    countries: (movie.production_countries ?? []).map((c) => c.name),
    budget_usd: movie.budget || undefined,
    revenue_usd: movie.revenue || undefined,
    directors: pick('Director'),
    writers: [...new Set([...pick('Screenplay'), ...pick('Writer'), ...pick('Story')])],
    composers: pick('Original Music Composer'),
    cast: (movie.credits?.cast ?? []).slice(0, MAX_CAST).map((c) => ({
      name: c.name,
      character: c.character || undefined,
    })),
    trailer_youtube_id: trailer?.key,
    imdb_id: movie.imdb_id || undefined,
  };
}

// ---------------------------------------------------------------------------
// The tools themselves
// ---------------------------------------------------------------------------

async function searchMovies({ query, year: releaseYear, language }) {
  const data = await tmdbRequest('/search/movie', {
    query,
    primary_release_year: releaseYear,
    language: 'en-US',
    include_adult: false,
  });
  let results = data?.results ?? [];
  // TMDB has no original-language filter on search, so narrow it here.
  if (language) results = results.filter((m) => m.original_language === language);
  return {
    total_results: data?.total_results ?? 0,
    results: results.slice(0, MAX_RESULTS).map(briefMovie),
  };
}

async function getMovieDetails({ movie_id }) {
  const data = await tmdbRequest(`/movie/${Number(movie_id)}`, {
    append_to_response: 'credits,videos',
    language: 'en-US',
  });
  if (!data) return { error: 'No movie with that id.' };
  return fullMovie(data);
}

async function searchPeople({ query }) {
  const data = await tmdbRequest('/search/person', { query, include_adult: false });
  return {
    total_results: data?.total_results ?? 0,
    results: (data?.results ?? []).slice(0, MAX_RESULTS).map((person) => ({
      id: person.id,
      name: person.name,
      known_for_department: person.known_for_department,
      known_for: (person.known_for ?? []).map((m) => m.title ?? m.name).filter(Boolean),
    })),
  };
}

async function getPersonCredits({ person_id, role }) {
  const [person, credits] = await Promise.all([
    tmdbRequest(`/person/${Number(person_id)}`),
    tmdbRequest(`/person/${Number(person_id)}/movie_credits`),
  ]);
  if (!person) return { error: 'No person with that id.' };

  const acting = (credits?.cast ?? []).map((m) => ({ ...briefMovie(m), character: m.character || undefined }));
  const crewWork = (credits?.crew ?? []).map((m) => ({ ...briefMovie(m), job: m.job }));

  // Newest first — "what have they been in lately" is the common question.
  const byYear = (a, b) => (b.year ?? '0').localeCompare(a.year ?? '0');

  const wanted = role === 'crew' ? [] : acting.sort(byYear).slice(0, MAX_CREDITS);
  const wantedCrew = role === 'acting' ? [] : crewWork.sort(byYear).slice(0, MAX_CREDITS);

  return {
    id: person.id,
    name: person.name,
    birthday: person.birthday || undefined,
    deathday: person.deathday || undefined,
    place_of_birth: person.place_of_birth || undefined,
    known_for_department: person.known_for_department,
    biography: person.biography ? person.biography.slice(0, 600) : undefined,
    acting_credits: wanted,
    crew_credits: wantedCrew,
    total_acting_credits: acting.length,
    total_crew_credits: crewWork.length,
  };
}

async function discoverMovies({
  original_language,
  year_from,
  year_to,
  genres,
  with_cast,
  with_crew,
  sort_by,
  min_votes,
}) {
  const data = await tmdbRequest('/discover/movie', {
    with_original_language: original_language,
    'primary_release_date.gte': year_from ? `${year_from}-01-01` : undefined,
    'primary_release_date.lte': year_to ? `${year_to}-12-31` : undefined,
    with_genres: genres,
    with_cast,
    with_crew,
    sort_by: sort_by || 'popularity.desc',
    'vote_count.gte': min_votes ?? 50,
    include_adult: false,
    language: 'en-US',
  });
  return {
    total_results: data?.total_results ?? 0,
    results: (data?.results ?? []).slice(0, MAX_RESULTS).map(briefMovie),
  };
}

let genreCache = null;

async function listGenres() {
  if (!genreCache) {
    const data = await tmdbRequest('/genre/movie/list', { language: 'en-US' });
    genreCache = (data?.genres ?? []).map((g) => ({ id: g.id, name: g.name }));
  }
  return { genres: genreCache };
}

// ---------------------------------------------------------------------------
// Declarations handed to the model, and the dispatch table
// ---------------------------------------------------------------------------

export const TOOL_DECLARATIONS = [
  {
    type: 'function',
    name: 'search_movies',
    description:
      'Find movies by title. Use this first when the user names a film, then call get_movie_details with the id for facts like cast, runtime, budget or box office.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'The movie title to search for.' },
        year: { type: 'integer', description: 'Optional release year to disambiguate remakes.' },
        language: {
          type: 'string',
          description:
            "Optional ISO 639-1 code to keep only films originally in that language, e.g. 'hi' for Hindi, 'ta' Tamil, 'ja' Japanese, 'ko' Korean.",
        },
      },
      required: ['query'],
    },
  },
  {
    type: 'function',
    name: 'get_movie_details',
    description:
      'Full details for one movie: plot, genres, runtime, release date, budget, box office, director, writers, top cast and a trailer id. Requires a movie id from search_movies or discover_movies.',
    parameters: {
      type: 'object',
      properties: { movie_id: { type: 'integer', description: 'TMDB movie id.' } },
      required: ['movie_id'],
    },
  },
  {
    type: 'function',
    name: 'search_people',
    description: 'Find actors, directors, writers or composers by name. Returns ids for get_person_credits.',
    parameters: {
      type: 'object',
      properties: { query: { type: 'string', description: "The person's name." } },
      required: ['query'],
    },
  },
  {
    type: 'function',
    name: 'get_person_credits',
    description:
      "A person's biography and filmography — what they acted in and what they directed, wrote or composed.",
    parameters: {
      type: 'object',
      properties: {
        person_id: { type: 'integer', description: 'TMDB person id from search_people.' },
        role: {
          type: 'string',
          enum: ['acting', 'crew', 'both'],
          description: "Which credits to return. Use 'crew' for directing or writing work.",
        },
      },
      required: ['person_id'],
    },
  },
  {
    type: 'function',
    name: 'discover_movies',
    description:
      'Browse movies by filters rather than by title. Use for questions like "top Hindi films of the 90s" or "movies with both these actors". Combine cast ids with a comma for AND.',
    parameters: {
      type: 'object',
      properties: {
        original_language: { type: 'string', description: "ISO 639-1 code, e.g. 'hi', 'en', 'ko'." },
        year_from: { type: 'integer', description: 'Earliest release year.' },
        year_to: { type: 'integer', description: 'Latest release year.' },
        genres: { type: 'string', description: 'Comma-separated TMDB genre ids from list_genres.' },
        with_cast: { type: 'string', description: 'Comma-separated person ids that must all appear in the cast.' },
        with_crew: { type: 'string', description: 'Comma-separated person ids that must all be in the crew.' },
        sort_by: {
          type: 'string',
          enum: ['popularity.desc', 'vote_average.desc', 'revenue.desc', 'primary_release_date.desc', 'primary_release_date.asc'],
          description: 'Ordering. Use vote_average.desc for "best" questions.',
        },
        min_votes: { type: 'integer', description: 'Minimum vote count; raise to ~300 for "best of" lists.' },
      },
      required: [],
    },
  },
  {
    type: 'function',
    name: 'list_genres',
    description: 'The list of TMDB genre names and their ids, for use with discover_movies.',
    parameters: { type: 'object', properties: {}, required: [] },
  },
];

const HANDLERS = {
  search_movies: searchMovies,
  get_movie_details: getMovieDetails,
  search_people: searchPeople,
  get_person_credits: getPersonCredits,
  discover_movies: discoverMovies,
  list_genres: listGenres,
};

/** Runs one tool call. Errors come back as data so the model can recover. */
export async function runTool(name, args) {
  const handler = HANDLERS[name];
  if (!handler) return { error: `Unknown tool "${name}".` };
  try {
    return (await handler(args ?? {})) ?? { error: 'No result.' };
  } catch (err) {
    return { error: err.message ?? 'The lookup failed.' };
  }
}

export const TOOL_NAMES = Object.keys(HANDLERS);
