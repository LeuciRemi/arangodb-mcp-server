import { createHash } from "node:crypto";
import { McpServer, ProtocolError, ProtocolErrorCode, ResourceTemplate, } from "@modelcontextprotocol/server";
import { z } from "zod";
import { ArangoDBService } from "./arangodb-service.js";
import { publicErrorMessage, redactErrorMessage } from "./errors.js";
import { boundedObjectResult, boundedProtocolError, boundedQueryPageResult, boundedToolErrorResult, } from "./mcp-content.js";
class BoundedErrorMcpServer extends McpServer {
    config;
    constructor(config, ...args) {
        super(...args);
        this.config = config;
    }
    async connect(transport) {
        // The SDK creates validation errors before invoking tool callbacks. Apply the
        // same limit at the owned transport boundary so these errors are covered too.
        const send = transport.send.bind(transport);
        transport.send = (message, options) => {
            if ("error" in message && message.error) {
                // SDK v2 reports unknown tools and other protocol failures as JSON-RPC
                // errors rather than tool results; bound and redact them the same way.
                message = {
                    ...message,
                    error: boundedProtocolError({
                        ...message.error,
                        message: redactErrorMessage(message.error.message, this.config),
                    }, this.config.maxBytes),
                };
            }
            else if ("result" in message && message.result.isError === true) {
                const content = Array.isArray(message.result.content) ? message.result.content : [];
                const text = content
                    .filter((item) => item && item.type === "text" && typeof item.text === "string")
                    .map((item) => item.text)
                    .join("\n");
                message = {
                    ...message,
                    result: boundedToolErrorResult(redactErrorMessage(text || "Tool request failed", this.config), this.config.maxBytes),
                };
            }
            return send(message, options);
        };
        await super.connect(transport);
    }
}
const warningSchema = z.object({
    code: z.number().int(),
    message: z.string(),
});
const queryOutputSchema = z.object({
    rows: z.array(z.unknown()),
    rowCount: z.number().int().nonnegative(),
    bytes: z.number().int().nonnegative(),
    hasMore: z.boolean(),
    nextCursor: z.string().optional(),
    warnings: z.array(warningSchema),
    stats: z.record(z.string(), z.unknown()).optional(),
});
const readOnlyAnnotations = {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
};
function queryPageContent(page, maxBytes) {
    return boundedQueryPageResult(page, maxBytes);
}
function objectContent(structuredContent, maxBytes) {
    return boundedObjectResult(structuredContent, maxBytes);
}
function resourceText(value, uri, maxBytes) {
    const text = JSON.stringify(value);
    const bytes = Buffer.byteLength(JSON.stringify({
        contents: [{ uri, mimeType: "application/json", text }],
    }), "utf8");
    if (bytes > maxBytes) {
        throw new ProtocolError(ProtocolErrorCode.InternalError, `Complete MCP resource response is ${bytes} bytes and exceeds the configured ${maxBytes}-byte limit`);
    }
    return text;
}
function resourceSegment(value) {
    let decoded;
    try {
        if (typeof value !== "string") {
            throw new Error();
        }
        decoded = decodeURIComponent(value);
    }
    catch {
        throw new ProtocolError(ProtocolErrorCode.InvalidParams, "Invalid encoded resource URI segment");
    }
    if (!decoded ||
        decoded === "." ||
        decoded === ".." ||
        /[/\\?#\u0000-\u001f\u007f]/u.test(decoded)) {
        throw new ProtocolError(ProtocolErrorCode.InvalidParams, "Invalid resource URI segment");
    }
    return decoded;
}
function encodeListCursor(kind, context, after) {
    return Buffer.from(JSON.stringify({ kind, context, after }), "utf8").toString("base64url");
}
function decodeListCursor(cursor, expectedKind, expectedContext) {
    if (!cursor) {
        return undefined;
    }
    try {
        const decoded = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
        if (!decoded ||
            decoded.kind !== expectedKind ||
            decoded.context !== expectedContext ||
            typeof decoded.after !== "string") {
            throw new Error();
        }
        return decoded.after;
    }
    catch {
        throw new Error("Invalid list cursor");
    }
}
function paginateNames(items, name, kind, context, cursor, limit) {
    const after = decodeListCursor(cursor, kind, context);
    const remaining = after ? items.filter((item) => name(item) > after) : items;
    const visible = remaining.slice(0, limit);
    const hasMore = visible.length < remaining.length;
    return {
        visible,
        nextCursor: hasMore && visible.length
            ? encodeListCursor(kind, context, name(visible.at(-1)))
            : undefined,
    };
}
export function createArangoMcpServer(config, version) {
    const service = new ArangoDBService(config);
    const policyFingerprint = createHash("sha256")
        .update(JSON.stringify({
        databases: [...config.allowedDatabases].sort(),
        collections: [...config.allowedCollections].sort(),
    }))
        .digest("base64url")
        .slice(0, 16);
    const server = new BoundedErrorMcpServer(config, {
        name: "arangodb-mcp-server",
        title: "ArangoDB MCP Server",
        version,
        description: "Safe, bounded exploration and querying of ArangoDB databases",
        websiteUrl: "https://github.com/LeuciRemi/arangodb-mcp-server",
    }, {
        capabilities: { logging: {} },
        instructions: [
            "Use listDatabases, listCollections, and describeCollection before writing AQL.",
            "Use bindVars for values and collection names.",
            "readQuery is enforced as read-only and returns bounded pages.",
            "Use continueQuery only when a result contains nextCursor.",
            "Use sampleDocuments sparingly because database documents may contain sensitive data.",
        ].join(" "),
    });
    const continuationAnnotations = config.enableReadWriteQuery
        ? {
            readOnlyHint: false,
            destructiveHint: true,
            idempotentHint: false,
            openWorldHint: false,
        }
        : {
            ...readOnlyAnnotations,
            idempotentHint: false,
        };
    function log(level, data) {
        if (!server.isConnected()) {
            return;
        }
        void server.sendLoggingMessage({ level, data }).catch(() => undefined);
    }
    async function safely(operation, action) {
        try {
            return await action();
        }
        catch (error) {
            const message = publicErrorMessage(error, config);
            log("error", { operation, status: "failed" });
            throw new Error(message);
        }
    }
    async function safelyReadResource(operation, action) {
        try {
            return await action();
        }
        catch (error) {
            const message = publicErrorMessage(error, config);
            log("error", { operation, status: "failed" });
            throw new ProtocolError(ProtocolErrorCode.InternalError, message);
        }
    }
    const queryInputSchema = z.object({
        databaseName: z.string().min(1).describe("Database to query"),
        aql: z.string().min(1).max(100_000).describe("AQL query to execute"),
        bindVars: z
            .record(z.string(), z.unknown())
            .optional()
            .default({})
            .describe("AQL bind variables, including @collection keys for collection binds"),
        pageSize: z
            .number()
            .int()
            .min(1)
            .max(config.maxRows)
            .optional()
            .default(Math.min(50, config.maxRows))
            .describe(`Rows to return, capped at ${config.maxRows}`),
    });
    server.registerTool("readQuery", {
        title: "Run read-only AQL",
        description: "Run an AQL query in an ArangoDB read-only transaction. Data-modification plans are rejected before execution and results are size-bounded.",
        inputSchema: queryInputSchema,
        outputSchema: queryOutputSchema,
        annotations: readOnlyAnnotations,
    }, async ({ databaseName, aql, bindVars, pageSize }, ctx) => {
        log("debug", {
            operation: "readQuery",
            databaseName,
            queryLength: aql.length,
            bindVariableCount: Object.keys(bindVars).length,
        });
        const page = await safely("readQuery", () => service.executeReadQuery(databaseName, aql, bindVars, pageSize, ctx.mcpReq.signal));
        return queryPageContent(page, config.maxBytes);
    });
    server.registerTool("continueQuery", {
        title: "Continue a query",
        description: "Read the next bounded page from a stateful cursor returned by a query tool. When write-capable AQL is enabled, this also accepts readWriteQuery cursors.",
        inputSchema: z.object({
            cursor: z.string().uuid().describe("Opaque nextCursor from a previous query result"),
            pageSize: z
                .number()
                .int()
                .min(1)
                .max(config.maxRows)
                .optional()
                .default(Math.min(50, config.maxRows)),
        }),
        outputSchema: queryOutputSchema,
        annotations: continuationAnnotations,
    }, async ({ cursor, pageSize }, ctx) => {
        const page = await safely("continueQuery", () => service.continueQuery(cursor, pageSize, ctx.mcpReq.signal));
        return queryPageContent(page, config.maxBytes);
    });
    if (config.enableDiagnosticTools) {
        server.registerTool("explainQuery", {
            title: "Explain read-only AQL",
            description: "Validate that an AQL query is read-only and return a compact optimizer plan without executing it.",
            inputSchema: z.object({
                databaseName: queryInputSchema.shape.databaseName,
                aql: queryInputSchema.shape.aql,
                bindVars: queryInputSchema.shape.bindVars,
            }),
            outputSchema: z.object({
                databaseName: z.string(),
                isModificationQuery: z.boolean(),
                estimatedCost: z.number(),
                estimatedNrItems: z.number(),
                collections: z.array(z.object({ name: z.string(), type: z.enum(["read", "write"]) })),
                rules: z.array(z.string()),
                nodes: z.array(z.object({
                    type: z.string(),
                    estimatedCost: z.number(),
                    estimatedNrItems: z.number(),
                })),
                warnings: z.array(warningSchema),
            }),
            annotations: readOnlyAnnotations,
        }, async ({ databaseName, aql, bindVars }) => {
            const plan = await safely("explainQuery", () => service.explainReadQuery(databaseName, aql, bindVars));
            return objectContent({ ...plan }, config.maxBytes);
        });
    }
    server.registerTool("listDatabases", {
        title: "List databases",
        description: "List databases visible to both the ArangoDB user and server policy.",
        inputSchema: z.object({
            cursor: z.string().max(2_048).optional().describe("Opaque cursor from a previous page"),
            limit: z
                .number()
                .int()
                .min(1)
                .max(config.maxRows)
                .optional()
                .default(Math.min(50, config.maxRows)),
        }),
        outputSchema: z.object({
            databases: z.array(z.object({ name: z.string() })),
            totalDatabases: z.number().int().nonnegative(),
            truncated: z.boolean(),
            nextCursor: z.string().optional(),
        }),
        annotations: readOnlyAnnotations,
    }, async ({ cursor, limit }) => {
        const databases = await safely("listDatabases", () => service.listDatabases());
        const { visible, nextCursor } = paginateNames(databases, (databaseName) => databaseName, "databases", `databases:${policyFingerprint}`, cursor, limit);
        return objectContent({
            databases: visible.map((name) => ({ name })),
            totalDatabases: databases.length,
            truncated: nextCursor !== undefined,
            nextCursor,
        }, config.maxBytes);
    });
    server.registerTool("listCollections", {
        title: "List collections",
        description: "List non-system collections in an allowed database.",
        inputSchema: z.object({
            databaseName: z.string().min(1).describe("Database to inspect"),
            cursor: z.string().max(2_048).optional().describe("Opaque cursor from a previous page"),
            limit: z
                .number()
                .int()
                .min(1)
                .max(config.maxRows)
                .optional()
                .default(Math.min(50, config.maxRows)),
        }),
        outputSchema: z.object({
            databaseName: z.string(),
            collections: z.array(z.object({
                name: z.string(),
                type: z.number().int(),
                status: z.number().int(),
                isSystem: z.boolean(),
            })),
            totalCollections: z.number().int().nonnegative(),
            truncated: z.boolean(),
            nextCursor: z.string().optional(),
        }),
        annotations: readOnlyAnnotations,
    }, async ({ databaseName, cursor, limit }) => {
        const collections = await safely("listCollections", () => service.listCollections(databaseName));
        const { visible, nextCursor } = paginateNames(collections, (collection) => collection.name, "collections", `collections:${databaseName}:${policyFingerprint}`, cursor, limit);
        return objectContent({
            databaseName,
            collections: visible,
            totalCollections: collections.length,
            truncated: nextCursor !== undefined,
            nextCursor,
        }, config.maxBytes);
    });
    server.registerTool("describeCollection", {
        title: "Describe a collection",
        description: "Return collection properties, document count, optional JSON Schema, and indexes without sampling documents.",
        inputSchema: z.object({
            databaseName: z.string().min(1),
            collectionName: z.string().min(1),
        }),
        outputSchema: z.object({
            details: z.record(z.string(), z.unknown()),
        }),
        annotations: readOnlyAnnotations,
    }, async ({ databaseName, collectionName }) => {
        const details = await safely("describeCollection", () => service.describeCollection(databaseName, collectionName));
        return objectContent({ details }, config.maxBytes);
    });
    server.registerTool("sampleDocuments", {
        title: "Sample documents",
        description: "Explicitly sample up to 20 documents, optionally projecting selected fields. Use only when document contents are needed.",
        inputSchema: z.object({
            databaseName: z.string().min(1),
            collectionName: z.string().min(1),
            limit: z
                .number()
                .int()
                .min(1)
                .max(Math.min(20, config.maxRows))
                .optional()
                .default(Math.min(5, config.maxRows)),
            fields: z.array(z.string().min(1)).max(100).optional().default([]),
        }),
        outputSchema: queryOutputSchema,
        annotations: readOnlyAnnotations,
    }, async ({ databaseName, collectionName, limit, fields }, ctx) => {
        const page = await safely("sampleDocuments", () => service.sampleDocuments(databaseName, collectionName, limit, fields, ctx.mcpReq.signal));
        return queryPageContent(page, config.maxBytes);
    });
    if (config.enableDiagnosticTools) {
        server.registerTool("healthCheck", {
            title: "Check ArangoDB health",
            description: "Check connectivity and report ArangoDB version, availability, active cursor count, policies, and safety limits.",
            outputSchema: z.object({
                health: z.record(z.string(), z.unknown()),
            }),
            annotations: readOnlyAnnotations,
        }, async () => {
            const health = await safely("healthCheck", () => service.health());
            return objectContent({ health }, config.maxBytes);
        });
    }
    if (config.enableDocumentWrites) {
        const documentWriteInput = {
            databaseName: z.string().min(1),
            collectionName: z.string().min(1),
        };
        const documentOutput = z.object({
            metadata: z.record(z.string(), z.unknown()),
        });
        server.registerTool("insertDocument", {
            title: "Insert a document",
            description: "Insert one bounded document into an allowed collection and return its operation metadata.",
            inputSchema: z.object({
                ...documentWriteInput,
                document: z.record(z.string(), z.unknown()),
            }),
            outputSchema: documentOutput,
            annotations: {
                readOnlyHint: false,
                destructiveHint: false,
                idempotentHint: false,
                openWorldHint: false,
            },
        }, async ({ databaseName, collectionName, document }) => {
            const stored = await safely("insertDocument", () => service.insertDocument(databaseName, collectionName, document));
            return objectContent({ metadata: stored }, config.maxBytes);
        });
        server.registerTool("updateDocument", {
            title: "Update a document",
            description: "Patch one document only if its current _rev matches, preventing lost updates.",
            inputSchema: z.object({
                ...documentWriteInput,
                documentId: z.string().min(1),
                revision: z.string().min(1).describe("Expected current _rev"),
                patch: z.record(z.string(), z.unknown()),
            }),
            outputSchema: documentOutput,
            annotations: {
                readOnlyHint: false,
                destructiveHint: true,
                idempotentHint: false,
                openWorldHint: false,
            },
        }, async ({ databaseName, collectionName, documentId, revision, patch }) => {
            const updated = await safely("updateDocument", () => service.updateDocument(databaseName, collectionName, documentId, revision, patch));
            return objectContent({ metadata: updated }, config.maxBytes);
        });
        server.registerTool("deleteDocument", {
            title: "Delete a document",
            description: "Delete one document only if its current _rev matches and return operation metadata.",
            inputSchema: z.object({
                ...documentWriteInput,
                documentId: z.string().min(1),
                revision: z.string().min(1).describe("Expected current _rev"),
            }),
            outputSchema: documentOutput,
            annotations: {
                readOnlyHint: false,
                destructiveHint: true,
                idempotentHint: false,
                openWorldHint: false,
            },
        }, async ({ databaseName, collectionName, documentId, revision }) => {
            const deleted = await safely("deleteDocument", () => service.deleteDocument(databaseName, collectionName, documentId, revision));
            return objectContent({ metadata: deleted }, config.maxBytes);
        });
    }
    if (config.enableReadWriteQuery) {
        server.registerTool("readWriteQuery", {
            title: "Run write-capable AQL",
            description: "Run arbitrary AQL including destructive modifications. This higher-privilege tool is exposed only when write-capable AQL is separately enabled.",
            inputSchema: queryInputSchema,
            outputSchema: queryOutputSchema,
            annotations: {
                readOnlyHint: false,
                destructiveHint: true,
                idempotentHint: false,
                openWorldHint: false,
            },
        }, async ({ databaseName, aql, bindVars, pageSize }, ctx) => {
            log("warning", {
                operation: "readWriteQuery",
                databaseName,
                queryLength: aql.length,
                bindVariableCount: Object.keys(bindVars).length,
            });
            const page = await safely("readWriteQuery", () => service.executeWriteQuery(databaseName, aql, bindVars, pageSize, ctx.mcpReq.signal));
            return queryPageContent(page, config.maxBytes);
        });
    }
    const collectionTemplate = new ResourceTemplate("arangodb:///{database}/{collection}", {
        list: undefined,
        complete: {
            database: async (value) => {
                try {
                    return (await service.listDatabases())
                        .filter((name) => name.startsWith(value))
                        .slice(0, 100);
                }
                catch {
                    return [];
                }
            },
            collection: async (value, context) => {
                const databaseName = context?.arguments?.database;
                if (!databaseName) {
                    return [];
                }
                try {
                    return (await service.listCollections(databaseName))
                        .map((collection) => collection.name)
                        .filter((name) => name.startsWith(value))
                        .slice(0, 100);
                }
                catch {
                    return [];
                }
            },
        },
    });
    server.registerResource("ArangoDB collection metadata", collectionTemplate, {
        title: "ArangoDB collection metadata",
        mimeType: "application/json",
        description: "Collection properties, document count, schema, and indexes",
        annotations: { audience: ["assistant"], priority: 0.7 },
    }, async (uri, variables) => {
        const databaseName = resourceSegment(variables.database);
        const collectionName = resourceSegment(variables.collection);
        const details = await safelyReadResource("collectionResource", () => service.describeCollection(databaseName, collectionName));
        return {
            contents: [
                {
                    uri: uri.href,
                    mimeType: "application/json",
                    text: resourceText(details, uri.href, config.maxBytes),
                },
            ],
        };
    });
    server.registerResource("ArangoDB document", new ResourceTemplate("arangodb:///{database}/{collection}/{documentId}", {
        list: undefined,
        complete: {
            database: collectionTemplate.completeCallback("database"),
            collection: collectionTemplate.completeCallback("collection"),
        },
    }), {
        title: "ArangoDB document",
        mimeType: "application/json",
        description: "A single explicitly addressed ArangoDB document",
        annotations: { audience: ["assistant"], priority: 0.5 },
    }, async (uri, variables) => {
        const databaseName = resourceSegment(variables.database);
        const collectionName = resourceSegment(variables.collection);
        const documentId = resourceSegment(variables.documentId);
        const document = await safelyReadResource("documentResource", () => service.readDocument(databaseName, collectionName, documentId));
        return {
            contents: [
                {
                    uri: uri.href,
                    mimeType: "application/json",
                    text: resourceText(document, uri.href, config.maxBytes),
                },
            ],
        };
    });
    server.registerPrompt("exploreDatabase", {
        title: "Explore an ArangoDB database safely",
        description: "Guide a bounded, schema-first exploration of a database",
        argsSchema: z.object({
            databaseName: z.string().min(1).describe("Database to explore"),
        }),
    }, async ({ databaseName }) => ({
        messages: [
            {
                role: "user",
                content: {
                    type: "text",
                    text: [
                        `Explore the ArangoDB database "${databaseName}" safely.`,
                        "First list its collections, then describe only the relevant collections.",
                        config.enableDiagnosticTools
                            ? "Use explainQuery before expensive AQL and use bind variables for values."
                            : "Use bind variables for values and keep AQL queries narrowly scoped.",
                        "Keep result pages small and summarize findings without exposing unnecessary document fields.",
                    ].join(" "),
                },
            },
        ],
    }));
    let closePromise;
    function close() {
        // Defer execution until the promise is assigned: server.close() invokes
        // onclose synchronously, which must reuse this promise instead of recursing.
        closePromise ??= Promise.resolve().then(async () => {
            try {
                await server.close();
            }
            finally {
                await service.close();
            }
        });
        return closePromise;
    }
    server.server.onclose = () => {
        void close().catch((error) => {
            server.server.onerror?.(error instanceof Error ? error : new Error(String(error)));
        });
    };
    return { server, service, close };
}
