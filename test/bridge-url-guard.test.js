import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluateBridgeUrl } from "../src/bridge.js";

test("localhost http is accepted (default secure posture)", () => {
    const r = evaluateBridgeUrl("http://localhost:17842");
    assert.equal(r.ok, true);
    assert.equal(r.url, "http://localhost:17842");
    assert.equal(r.warning, undefined);
});

test("127.0.0.1 http is accepted as loopback", () => {
    const r = evaluateBridgeUrl("http://127.0.0.1:17842");
    assert.equal(r.ok, true);
    assert.equal(r.warning, undefined);
});

test("IPv6 ::1 http is accepted as loopback", () => {
    const r = evaluateBridgeUrl("http://[::1]:17842");
    assert.equal(r.ok, true);
});

test("external http is refused without the override", () => {
    const r = evaluateBridgeUrl("http://example.com:8080");
    assert.equal(r.ok, false);
    assert.match(r.error, /Plain HTTP to a non-loopback host/);
    assert.match(r.error, /cleartext/);
});

test("external http with ALLOW_INSECURE proceeds with a warning", () => {
    const r = evaluateBridgeUrl("http://example.com:8080", { allowInsecure: true });
    assert.equal(r.ok, true);
    assert.match(r.warning, /ALLOW_INSECURE=true/);
    assert.match(r.warning, /cleartext/);
});

test("https to any host is accepted without warning", () => {
    const r = evaluateBridgeUrl("https://prod.internal:443");
    assert.equal(r.ok, true);
    assert.equal(r.warning, undefined);
});

test("non-http(s) scheme is refused even if loopback", () => {
    for (const url of ["ftp://localhost", "file:///tmp/x", "javascript:alert(1)", "ws://localhost"]) {
        const r = evaluateBridgeUrl(url);
        assert.equal(r.ok, false, `should refuse '${url}'`);
        assert.match(r.error, /must use http:\/\/ or https:\/\//);
    }
});

test("malformed URL is refused", () => {
    const r = evaluateBridgeUrl("not a url");
    assert.equal(r.ok, false);
    assert.match(r.error, /not a valid URL/);
});

test("trailing slashes are stripped", () => {
    const r = evaluateBridgeUrl("http://localhost:17842//");
    assert.equal(r.ok, true);
    assert.equal(r.url, "http://localhost:17842");
});

test("hostname case is normalized (LOCALHOST treated as loopback)", () => {
    const r = evaluateBridgeUrl("http://LOCALHOST:17842");
    assert.equal(r.ok, true);
});
