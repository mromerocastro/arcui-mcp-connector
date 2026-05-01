#!/usr/bin/env node
/**
 * Standalone sanity check for the ArcUI HTTP bridge.
 * Run this BEFORE plugging the MCP server into Claude Desktop / Unity AI Assistant
 * so any connectivity issues surface with a clear error instead of a silent
 * "tool unavailable" state inside the client.
 *
 * Usage:
 *   npm run check-bridge
 *   ARCUI_BRIDGE_URL=http://localhost:17842 npm run check-bridge
 */

import { bridge } from "./bridge.js";

const ok   = (s) => console.log(`\x1b[32m✓\x1b[0m ${s}`);
const fail = (s) => console.log(`\x1b[31m✗\x1b[0m ${s}`);
const info = (s) => console.log(`  ${s}`);

let exitCode = 0;

console.log(`\nArcUI bridge check — target: ${bridge.baseUrl} (auth: ${bridge.hasAuth ? "on" : "off"})\n`);

try {
    const p = await bridge.ping();
    ok(`ping → ${p.product} v${p.version} @ ${p.timestamp}`);
} catch (e) {
    fail(`ping failed: ${e.message}`);
    console.log("\nFix: open Unity, enter Play Mode, confirm the ArcHMIMcpBridge component is enabled.\n");
    process.exitCode = 1;
}

try {
    const t = await bridge.listTags();
    ok(`listTags → ${t.tags.length} registered`);
    for (const tag of t.tags.slice(0, 5)) info(`${tag.key}  (${tag.type}) = ${JSON.stringify(tag.value)}`);
    if (t.tags.length > 5) info(`… and ${t.tags.length - 5} more`);
} catch (e) { fail(`listTags: ${e.message}`); exitCode = 1; }

try {
    const h = await bridge.health();
    ok(`health → status=${h.status}, providers=${h.connected}/${h.total}, tags=${h.tag_count}`);
    if (h.warnings?.length) for (const w of h.warnings) info(`⚠ ${w}`);
} catch (e) { fail(`health: ${e.message}`); exitCode = 1; }

try {
    const a = await bridge.activeAlarms();
    ok(`activeAlarms → ${a.count} active, max severity = ${a.max_severity}`);
} catch (e) { fail(`activeAlarms: ${e.message}`); exitCode = 1; }

console.log();
process.exitCode = exitCode;
