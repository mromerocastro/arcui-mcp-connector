/**
 * ArcUI MCP Bridge Client
 * ─────────────────────────────────────────────────────────────────────────
 * Thin HTTP client that talks to ArcHMIMcpBridge.cs running inside Unity.
 * All tool handlers delegate to this module so that the MCP server itself
 * stays stateless and testable.
 *
 * Configuration via environment variables:
 *   ARCUI_BRIDGE_URL              default: http://localhost:17842
 *   ARCUI_BRIDGE_TOKEN            optional: must match ArcHMIMcpBridge.authToken
 *   ARCUI_BRIDGE_TIMEOUT_MS       default: 5000
 *   ARCUI_BRIDGE_ALLOW_INSECURE   default: false
 *                                 Opt-in override that allows plain http:// to
 *                                 a non-loopback host. Use only on a trusted
 *                                 private link (e.g., a VPN tunnel) where TLS
 *                                 is terminated at the network layer.
 *
 * Protocol versioning:
 *   The bridge advertises its wire-protocol version via GET /mcp/schema. This
 *   client supports MAJOR == SUPPORTED_PROTOCOL_MAJOR. A handshake at startup
 *   surfaces incompatibilities with a clear error before any tool call lands.
 */

// Wire-protocol MAJOR version this connector is built against. Must match the
// MAJOR of ArcHMIMcpBridge.PROTOCOL_VERSION on the Unity side. Bump together
// with the bridge when a breaking change is made to any endpoint's JSON shape.
export const SUPPORTED_PROTOCOL_MAJOR = 1;

// Fallback assumed when the bridge has no /mcp/schema endpoint (legacy
// installations from before the handshake landed). All capabilities default
// to true so existing tool catalogs continue to work.
const LEGACY_FALLBACK = Object.freeze({
    bridge_version:   "unknown",
    protocol_version: "1.0.0",
    capabilities: Object.freeze({
        alarms:              true,
        reports:             true,
        training:            true,
        instructor_messages: true,
        timemachine:         true,
    }),
    _legacy: true,
});

/**
 * @typedef {Object} BridgeUrlResult
 * @property {boolean}  ok        true if the URL is acceptable, false otherwise.
 * @property {string}  [url]      Sanitized URL when ok=true (trailing slashes stripped).
 * @property {string}  [warning]  Non-fatal advisory shown on stderr when ok=true.
 * @property {string}  [error]    Fatal explanation shown on stderr when ok=false.
 *
 * @typedef {Object} RequestOpts
 * @property {Record<string, string|number|boolean|null|undefined>} [query]
 * @property {any} [body]
 */

/**
 * Pure URL guard. Decides whether `rawUrl` is acceptable as the bridge target
 * given the operator's `allowInsecure` opt-in. Returns either:
 *   { ok: true,  url, warning? }   — proceed (warning is non-fatal advisory)
 *   { ok: false, error }           — caller must abort
 *
 * Kept side-effect free so the suite in test/bridge-url-guard.test.js can
 * exercise every branch without spawning child processes.
 *
 * @param {string|undefined|null} rawUrl
 * @param {{ allowInsecure?: boolean }} [opts]
 * @returns {BridgeUrlResult}
 */
export function evaluateBridgeUrl(rawUrl, { allowInsecure = false } = {}) {
    const raw = String(rawUrl || "").replace(/\/+$/, "");

    let parsed;
    try { parsed = new URL(raw); }
    catch {
        return { ok: false, error: `ARCUI_BRIDGE_URL is not a valid URL: '${raw}'.` };
    }

    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        return { ok: false, error: `ARCUI_BRIDGE_URL must use http:// or https://, got '${parsed.protocol}'.` };
    }

    // WHATWG URL returns IPv6 hostnames with literal brackets (e.g. "[::1]").
    // Strip them so the comparison hits "::1" as expected.
    const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
    const isLoopback = host === "localhost" || host === "127.0.0.1" || host === "::1";

    if (parsed.protocol === "http:" && !isLoopback && !allowInsecure) {
        return {
            ok: false,
            error:
                `Refusing to use ARCUI_BRIDGE_URL='${raw}'. ` +
                `Plain HTTP to a non-loopback host would send the bearer token and ` +
                `all DataStore traffic in cleartext. Use https://, or set ` +
                `ARCUI_BRIDGE_ALLOW_INSECURE=true if this is a trusted private link ` +
                `(e.g., a VPN tunnel) and you accept the risk.`,
        };
    }

    let warning;
    if (parsed.protocol === "http:" && !isLoopback && allowInsecure) {
        warning =
            `ARCUI_BRIDGE_ALLOW_INSECURE=true. ` +
            `Sending bearer token in cleartext to ${parsed.host}. ` +
            `Only do this on a trusted private link.`;
    }

    return { ok: true, url: raw, warning };
}

