import { createHash } from "node:crypto";

import {
  McpServer,
  ProtocolError,
  ProtocolErrorCode,
  ResourceTemplate,
  type Transport,
} from "@modelcontextprotocol/server";
import { z } from "zod";

import { ArangoDBService, type QueryPage } from "./arangodb-service.js";
import type { ServerConfig } from "./config.js";
import { publicErrorMessage, redactErrorMessage } from "./errors.js";
import {
  boundedObjectResult,
  boundedProtocolError,
  boundedQueryPageResult,
  boundedToolErrorResult,
} from "./mcp-content.js";

class BoundedErrorMcpServer extends McpServer {
  constructor(
    private readonly config: ServerConfig,
    ...args: ConstructorParameters<typeof McpServer>
  ) {
    super(...args);
  }

  override async connect(transport: Transport): Promise<void> {
    // The SDK creates validation errors before invoking tool callbacks. Apply the
    // same limit at the owned transport boundary so these errors are covered too.
    const send = transport.send.bind(transport);
    transport.send = (message, options) => {
      if ("error" in message && message.error) {
        // SDK v2 reports unknown tools and other protocol failures as JSON-RPC
        // errors rather than tool results; bound and redact them the same way.
        message = {
          ...message,
          error: boundedProtocolError(
            {
              ...message.error,
              message: redactErrorMessage(message.error.message, this.config),
            },
            this.config.maxBytes,
          ),
        };
      } else if ("result" in message && message.result.isError === true) {
        const content = Array.isArray(message.result.content) ? message.result.content : [];
        const text = content
          .filter((item) => item && item.type === "text" && typeof item.text === "string")
          .map((item) => item.text)
          .join("\n");
        message = {
          ...message,
          result: boundedToolErrorResult(
            redactErrorMessage(text || "Tool request failed", this.config),
            this.config.maxBytes,
          ),
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
  hasMore: z.boolean(),
  nextCursor: z.string().optional(),
  warnings: z.array(warningSchema).optional(),
  stats: z.record(z.string(), z.unknown()).optional(),
});

const writeQueryOutputSchema = queryOutputSchema.extend({
  writesExecuted: z.number(),
  writesIgnored: z.number(),
});

const collectionIndexSchema = z.object({
  name: z.string(),
  type: z.string(),
  fields: z.array(z.string()),
  unique: z.boolean().optional(),
  sparse: z.boolean().optional(),
  expireAfter: z.number().optional(),
});

const describeCollectionOutputSchema = z.object({
  databaseName: z.string(),
  collectionName: z.string(),
  type: z.enum(["document", "edge"]),
  documentCount: z.number().int().nonnegative(),
  schema: z.record(z.string(), z.unknown()).optional(),
  computedValues: z.unknown().optional(),
  indexes: z.array(collectionIndexSchema),
  properties: z.record(z.string(), z.unknown()).optional(),
  rawIndexes: z.array(z.record(z.string(), z.unknown())).optional(),
});

const readOnlyAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

function queryPageContent(
  page: QueryPage,
  maxBytes: number,
  options: { includeStats?: boolean; includeWriteStats?: boolean } = {},
) {
  return boundedQueryPageResult(page, maxBytes, options);
}

function objectContent(structuredContent: Record<string, unknown>, maxBytes: number) {
  return boundedObjectResult(structuredContent, maxBytes);
}

function recordOf(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** Project the service's raw collection description onto the compact contract. */
function compactCollectionDescription(
  details: Record<string, unknown>,
  verbose: boolean,
): Record<string, unknown> {
  const properties = recordOf(details.properties);
  const rawIndexes = (Array.isArray(details.indexes) ? details.indexes : []).map(recordOf);
  const computedValues = properties.computedValues;
  const hasComputedValues = Array.isArray(computedValues)
    ? computedValues.length > 0
    : computedValues !== null &&
      typeof computedValues === "object" &&
      Object.keys(computedValues).length > 0;
  return {
    databaseName: details.databaseName,
    collectionName: details.collectionName,
    type: properties.type === 3 ? "edge" : "document",
    documentCount: details.documentCount,
    ...(properties.schema && typeof properties.schema === "object"
      ? { schema: properties.schema }
      : {}),
    ...(hasComputedValues ? { computedValues } : {}),
    indexes: rawIndexes.map((index) => ({
      name: index.name,
      type: index.type,
      fields: (Array.isArray(index.fields) ? index.fields : []).flatMap((field) => {
        if (typeof field === "string") {
          return [field];
        }
        const name = recordOf(field).name;
        return typeof name === "string" ? [name] : [];
      }),
      ...(index.unique === true ? { unique: true } : {}),
      ...(index.sparse === true ? { sparse: true } : {}),
      ...(index.type === "ttl" && typeof index.expireAfter === "number"
        ? { expireAfter: index.expireAfter }
        : {}),
    })),
    ...(verbose ? { properties, rawIndexes } : {}),
  };
}

function resourceText(value: unknown, uri: string, maxBytes: number): string {
  const text = JSON.stringify(value);
  const bytes = Buffer.byteLength(
    JSON.stringify({
      contents: [{ uri, mimeType: "application/json", text }],
    }),
    "utf8",
  );
  if (bytes > maxBytes) {
    throw new ProtocolError(
      ProtocolErrorCode.InternalError,
      `Complete MCP resource response is ${bytes} bytes and exceeds the configured ${maxBytes}-byte limit`,
    );
  }
  return text;
}

function resourceSegment(value: string | string[] | undefined): string {
  let decoded: string;
  try {
    if (typeof value !== "string") {
      throw new Error();
    }
    decoded = decodeURIComponent(value);
  } catch {
    throw new ProtocolError(ProtocolErrorCode.InvalidParams, "Invalid encoded resource URI segment");
  }
  if (
    !decoded ||
    decoded === "." ||
    decoded === ".." ||
    /[/\\?#\u0000-\u001f\u007f]/u.test(decoded)
  ) {
    throw new ProtocolError(ProtocolErrorCode.InvalidParams, "Invalid resource URI segment");
  }
  return decoded;
}

type ListCursorKind = "databases" | "collections" | "graphs" | "views";

function encodeListCursor(kind: ListCursorKind, context: string, after: string): string {
  return Buffer.from(JSON.stringify({ kind, context, after }), "utf8").toString("base64url");
}

function decodeListCursor(
  cursor: string | undefined,
  expectedKind: ListCursorKind,
  expectedContext: string,
): string | undefined {
  if (!cursor) {
    return undefined;
  }
  try {
    const decoded = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (
      !decoded ||
      decoded.kind !== expectedKind ||
      decoded.context !== expectedContext ||
      typeof decoded.after !== "string"
    ) {
      throw new Error();
    }
    return decoded.after;
  } catch {
    throw new Error("Invalid list cursor");
  }
}

function paginateNames<T>(
  items: T[],
  name: (item: T) => string,
  kind: ListCursorKind,
  context: string,
  cursor: string | undefined,
  limit: number,
): { visible: T[]; nextCursor?: string } {
  const after = decodeListCursor(cursor, kind, context);
  const remaining = after ? items.filter((item) => name(item) > after) : items;
  const visible = remaining.slice(0, limit);
  const hasMore = visible.length < remaining.length;
  return {
    visible,
    nextCursor:
      hasMore && visible.length
        ? encodeListCursor(kind, context, name(visible.at(-1)!))
        : undefined,
  };
}

export interface ArangoMcpApplication {
  server: McpServer;
  service: ArangoDBService;
  close(): Promise<void>;
}

export function createArangoMcpServer(
  config: ServerConfig,
  version: string,
): ArangoMcpApplication {
  const service = new ArangoDBService(config);
  const policyFingerprint = createHash("sha256")
    .update(
      JSON.stringify({
        databases: [...config.allowedDatabases].sort(),
        collections: [...config.allowedCollections].sort(),
      }),
    )
    .digest("base64url")
    .slice(0, 16);
  const server = new BoundedErrorMcpServer(
    config,
    {
      name: "arangodb-mcp-server",
      title: "ArangoDB MCP Server",
      version,
      description: "Safe, bounded exploration and querying of ArangoDB databases",
      websiteUrl: "https://github.com/LeuciRemi/arangodb-mcp-server",
    },
    {
      capabilities: { logging: {} },
      instructions: [
        "Work from metadata to data: listDatabases, then listCollections (names, types, document counts), then describeCollection or inferSchema before writing AQL.",
        "Call listGraphs before graph traversals and listViews before SEARCH queries.",
        "Use bindVars for values and collection names; declare collections accessed dynamically (DOCUMENT(), anonymous traversals) in a leading WITH statement.",
        "readQuery is read-only and returns bounded pages.",
        "Call continueQuery only with a nextCursor returned by the previous page.",
        "Use sampleDocuments only when document contents are needed, because database documents may contain sensitive data.",
      ].join(" "),
    },
  );
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

  function log(level: "debug" | "info" | "warning" | "error", data: unknown): void {
    if (!server.isConnected()) {
      return;
    }
    void server.sendLoggingMessage({ level, data }).catch(() => undefined);
  }

  async function safely<T>(operation: string, action: () => Promise<T>): Promise<T> {
    try {
      return await action();
    } catch (error) {
      const message = publicErrorMessage(error, config);
      log("error", { operation, status: "failed" });
      throw new Error(message);
    }
  }

  async function safelyReadResource<T>(
    operation: string,
    action: () => Promise<T>,
  ): Promise<T> {
    try {
      return await action();
    } catch (error) {
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
    includeStats: z
      .boolean()
      .optional()
      .default(false)
      .describe(
        "Include query statistics; a read query reports them only when the whole result fits the first page",
      ),
  });

  server.registerTool(
    "readQuery",
    {
      title: "Run read-only AQL",
      description:
        "Run AQL in a read-only transaction and return a bounded page. Use bindVars for values and collection names.",
      inputSchema: queryInputSchema,
      outputSchema: queryOutputSchema,
      annotations: readOnlyAnnotations,
    },
    async ({ databaseName, aql, bindVars, pageSize, includeStats }, ctx) => {
      log("debug", {
        operation: "readQuery",
        databaseName,
        queryLength: aql.length,
        bindVariableCount: Object.keys(bindVars).length,
      });
      const page = await safely("readQuery", () =>
        service.executeReadQuery(databaseName, aql, bindVars, pageSize, ctx.mcpReq.signal),
      );
      return queryPageContent(page, config.maxBytes, { includeStats });
    },
  );

  server.registerTool(
    "continueQuery",
    {
      title: "Continue a query",
      description:
        "Fetch the next bounded page for a nextCursor returned by readQuery or readWriteQuery, before the cursor expires.",
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
    },
    async ({ cursor, pageSize }, ctx) => {
      const page = await safely("continueQuery", () =>
        service.continueQuery(cursor, pageSize, ctx.mcpReq.signal),
      );
      return queryPageContent(page, config.maxBytes);
    },
  );

  if (config.enableDiagnosticTools) {
    server.registerTool(
      "explainQuery",
      {
        title: "Explain read-only AQL",
        description:
          "Validate that an AQL query is read-only and return a compact optimizer plan without executing it.",
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
          collections: z.array(
            z.object({ name: z.string(), type: z.enum(["read", "write"]) }),
          ),
          views: z.array(z.string()),
          rules: z.array(z.string()),
          nodes: z.array(
            z.object({
              type: z.string(),
              estimatedCost: z.number(),
              estimatedNrItems: z.number(),
            }),
          ),
          warnings: z.array(warningSchema),
        }),
        annotations: readOnlyAnnotations,
      },
      async ({ databaseName, aql, bindVars }) => {
        const plan = await safely("explainQuery", () =>
          service.explainReadQuery(databaseName, aql, bindVars),
        );
        return objectContent({ ...plan }, config.maxBytes);
      },
    );
  }

  server.registerTool(
    "listDatabases",
    {
      title: "List databases",
      description:
        "List databases allowed by server policy. Start exploration here, then call listCollections for one database.",
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
        databases: z.array(z.string()),
        totalDatabases: z.number().int().nonnegative(),
        nextCursor: z.string().optional(),
      }),
      annotations: readOnlyAnnotations,
    },
    async ({ cursor, limit }) => {
      const databases = await safely("listDatabases", () => service.listDatabases());
      const { visible, nextCursor } = paginateNames(
        databases,
        (databaseName) => databaseName,
        "databases",
        `databases:${policyFingerprint}`,
        cursor,
        limit,
      );
      return objectContent(
        {
          databases: visible,
          totalDatabases: databases.length,
          ...(nextCursor === undefined ? {} : { nextCursor }),
        },
        config.maxBytes,
      );
    },
  );

  server.registerTool(
    "listCollections",
    {
      title: "List collections",
      description:
        "List collection names, types, and document counts in an allowed database.",
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
        collections: z.array(
          z.object({
            name: z.string(),
            type: z.enum(["document", "edge"]),
            count: z.number().int().nonnegative().optional(),
          }),
        ),
        totalCollections: z.number().int().nonnegative(),
        nextCursor: z.string().optional(),
      }),
      annotations: readOnlyAnnotations,
    },
    async ({ databaseName, cursor, limit }) => {
      const collections = await safely("listCollections", () =>
        service.listCollections(databaseName),
      );
      const { visible, nextCursor } = paginateNames(
        collections,
        (collection) => collection.name,
        "collections",
        `collections:${databaseName}:${policyFingerprint}`,
        cursor,
        limit,
      );
      const counts = visible.length
        ? await safely("listCollections", () =>
            service.collectionCounts(
              databaseName,
              visible.map((collection) => collection.name),
            ),
          )
        : {};
      return objectContent(
        {
          databaseName,
          collections: visible.map((collection) => ({
            name: collection.name,
            type: collection.type,
            ...(counts[collection.name] === undefined
              ? {}
              : { count: counts[collection.name] }),
          })),
          totalCollections: collections.length,
          ...(nextCursor === undefined ? {} : { nextCursor }),
        },
        config.maxBytes,
      );
    },
  );

  server.registerTool(
    "describeCollection",
    {
      title: "Describe a collection",
      description:
        "Describe one collection: type, document count, schema, computed values, and indexes. Set verbose for raw properties and indexes.",
      inputSchema: z.object({
        databaseName: z.string().min(1),
        collectionName: z.string().min(1),
        verbose: z
          .boolean()
          .optional()
          .default(false)
          .describe("Also return raw collection properties and index objects"),
      }),
      outputSchema: describeCollectionOutputSchema,
      annotations: readOnlyAnnotations,
    },
    async ({ databaseName, collectionName, verbose }) => {
      const details = await safely("describeCollection", () =>
        service.describeCollection(databaseName, collectionName),
      );
      return objectContent(
        compactCollectionDescription(details, verbose),
        config.maxBytes,
      );
    },
  );

  server.registerTool(
    "inferSchema",
    {
      title: "Infer a collection schema",
      description:
        "Infer field paths and per-type counts from the first sampleSize documents in storage order (not a random sample). The aggregation runs entirely inside ArangoDB.",
      inputSchema: z.object({
        databaseName: z.string().min(1),
        collectionName: z.string().min(1),
        sampleSize: z
          .number()
          .int()
          .min(1)
          .max(1_000)
          .optional()
          .default(100)
          .describe("Documents to scan in storage order (1-1000)"),
      }),
      outputSchema: z.object({
        databaseName: z.string(),
        collectionName: z.string(),
        sampledDocuments: z.number().int().nonnegative(),
        fields: z.array(
          z.object({
            path: z.string(),
            types: z.record(z.string(), z.number()),
          }),
        ),
        truncated: z.boolean(),
      }),
      annotations: readOnlyAnnotations,
    },
    async ({ databaseName, collectionName, sampleSize }, ctx) => {
      const schema = await safely("inferSchema", () =>
        service.inferSchema(databaseName, collectionName, sampleSize, ctx.mcpReq.signal),
      );
      return objectContent(
        { databaseName, collectionName, ...schema },
        config.maxBytes,
      );
    },
  );

  server.registerTool(
    "listGraphs",
    {
      title: "List graphs",
      description:
        "List named graphs with their edge definitions and orphan collections. Call it before GRAPH traversals.",
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
        graphs: z.array(
          z.object({
            name: z.string(),
            edgeDefinitions: z.array(
              z.object({
                collection: z.string(),
                from: z.array(z.string()),
                to: z.array(z.string()),
              }),
            ),
            orphanCollections: z.array(z.string()).optional(),
          }),
        ),
        totalGraphs: z.number().int().nonnegative(),
        nextCursor: z.string().optional(),
      }),
      annotations: readOnlyAnnotations,
    },
    async ({ databaseName, cursor, limit }) => {
      const graphs = await safely("listGraphs", () => service.listGraphs(databaseName));
      const { visible, nextCursor } = paginateNames(
        graphs,
        (graph) => graph.name,
        "graphs",
        `graphs:${databaseName}:${policyFingerprint}`,
        cursor,
        limit,
      );
      return objectContent(
        {
          databaseName,
          graphs: visible,
          totalGraphs: graphs.length,
          ...(nextCursor === undefined ? {} : { nextCursor }),
        },
        config.maxBytes,
      );
    },
  );

  server.registerTool(
    "listViews",
    {
      title: "List views",
      description:
        "List ArangoSearch and search-alias views with the collections they read and compact link definitions. Call it before SEARCH queries.",
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
        views: z.array(
          z.discriminatedUnion("type", [
            z.object({
              name: z.string(),
              type: z.literal("arangosearch"),
              collections: z.array(z.string()),
              links: z
                .record(z.string(), z.record(z.string(), z.unknown()))
                .optional(),
              primarySort: z.array(z.record(z.string(), z.unknown())).optional(),
            }),
            z.object({
              name: z.string(),
              type: z.literal("search-alias"),
              collections: z.array(z.string()),
              indexes: z.array(
                z.object({ collection: z.string(), index: z.string() }),
              ),
            }),
          ]),
        ),
        totalViews: z.number().int().nonnegative(),
        nextCursor: z.string().optional(),
      }),
      annotations: readOnlyAnnotations,
    },
    async ({ databaseName, cursor, limit }) => {
      const views = await safely("listViews", () => service.listViews(databaseName));
      const { visible, nextCursor } = paginateNames(
        views,
        (view) => view.name,
        "views",
        `views:${databaseName}:${policyFingerprint}`,
        cursor,
        limit,
      );
      return objectContent(
        {
          databaseName,
          views: visible,
          totalViews: views.length,
          ...(nextCursor === undefined ? {} : { nextCursor }),
        },
        config.maxBytes,
      );
    },
  );

  server.registerTool(
    "sampleDocuments",
    {
      title: "Sample documents",
      description:
        "Explicitly sample up to 20 documents, optionally projecting selected fields. Use only when document contents are needed.",
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
    },
    async ({ databaseName, collectionName, limit, fields }, ctx) => {
      const page = await safely("sampleDocuments", () =>
        service.sampleDocuments(
          databaseName,
          collectionName,
          limit,
          fields,
          ctx.mcpReq.signal,
        ),
      );
      return queryPageContent(page, config.maxBytes);
    },
  );

  if (config.enableDiagnosticTools) {
    server.registerTool(
      "healthCheck",
      {
        title: "Check ArangoDB health",
        description:
          "Check connectivity and report ArangoDB version, availability, active cursor count, policies, and safety limits.",
        outputSchema: z.object({
          health: z.record(z.string(), z.unknown()),
        }),
        annotations: readOnlyAnnotations,
      },
      async () => {
        const health = await safely("healthCheck", () => service.health());
        return objectContent({ health }, config.maxBytes);
      },
    );
  }

  if (config.enableDocumentWrites) {
    const documentWriteInput = {
      databaseName: z.string().min(1),
      collectionName: z.string().min(1),
    };
    const documentOutput = z.object({
      metadata: z.record(z.string(), z.unknown()),
    });

    server.registerTool(
      "insertDocument",
      {
        title: "Insert a document",
        description:
          "Insert one bounded document into an allowed collection and return its operation metadata.",
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
      },
      async ({ databaseName, collectionName, document }) => {
        const stored = await safely("insertDocument", () =>
          service.insertDocument(databaseName, collectionName, document),
        );
        return objectContent({ metadata: stored }, config.maxBytes);
      },
    );

    server.registerTool(
      "updateDocument",
      {
        title: "Update a document",
        description:
          "Patch one document only if its current _rev matches, preventing lost updates.",
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
      },
      async ({ databaseName, collectionName, documentId, revision, patch }) => {
        const updated = await safely("updateDocument", () =>
          service.updateDocument(
            databaseName,
            collectionName,
            documentId,
            revision,
            patch,
          ),
        );
        return objectContent({ metadata: updated }, config.maxBytes);
      },
    );

    server.registerTool(
      "deleteDocument",
      {
        title: "Delete a document",
        description:
          "Delete one document only if its current _rev matches and return operation metadata.",
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
      },
      async ({ databaseName, collectionName, documentId, revision }) => {
        const deleted = await safely("deleteDocument", () =>
          service.deleteDocument(
            databaseName,
            collectionName,
            documentId,
            revision,
          ),
        );
        return objectContent({ metadata: deleted }, config.maxBytes);
      },
    );
  }

  if (config.enableReadWriteQuery) {
    server.registerTool(
      "readWriteQuery",
      {
        title: "Run write-capable AQL",
        description:
          "Run arbitrary AQL, including modifications. Available only when write-capable AQL is separately enabled; writes are committed before the first page is returned.",
        inputSchema: queryInputSchema,
        outputSchema: writeQueryOutputSchema,
        annotations: {
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: false,
          openWorldHint: false,
        },
      },
      async ({ databaseName, aql, bindVars, pageSize, includeStats }, ctx) => {
        log("warning", {
          operation: "readWriteQuery",
          databaseName,
          queryLength: aql.length,
          bindVariableCount: Object.keys(bindVars).length,
        });
        const page = await safely("readWriteQuery", () =>
          service.executeWriteQuery(databaseName, aql, bindVars, pageSize, ctx.mcpReq.signal),
        );
        return queryPageContent(page, config.maxBytes, {
          includeStats,
          includeWriteStats: true,
        });
      },
    );
  }

  const collectionTemplate = new ResourceTemplate(
    "arangodb:///{database}/{collection}",
    {
      list: undefined,
      complete: {
        database: async (value) => {
          try {
            return (await service.listDatabases())
              .filter((name) => name.startsWith(value))
              .slice(0, 100);
          } catch {
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
          } catch {
            return [];
          }
        },
      },
    },
  );

  server.registerResource(
    "ArangoDB collection metadata",
    collectionTemplate,
    {
      title: "ArangoDB collection metadata",
      mimeType: "application/json",
      description: "Compact collection type, document count, schema, and indexes",
      annotations: { audience: ["assistant"], priority: 0.7 },
    },
    async (uri, variables) => {
      const databaseName = resourceSegment(variables.database);
      const collectionName = resourceSegment(variables.collection);
      const details = await safelyReadResource("collectionResource", () =>
        service.describeCollection(databaseName, collectionName),
      );
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "application/json",
            text: resourceText(
              compactCollectionDescription(details, false),
              uri.href,
              config.maxBytes,
            ),
          },
        ],
      };
    },
  );

  server.registerResource(
    "ArangoDB document",
    new ResourceTemplate("arangodb:///{database}/{collection}/{documentId}", {
      list: undefined,
      complete: {
        database: collectionTemplate.completeCallback("database")!,
        collection: collectionTemplate.completeCallback("collection")!,
      },
    }),
    {
      title: "ArangoDB document",
      mimeType: "application/json",
      description: "A single explicitly addressed ArangoDB document",
      annotations: { audience: ["assistant"], priority: 0.5 },
    },
    async (uri, variables) => {
      const databaseName = resourceSegment(variables.database);
      const collectionName = resourceSegment(variables.collection);
      const documentId = resourceSegment(variables.documentId);
      const document = await safelyReadResource("documentResource", () =>
        service.readDocument(databaseName, collectionName, documentId),
      );
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "application/json",
            text: resourceText(document, uri.href, config.maxBytes),
          },
        ],
      };
    },
  );

  server.registerPrompt(
    "exploreDatabase",
    {
      title: "Explore an ArangoDB database safely",
      description: "Guide a bounded, schema-first exploration of a database",
      argsSchema: z.object({
        databaseName: z.string().min(1).describe("Database to explore"),
      }),
    },
    async ({ databaseName }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: [
              `Explore the ArangoDB database "${databaseName}" safely.`,
              "Call listCollections for names, types, and document counts, then describeCollection or inferSchema for only the relevant collections.",
              "Call listGraphs before graph traversals and listViews before SEARCH queries.",
              config.enableDiagnosticTools
                ? "Use explainQuery before expensive AQL and use bind variables for values."
                : "Use bind variables for values and keep AQL queries narrowly scoped.",
              "Summarize findings without exposing unnecessary document fields.",
            ].join(" "),
          },
        },
      ],
    }),
  );

  let closePromise: Promise<void> | undefined;
  function close(): Promise<void> {
    // Defer execution until the promise is assigned: server.close() invokes
    // onclose synchronously, which must reuse this promise instead of recursing.
    closePromise ??= Promise.resolve().then(async () => {
      try {
        await server.close();
      } finally {
        await service.close();
      }
    });
    return closePromise;
  }
  server.server.onclose = () => {
    void close().catch((error: unknown) => {
      server.server.onerror?.(error instanceof Error ? error : new Error(String(error)));
    });
  };

  return { server, service, close };
}
