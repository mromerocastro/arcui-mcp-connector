import { GoogleGenAI } from "@google/genai";
import { existsSync, statSync } from "node:fs";
import { basename, delimiter, relative, resolve } from "node:path";

const DEFAULT_MODEL = "gemini-2.5-flash";
const DEFAULT_EMBEDDING_MODEL = "models/gemini-embedding-2";

const API_KEY = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || "";
const DEFAULT_STORE = normalizeStoreName(process.env.ARCUI_KNOWLEDGE_STORE || "");
const DEFAULT_MODEL_NAME = process.env.ARCUI_KNOWLEDGE_MODEL || DEFAULT_MODEL;
const DEFAULT_EMBEDDING_MODEL_NAME =
    process.env.ARCUI_KNOWLEDGE_EMBEDDING_MODEL || DEFAULT_EMBEDDING_MODEL;
const POLL_MS = parseInt(process.env.ARCUI_KNOWLEDGE_POLL_MS || "5000", 10);
const MAX_POLLS = parseInt(process.env.ARCUI_KNOWLEDGE_MAX_POLLS || "120", 10);
const ENABLE_KNOWLEDGE_TOOLS = isEnabled(process.env.ARCUI_ENABLE_KNOWLEDGE_TOOLS);
const ENABLE_KNOWLEDGE_INDEXING = isEnabled(process.env.ARCUI_ENABLE_KNOWLEDGE_INDEXING);
const ALLOWED_ROOTS = parseAllowedRoots(process.env.ARCUI_KNOWLEDGE_ROOTS || "");

let client;

function isEnabled(value) {
    return /^(1|true|yes|on)$/i.test(String(value || ""));
}

function parseAllowedRoots(value) {
    return value
        .split(delimiter)
        .map((entry) => entry.trim())
        .filter(Boolean)
        .map((entry) => resolve(entry));
}

function ensureKnowledgeEnabled() {
    if (!ENABLE_KNOWLEDGE_TOOLS) {
        throw new Error(
            "Knowledge tools are disabled. Set ARCUI_ENABLE_KNOWLEDGE_TOOLS=true to enable Gemini File Search tools.",
        );
    }
}

function ensureIndexingEnabled() {
    ensureKnowledgeEnabled();
    if (!ENABLE_KNOWLEDGE_INDEXING) {
        throw new Error(
            "Knowledge indexing is disabled. Set ARCUI_ENABLE_KNOWLEDGE_INDEXING=true and ARCUI_KNOWLEDGE_ROOTS to approved document folders.",
        );
    }
}

function resolveAllowedFile(path) {
    if (!path) throw new Error("Parameter 'path' is required.");
    const resolved = resolve(path);

    if (!existsSync(resolved)) throw new Error(`File not found: ${resolved}`);
    if (!statSync(resolved).isFile()) throw new Error(`Path is not a file: ${resolved}`);

    if (ALLOWED_ROOTS.length === 0) {
        throw new Error(
            "ARCUI_KNOWLEDGE_ROOTS is required for indexing. Add one or more approved document folders.",
        );
    }

    // Path comparison is case-insensitive to match Windows filesystem semantics
    // (the deployment target). On case-sensitive filesystems (Linux/macOS) this
    // is intentionally lax — if you ship there, replace toLowerCase() with a
    // platform-aware compare (e.g. branch on process.platform) so /Etc/passwd
    // and /etc/passwd are not treated as the same path.
    const resolvedLower = resolved.toLowerCase();
    const allowed = ALLOWED_ROOTS.some((root) => {
        const rootLower = root.toLowerCase();
        const rel = relative(rootLower, resolvedLower);
        return rel === "" || (!rel.startsWith("..") && !rel.startsWith("/") && !rel.startsWith("\\"));
    });

    if (!allowed) {
        throw new Error(
            `Refusing to index file outside ARCUI_KNOWLEDGE_ROOTS: ${resolved}`,
        );
    }

    return resolved;
}

function getClient() {
    ensureKnowledgeEnabled();
    if (!API_KEY) {
        throw new Error(
            "Gemini File Search is not configured. Set GEMINI_API_KEY or GOOGLE_API_KEY.",
        );
    }
    if (!client) client = new GoogleGenAI({ apiKey: API_KEY });
    return client;
}

function normalizeStoreName(name) {
    if (!name) return "";
    return name.startsWith("fileSearchStores/") ? name : `fileSearchStores/${name}`;
}

function compact(obj) {
    if (!obj || typeof obj !== "object") return obj;
    if (Array.isArray(obj)) return obj.map(compact).filter((v) => v !== undefined);

    const out = {};
    for (const [key, value] of Object.entries(obj)) {
        if (value === undefined || value === null || value === "") continue;
        out[key] = compact(value);
    }
    return out;
}