// Thin module-level wrapper: applies the pure guard against the current env
// and either returns the validated URL or terminates the process. The exit
// path is intentionally outside evaluateBridgeUrl so the latter stays unit-
// testable without spawning child processes.
function resolveSecureBaseUrl() {
    const result = evaluateBridgeUrl(
        process.env.ARCUI_BRIDGE_URL || "http://localhost:17842",
        { allowInsecure: process.env.ARCUI_BRIDGE_ALLOW_INSECURE === "true" },
    );

    if (!result.ok) {
        process.stderr.write(`[arcui-mcp] FATAL: ${result.error}\n`);
        process.exit(1);
    }
    if (result.warning) {
        process.stderr.write(`[arcui-mcp] WARNING: ${result.warning}\n`);
    }
    return result.url;
}

const BASE_URL = resolveSecureBaseUrl();
const TOKEN = process.env.ARCUI_BRIDGE_TOKEN || "";
const TIMEOUT_MS = parseInt(process.env.ARCUI_BRIDGE_TIMEOUT_MS || "5000", 10);

/**
 * @param {Record<string, string>} [extra]
 * @returns {Record<string, string>}
 */
function buildHeaders(extra = {}) {
    /** @type {Record<string, string>} */
    const h = { "Accept": "application/json", ...extra };
    if (TOKEN) h["Authorization"] = `Bearer ${TOKEN}`;
    return h;
}

/**
 * @param {string} method
 * @param {string} path
 * @param {RequestOpts} [opts]
 * @returns {Promise<any>}
 */
