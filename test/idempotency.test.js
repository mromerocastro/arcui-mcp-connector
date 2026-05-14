import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { withIdempotency, _resetCache, _cacheSize } from "../src/idempotency.js";

beforeEach(() => _resetCache());

test("no key bypasses cache (handler runs every call)", async () => {
    let calls = 0;
    const fn = () => Promise.resolve({ content: [{ type: "text", text: String(++calls) }] });

    await withIdempotency("trigger_alarm", undefined, fn);
    await withIdempotency("trigger_alarm", undefined, fn);
    await withIdempotency("trigger_alarm", null, fn);

    assert.equal(calls, 3);
});

test("same key returns cached response without re-executing", async () => {
    let calls = 0;
    const fn = () => Promise.resolve({ content: [{ type: "text", text: String(++calls) }] });

    const first  = await withIdempotency("trigger_alarm", "k1", fn);
    const second = await withIdempotency("trigger_alarm", "k1", fn);
    const third  = await withIdempotency("trigger_alarm", "k1", fn);

    assert.equal(calls, 1);
    assert.deepEqual(first, second);
    assert.deepEqual(first, third);
});

test("different keys produce different executions", async () => {
    let calls = 0;
    const fn = () => Promise.resolve({ content: [{ type: "text", text: String(++calls) }] });

    await withIdempotency("trigger_alarm", "k1", fn);
    await withIdempotency("trigger_alarm", "k2", fn);

    assert.equal(calls, 2);
});

test("same key on different tools is namespaced (no collision)", async () => {
    let calls = 0;
    const fn = () => Promise.resolve({ content: [{ type: "text", text: String(++calls) }] });

    await withIdempotency("trigger_alarm", "shared-key", fn);
    await withIdempotency("inject_event",  "shared-key", fn);

    assert.equal(calls, 2, "cache key must namespace by tool");
});

test("error responses are NOT cached — client can retry", async () => {
    let calls = 0;
    const fn = () => {
        calls += 1;
        // First call fails, subsequent calls succeed.
        if (calls === 1) {
            return Promise.resolve({ content: [{ type: "text", text: "boom" }], isError: true });
        }
        return Promise.resolve({ content: [{ type: "text", text: "ok" }] });
    };

    const failed = await withIdempotency("trigger_alarm", "k1", fn);
    assert.equal(failed.isError, true);

    const retried = await withIdempotency("trigger_alarm", "k1", fn);
    assert.equal(retried.isError, undefined);
    assert.equal(calls, 2, "failure must evict so retry runs the handler");
});

test("thrown exceptions are NOT cached and propagate", async () => {
    let calls = 0;
    const fn = () => {
        calls += 1;
        if (calls === 1) return Promise.reject(new Error("network down"));
        return Promise.resolve({ content: [{ type: "text", text: "ok" }] });
    };

    await assert.rejects(
        () => withIdempotency("trigger_alarm", "k1", fn),
        /network down/,
    );

    const retried = await withIdempotency("trigger_alarm", "k1", fn);
    assert.equal(retried.content[0].text, "ok");
    assert.equal(calls, 2);
});

test("concurrent calls with same key collapse onto one handler invocation", async () => {
    let calls = 0;
    let resolve;
    const fn = () => {
        calls += 1;
        return new Promise(r => { resolve = r; });
    };

    const p1 = withIdempotency("trigger_alarm", "k1", fn);
    const p2 = withIdempotency("trigger_alarm", "k1", fn);
    const p3 = withIdempotency("trigger_alarm", "k1", fn);

    assert.equal(calls, 1, "second and third callers must reuse the in-flight Promise");
    resolve({ content: [{ type: "text", text: "done" }] });

    const [r1, r2, r3] = await Promise.all([p1, p2, p3]);
    assert.deepEqual(r1, r2);
    assert.deepEqual(r2, r3);
});

test("cache is bounded — LRU eviction kicks in past MAX_ENTRIES", async () => {
    // MAX_ENTRIES is 256; we fill past it and verify size never exceeds the cap.
    const fn = () => Promise.resolve({ content: [{ type: "text", text: "ok" }] });

    for (let i = 0; i < 300; i++) {
        await withIdempotency("trigger_alarm", `k${i}`, fn);
    }

    assert.ok(_cacheSize() <= 256, `cache size ${_cacheSize()} exceeded MAX_ENTRIES (256)`);
});
