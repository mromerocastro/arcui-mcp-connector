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
import { geminiFileSearch } from "./gemini-file-search.js";

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

// ─── Training Tools ────────────────────────────────────────────────────────
//
// Scenario authoring + live session control. The instructor can author a
// scenario, register it in the running ArcUI bridge, kick off playback on
// the in-Unity ArcHMIScenarioRunner, push live tag injections during the
// run, and read back the chronological session record for debrief.
//
// ArcUI side: requires the scene to boot in Training mode
// (ArcHMIContractLoader.runtimeMode = Training) and to have an
// ArcHMIScenarioRunner + ArcHMITrainingSession somewhere in the scene.
const TRAINING_TOOLS = [
    {
        name: "create_scenario",
        description:
            "Author a Training scenario from a JSON description and register it in the ArcUI bridge. " +
            "The scenario is a list of timed events; each event writes a value to a DataStore tag at " +
            "offset_seconds after playback starts. The bridge returns a scenario_id that 'start_scenario' " +
            "consumes. Use this when the user asks to 'create a training case', 'simulate a fault', or " +
            "'design an exercise around a specific failure mode'.",
        inputSchema: {
            type: "object",
            properties: {
                id: {
                    type: "string",
                    description: "Stable identifier for the scenario (e.g. 'welder-argon-loss-001'). " +
                                 "Re-using an id overwrites the prior scenario in the registry.",
                },
                display_name: {
                    type: "string",
                    description: "Short human-readable title shown in instructor tooling.",
                },
                description: {
                    type: "string",
                    description: "Operator-facing briefing. The ARIA tutor may surface this at scenario start.",
                },
                events: {
                    type: "array",
                    description: "Scripted timeline. Each entry writes one value to one tag at offset_seconds.",
                    items: {
                        type: "object",
                        properties: {
                            offset_seconds: { type: "number", minimum: 0, description: "Seconds after playback starts when this event fires." },
                            tag_key:        { type: "string",  description: "DataStore tag key to write." },
                            value_type:     { type: "string", enum: ["Float", "Int", "Bool", "String"], default: "Float" },
                            raw_value:      { type: "string", description: "Value as a string. Parsed via InvariantCulture by ArcUI." },
                            description:    { type: "string", description: "Optional human note for journals and inspectors." },
                        },
                        required: ["tag_key", "value_type", "raw_value"],
                    },
                },
            },
            required: ["id"],
        },
    },
    {
        name: "start_scenario",
        description:
            "Begin playback of a registered scenario on the scene's ArcHMIScenarioRunner. Refuses if no " +
            "runner is present in the scene, if the scene is not in Training mode, or if the scenario_id " +
            "is unknown. Pair with 'list_scenarios' to discover available ids.",
        inputSchema: {
            type: "object",
            properties: {
                scenario_id: { type: "string", description: "Id returned by 'create_scenario'." },
            },
            required: ["scenario_id"],
        },
    },
    {
        name: "list_scenarios",
        description:
            "Enumerate every scenario currently registered in the ArcUI bridge, with id, display name, " +
            "description, and event count. Use this to introspect what the trainee can run.",
        inputSchema: { type: "object", properties: {} },
    },
    {
        name: "inject_event",
        description:
            "Write a single value to a DataStore tag during a live training session. Attributed to the " +
            "'training_scenario' writer in the audit trail so it is distinguishable from trainee actions " +
            "or live operator commands. Use this for ad-hoc instructor moves like 'make it harder' or " +
            "'force a specific value right now', without authoring a full scenario.",
        inputSchema: {
            type: "object",
            properties: {
                tag_key:    { type: "string",  description: "DataStore tag key to write." },
                value_type: { type: "string", enum: ["Float", "Int", "Bool", "String"], default: "Float" },
                raw_value:  { type: "string",  description: "Value as a string. Parsed via InvariantCulture by ArcUI." },
            },
            required: ["tag_key", "value_type", "raw_value"],
        },
    },
    {
        name: "evaluate_session",
        description:
            "Read the active ArcHMITrainingSession's chronological record: alarm activations, " +
            "acknowledgements, resolutions, and tag changes captured so far. Returns the raw event " +
            "list for the LLM to turn into a debrief narrative. When no session is active, the " +
            "response carries active=false and an empty events array.",
        inputSchema: { type: "object", properties: {} },
    },
];

