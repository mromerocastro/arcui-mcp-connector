import { test } from "node:test";
import assert from "node:assert/strict";
import { filterToolsByCapabilities, TOOL_CAPABILITY } from "../src/tools-filter.js";

// Sample tool catalog mirroring what server.js assembles. We test the filter
// in isolation — the actual catalog content is verified by integration use.
const SAMPLE_TOOLS = [
    { name: "get_sensor_value" },        // core, no capability needed
    { name: "list_sensors" },            // core
    { name: "trigger_alarm" },           // alarms
    { name: "get_active_alarms" },       // alarms
    { name: "generate_report" },         // reports
    { name: "create_scenario" },         // training
    { name: "send_instructor_message" }, // instructor_messages
    { name: "timemachine_play" },        // timemachine
    { name: "timemachine_forecast" },    // timemachine
    { name: "knowledge_status" },        // client-side, no bridge capability
];

test("full capabilities returns every tool", () => {
    const filtered = filterToolsByCapabilities(SAMPLE_TOOLS, {
        alarms: true, reports: true, training: true,
        instructor_messages: true, timemachine: true,
    });
    assert.equal(filtered.length, SAMPLE_TOOLS.length);
});

test("empty capabilities object hides every bridge-dependent tool", () => {
    const filtered = filterToolsByCapabilities(SAMPLE_TOOLS, {});
    const names = filtered.map(t => t.name);

    // Core + client-side stubs survive
    assert.ok(names.includes("get_sensor_value"));
    assert.ok(names.includes("list_sensors"));
    assert.ok(names.includes("knowledge_status"));

    // Every capability-gated tool is gone
    assert.ok(!names.includes("trigger_alarm"));
    assert.ok(!names.includes("create_scenario"));
    assert.ok(!names.includes("timemachine_play"));
});

test("null/undefined capabilities behaves like empty object", () => {
    const filteredNull  = filterToolsByCapabilities(SAMPLE_TOOLS, null);
    const filteredUndef = filterToolsByCapabilities(SAMPLE_TOOLS, undefined);
    const filteredEmpty = filterToolsByCapabilities(SAMPLE_TOOLS, {});
    assert.equal(filteredNull.length,  filteredEmpty.length);
    assert.equal(filteredUndef.length, filteredEmpty.length);
});

test("partial capabilities filters precisely", () => {
    // Bridge built with only alarms + reports (no training, no timemachine).
    const filtered = filterToolsByCapabilities(SAMPLE_TOOLS, {
        alarms: true, reports: true,
        training: false, instructor_messages: false, timemachine: false,
    });
    const names = filtered.map(t => t.name);

    assert.ok(names.includes("trigger_alarm"),    "alarms enabled");
    assert.ok(names.includes("generate_report"),  "reports enabled");
    assert.ok(!names.includes("create_scenario"), "training disabled");
    assert.ok(!names.includes("send_instructor_message"), "instructor_messages disabled");
    assert.ok(!names.includes("timemachine_play"),     "timemachine disabled");
    assert.ok(!names.includes("timemachine_forecast"), "timemachine disabled (all variants)");
});

test("capability value must be strictly true (truthy is not enough)", () => {
    // Bridge protocol says capability is BOOLEAN. We refuse to interpret
    // "yes" / 1 / non-empty-string as enabled to avoid coercion surprises.
    const filtered = filterToolsByCapabilities(SAMPLE_TOOLS, {
        alarms: 1,           // truthy but not boolean true
        reports: "true",     // truthy string
        training: true,      // the real thing
    });
    const names = filtered.map(t => t.name);

    assert.ok(!names.includes("trigger_alarm"),   "alarms=1 must not enable");
    assert.ok(!names.includes("generate_report"), "reports='true' must not enable");
    assert.ok(names.includes("create_scenario"),  "training=true enables");
});

test("TOOL_CAPABILITY map is frozen against accidental mutation", () => {
    assert.ok(Object.isFrozen(TOOL_CAPABILITY));
});

test("every TOOL_CAPABILITY entry points at a known capability flag", () => {
    const validCapabilities = new Set([
        "alarms", "reports", "training", "instructor_messages", "timemachine",
    ]);
    for (const [tool, cap] of Object.entries(TOOL_CAPABILITY)) {
        assert.ok(
            validCapabilities.has(cap),
            `tool '${tool}' maps to unknown capability '${cap}'. Update either the bridge schema or this map.`,
        );
    }
});
