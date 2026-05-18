# ArcUI MCP Connector — Component Inventory

**Scope:** every source file that ships in this repository, derived
from the actual filesystem on `2026-05-18`. Companion document to the
top-level `README.md`, which covers usage, security posture, and
operational guidance.

**What this is not:** a description of intent or a roadmap. Anything
that does not exist as code today is called out under "Open questions"
at the bottom.

**Place in the larger system:** this connector is the *external* MCP
server for the ArcUI SDK. The Unity-side counterpart it talks to is
`McpBridge.cs` in the ArcUI System Unity project. See the Unity-side
documentation hub for the SDK component inventory:
`Assets/ArcUI_System/Documentation~/00-inventory.md` in the
ArcUI System repository.

---

## Runtime topology

```
+---------------------+    stdio    +-----------------------+    HTTP    +------------------------+
| MCP client          | <---------> | arcui-mcp-connector   | <--------> | Unity McpBridge.cs     |
| (Claude Desktop /   |  (process)  | (this repo, Node ESM) | (loopback) | (ArcUI System project) |
|  Cursor / Windsurf) |             |                       |            |                        |
+---------------------+             +-----------------------+            +------------------------+
```

The connector is stateless: it does not persist between runs, does not
open inbound sockets, and is launched as a child process by the MCP
client over stdio.

---

## A. MCP server entrypoint

| Component  | File                            | Role                                                        |
|------------|---------------------------------|-------------------------------------------------------------|
| Server     | [src/server.js](../src/server.js) | MCP stdio server bootstrap. `main` and `bin` of the package. Wires the `@modelcontextprotocol/sdk` server against the bridge, validation, idempotency, tool filter, and (optionally) knowledge tools. |

## B. Unity-bridge transport

| Component   | File                                       | Role                                                        |
|-------------|--------------------------------------------|-------------------------------------------------------------|
| Bridge      | [src/bridge.js](../src/bridge.js)          | HTTP client against the in-Unity `McpBridge.cs`. Implements URL-scheme guard (rejects non-loopback `http://` unless `ARCUI_BRIDGE_ALLOW_INSECURE=true`) and bearer auth via `ARCUI_BRIDGE_TOKEN`. |
| Bridge probe| [src/check-bridge.js](../src/check-bridge.js) | Standalone connectivity test. Exposed via `npm run check-bridge`. Useful in deployment validation and CI smoke checks. |

## C. Hardening

| Component   | File                                          | Role                                                                                  |
|-------------|-----------------------------------------------|---------------------------------------------------------------------------------------|
| Validation  | [src/validation.js](../src/validation.js)     | Schema enforcement at the server boundary: type, bounded lengths, enum membership, numeric bounds, identifier character set (ArcUI tags, MQTT topics, OPC-UA / DCS). Rejects injection-style characters. Error messages never echo the bad value. |
| Idempotency | [src/idempotency.js](../src/idempotency.js)   | Cache that deduplicates retried tool calls so an upstream client retry does not cause double writes against the DataStore. |
| Tools filter| [src/tools-filter.js](../src/tools-filter.js) | Capability-driven advertisement of available tools. Tools the bridge does not support are hidden from the client rather than failing on call. |

## D. Optional knowledge layer

| Component       | File                                                          | Role                                                                                  |
|-----------------|---------------------------------------------------------------|---------------------------------------------------------------------------------------|
| File search     | [src/gemini-file-search.js](../src/gemini-file-search.js)     | Gemini File Search tools (`@google/genai`). Off by default. Enabled by both `ARCUI_ENABLE_KNOWLEDGE_TOOLS=true` and `GEMINI_API_KEY` being set. Reviewed-content-only — review File Search store before enabling for regulated deployments. |

## E. Tests

Runtime is plain ESM JavaScript. Tests use the built-in `node --test`
runner. Type checking is dev-only via `tsc --noEmit` over JSDoc
annotations (no transpile step).

| Suite                | File                                                          | Coverage                                                                              |
|----------------------|---------------------------------------------------------------|---------------------------------------------------------------------------------------|
| Server tools         | [test/server-tools.test.js](../test/server-tools.test.js)     | Protocol handshake against compatible / legacy / incompatible / unreachable bridges; capability-driven tool filtering; idempotency cache behavior. Real loopback HTTP servers on ephemeral ports, no mocks. |
| Validation           | [test/validation.test.js](../test/validation.test.js)         | Every input-validation rule: type, length, enum, numeric bounds, identifier charset, injection-style rejection. |

Run via:

```bash
npm test          # full suite, zero runtime dependencies
npm run typecheck # strict static analysis over JSDoc-annotated .js
```

## F. Configuration

| File              | Role                                                                                                            |
|-------------------|-----------------------------------------------------------------------------------------------------------------|
| `package.json`    | Registered name: `arcui-mcp-server` (note: human-facing name in README is "ArcUI MCP Connector"). ESM. Node ≥ 18. Two prod deps: `@google/genai`, `@modelcontextprotocol/sdk`. |
| `tsconfig.json`   | Type-checking only — `tsc --noEmit`. No build output.                                                           |
| `.env.example`    | Template for the environment variables consumed by `bridge.js`, `gemini-file-search.js`, and the URL-scheme guard. |
| `LICENSE`         | Project license.                                                                                                |
| `README.md`       | User-facing documentation: security model, install, available tools, operational guidance.                      |

---

## Environment variables — quick reference

| Variable                          | Consumer                  | Default     | Purpose                                                                                  |
|-----------------------------------|---------------------------|-------------|------------------------------------------------------------------------------------------|
| `ARCUI_BRIDGE_URL`                | `bridge.js`               | loopback    | URL of the in-Unity McpBridge. Plain `http://` to non-loopback is **rejected** unless the insecure flag is set. |
| `ARCUI_BRIDGE_TOKEN`              | `bridge.js`               | (none)      | Bearer token sent with every bridge call. **Recommended for production.**                 |
| `ARCUI_BRIDGE_ALLOW_INSECURE`     | `bridge.js`               | `false`     | Escape hatch for trusted private links (e.g. VPN with TLS terminated at the network layer). Logs a warning on every startup. |
| `ARCUI_ENABLE_KNOWLEDGE_TOOLS`    | `gemini-file-search.js`   | `false`     | Master switch for the Gemini File Search tools.                                          |
| `GEMINI_API_KEY`                  | `gemini-file-search.js`   | (none)      | Required when knowledge tools are enabled. Treat as a credential.                        |

`.env.example` is the canonical template.

---

## Open questions

1. **Naming consistency.** The README and the marketed identity are
   "ArcUI MCP Connector". The `package.json` `name` field is
   `arcui-mcp-server`. Both refer to the same artifact. Decision
   pending: align on one name everywhere or document the duality.
2. **`@types/gemini-file-search.js` exports.** A prior session flagged
   that `gemini-file-search.js` exports are not yet typed for the
   `tsc --noEmit` step. Confirm whether this is still pending and add
   JSDoc annotations if so.