async function request(method, path, { query, body } = {}) {
    const url = new URL(BASE_URL + path);
    if (query) {
        for (const [k, v] of Object.entries(query)) {
            if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
        }
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

    try {
        const res = await fetch(url, {
            method,
            headers: buildHeaders(body ? { "Content-Type": "application/json" } : {}),
            body: body ? JSON.stringify(body) : undefined,
            signal: controller.signal,
        });

        const text = await res.text();
        let parsed;
        try { parsed = text ? JSON.parse(text) : {}; }
        catch { throw new Error(`Bridge returned non-JSON (status ${res.status}): ${text.slice(0, 200)}`); }

        if (!res.ok) {
            const msg = parsed?.error || parsed?.message || res.statusText;
            throw new Error(`Bridge ${res.status}: ${msg}`);
        }
        return parsed;
    } catch (err) {
        if (err.name === "AbortError") {
            throw new Error(`Bridge request timed out after ${TIMEOUT_MS}ms. Is Unity in Play Mode with ArcHMIMcpBridge enabled?`);
        }
        if (err.code === "ECONNREFUSED" || /ECONNREFUSED|fetch failed/i.test(err.message)) {
            throw new Error(`Cannot reach ArcUI bridge at ${BASE_URL}. Start Unity Play Mode with ArcHMIMcpBridge component.`);
        }
        throw err;
    } finally {
        clearTimeout(timer);
    }
}

/**
 * Performs the protocol handshake against the bridge.
 *
 * Sequence:
 *   1. GET /mcp/schema
 *   2. If 404 → assume legacy bridge (pre-handshake), log a warning, return
 *      a permissive default so the connector keeps working.
 *   3. If any other error (timeout, ECONNREFUSED) → propagate to caller; the
 *      connector treats handshake failure as FATAL.
 *   4. Parse protocol_version. Major mismatch → throw with a clear message so
 *      the caller can exit before exposing any tool to the MCP client.
 *
 * Returns the schema document. Caller is expected to cache it for the
 * process lifetime.
 */
export async function handshake() {
    let schema;
    try {
        schema = await request("GET", "/mcp/schema");
    } catch (err) {
        if (/Bridge 404/.test(err.message)) {
            process.stderr.write(
                `[arcui-mcp] WARNING: bridge has no /mcp/schema endpoint. ` +
                `Assuming legacy protocol ${LEGACY_FALLBACK.protocol_version} with all capabilities enabled. ` +
                `Update the SDK to enable capability-aware tool filtering.\n`,
            );
            return LEGACY_FALLBACK;
        }
        // Network failures: the bridge isn't up yet. Don't block startup — the
        // MCP client may have been launched before Unity Play Mode. Individual
        // tool calls will surface a clear error when actually invoked.
        if (/Bridge request timed out|Cannot reach ArcUI bridge/.test(err.message)) {
            process.stderr.write(
                `[arcui-mcp] WARNING: bridge unreachable at handshake (${err.message}). ` +
                `Continuing with permissive tool catalog; tool calls will fail until ` +
                `the bridge becomes reachable.\n`,
            );
            return LEGACY_FALLBACK;
        }
        throw err;
    }

    const remoteVersion = String(schema.protocol_version || "");
    const remoteMajor = parseInt(remoteVersion.split(".")[0], 10);
    if (!Number.isFinite(remoteMajor)) {
        throw new Error(
            `Bridge returned an unparseable protocol_version: '${remoteVersion}'.`,
        );
    }
    if (remoteMajor !== SUPPORTED_PROTOCOL_MAJOR) {
        throw new Error(
            `Bridge protocol ${remoteVersion} is incompatible with this connector ` +
            `(supports MAJOR=${SUPPORTED_PROTOCOL_MAJOR}.x). ` +
            `Update either ArcHMIMcpBridge.PROTOCOL_VERSION on the Unity side ` +
            `or the connector to match.`,
        );
    }

    return schema;
}

export const bridge = {
    baseUrl: BASE_URL,
    hasAuth: Boolean(TOKEN),

    handshake,
    schema:         /** @returns {Promise<any>} */ ()                          => request("GET",  "/mcp/schema"),
    ping:           /** @returns {Promise<any>} */ ()                          => request("GET",  "/mcp/ping"),
    stats:          /** @returns {Promise<any>} */ ()                          => request("GET",  "/mcp/stats"),
    listTags:       /** @returns {Promise<any>} */ ()                          => request("GET",  "/mcp/tags"),
    getTag:         /** @param {string} key */     (key)                       => request("GET",  "/mcp/tag", { query: { key } }),
    activeAlarms:   /** @returns {Promise<any>} */ ()                          => request("GET",  "/mcp/alarms/active"),
    alarmHistory:   /** @param {number} limit */   (limit)                     => request("GET",  "/mcp/alarms/history", { query: { limit } }),
    triggerAlarm:   /** @param {any} payload */    (payload)                   => request("POST", "/mcp/alarms/trigger", { body: payload }),
    health:         /** @returns {Promise<any>} */ ()                          => request("GET",  "/mcp/health"),
    report:         /** @param {any} payload */    (payload)                   => request("POST", "/mcp/report", { body: payload }),

    // ── Training (scenario authoring + live session) ─────────────────────────
    createScenario:   /** @param {any} payload */ (payload)                    => request("POST", "/mcp/scenario/create",  { body: payload }),
    startScenario:    /** @param {any} payload */ (payload)                    => request("POST", "/mcp/scenario/start",   { body: payload }),
    listScenarios:    /** @returns {Promise<any>} */ ()                        => request("GET",  "/mcp/scenario/list"),
    injectEvent:      /** @param {any} payload */ (payload)                    => request("POST", "/mcp/session/inject",   { body: payload }),
    sendInstructorMessage: /** @param {any} payload */ (payload)               => request("POST", "/mcp/session/instructor-message", { body: payload }),
    evaluateSession:  /** @returns {Promise<any>} */ ()                        => request("GET",  "/mcp/session/evaluate"),
    startSession:     /** @param {any} payload */ (payload)                    => request("POST", "/mcp/session/start",    { body: payload }),
    endSession:       /** @returns {Promise<any>} */ ()                        => request("POST", "/mcp/session/end",      { body: {} }),
    annotateSession:  /** @param {any} payload */ (payload)                    => request("POST", "/mcp/session/annotate", { body: payload }),

    // ── TimeMachine (playback control) ───────────────────────────────────────
    timeMachinePlay:     /** @returns {Promise<any>} */ ()                     => request("POST", "/mcp/timemachine/play"),
    timeMachinePause:    /** @returns {Promise<any>} */ ()                     => request("POST", "/mcp/timemachine/pause"),
    timeMachineSeek:     /** @param {number} target_time */ (target_time)      => request("POST", "/mcp/timemachine/seek", { body: { target_time: target_time.toString() } }),
    timeMachineForecast: /** @param {string} tag @param {number} lookahead */ (tag, lookahead) => request("POST", "/mcp/timemachine/forecast", { body: { tag, lookahead_seconds: lookahead.toString() } }),
};
