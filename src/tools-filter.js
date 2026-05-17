/**
 * ArcUI MCP — Capability-based Tool Filter
 * ─────────────────────────────────────────────────────────────────────────
 * Pure data + pure function. Extracted from server.js so unit tests can
 * exercise the filter without booting the stdio MCP server.
 *
 * The bridge advertises which subsystems are wired via the schema handshake
 * (GET /mcp/schema, see ArcHMIMcpBridge.PROTOCOL_VERSION). For each tool that
 * depends on a bridge subsystem, this map declares which capability flag
 * must be true. Tools not present in the map are treated as core (always
 * available) or as client-side stubs that never call the bridge.
 */

/** @type {Readonly<Record<string, string>>} */
export const TOOL_CAPABILITY = Object.freeze({
    // Operations
    "get_active_alarms":       "alarms",
    "get_alarm_history":       "alarms",
    "trigger_alarm":           "alarms",
    "generate_report":         "reports",

    // Training
    "create_scenario":         "training",
    "start_scenario":          "training",
    "list_scenarios":          "training",
    "inject_event":            "training",
    "evaluate_session":        "training",
    "start_session":           "training",
    "end_session":             "training",
    "annotate_session":        "training",
    "send_instructor_message": "instructor_messages",

    // TimeMachine
    "timemachine_play":        "timemachine",
    "timemachine_pause":       "timemachine",
    "timemachine_seek":        "timemachine",
    "timemachine_forecast":    "timemachine",
});

/**
 * Returns the subset of `tools` whose required capability is enabled in
 * `capabilities`. Tools without a mapped capability pass through unchanged.
 *
 * `capabilities` may be null or undefined — both behave like an empty
 * record (every capability-gated tool is filtered out).
 *
 * @param {Array<{name: string}>} tools
 * @param {Record<string, any> | null | undefined} capabilities
 * @returns {Array<{name: string}>}
 */
export function filterToolsByCapabilities(tools, capabilities) {
    const caps = capabilities || {};
    return tools.filter((t) => {
        const required = TOOL_CAPABILITY[t.name];
        if (!required) return true;
        return caps[required] === true;
    });
}