function metadataValue(value) {
    if (typeof value === "number" && Number.isFinite(value)) {
        return { numericValue: value };
    }
    if (typeof value === "boolean") {
        return { stringValue: value ? "true" : "false" };
    }
    return { stringValue: String(value) };
}

function toCustomMetadata(metadata = {}) {
    if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return undefined;
    const entries = Object.entries(metadata)
        .filter(([key, value]) => key && value !== undefined && value !== null && value !== "")
        .map(([key, value]) => ({ key, ...metadataValue(value) }));
    return entries.length ? entries : undefined;
}

function getResponseText(response) {
    if (!response) return "";
    if (typeof response.text === "string") return response.text;
    if (typeof response.text === "function") return response.text();

    const parts = response.candidates?.[0]?.content?.parts || [];
    return parts.map((p) => p.text || "").filter(Boolean).join("\n");
}

function getGrounding(response) {
    return response?.candidates?.[0]?.groundingMetadata || null;
}

function simplifyGrounding(groundingMetadata) {
    const chunks = groundingMetadata?.groundingChunks || [];
    return chunks
        .map((chunk) => chunk.retrievedContext)
        .filter(Boolean)
        .map((ctx) => ({
            title: ctx.title || "",
            uri: ctx.uri || "",
            page_number: ctx.pageNumber,
            file_search_store: ctx.fileSearchStore || "",
            text: ctx.text || "",
            custom_metadata: ctx.customMetadata || [],
        }));
}

async function waitForOperation(operation) {
    const ai = getClient();
    let current = operation;

    for (let i = 0; i < MAX_POLLS; i++) {
        if (current?.done) return current;
        await new Promise((resolve) => setTimeout(resolve, POLL_MS));
        current = await ai.operations.get({ operation: current });
    }

    throw new Error(
        `Gemini File Search operation did not finish after ${MAX_POLLS} polls.`,
    );
}

function requireStoreName(storeName) {
    const resolved = normalizeStoreName(storeName || DEFAULT_STORE);
    if (!resolved) {
        throw new Error(
            "No File Search store configured. Pass store_name or set ARCUI_KNOWLEDGE_STORE.",
        );
    }
    return resolved;
}

function parseJsonObject(text) {
    const trimmed = (text || "").trim();
    if (!trimmed) throw new Error("Gemini returned an empty response.");

    try { return JSON.parse(trimmed); }
    catch {
        const match = trimmed.match(/\{[\s\S]*\}/);
        if (!match) throw new Error("Gemini response did not contain a JSON object.");
        return JSON.parse(match[0]);
    }
}

const scenarioSchema = {
    type: "object",
    properties: {
        id: { type: "string" },
        display_name: { type: "string" },
        description: { type: "string" },
        objective: { type: "string" },
        tags_used: { type: "array", items: { type: "string" } },
        events: {
            type: "array",
            items: {
                type: "object",
                properties: {
                    offset_seconds: { type: "number" },
                    tag_key: { type: "string" },
                    value_type: { type: "string", enum: ["Float", "Int", "Bool", "String"] },
                    raw_value: { type: "string" },
                    description: { type: "string" },
                },
                required: ["tag_key", "value_type", "raw_value"],
            },
        },
        success_criteria: { type: "array", items: { type: "string" } },
        instructor_notes: { type: "array", items: { type: "string" } },
        rag_sources: {
            type: "array",
            items: {
                type: "object",
                properties: {
                    title: { type: "string" },
                    uri: { type: "string" },
                    page_number: { type: "number" },
                    claim: { type: "string" },
                },
            },
        },
        validation_status: { type: "string" },
        instructor_review_required: { type: "boolean" },
    },
    required: ["id", "display_name", "description", "events"],
};

function tagsForPrompt(tags) {
    if (!Array.isArray(tags)) return "[]";
    return JSON.stringify(
        tags.map((t) => ({
            key: t.key,
            type: t.type,
            value: t.value,
        })),
        null,
        2,
    );
}

function buildScenarioPrompt({ request, system, tags, constraints }) {
    return `
You are ArcUI's Training Scenario Designer.
Create a validated training scenario draft for ArcUI Training Mode.

System / equipment:
${system || "Unknown ArcUI system"}

Instructor request:
${request}

Available live ArcUI tags:
${tagsForPrompt(tags)}

Constraints:
${constraints || "Use only available tag keys. Keep event values plausible. Require instructor review."}

Return JSON only. The JSON must match this intent:
- id: stable kebab-case identifier
- display_name: short instructor-facing title
- description: trainee briefing
- objective: measurable training objective
- tags_used: only real ArcUI tag keys
- events: timeline using offset_seconds, tag_key, value_type, raw_value, description
- success_criteria: observable trainee outcomes
- instructor_notes: what the instructor should watch
- rag_sources: cite document titles/pages/claims from retrieved context when available
- validation_status: "draft"
- instructor_review_required: true
`.trim();
}

