# ArcUI MCP Connector

Official Node.js Model Context Protocol (MCP) connector for the **ArcUI System**.
This acts as a standard MCP Server (stdio) that bridges external AI clients (like Claude Desktop, Cursor IDE, Windsurf, etc.) with your live ArcUI Digital Twins in Unity.

## ⚠️ Important Note
This connector is an **optional add-on** for advanced users. The core ArcUI System (including the ARIA Agentic Panel) works natively inside Unity and does *not* require Node.js or this connector to function.

## Security model

This connector runs as a **stdio MCP server** — it is launched by your MCP client
(Claude Desktop, Cursor, Windsurf, etc.) and speaks to that client over the client's
standard input/output. The connector itself does **not** open inbound network sockets
and does **not** persist state between runs. It is a stateless translator.

| Hop | Trust | Protection |
| --- | --- | --- |
| MCP client ↔ connector | Same machine, same OS user, stdio pipe | OS process isolation |
| Connector ↔ Unity bridge | Loopback `http://localhost:17842` by default. Plain HTTP to a non-loopback host is rejected on startup unless `ARCUI_BRIDGE_ALLOW_INSECURE=true` is set explicitly. | Optional `ARCUI_BRIDGE_TOKEN` bearer (recommended) |
| Connector ↔ Gemini File Search | External, only when explicitly enabled | `GEMINI_API_KEY` + `ARCUI_ENABLE_KNOWLEDGE_TOOLS=true` |

### Input validation

Every tool parameter is validated at the server boundary (`src/validation.js`) before
any call reaches the Unity bridge or Gemini. The validator enforces:

- **Type** — each parameter is checked against its declared kind (string, number,
  boolean, enum). Mismatched types are rejected.
- **Length** — every string has a bounded ceiling (256 chars default, 4 KB for
  free-form prompts, 8 KB for `raw_value`, 1 MB for `session_json`/`json` blobs).
- **Identifier character set** — `tag`, `tag_key`, `id`, and `scenario_id` accept
  `A-Z a-z 0-9 _ . - : / [ ]`. This covers `System.ActiveView` (ArcUI conventions),
  MQTT topics (`factory/line1/temp`), and OPC-UA / DCS addressing
  (`Channel1.Device1[0]`). Spaces, quotes, `<`, `>`, `;`, `$`, and other
  injection-style characters are rejected as defense in depth — URL and JSON
  encoding on the wire already handle the allowed characters safely.
- **Enum membership** — `level`, `value_type`, `type`, and similar fields only
  accept their documented values.
- **Numeric bounds** — limits like `1 ≤ limit ≤ 500` and `lookahead_seconds ≥ 0`
  are enforced before the bridge call.

Validation errors return a clean, parameter-named message and **never echo the
bad value back to the client**, so an attacker payload cannot reflect off the
error path. Unknown fields on state-changing tools are dropped: only the
documented schema reaches the Unity bridge.

### Operational guidance

- Set `ARCUI_BRIDGE_TOKEN` in production and keep it out of source control.
- Keep the Unity bridge bound to loopback (`localhostOnly = true` on
  `ArcHMIMcpBridge`). Do not expose port `17842` to untrusted or public networks.
- If you must reach the Unity bridge from another machine, use TLS — terminate
  HTTPS at a reverse proxy on the Unity host and point `ARCUI_BRIDGE_URL` at
  the proxy's `https://` endpoint. The connector **refuses to start** if
  `ARCUI_BRIDGE_URL` resolves to a non-loopback host over plain `http://`,
  because the bearer token and DataStore traffic would otherwise travel in
  cleartext. The escape hatch `ARCUI_BRIDGE_ALLOW_INSECURE=true` exists only
  for trusted private links such as a VPN tunnel where TLS is terminated at
  the network layer — it emits a warning on every startup.
- Treat `GEMINI_API_KEY` like any other API credential — rotate on suspicion,
  scope to the minimum project, and review File Search store contents before
  enabling for regulated deployments.

