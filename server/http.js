/* fetch with retries for transient network failures.
 *
 * Calls to TMDB and Gemini go out over the open internet, where a connection
 * gets reset now and then — noticeably often on Windows, where antivirus and
 * VPN software sit in the TLS path. A single ECONNRESET should not surface to
 * the user as "I could not reach the movie database".
 */

/** Socket-level failures worth trying again. */
const TRANSIENT_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ECONNABORTED',
  'EPIPE',
  'ETIMEDOUT',
  'EAI_AGAIN', // DNS hiccup
  'UND_ERR_SOCKET',
  'UND_ERR_CONNECT_TIMEOUT',
]);

/** Server-side statuses that usually clear on their own. */
const TRANSIENT_STATUS = new Set([502, 503, 504]);

/** Rate limits clear on their own too, but need a longer pause. */
const RATE_LIMIT_STATUS = 429;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * How long to wait before trying again, by what went wrong.
 *
 * A dropped socket is almost always a keep-alive connection the server had
 * already closed — there is nothing to wait for, so retry straight away. A
 * rate limit genuinely needs time.
 */
function backoff(attempt, kind) {
  const jitter = Math.random() * 150;
  // Drain stale pooled sockets fast, then ease off if it is a real outage.
  if (kind === 'socket') return Math.min(600, attempt * 150) + jitter;
  if (kind === 'ratelimit') return 1500 * 3 ** attempt + jitter;
  return 250 * 3 ** attempt + jitter;
}

export function isTransientError(error) {
  if (!error) return false;
  if (TRANSIENT_CODES.has(error.code)) return true;
  if (TRANSIENT_CODES.has(error.cause?.code)) return true;
  // undici wraps socket errors in a bare "fetch failed" TypeError.
  return error.name === 'TypeError' && /fetch failed/i.test(error.message ?? '');
}

const isTimeout = (error) =>
  error?.name === 'TimeoutError' || error?.cause?.name === 'TimeoutError';

/**
 * @param {string|URL} url
 * @param {RequestInit} options
 * @param {{retries?: number, timeoutMs?: number, retryTimeouts?: boolean,
 *          retryRateLimits?: boolean, onRetry?: Function}} config
 */
export async function fetchWithRetry(url, options = {}, config = {}) {
  const {
    retries = 2,
    timeoutMs = 12000,
    retryTimeouts = true,
    retryRateLimits = true,
    onRetry,
  } = config;

  let lastError = null;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const response = await fetch(url, {
        ...options,
        signal: AbortSignal.timeout(timeoutMs),
      });

      const rateLimited = response.status === RATE_LIMIT_STATUS && retryRateLimits;
      const wobbly = TRANSIENT_STATUS.has(response.status);

      if ((rateLimited || wobbly) && attempt < retries) {
        onRetry?.({ attempt, reason: `HTTP ${response.status}` });
        await sleep(backoff(attempt, rateLimited ? 'ratelimit' : 'status'));
        continue;
      }
      return response;
    } catch (error) {
      lastError = error;

      // A timeout means the request was genuinely slow, not dropped — retrying
      // is only worth it where the caller has time to spare.
      const worthRetrying = isTimeout(error) ? retryTimeouts : isTransientError(error);
      if (!worthRetrying || attempt === retries) break;

      onRetry?.({ attempt, reason: error.cause?.code ?? error.name });
      await sleep(backoff(attempt, 'socket'));
    }
  }

  throw lastError ?? new Error('The request failed.');
}

/** Turns undici's opaque "fetch failed" into something worth showing a user. */
export function describeNetworkError(error, what) {
  if (isTimeout(error)) return `${what} took too long to respond.`;
  if (isTransientError(error)) return `Could not reach ${what} — the connection kept dropping.`;
  return `${what} failed: ${error?.message ?? 'unknown error'}`;
}