function buildDebriefPrompt({ session, request }) {
    return `
You are ArcUI's Training Debrief Assistant.
Evaluate the trainee session against validated procedures from the File Search store.

Instructor focus:
${request || "Generate a concise training debrief."}

Captured session JSON:
${JSON.stringify(session || {}, null, 2)}

Return a concise debrief with:
- summary
- correct actions
- missed or delayed actions
- safety/procedure alignment
- recommended next exercise
- citations or source titles when available
`.trim();
}

export const geminiFileSearch = {
    isEnabled: () => ENABLE_KNOWLEDGE_TOOLS,
    isIndexingEnabled: () => ENABLE_KNOWLEDGE_INDEXING,
    isConfigured: () => Boolean(API_KEY),
    defaultStoreName: () => DEFAULT_STORE,
    defaultModelName: () => DEFAULT_MODEL_NAME,
    allowedRoots: () => ALLOWED_ROOTS,

    async createStore({ display_name, embedding_model } = {}) {
        const ai = getClient();
        const store = await ai.fileSearchStores.create({
            config: compact({
                displayName: display_name || `ArcUI Knowledge ${Date.now()}`,
                embeddingModel: embedding_model || DEFAULT_EMBEDDING_MODEL_NAME,
            }),
        });
        return store;
    },

    async listStores() {
        const ai = getClient();
        const stores = [];
        const pager = await ai.fileSearchStores.list();
        for await (const store of pager) stores.push(store);
        return stores;
    },

    async listDocuments({ store_name } = {}) {
        const ai = getClient();
        const parent = requireStoreName(store_name);
        const docs = [];
        const pager = await ai.fileSearchStores.documents.list({ parent });
        for await (const doc of pager) docs.push(doc);
        return { store_name: parent, documents: docs };
    },

    async indexFile({
        path,
        store_name,
        display_name,
        metadata,
        max_tokens_per_chunk,
        max_overlap_tokens,
        wait = true,
    } = {}) {
        ensureIndexingEnabled();
        const resolvedPath = resolveAllowedFile(path);

        const ai = getClient();
        const fileSearchStoreName = requireStoreName(store_name);
        const operation = await ai.fileSearchStores.uploadToFileSearchStore({
            file: resolvedPath,
            fileSearchStoreName,
            config: compact({
                displayName: display_name || basename(resolvedPath),
                customMetadata: toCustomMetadata(metadata),
                chunkingConfig: max_tokens_per_chunk || max_overlap_tokens
                    ? {
                        whiteSpaceConfig: {
                            maxTokensPerChunk: max_tokens_per_chunk,
                            maxOverlapTokens: max_overlap_tokens,
                        },
                    }
                    : undefined,
            }),
        });

        const finalOperation = wait ? await waitForOperation(operation) : operation;
        return { store_name: fileSearchStoreName, operation: finalOperation };
    },

    async search({
        query,
        store_name,
        metadata_filter,
        model,
        instruction,
        response_mime_type,
        response_json_schema,
    } = {}) {
        if (!query) throw new Error("Parameter 'query' is required.");

        const ai = getClient();
        const fileSearchStoreName = requireStoreName(store_name);
        const response = await ai.models.generateContent({
            model: model || DEFAULT_MODEL_NAME,
            contents: instruction ? `${instruction}\n\n${query}` : query,
            config: compact({
                tools: [
                    {
                        fileSearch: {
                            fileSearchStoreNames: [fileSearchStoreName],
                            metadataFilter: metadata_filter,
                        },
                    },
                ],
                responseMimeType: response_mime_type,
                responseJsonSchema: response_json_schema,
            }),
        });

        const groundingMetadata = getGrounding(response);
        return {
            store_name: fileSearchStoreName,
            model: model || DEFAULT_MODEL_NAME,
            text: getResponseText(response),
            citations: simplifyGrounding(groundingMetadata),
            grounding_metadata: groundingMetadata,
        };
    },

    async generateScenario({ request, system, tags, constraints, store_name, metadata_filter, model } = {}) {
        if (!request) throw new Error("Parameter 'request' is required.");
        const prompt = buildScenarioPrompt({ request, system, tags, constraints });
        const result = await this.search({
            query: prompt,
            store_name,
            metadata_filter,
            model,
            response_mime_type: "application/json",
            response_json_schema: scenarioSchema,
        });
        const scenario = parseJsonObject(result.text);
        return {
            ...result,
            scenario: {
                ...scenario,
                validation_status: scenario.validation_status || "draft",
                instructor_review_required: scenario.instructor_review_required !== false,
            },
        };
    },

    async generateDebrief({ session, request, store_name, metadata_filter, model } = {}) {
        const prompt = buildDebriefPrompt({ session, request });
        return this.search({
            query: prompt,
            store_name,
            metadata_filter,
            model,
            instruction:
                "Ground the debrief in approved procedures. If evidence is missing, say what cannot be validated.",
        });
    },
};