const KNOWLEDGE_TOOLS = [
    {
        name: "knowledge_status",
        description:
            "Return Gemini File Search configuration status for ArcUI Knowledge Packs. " +
            "Use this before indexing or querying knowledge so setup issues are explicit.",
        inputSchema: { type: "object", properties: {} },
    },
    {
        name: "create_knowledge_store",
        description:
            "Create a Gemini File Search store for an ArcUI Knowledge Pack. " +
            "Use one store per system/equipment when possible, e.g. MQTT_Turbine.",
        inputSchema: {
            type: "object",
            properties: {
                display_name: {
                    type: "string",
                    description: "Human-readable store name, e.g. 'ArcUI MQTT Turbine Knowledge'.",
                },
                embedding_model: {
                    type: "string",
                    default: "models/gemini-embedding-2",
                    description: "Embedding model for the store.",
                },
            },
        },
    },
    {
        name: "list_knowledge_stores",
        description:
            "List Gemini File Search stores visible to the configured Gemini API key.",
        inputSchema: { type: "object", properties: {} },
    },
    {
        name: "list_knowledge_documents",
        description:
            "List documents already indexed into an ArcUI Knowledge Pack / Gemini File Search store.",
        inputSchema: {
            type: "object",
            properties: {
                store_name: {
                    type: "string",
                    description: "Store resource name, e.g. 'fileSearchStores/my-store'. Defaults to ARCUI_KNOWLEDGE_STORE.",
                },
            },
        },
    },
    {
        name: "index_knowledge_file",
        description:
            "Upload and index one local document into the configured Gemini File Search store. " +
            "Use for approved manuals, SOPs, context.json files, prompts, protocols, and scenario references.",
        inputSchema: {
            type: "object",
            properties: {
                path: {
                    type: "string",
                    description: "Absolute or working-directory-relative path to a local file.",
                },
                store_name: {
                    type: "string",
                    description: "Store resource name. Defaults to ARCUI_KNOWLEDGE_STORE.",
                },
                display_name: {
                    type: "string",
                    description: "Citation-visible document name.",
                },
                metadata: {
                    type: "object",
                    description:
                        "Optional filterable metadata, e.g. { system:'MQTT_Turbine', domain:'training', approved:'true' }.",
                },
                max_tokens_per_chunk: {
                    type: "integer",
                    minimum: 1,
                    description: "Optional chunk size override.",
                },
                max_overlap_tokens: {
                    type: "integer",
                    minimum: 0,
                    description: "Optional chunk overlap override.",
                },
                wait: {
                    type: "boolean",
                    default: true,
                    description: "Wait for indexing to complete before returning.",
                },
            },
            required: ["path"],
        },
    },
    {
        name: "search_training_knowledge",
        description:
            "Ask a question against the ArcUI Knowledge Pack using Gemini File Search. " +
            "Returns grounded text plus citations/source chunks when available.",
        inputSchema: {
            type: "object",
            properties: {
                query: { type: "string", description: "Question or retrieval prompt." },
                store_name: { type: "string", description: "Defaults to ARCUI_KNOWLEDGE_STORE." },
                metadata_filter: {
                    type: "string",
                    description: "Optional Gemini metadata filter, e.g. 'system = \"MQTT_Turbine\" AND approved = \"true\"'.",
                },
                instruction: {
                    type: "string",
                    description: "Optional extra instruction prepended to the query.",
                },
                model: {
                    type: "string",
                    description: "Gemini model. Defaults to ARCUI_KNOWLEDGE_MODEL or gemini-3-flash-preview.",
                },
            },
            required: ["query"],
        },
    },
    {
        name: "generate_grounded_scenario",
        description:
            "Generate a draft ArcUI Training scenario grounded in the Knowledge Pack and constrained to live ArcUI tags. " +
            "By default this returns a draft for instructor review; set register=true to send it to Unity create_scenario.",
        inputSchema: {
            type: "object",
            properties: {
                request: {
                    type: "string",
                    description: "Instructor request, e.g. 'Create a brake failure scenario for the turbine'.",
                },
                system: {
                    type: "string",
                    description: "Optional system/equipment name to include in the prompt.",
                },
                constraints: {
                    type: "string",
                    description: "Optional extra constraints for event timing, severity, trainee level, etc.",
                },
                store_name: { type: "string", description: "Defaults to ARCUI_KNOWLEDGE_STORE." },
                metadata_filter: {
                    type: "string",
                    description: "Optional Gemini metadata filter, e.g. 'approved = \"true\"'.",
                },
                register: {
                    type: "boolean",
                    default: false,
                    description: "When true, register the generated scenario in the running Unity bridge.",
                },
                model: { type: "string", description: "Optional Gemini model override." },
            },
            required: ["request"],
        },
    },
    {
        name: "generate_training_debrief",
        description:
            "Generate a grounded debrief for the active ArcUI Training session using the Knowledge Pack. " +
            "The tool reads evaluate_session from Unity unless session_json is provided.",
        inputSchema: {
            type: "object",
            properties: {
                request: {
                    type: "string",
                    description: "Instructor focus for the debrief.",
                },
                session_json: {
                    type: "string",
                    description: "Optional raw session JSON. If omitted, the active Unity session is fetched.",
                },
                store_name: { type: "string", description: "Defaults to ARCUI_KNOWLEDGE_STORE." },
                metadata_filter: {
                    type: "string",
                    description: "Optional Gemini metadata filter, e.g. 'approved = \"true\"'.",
                },
                model: { type: "string", description: "Optional Gemini model override." },
            },
        },
    },
];

