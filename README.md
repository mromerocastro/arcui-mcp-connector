# ArcUI MCP Connector

Official Node.js Model Context Protocol (MCP) connector for the **ArcUI System**.
This acts as a standard MCP Server (stdio) that bridges external AI clients (like Claude Desktop, Cursor IDE, Windsurf, etc.) with your live ArcUI Digital Twins in Unity.

## ⚠️ Important Note
This connector is an **optional add-on** for advanced users. The core ArcUI System (including the ARIA Agentic Panel) works natively inside Unity and does *not* require Node.js or this connector to function.

## Prerequisites
*   [Node.js](https://nodejs.org/) installed on your system.
*   An active ArcUI System project running in the Unity Editor or a standalone build.

## Installation

1. Clone this repository to your local machine:
   ```bash
   git clone https://github.com/mromerocastro/arcui-mcp-connector.git
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
