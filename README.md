# ArcUI MCP Server

> Phase 3 of the ArcUI stack — exposes the live Unity HMI runtime to any
> Model Context Protocol client (Claude Desktop, Unity AI Assistant 2.6,
> Cursor, custom agents). Replaces the old "prompt-injection with static
> context" flow with live tool calls against the running scene.

---

## 1. Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│ Unity Editor (Play Mode)                                         │
│                                                                  │
│   Scene ──► ArcHMIDataStore ──► ArcHMIMcpBridge                  │
│                                 (HttpListener @ :17842)          │
│                                          ▲                       │
└──────────────────────────────────────────┼───────────────────────┘
                                           │ HTTP + JSON
                                           │
                    ┌──────────────────────┴─────────────────────┐
                    │  arcui-mcp-server  (this package)          │
                    │  • Node 18+, stdio JSON-RPC                │
                    │  • 11 tools registered                     │
                    │  • Stateless thin client                   │
                    └──────────────────────┬─────────────────────┘
                                           │ stdio MCP
           ┌───────────────┬───────────────┼───────────────┐
           ▼               ▼               ▼               ▼
   Claude Desktop   Unity Assistant   Cursor / etc.   Custom agent
                    2.6 (Claude Code)
```

**Design principle — ISO 27001 compliant stateless conduit**
No MCP call has the authority to mutate physical hardware. `trigger_alarm`
raises a logical alarm inside the DataStore, not an actuator write. The
bridge exposes read access + logical events only.

---

## 2. Quick start

### Prerequisites
- Node.js 18 or newer (`node --version`).
- Unity project with `ArcHMIMcpBridge` MonoBehaviour on a GameObject
  (usually the same host as `ArcHMIDataStore`).
- Unity in **Play Mode** when the client needs live data.

### Install & verify
```bash
cd Tools/mcp-server
npm install
npm run check-bridge
```

Expected output:
```
ArcUI bridge check — target: http://localhost:17842 (auth: off)
✓ ping → ArcUI-MCP-Bridge v1.0.0 @ 2026-04-22T...
✓ listTags → 19 registered
✓ health → status=healthy, providers=1/1, tags=19
✓ activeAlarms → 0 active, max severity = None
```

If `ping` fails, the bridge isn't running — open Unity, enter Play Mode,
check the `ArcHMIMcpBridge` component is enabled, and re-run.

### Start the MCP server manually (optional — clients spawn it automatically)
```bash
npm start
```

The server writes a banner to stderr and then stays quiet, listening on
stdin for JSON-RPC frames. Stop with Ctrl+C.

---

## 3. Tool catalog

Eleven tools across two categories.

### Operations (live data, 7 tools)

| Tool | Purpose | Backing endpoint |
|---|---|---|
| `list_sensors` | Enumerate every registered tag with current value and type. | `GET /mcp/tags` |
| `get_sensor_value` | Read one tag by key. | `GET /mcp/tag?key=` |
| `get_active_alarms` | Active + acknowledged alarms with severity. | `GET /mcp/alarms/active` |
| `get_alarm_history` | Last N resolved alarms from audit log. | `GET /mcp/alarms/history?limit=` |
| `trigger_alarm` | Raise a new logical alarm against a tag. No physical action. | `POST /mcp/alarms/trigger` |
| `get_system_health` | Providers online, uptime, warnings. | `GET /mcp/health` |
| `generate_report` | Structured snapshot + narrative prompt for an LLM. | `POST /mcp/report` |

### Builder (setup-time, 4 tools — currently stubs)

| Tool | Purpose |
|---|---|
| `get_protocol_config` | Recommended protocol for an industry/equipment pair. |
| `validate_context_layer` | Schema check against a Context Layer JSON. |
| `generate_pilot_scope` | Template pilot scope with budget estimate. |
| `list_available_tags` | Reference tag list for a vertical (wind, water, solar, …). |

The Builder tools return static reference data today. They'll grow real
logic when the Builder Mode roadmap lands (month 4+).

---

## 4. Client configuration

All three supported clients speak stdio MCP. The config differs only in
where the JSON lives.

### Claude Desktop

File: `%APPDATA%\Claude\claude_desktop_config.json` (Windows) or
`~/Library/Application Support/Claude/claude_desktop_config.json` (macOS).

```json
{
  "mcpServers": {
    "arcui": {
      "command": "node",
      "args": [
        "C:\\Users\\Marlon\\Documents\\Unity\\ArcUI_System\\Tools\\mcp-server\\src\\server.js"
      ],
      "env": {
        "ARCUI_BRIDGE_URL": "http://localhost:17842"
      }
    }
  }
}
```

Restart Claude Desktop after editing. The tools appear under the 🔌
icon in the composer.

### Unity AI Assistant 2.6 (Claude Code agent)

The Unity Assistant package ships with Claude Code as a built-in agent.
Claude Code reads MCP servers from a project-level `.mcp.json`, so the
config is **already present** at the Unity project root:

```
C:\Users\Marlon\Documents\Unity\ArcUI_System\.mcp.json
```

To activate:
1. Open `Window > AI > Assistant`.
2. In the agent dropdown, click **+ Add agent**.
3. Choose Agent Type: **Claude Code**.
4. Paste your `ANTHROPIC_API_KEY` under Environment Variables.
5. Tick **Enable Agent** and close the Gateway.
6. Enter Unity Play Mode (for live data access) and chat.

### Cursor / other MCP clients

Point their config at `node <absolute path>/src/server.js` with the
same `ARCUI_BRIDGE_URL` env var. Format follows each client's docs.

---

## 5. Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `ARCUI_BRIDGE_URL` | `http://localhost:17842` | Base URL of `ArcHMIMcpBridge`. |
| `ARCUI_BRIDGE_TOKEN` | *(empty)* | Optional bearer token if the bridge runs with `authToken` set. |
| `ARCUI_BRIDGE_TIMEOUT_MS` | `5000` | Per-request timeout. |

