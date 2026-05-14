import { test } from "node:test";
import assert from "node:assert/strict";
import {
    ValidationError,
    Patterns,
    requireString,
    optionalString,
    requireNumber,
    optionalNumber,
    requireEnum,
    optionalEnum,
    optionalBoolean,
} from "../src/validation.js";

// ─── requireString ─────────────────────────────────────────────────────────

test("requireString returns the value on happy path", () => {
    assert.equal(requireString({ tag: "Reactor.Temp" }, "tag"), "Reactor.Temp");
});

test("requireString throws when missing", () => {
    assert.throws(() => requireString({}, "tag"), ValidationError);
});

test("requireString throws when null", () => {
    assert.throws(() => requireString({ tag: null }, "tag"), /required/);
});

test("requireString throws when wrong type", () => {
    assert.throws(() => requireString({ tag: 42 }, "tag"), /must be a string/);
});

test("requireString rejects empty string by default", () => {
    assert.throws(() => requireString({ tag: "" }, "tag"), /must not be empty/);
});

test("requireString accepts empty when allowEmpty=true", () => {
    assert.equal(requireString({ tag: "" }, "tag", { allowEmpty: true }), "");
});

test("requireString enforces maxLen", () => {
    assert.throws(
        () => requireString({ tag: "x".repeat(300) }, "tag", { maxLen: 256 }),
        /max length of 256/,
    );
});

test("requireString enforces pattern", () => {
    assert.throws(
        () => requireString({ tag: "bad tag with spaces" }, "tag", { pattern: Patterns.TAG }),
        /invalid characters/,
    );
});

// ─── Patterns.TAG ──────────────────────────────────────────────────────────

test("Patterns.TAG accepts ArcUI conventions", () => {
    // Note: full OPC-UA NodeId URI form ('ns=2;s=Tag') is intentionally NOT
    // supported — '=' and ';' are reserved as injection-style markers.
    // Callers using NodeIds must pre-translate to a flat tag key.
    for (const valid of [
        "System.ActiveView",
        "fleet_01.rotor_rpm",
        "factory/line1/temp",
        "Channel1.Device1[0]",
        "Site:Plant:Line:Sensor",
    ]) {
        assert.match(valid, Patterns.TAG, `should accept '${valid}'`);
    }
});

test("Patterns.TAG rejects injection-style payloads", () => {
    for (const bad of [
        "tag with space",
        "tag\"quote",
        "tag<script>",
        "tag;DROP",
        "tag$var",
    ]) {
        assert.doesNotMatch(bad, Patterns.TAG, `should reject '${bad}'`);
    }
});

// ─── optionalString ────────────────────────────────────────────────────────

test("optionalString returns undefined when missing", () => {
    assert.equal(optionalString({}, "x"), undefined);
});

test("optionalString validates when present", () => {
    assert.throws(() => optionalString({ x: 1 }, "x"), /must be a string/);
});

// ─── requireNumber ─────────────────────────────────────────────────────────

test("requireNumber accepts JS numbers", () => {
    assert.equal(requireNumber({ n: 42.5 }, "n"), 42.5);
});

test("requireNumber coerces numeric strings", () => {
    assert.equal(requireNumber({ n: "3.14" }, "n"), 3.14);
});

test("requireNumber rejects NaN and Infinity", () => {
    assert.throws(() => requireNumber({ n: NaN }, "n"), /finite number/);
    assert.throws(() => requireNumber({ n: Infinity }, "n"), /finite number/);
});

test("requireNumber enforces integer flag", () => {
    assert.throws(
        () => requireNumber({ n: 3.5 }, "n", { integer: true }),
        /must be an integer/,
    );
});

test("requireNumber enforces min/max", () => {
    assert.throws(() => requireNumber({ n: -1 }, "n", { min: 0 }), />= 0/);
    assert.throws(() => requireNumber({ n: 101 }, "n", { max: 100 }), /<= 100/);
});

// ─── requireEnum ───────────────────────────────────────────────────────────

test("requireEnum returns valid value", () => {
    assert.equal(
        requireEnum({ level: "warning" }, "level", ["info", "warning", "critical"]),
        "warning",
    );
});

test("requireEnum rejects unknown value", () => {
    assert.throws(
        () => requireEnum({ level: "boom" }, "level", ["info", "warning"]),
        /must be one of: info, warning/,
    );
});

test("optionalEnum returns fallback when missing", () => {
    assert.equal(optionalEnum({}, "level", ["a", "b"], "a"), "a");
});

// ─── optionalBoolean ───────────────────────────────────────────────────────

test("optionalBoolean returns fallback when missing", () => {
    assert.equal(optionalBoolean({}, "flag", false), false);
});

test("optionalBoolean accepts true/false", () => {
    assert.equal(optionalBoolean({ flag: true }, "flag"), true);
    assert.equal(optionalBoolean({ flag: false }, "flag"), false);
});

test("optionalBoolean rejects truthy non-booleans", () => {
    assert.throws(() => optionalBoolean({ flag: "true" }, "flag"), /must be a boolean/);
    assert.throws(() => optionalBoolean({ flag: 1 }, "flag"), /must be a boolean/);
});

// ─── ValidationError shape ─────────────────────────────────────────────────

test("ValidationError is an Error and identifiable via instanceof", () => {
    const e = new ValidationError("bad");
    assert.ok(e instanceof Error);
    assert.ok(e instanceof ValidationError);
    assert.equal(e.name, "ValidationError");
    assert.equal(e.message, "bad");
});