// Knowledge tools are gated by ARCUI_ENABLE_KNOWLEDGE_TOOLS so MCP clients
// never see Gemini-backed tools they cannot actually use. knowledge_status
// is always exposed so consumers can discover how to enable the rest.
const ACTIVE_KNOWLEDGE_TOOLS = geminiFileSearch.isEnabled()
    ? KNOWLEDGE_TOOLS
    : KNOWLEDGE_TOOLS.filter((t) => t.name === "knowledge_status");

const ALL_TOOLS = [...OPERATIONS_TOOLS, ...BUILDER_TOOLS, ...TRAINING_TOOLS, ...ACTIVE_KNOWLEDGE_TOOLS];

// ─── Tool Handlers ─────────────────────────────────────────────────────────

function asText(obj) {
    return { content: [{ type: "text", text: typeof obj === "string" ? obj : JSON.stringify(obj, null, 2) }] };
}

function asError(msg) {
    return { content: [{ type: "text", text: msg }], isError: true };
}

async function getLiveTagsForKnowledge() {
    try {
        const result = await bridge.listTags();
        return Array.isArray(result?.tags) ? result.tags : [];
    } catch {
        return [];
    }
}

function parseOptionalJson(raw, fallback = {}) {
    if (!raw) return fallback;
    if (typeof raw === "object") return raw;
    try { return JSON.parse(raw); }
    catch (e) { throw new Error(`session_json is not valid JSON: ${e.message}`); }
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

    // ── Training (Path C of the Training subsystem) ────────────────────────
    create_scenario: async (args) => {
        if (!args?.id) return asError("Parameter 'id' is required.");
        return asText(await bridge.createScenario(args));
    },

    start_scenario: async (args) => {
        if (!args?.scenario_id) return asError("Parameter 'scenario_id' is required.");
        return asText(await bridge.startScenario(args));
    },

    list_scenarios: async () => asText(await bridge.listScenarios()),

    inject_event: async (args) => {
        if (!args?.tag_key)    return asError("Parameter 'tag_key' is required.");
        if (!args?.value_type) return asError("Parameter 'value_type' is required.");
        if (args?.raw_value === undefined || args?.raw_value === null)
            return asError("Parameter 'raw_value' is required.");
        return asText(await bridge.injectEvent(args));
    },

    evaluate_session: async () => asText(await bridge.evaluateSession()),

    // --- Knowledge / RAG (Gemini File Search) -----------------------------
    knowledge_status: async () => asText({
        enabled: geminiFileSearch.isEnabled(),
        indexing_enabled: geminiFileSearch.isIndexingEnabled(),
        gemini_configured: geminiFileSearch.isConfigured(),
        default_store: geminiFileSearch.defaultStoreName() || null,
        default_model: geminiFileSearch.defaultModelName(),
        allowed_roots: geminiFileSearch.allowedRoots(),
        note: !geminiFileSearch.isEnabled()
            ? "Set ARCUI_ENABLE_KNOWLEDGE_TOOLS=true to enable Gemini File Search tools."
            : !geminiFileSearch.isConfigured()
                ? "Set GEMINI_API_KEY or GOOGLE_API_KEY before using knowledge tools."
                : "Gemini File Search is ready. Set ARCUI_KNOWLEDGE_STORE or pass store_name to query/index.",
    }),

    create_knowledge_store: async (args = {}) =>
        asText(await geminiFileSearch.createStore(args)),

    list_knowledge_stores: async () =>
        asText({ stores: await geminiFileSearch.listStores() }),

    list_knowledge_documents: async (args = {}) =>
        asText(await geminiFileSearch.listDocuments(args)),

    index_knowledge_file: async (args = {}) => {
        if (!args?.path) return asError("Parameter 'path' is required.");
        return asText(await geminiFileSearch.indexFile(args));
    },

    search_training_knowledge: async (args = {}) => {
        if (!args?.query) return asError("Parameter 'query' is required.");
        return asText(await geminiFileSearch.search(args));
    },

    generate_grounded_scenario: async (args = {}) => {
        if (!args?.request) return asError("Parameter 'request' is required.");

        const tags = await getLiveTagsForKnowledge();
        const result = await geminiFileSearch.generateScenario({
            ...args,
            tags,
        });

        if (args.register) {
            const scenario = result.scenario;
            result.registration = await bridge.createScenario({
                id: scenario.id,
                display_name: scenario.display_name,
                description: scenario.description,
                events: scenario.events || [],
            });
        }

        return asText(result);
    },

    generate_training_debrief: async (args = {}) => {
        const session = args.session_json
            ? parseOptionalJson(args.session_json)
            : await bridge.evaluateSession();

        return asText(await geminiFileSearch.generateDebrief({
            ...args,
            session,
        }));
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
