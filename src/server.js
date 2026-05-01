#!/usr/bin/env node
/**
 * ArcUI MCP Server
 * ─────────────────────────────────────────────────────────────────────────
 * Stdio MCP server that exposes ArcUI domain knowledge (sensor tags, alarms,
 * system health, narrative reports) to any MCP-compatible client:
 *   • Claude Desktop   (operators, debugging)
 *   • Unity AI Assistant 2.6+ (Builder Mode, in-Editor)
 *   • Cursor / other IDE clients
 *
 * The server is a thin translator: every tool call is proxied to the
 * ArcHMIMcpBridge HTTP endpoint running inside Unity. No state is kept here.
 *
 * Run:
 *   node src/server.js
 *
 * MCP clients launch this process themselves over stdio — you do not run it
 * manually when connecting to Claude Desktop / Unity AI Assistant.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { bridge } from "./bridge.js";

// ─── Tool Catalog ──────────────────────────────────────────────────────────

const OPERATIONS_TOOLS = [
    {
        name: "get_sensor_value",
        description:
            "Read the current live value of a DataStore tag (sensor reading, status flag, counter, etc.). " +
            "Returns the value, its runtime type, and the tag key. " +
            "Use this before making any claim about the state of the plant — never guess values.",
        inputSchema: {
            type: "object",
            properties: {
                tag: { type: "string", description: "DataStore tag key (e.g. 'Reactor.Temperature')." },
            },
            required: ["tag"],
        },
    },
    {
        name: "list_sensors",
        description:
            "List every tag currently registered in the ArcUI DataStore, with current value and type. " +
            "Useful as a first step when the user's query does not specify an exact tag name.",
        inputSchema: { type: "object", properties: {} },
    },
    {
        name: "get_active_alarms",
        description:
            "Return every alarm currently in Active or Acknowledged state, ordered by severity. " +
            "Use this when the user asks about current problems, warnings, or system status.",
        inputSchema: { type: "object", properties: {} },
    },
    {
        name: "get_alarm_history",
        description:
            "Return the most recent resolved alarms from the in-memory audit log. " +
            "Use this when the user asks about past incidents, trends, or 'what happened earlier'.",
        inputSchema: {
            type: "object",
            properties: {
                limit: {
                    type: "integer",
                    minimum: 1,
                    maximum: 500,
                    default: 50,
                    description: "Maximum number of records to return.",
                },
            },
        },
    },
    {
        name: "trigger_alarm",
        description:
            "Register and activate a new alarm for a given DataStore tag. " +
            "Use this when the AI agent detects a condition that warrants operator attention. " +
            "This does NOT enact any physical change — it only raises a visible alert in the HMI. " +
            "Physical state changes remain gated by the Semantic Command Bridge (HITL authorization).",
        inputSchema: {
            type: "object",
            properties: {
                tag:       { type: "string", description: "DataStore tag key being alarmed on." },
                level:     { type: "string", enum: ["info", "warning", "critical"], default: "warning" },
                message:   { type: "string", description: "Human-readable alarm message. Supports {tag} and {value} placeholders." },
                threshold: { type: "number", description: "Threshold value that triggered this alarm (optional, informational)." },
            },
            required: ["tag"],
        },
    },
    {
        name: "get_system_health",
        description:
            "Return the overall system health report: provider connectivity, uptime, tag count, warnings. " +
            "Status is one of 'healthy' | 'degraded' | 'critical'. " +
            "Use this to answer questions about the reliability or stability of the system.",
        inputSchema: { type: "object", properties: {} },
    },
    {
        name: "generate_report",
        description:
            "Build a structured operational report snapshot (tag values, active alarms, recent history, health). " +
            "Returns the data package plus a ready-to-use prompt string that an LLM can turn into a narrative report. " +
            "Use this when the user asks for a shift summary, incident report, or operational brief.",
        inputSchema: {
            type: "object",
            properties: {
                type:         { type: "string", enum: ["shift", "on-demand", "incident"], default: "on-demand" },
                requested_by: { type: "string", default: "mcp" },
            },
        },
    },
];

// Builder Mode stubs (Month 4+ of the roadmap).
// These are intentionally simple and do not mutate the project yet.
const BUILDER_TOOLS = [
    {
        name: "get_protocol_config",
        description:
            "Return a recommended ArcUI data-provider configuration for a given industry and equipment class. " +
            "Used by the ArcUI Builder flow to pre-fill MQTT/REST/WebSocket settings.",
        inputSchema: {
            type: "object",
            properties: {
                industry:  { type: "string", description: "e.g. 'energy', 'medical', 'defense', 'industrial'." },
                equipment: { type: "string", description: "e.g. 'wind-turbine', 'reactor', 'infusion-pump'." },
            },
            required: ["industry", "equipment"],
        },
    },
    {
        name: "validate_context_layer",
        description:
            "Validate a Context Layer JSON object (the _context.json used by ARIA) against the minimum required schema. " +
            "Returns { valid, errors } — errors is an array of human-readable issues.",
        inputSchema: {
            type: "object",
            properties: {
                json: { type: "string", description: "Raw JSON string to validate." },
            },
            required: ["json"],
        },
    },
    {
        name: "generate_pilot_scope",
        description:
            "Produce a scope outline for a pilot deployment: phases, timeline, deliverables, estimated budget range. " +
            "Template-based — intended as a starting point for the Builder, not a contractual quote.",
        inputSchema: {
            type: "object",
            properties: {
                vertical: { type: "string", description: "'energy' | 'medical' | 'defense' | 'industrial' | ..." },
                timeline: { type: "string", description: "e.g. '6 weeks', '3 months'." },
            },
            required: ["vertical"],
        },
    },
    {
        name: "list_available_tags",
        description:
            "List tag names typically available for a given vertical, based on ArcUI's reference context library. " +
            "Useful when drafting a new Context Layer and you need a starting point for the tag list.",
        inputSchema: {
            type: "object",
            properties: {
                vertical: { type: "string", description: "'energy' | 'medical' | 'defense' | 'industrial' | ..." },
            },
            required: ["vertical"],
        },
    },
];

const ALL_TOOLS = [...OPERATIONS_TOOLS, ...BUILDER_TOOLS];

// ─── Tool Handlers ─────────────────────────────────────────────────────────

function asText(obj) {
    return { content: [{ type: "text", text: typeof obj === "string" ? obj : JSON.stringify(obj, null, 2) }] };
}

function asError(msg) {
    return { content: [{ type: "text", text: msg }], isError: true };
}

const HANDLERS = {
    // ── Operations ─────────────────────────────────────────────────────────
    get_sensor_value: async ({ tag }) => {
        if (!tag) return asError("Parameter 'tag' is required.");
        return asText(await bridge.getTag(tag));
    },
    list_sensors: async () => asText(await bridge.listTags()),
    get_active_alarms: async () => asText(await bridge.activeAlarms()),
    get_alarm_history: async ({ limit = 50 } = {}) => asText(await bridge.alarmHistory(limit)),
    trigger_alarm: async (args) => {
        if (!args?.tag) return asError("Parameter 'tag' is required.");
        return asText(await bridge.triggerAlarm(args));
    },
    get_system_health: async () => asText(await bridge.health()),
    generate_report: async (args = {}) => asText(await bridge.report(args)),

    // ── Builder (static stubs — Month 4+ of the roadmap) ───────────────────
    get_protocol_config: async ({ industry, equipment }) => {
        const catalog = {
            "energy/wind-turbine":   { protocol: "MQTT",   broker: "mqtt://broker.local:1883", tags: ["rotor_rpm", "pitch_angle", "wind_speed", "grid_power"] },
            "energy/solar-farm":     { protocol: "MQTT",   broker: "mqtt://broker.local:1883", tags: ["dc_voltage", "inverter_temp", "ac_power", "irradiance"] },
            "medical/infusion-pump": { protocol: "REST",   baseUrl: "http://device.local/api", tags: ["flow_rate", "volume_delivered", "occlusion"] },
            "industrial/reactor":    { protocol: "OPC-UA", endpoint: "opc.tcp://plc.local:4840", tags: ["temperature", "pressure", "agitation_rpm"] },
            "defense/radar":         { protocol: "WebSocket", url: "wss://radar.local/ws", tags: ["track_count", "mode", "range_km"] },
        };
        const key = `${industry}/${equipment}`.toLowerCase();
        return asText({
            match: key,
            recommendation: catalog[key] || { protocol: "REST", note: "No reference entry — using REST default.", tags: [] },
            note: "Stub implementation — Month 4+ will read from the ArcUI reference context library.",
        });
    },

    validate_context_layer: async ({ json }) => {
        const errors = [];
        let parsed;
        try { parsed = JSON.parse(json); }
        catch (e) { return asText({ valid: false, errors: [`JSON parse error: ${e.message}`] }); }

        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
            errors.push("Root must be a JSON object.");
        if (!parsed?.system_name)   errors.push("Missing required field: 'system_name'.");
        if (!Array.isArray(parsed?.tags)) errors.push("Missing or invalid 'tags' array.");
        else {
            parsed.tags.forEach((t, i) => {
                if (!t?.name)  errors.push(`tags[${i}]: missing 'name'.`);
                if (!t?.unit && t?.type !== "state") errors.push(`tags[${i}]: missing 'unit' for numeric tag.`);
            });
        }
        return asText({ valid: errors.length === 0, errors });
    },

    generate_pilot_scope: async ({ vertical, timeline = "8 weeks" }) => {
        const base = {
            vertical,
            timeline,
            phases: [
                { name: "Discovery",   duration: "1 week",  deliverables: ["Stakeholder map", "Data inventory", "Risk register"] },
                { name: "Integration", duration: "3 weeks", deliverables: ["Data provider config", "Context Layer v1", "Initial widgets"] },
                { name: "ARIA tuning", duration: "2 weeks", deliverables: ["Domain prompt", "Alarm rules", "HITL commands"] },
                { name: "Pilot run",   duration: "2 weeks", deliverables: ["Operator training", "Shift reports", "Handoff doc"] },
            ],
            estimated_budget_usd: { low: 35000, high: 85000 },
            assumptions: [
                "Client provides live or simulated data endpoints.",
                "One hardware target (Quest 3 or equivalent).",
                "Single language deployment.",
            ],
            disclaimer: "Template output — not a contractual quote.",
        };
        return asText(base);
    },

    list_available_tags: async ({ vertical }) => {
        const catalogs = {
            energy:     ["rotor_rpm", "pitch_angle", "wind_speed", "grid_power", "dc_voltage", "ac_power", "irradiance"],
            medical:    ["heart_rate", "spo2", "flow_rate", "volume_delivered", "occlusion", "battery_level"],
            defense:    ["track_count", "mode", "range_km", "azimuth", "threat_level"],
            industrial: ["temperature", "pressure", "agitation_rpm", "valve_state", "level_pct", "ph"],
        };
        const v = (vertical || "").toLowerCase();
        return asText({
            vertical: v,
            tags: catalogs[v] || [],
            note: catalogs[v] ? "Reference tag names — adapt to your specific equipment." : "Unknown vertical; provide one of: energy, medical, defense, industrial.",
        });
    },
};

// ─── Wire up MCP Server ────────────────────────────────────────────────────

const server = new Server(
    { name: "arcui-mcp", version: "0.1.0" },
    { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: ALL_TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const name = req.params?.name;
    const args = req.params?.arguments || {};
    const handler = HANDLERS[name];
    if (!handler) return asError(`Unknown tool: ${name}`);

    try { return await handler(args); }
    catch (e)   { return asError(`${name} failed: ${e.message}`); }
});

// ─── Startup ───────────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);

// MCP spec: servers MUST NOT write to stdout (reserved for JSON-RPC).
// Diagnostic logs go to stderr.
process.stderr.write(
    `[arcui-mcp] ready — bridge=${bridge.baseUrl} auth=${bridge.hasAuth ? "on" : "off"} tools=${ALL_TOOLS.length}\n`,
);