## Prerequisites
*   [Node.js](https://nodejs.org/) installed on your system.
*   An active ArcUI System project running in the Unity Editor or a standalone build.

## Installation

1. Clone this repository to your local machine:
   ```bash
   git clone https://github.com/mromerocastro/arcui-mcp-connector.git
   ```

## Available Tools

The MCP server exposes several tool categories for AI agents to control the ArcUI environment:

### Operations & Training
- **Core Operations**: Read tags, list active alarms, query system health, and list available sensors.
- **Scenario Runner**: Create, start, and evaluate training scenarios (`create_scenario`, `start_scenario`, `evaluate_session`).
- **Event Injection**: Trigger alarms and inject specific tag overrides during a live session.

### TimeMachine (Time-Travel Simulation)
The TimeMachine tools allow AI agents to navigate historical telemetry and predict future states when the `ArcHMITimeMachineProvider` is active in Unity.
- `timemachine_play` / `timemachine_pause`: Control playback of the simulation timeline.
- `timemachine_seek`: Jump to a specific timestamp in the scenario (in seconds).
- `timemachine_forecast`: Predict the future value of a specific tag by looking ahead in the pre-loaded telemetry.

> **Security Note:** TimeMachine and Training injections write to the live DataStore and therefore inherit the bridge's auth posture. When `ARCUI_BRIDGE_TOKEN` is set, every tool call to the Unity bridge must present a matching bearer token; when it is unset, `ArcHMIMcpBridge` rejects all requests by default (`allowUnauthenticated = false`). Keep the bridge bound to loopback and the token out of source control. See the [Security model](#security-model) section for the full trust picture.

## Protocol handshake

On startup the connector calls `GET /mcp/schema` against the configured bridge
to negotiate the wire-protocol version and discover which features the bridge
actually supports. Behavior:

- **Compatible bridge (matching protocol MAJOR)** — the connector caches the
  reported `capabilities` and **filters the tool catalog** advertised to the
  MCP client. Tools that depend on a disabled capability are hidden so the
  client never tries to call something the bridge cannot execute. For example
  a bridge built without TimeMachine wiring would advertise
  `timemachine: false`, and `timemachine_*` tools would not appear in the
  client's tool list.
- **Legacy bridge (no `/mcp/schema` endpoint, returns 404)** — the connector
  logs a warning and proceeds with a permissive default (`protocol 1.0.0`,
  all capabilities enabled). This keeps installations from before the
  handshake landed working.
- **Unreachable bridge (timeout, ECONNREFUSED)** — the connector logs a
  warning and proceeds with the same permissive default. Tool calls will
  surface a clear error when actually invoked. This matches the prior
  behavior where the MCP client could be launched before Unity Play Mode.
- **Incompatible protocol (MAJOR mismatch)** — FATAL. The connector exits
  with a clear message telling the operator to update either
  `ArcHMIMcpBridge.PROTOCOL_VERSION` on the Unity side or the connector.
  Continuing would expose tools that may have changed wire shapes.

The connector's startup line on stderr now reports the negotiated protocol
alongside the bridge URL, e.g.:

```
[arcui-mcp] ready — bridge=http://localhost:17842 protocol=1.0.0 auth=on tools=21
```

When running against a legacy bridge the suffix `(legacy)` is appended so the
operator knows capability filtering is not active.

## Idempotency

State-changing tools accept an optional `idempotency_key` string parameter so a
flaky network or a client-side retry does not produce duplicate side-effects in
Unity. Tools that honor the key:

- `trigger_alarm`
- `create_scenario`
- `start_scenario`
- `inject_event`

When a call carries an `idempotency_key`, the first execution runs normally and
the successful response is cached for **5 minutes** under
`<tool_name>:<key>`. Any subsequent call with the same key within that window
returns the cached response **without re-executing the handler** — no second
write to the Unity DataStore. Concurrent in-flight calls with the same key
collapse onto a single bridge round-trip.

Behavior details:

- **Failures are not cached.** If a call returns an error, the entry is evicted
  immediately so the client can retry with the same key and obtain a fresh
  attempt.
- **Process-local only.** The cache lives in this Node process. A connector
  restart clears it; a key submitted after restart falls through and executes.
  For longer-horizon guarantees, the destination system must also be defensive.
- **Bounded memory.** Cache is capped at 256 entries with LRU eviction. No
  references to Unity DataStore tags, alarms, or sessions are retained beyond
  the cached MCP response payload.
- **Opt-in.** Tools without `idempotency_key` behave exactly as before; this is
  purely additive.

Example client usage:

```json
{
    "tool": "trigger_alarm",
    "arguments": {
        "tag": "Reactor.Temperature",
        "level": "critical",
        "message": "Temperature exceeded safety bound",
        "idempotency_key": "incident-2026-05-14-001"
    }
}
```

## Gemini File Search MVP

This connector can expose ArcUI Knowledge Pack tools backed by Gemini File Search.
The Unity SDK remains the runtime source of truth for tags, alarms, scenarios, and
training sessions; Gemini File Search is used only by this Node MCP layer to index
validated documents and ground scenario/debrief generation.

### Environment

Set these variables in the MCP client config, shell, or process manager that
launches `node src/server.js`:

```bash
GEMINI_API_KEY=your_google_ai_studio_key
ARCUI_ENABLE_KNOWLEDGE_TOOLS=true
ARCUI_KNOWLEDGE_STORE=fileSearchStores/your-store-id
ARCUI_KNOWLEDGE_MODEL=gemini-2.5-flash
ARCUI_KNOWLEDGE_EMBEDDING_MODEL=models/gemini-embedding-2
```

Knowledge tools are disabled by default. This keeps public deployments from
accidentally sending project context or training data to Gemini.

To upload/index local files, enable indexing separately and allowlist the
approved document folders:

```bash
ARCUI_ENABLE_KNOWLEDGE_INDEXING=true
ARCUI_KNOWLEDGE_ROOTS=C:/ArcUI/approved-docs;C:/ArcUI/context-packs
```

`index_knowledge_file` refuses to upload files outside `ARCUI_KNOWLEDGE_ROOTS`.
Use this for approved manuals, SOPs, protocols, context JSON, and training
references only.

`ARCUI_KNOWLEDGE_STORE` is optional for `create_knowledge_store` and
`list_knowledge_stores`, but required for query/index tools unless you pass
`store_name` explicitly.

Privacy note: Knowledge tools may send selected documents, prompts, generated
scenarios, and training-session summaries to the configured Gemini API account.
Do not enable them for regulated environments unless the customer's data policy
allows that provider and account.

### Tools

- `knowledge_status` - verifies Gemini/File Search configuration.
- `create_knowledge_store` - creates a File Search store for one ArcUI system.
- `list_knowledge_stores` - lists available stores.
- `list_knowledge_documents` - lists documents in a store.
- `index_knowledge_file` - uploads and indexes a local PDF, JSON, TXT, MD, etc.
- `search_training_knowledge` - asks grounded questions with citations.
- `generate_grounded_scenario` - generates a draft ArcUI scenario constrained to
  live Unity tags and grounded in the File Search store.
- `generate_training_debrief` - reads the active Unity training session and
  grounds the debrief in approved documents.

### Suggested flow

1. Create a store:
   ```json
   {
     "display_name": "ArcUI MQTT Turbine Knowledge"
   }
   ```

2. Index approved context and procedures:
   ```json
   {
     "path": "C:/path/to/MQTT_Turbine_context.json",
     "store_name": "fileSearchStores/your-store-id",
     "display_name": "MQTT Turbine Context",
     "metadata": {
       "system": "MQTT_Turbine",
       "domain": "training",
       "approved": "true"
     }
   }
   ```

3. Generate a grounded scenario draft:
   ```json
   {
     "request": "Create a brake failure scenario for the wind turbine",
     "system": "MQTT_Turbine",
     "metadata_filter": "system = \"MQTT_Turbine\" AND approved = \"true\"",
     "register": false
   }
   ```

4. After instructor review, call `create_scenario` or run
   `generate_grounded_scenario` again with `register: true`.
