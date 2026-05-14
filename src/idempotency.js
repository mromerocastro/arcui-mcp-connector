/**
 * ArcUI MCP — Idempotency Cache
 * ─────────────────────────────────────────────────────────────────────────
 * In-memory dedup cache for state-changing tools. When a tool call carries
 * an `idempotency_key`, the first invocation runs the handler and the cached
 * response is returned for any subsequent call with the same key within the
 * TTL window. The handler is not executed again.
 *
 * Scope and lifetime
 *   • Process-local. The cache lives in this Node process only.
 *   • The connector is stateless across restarts, so a key submitted after
 *     the process is restarted falls through and re-executes. Clients that
 *     need stronger guarantees must also be defensive at the destination
 *     system.
 *
 * What gets cached
 *   • Only successful responses (response.isError !== true). Failures are
 *     evicted so the client can retry with the same key and obtain a fresh
 *     attempt.
 *   • An in-flight call is cached as the pending Promise itself, so two
 *     concurrent calls with the same key collapse onto one bridge round-trip.
 *
 * Memory bounds
 *   • TTL_MS: 5 minutes per entry.
 *   • MAX_ENTRIES: 256. Oldest entry is evicted (LRU) when full.
 *   • Each entry holds one Promise resolving to one MCP tool response — a
 *     few KB at most, so the worst-case ceiling is bounded and predictable.
 *
 * This cache lives entirely in the connector. It does NOT cache, hold, or
 * keep references to any Unity DataStore tag, alarm, or session state.
 */

const TTL_MS      = 5 * 60 * 1000;
const MAX_ENTRIES = 256;

const cache = new Map();

function bumpToEnd(key, entry) {
    // Map preserves insertion order; deleting and re-setting moves the key
    // to the end so we can read the oldest entry via cache.keys().next().
    cache.delete(key);
    cache.set(key, entry);
}

function evictIfFull() {
    if (cache.size <= MAX_ENTRIES) return;
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
}

/**
 * Wrap a handler call with idempotency semantics.
 *
 * @param {string} toolName  Tool identifier — namespaces keys so that the
 *                           same idempotency_key cannot collide across tools.
 * @param {string|undefined} key  Client-supplied dedup key, or falsy to skip.
 * @param {() => Promise<any>} fn The handler invocation.
 */
export async function withIdempotency(toolName, key, fn) {
    if (!key) return fn();

    const cacheKey = `${toolName}:${key}`;
    const now = Date.now();
    const existing = cache.get(cacheKey);

    if (existing) {
        if (existing.expires > now) {
            bumpToEnd(cacheKey, existing);
            return existing.promise;
        }
        cache.delete(cacheKey);
    }

    const entry = { promise: null, expires: now + TTL_MS };
    entry.promise = (async () => {
        try {
            const result = await fn();
            if (result && result.isError) {
                // Don't cache failures — let the client retry cleanly.
                cache.delete(cacheKey);
            }
            return result;
        } catch (e) {
            cache.delete(cacheKey);
            throw e;
        }
    })();

    cache.set(cacheKey, entry);
    evictIfFull();
    return entry.promise;
}

// Test-only helpers. Not part of the public API; renamed with leading
// underscore so consumers do not depend on them.
export function _resetCache() { cache.clear(); }
export function _cacheSize()  { return cache.size; }
