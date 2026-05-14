import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

const BRIDGE_PATH = resolve(import.meta.dirname, "../src/bridge.js");

// bridge.js reads env vars at module evaluation, so each scenario must load
// a fresh module instance. Cache-bust via a query string on the import URL.
async function importBridgeFresh() {
    const bustedUrl = pathToFileURL(BRIDGE_PATH).href + "?t=" + Date.now() + "_" + Math.random();
    return import(bustedUrl);
}

async function startMock(handler) {
    const server = createServer(handler);
    await new Promise(r => server.listen(0, "127.0.0.1", r));
    return { server, port: server.address().port };
}

// Silence the stderr warnings these scenarios intentionally emit so the
// `node --test` output stays readable. Restore the real implementation
// afterwards so other test files are unaffected.
const realStderrWrite = process.stderr.write.bind(process.stderr);
before(() => { process.stderr.write = () => true; });
after(() =>  { process.stderr.write = realStderrWrite; });

test("A. valid schema with matching MAJOR returns the schema as-is", async () => {
    const mock = await startMock((req, res) => {
        if (req.url === "/mcp/schema") {
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({
                bridge_version:   "1.0.0",
                protocol_version: "1.0.0",
                capabilities: {
                    alarms: true, reports: false, training: true,
                    instructor_messages: true, timemachine: false,
                },
            }));
        } else { res.writeHead(404); res.end(); }
    });
    process.env.ARCUI_BRIDGE_URL = `http://127.0.0.1:${mock.port}`;

    try {
        const m = await importBridgeFresh();
        const s = await m.handshake();
        assert.equal(s.protocol_version, "1.0.0");
        assert.equal(s._legacy, undefined);
        assert.equal(s.capabilities.reports, false);
        assert.equal(s.capabilities.timemachine, false);
        assert.equal(s.capabilities.training, true);
    } finally {
        await new Promise(r => mock.server.close(r));
    }
});

test("B. 404 on /mcp/schema falls back to legacy (permissive caps)", async () => {
    const mock = await startMock((req, res) => {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "not found" }));
    });
    process.env.ARCUI_BRIDGE_URL = `http://127.0.0.1:${mock.port}`;

    try {
        const m = await importBridgeFresh();
        const s = await m.handshake();
        assert.equal(s._legacy, true);
        assert.equal(s.capabilities.alarms, true);
        assert.equal(s.capabilities.timemachine, true);
    } finally {
        await new Promise(r => mock.server.close(r));
    }
});

test("C. incompatible MAJOR protocol throws (caller should exit)", async () => {
    const mock = await startMock((req, res) => {
        if (req.url === "/mcp/schema") {
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ protocol_version: "2.0.0", capabilities: {} }));
        } else { res.writeHead(404); res.end(); }
    });
    process.env.ARCUI_BRIDGE_URL = `http://127.0.0.1:${mock.port}`;

    try {
        const m = await importBridgeFresh();
        await assert.rejects(
            () => m.handshake(),
            /protocol 2\.0\.0 is incompatible/,
        );
    } finally {
        await new Promise(r => mock.server.close(r));
    }
});

test("D. unreachable bridge falls back to legacy (does not throw)", async () => {
    // Port 1 is reserved and not listening; ECONNREFUSED.
    process.env.ARCUI_BRIDGE_URL = "http://127.0.0.1:1";
    process.env.ARCUI_BRIDGE_TIMEOUT_MS = "1500";

    try {
        const m = await importBridgeFresh();
        const s = await m.handshake();
        assert.equal(s._legacy, true);
        assert.equal(s.capabilities.alarms, true);
    } finally {
        delete process.env.ARCUI_BRIDGE_TIMEOUT_MS;
    }
});

test("E. unparseable protocol_version throws (caller should exit)", async () => {
    const mock = await startMock((req, res) => {
        if (req.url === "/mcp/schema") {
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ protocol_version: "nonsense", capabilities: {} }));
        } else { res.writeHead(404); res.end(); }
    });
    process.env.ARCUI_BRIDGE_URL = `http://127.0.0.1:${mock.port}`;

    try {
        const m = await importBridgeFresh();
        await assert.rejects(
            () => m.handshake(),
            /unparseable protocol_version/,
        );
    } finally {
        await new Promise(r => mock.server.close(r));
    }
});