---

## 6. Editor Monitor Window

Open `Window > ArcUI > MCP Bridge Monitor`.

Shows live bridge state:
- Running / stopped indicator.
- Uptime (seconds since HttpListener opened).
- Request count (total served).
- Last endpoint touched.

Provides:
- Start / Stop / Ping buttons.
- Auto-generated Claude Desktop JSON snippet with **Copy** button.
- Direct link to open `claude_desktop_config.json`.
- Full catalog of the 11 tools with descriptions.

Useful for debugging client ⇄ bridge connectivity without reading logs.

---

## 7. Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `check-bridge` fails with `ECONNREFUSED` | Unity not in Play Mode or bridge component disabled. | Enter Play Mode; verify `ArcHMIMcpBridge` is on a GameObject and enabled. |
| `Bridge request timed out after 5000ms` | Unity frozen, editor paused, or firewall blocking localhost:17842. | Check Unity is responsive; Windows Firewall prompt on first run. |
| Client shows "no tools available" | Server binary path wrong in client JSON. | Verify absolute path in `args[0]`, use double backslashes on Windows. |
| `Bridge 401: Unauthorized` | Server sending no `Authorization` header but bridge expects one. | Set `ARCUI_BRIDGE_TOKEN` in client env to match `ArcHMIMcpBridge.authToken`. |
| Claude Desktop: "Some MCP servers failed to load" | Nested `mcpServers` key in JSON. | Config must have exactly ONE top-level `mcpServers`. |
| Unity Assistant: "Insufficient points" warning | Unrelated — that's the built-in Unity AI agent. | Select the **Claude Code** agent instead; it uses your Anthropic API key. |

---

## 8. Integration roadmap (this project)

- ✅ **Phase 3a** — HTTP bridge + MCP server + Claude Desktop (done).
- ✅ **Phase 3b** — Editor Monitor Window (done).
- ✅ **Phase 3c** — Unity AI Assistant 2.6 via Claude Code agent (done).
- 🟡 **Phase 3d** — Fold Project Settings panel into MCP Bridge Monitor.
- 🔴 **Phase 4 (Paso D)** — Rewire ARIA Agent Tab to use MCP tool calling
  instead of Context Layer prompt injection. Lifts the in-scene operator
  agent from static context to live tools + HITL approval via SCB.
- 🔴 **Phase 5** — Rewire AI Assistant (UI Designer + Logic Script) to
  consume MCP tools (`validate_uxml`, `list_available_tags`, …) so the
  generated UXML/USS/C# grounds on real runtime data.

---

## 9. File map

```
Tools/mcp-server/
├── package.json            # Node manifest, ESM, requires Node ≥ 18
├── README.md               # This file
└── src/
    ├── server.js           # MCP stdio server, 11 tool definitions
    ├── bridge.js           # HTTP client → ArcHMIMcpBridge
    └── check-bridge.js     # Standalone sanity check (npm run check-bridge)

Assets/ArcUI_System/
├── Scripts/Core/
│   └── ArcHMIMcpBridge.cs  # Unity-side HttpListener + JSON routes
└── Editor/
    └── ArcUIMcpBridgeWindow.cs   # Editor monitor window

ArcUI_System/ (project root)
└── .mcp.json               # Claude Code / Unity Assistant MCP config
```

---

## 10. License & contact

Internal ArcUI project. Maintainer: Marlon Romero Castro.
