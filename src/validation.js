/**
 * ArcUI MCP — Input Validation
 * ─────────────────────────────────────────────────────────────────────────
 * Centralized parameter validation for MCP tool handlers. The MCP SDK does
 * not enforce a tool's inputSchema at call time, so handlers receive whatever
 * the client sent. This module catches bad inputs at the server boundary and
 * surfaces a clean error to the client instead of letting it surface deeper
 * in the bridge or the Gemini SDK.
 *
 * Usage pattern in handlers:
 *
 *   const tag = requireString(args, "tag", { pattern: Patterns.TAG });
 *   const lim = optionalNumber(args, "limit", { integer: true, min: 1, max: 500 });
 *
 * Any ValidationError thrown here is converted to a friendly asError() by the
 * top-level CallToolRequestSchema handler in server.js.
 *
 * @typedef {Object} StringOpts
 * @property {number} [maxLen]      Maximum string length (default 256).
 * @property {RegExp} [pattern]     Optional regex the value must satisfy.
 * @property {boolean} [allowEmpty] Allow zero-length strings (default false).
 *
 * @typedef {Object} NumberOpts
 * @property {number}  [min]      Inclusive minimum.
 * @property {number}  [max]      Inclusive maximum.
 * @property {boolean} [integer]  Require an integer (default false).
 *
 * @typedef {Record<string, any> | undefined} Args
 *      Generic argument bag — the raw `arguments` object MCP hands to a
 *      tool handler (or undefined when the client sent no arguments).
 *      Validators access fields by name without assuming a specific
 *      schema and tolerate the undefined case via `args?.[name]`.
 */

export class ValidationError extends Error {
    /** @param {string} message */
    constructor(message) {
        super(message);
        this.name = "ValidationError";
    }
}

// Tag keys: DataStore identifiers. Covers the conventions ArcUI users encounter
// in the field — System.ActiveView, fleet_01.rotor_rpm, factory/line1/temp (MQTT),
// Channel1.Device1[0] (OPC-UA / DCS addressing), ns=2:s=Tag (namespaced ids).
//
// Allowed:  letters, digits, _ . - : / [ ]
// Rejected: spaces, quotes, < > ; $ \ and other characters that have no
//           legitimate role in a tag identifier and would only appear in
//           injection-style payloads. URL / JSON encoding on the wire still
//           handles the allowed characters safely; the regex is defense in depth.
const TAG_PATTERN = /^[A-Za-z0-9_.\-:/\[\]]+$/;

// Scenario / resource ids: same surface as TAG.
const ID_PATTERN  = TAG_PATTERN;

export const Patterns = Object.freeze({
    TAG: TAG_PATTERN,
    ID:  ID_PATTERN,
});

// Conservative ceilings. They exist to bound memory, not to second-guess
// legitimate inputs. Bump in the call site (via maxLen) when a tool really
// needs longer payloads (e.g. session_json).
const DEFAULT_STRING_MAX = 256;

/** @param {unknown} v */
function isMissing(v) {
    return v === undefined || v === null;
}

/**
 * @param {Args} args
 * @param {string} name
 * @param {StringOpts} [opts]
 * @returns {string}
 */
export function requireString(args, name, opts = {}) {
    const { maxLen = DEFAULT_STRING_MAX, pattern, allowEmpty = false } = opts;
    const v = args?.[name];
    if (isMissing(v)) throw new ValidationError(`Parameter '${name}' is required.`);
    if (typeof v !== "string") throw new ValidationError(`Parameter '${name}' must be a string.`);
    if (!allowEmpty && v.length === 0) throw new ValidationError(`Parameter '${name}' must not be empty.`);
    if (v.length > maxLen) throw new ValidationError(`Parameter '${name}' exceeds max length of ${maxLen}.`);
    if (pattern && !pattern.test(v)) throw new ValidationError(`Parameter '${name}' contains invalid characters.`);
    return v;
}

/**
 * @param {Args} args
 * @param {string} name
 * @param {StringOpts} [opts]
 * @returns {string|undefined}
 */
export function optionalString(args, name, opts = {}) {
    if (isMissing(args?.[name])) return undefined;
    return requireString(args, name, opts);
}

/**
 * @param {Args} args
 * @param {string} name
 * @param {NumberOpts} [opts]
 * @returns {number}
 */
export function requireNumber(args, name, opts = {}) {
    const { min, max, integer = false } = opts;
    const raw = args?.[name];
    if (isMissing(raw)) throw new ValidationError(`Parameter '${name}' is required.`);
    const n = typeof raw === "number" ? raw : Number(raw);
    if (!Number.isFinite(n)) throw new ValidationError(`Parameter '${name}' must be a finite number.`);
    if (integer && !Number.isInteger(n)) throw new ValidationError(`Parameter '${name}' must be an integer.`);
    if (min !== undefined && n < min) throw new ValidationError(`Parameter '${name}' must be >= ${min}.`);
    if (max !== undefined && n > max) throw new ValidationError(`Parameter '${name}' must be <= ${max}.`);
    return n;
}

/**
 * @param {Args} args
 * @param {string} name
 * @param {NumberOpts} [opts]
 * @returns {number|undefined}
 */
export function optionalNumber(args, name, opts = {}) {
    if (isMissing(args?.[name])) return undefined;
    return requireNumber(args, name, opts);
}

/**
 * @param {Args} args
 * @param {string} name
 * @param {readonly string[]} allowed
 * @returns {string}
 */
export function requireEnum(args, name, allowed) {
    const v = requireString(args, name, { maxLen: 64 });
    if (!allowed.includes(v)) {
        throw new ValidationError(`Parameter '${name}' must be one of: ${allowed.join(", ")}.`);
    }
    return v;
}

/**
 * @param {Args} args
 * @param {string} name
 * @param {readonly string[]} allowed
 * @param {string} [fallback]
 * @returns {string|undefined}
 */
export function optionalEnum(args, name, allowed, fallback) {
    if (isMissing(args?.[name])) return fallback;
    return requireEnum(args, name, allowed);
}

/**
 * @param {Args} args
 * @param {string} name
 * @param {boolean} [fallback]
 * @returns {boolean|undefined}
 */
export function optionalBoolean(args, name, fallback) {
    const raw = args?.[name];
    if (isMissing(raw)) return fallback;
    if (typeof raw === "boolean") return raw;
    throw new ValidationError(`Parameter '${name}' must be a boolean.`);
}
