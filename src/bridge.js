/**
 * ArcUI MCP Bridge Client
 * ─────────────────────────────────────────────────────────────────────────
 * Thin HTTP client that talks to ArcHMIMcpBridge.cs running inside Unity.
 * All tool handlers delegate to this module so that the MCP server itself
 * stays stateless and testable.
 *
 * Configuration via environment variables:
 *   ARCUI_BRIDGE_URL    default: http://localhost:17842
 *   ARCUI_BRIDGE_TOKEN  optional: must match ArcHMIMcpBridge.authToken
 *   ARCUI_BRIDGE_TIMEOUT_MS  default: 5000
 */

const BASE_URL = (process.env.ARCUI_BRIDGE_URL || "http://localhost:17842").replace(/\/+$/, "");
const TOKEN = process.env.ARCUI_BRIDGE_TOKEN || "";
const TIMEOUT_MS = parseInt(process.env.ARCUI_BRIDGE_TIMEOUT_MS || "5000", 10);

function buildHeaders(extra = {}) {
    const h = { "Accept": "application/json", ...extra };
    if (TOKEN) h["Authorization"] = `Bearer ${TOKEN}`;
    return h;
}

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

export const bridge = {
    baseUrl: BASE_URL,
    hasAuth: Boolean(TOKEN),

    ping:           ()                 => request("GET",  "/mcp/ping"),
    stats:          ()                 => request("GET",  "/mcp/stats"),
    listTags:       ()                 => request("GET",  "/mcp/tags"),
    getTag:         (key)              => request("GET",  "/mcp/tag", { query: { key } }),
    activeAlarms:   ()                 => request("GET",  "/mcp/alarms/active"),
    alarmHistory:   (limit)            => request("GET",  "/mcp/alarms/history", { query: { limit } }),
    triggerAlarm:   (payload)          => request("POST", "/mcp/alarms/trigger", { body: payload }),
    health:         ()                 => request("GET",  "/mcp/health"),
    report:         (payload)          => request("POST", "/mcp/report", { body: payload }),
};
