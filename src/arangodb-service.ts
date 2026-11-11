import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { open, unlink, type FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Database } from "arangojs";
import type { Cursor } from "arangojs/cursors";
import type { Transaction } from "arangojs/transactions";

import type { ServerConfig } from "./config.js";
import { UserFacingError } from "./errors.js";
import { queryPageEnvelopeBytes } from "./mcp-content.js";

export interface CollectionSummary {
  name: string;
  type: "document" | "edge";
}

export interface GraphSummary {
  name: string;
  edgeDefinitions: Array<{ collection: string; from: string[]; to: string[] }>;
  orphanCollections?: string[];
}

export interface ViewSummary {
  name: string;
  type: "arangosearch" | "search-alias";
  collections: string[];
  links?: Record<string, Record<string, unknown>>;
  indexes?: Array<{ collection: string; index: string }>;
  primarySort?: Array<Record<string, unknown>>;
}

export interface InferredField {
  path: string;
  types: Record<string, number>;
}

export interface InferredSchema {
  sampledDocuments: number;
  fields: InferredField[];
  truncated: boolean;
}

export interface QueryWarning {
  code: number;
  message: string;
}

export interface QueryPage {
  rows: unknown[];
  rowCount: number;
  bytes: number;
  hasMore: boolean;
  nextCursor?: string;
  warnings: QueryWarning[];
  stats?: Record<string, unknown>;
  writeStats?: { writesExecuted: number; writesIgnored: number };
}

export interface ExplainSummary {
  databaseName: string;
  isModificationQuery: boolean;
  estimatedCost: number;
  estimatedNrItems: number;
  collections: Array<{ name: string; type: "read" | "write" }>;
  views: string[];
  rules: string[];
  nodes: Array<{
    type: string;
    estimatedCost: number;
    estimatedNrItems: number;
  }>;
  warnings: QueryWarning[];
}

interface CursorSession {
  token: string;
  databaseName: string;
  cursor: Cursor<unknown>;
  transaction?: Transaction;
  expiresAt: number;
  pending: unknown[];
  isWrite: boolean;
  spool?: ResultSpool;
}

interface ResultSpool {
  file: FileHandle;
  path: string;
  offset: number;
  size: number;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

interface PlannedCollection {
  name: string;
  type: "read" | "write";
}

/**
 * A plan lists views among its collections, but a view cannot be declared in a
 * transaction. The collections a view reads are listed as well, so they alone
 * carry the allowlist check and the transaction declaration.
 */
function splitPlannedViews(plan: {
  collections: PlannedCollection[];
  nodes: Array<{ type: string; [key: string]: unknown }>;
}): { collections: PlannedCollection[]; views: string[] } {
  const views = unique(
    plan.nodes.flatMap((node) =>
      node.type === "EnumerateViewNode" && typeof node.view === "string" ? [node.view] : [],
    ),
  );
  return {
    collections: plan.collections.filter((collection) => !views.includes(collection.name)),
    views,
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function isNonEmptyRecord(value: unknown): value is Record<string, unknown> {
  return Object.keys(asRecord(value)).length > 0;
}

function collectionNames(value: unknown): string[] {
  const values = Array.isArray(value) ? value : [value];
  return values
    .map((item) => (typeof item === "string" ? item : asRecord(item).name))
    .filter((name): name is string => typeof name === "string");
}

function collectionName(value: unknown): string {
  return collectionNames(value)[0] ?? "";
}

function sortByName<T extends { name: string }>(left: T, right: T): number {
  return left.name < right.name ? -1 : left.name > right.name ? 1 : 0;
}

// One aggregated query so no document value ever leaves ArangoDB: the server
// only sees per-path type counts. It scans the first @sampleSize documents in
// storage order (not a random sample) and always returns a single row.
const INFER_SCHEMA_QUERY = `LET documents = (FOR document IN @@collection LIMIT @sampleSize RETURN document)
LET entries = UNION(
  (FOR document IN documents
    FOR attribute IN ATTRIBUTES(document, false, true)
    RETURN { path: attribute, type: TYPENAME(document[attribute]) }),
  (FOR document IN documents
    FOR attribute IN ATTRIBUTES(document, false, true)
    FILTER IS_OBJECT(document[attribute])
    FOR nested IN ATTRIBUTES(document[attribute], false, true)
    RETURN {
      path: CONCAT(attribute, ".", nested),
      type: TYPENAME(document[attribute][nested])
    }),
  (FOR document IN documents
    FOR attribute IN ATTRIBUTES(document, false, true)
    FILTER IS_ARRAY(document[attribute])
      AND LENGTH(document[attribute]) > 0
      AND IS_OBJECT(document[attribute][0])
    FOR nested IN ATTRIBUTES(document[attribute][0], false, true)
    RETURN {
      path: CONCAT(attribute, "[].", nested),
      type: TYPENAME(document[attribute][0][nested])
    })
)
LET allFields = (
  FOR entry IN entries
  COLLECT path = entry.path, type = entry.type WITH COUNT INTO count
  COLLECT field = path INTO groups
  SORT field ASC
  RETURN { path: field, types: ZIP(groups[*].type, groups[*].count) }
)
RETURN {
  sampledDocuments: LENGTH(documents),
  fields: SLICE(allFields, 0, 200),
  truncated: LENGTH(allFields) > 200
}`;

function operationMetadata(value: unknown): Record<string, unknown> {
  const record = asRecord(value);
  return Object.fromEntries(
    ["_id", "_key", "_rev", "_oldRev"].flatMap((field) =>
      record[field] === undefined ? [] : [[field, record[field]]],
    ),
  );
}

export class ArangoDBService {
  private readonly rootDatabase: Database;
  private readonly databaseConnections = new Map<string, Database>();
  private readonly cursorSessions = new Map<string, CursorSession>();
  private readonly cleanupTimer: NodeJS.Timeout;
  private cursorCleanup?: Promise<void>;
  private cursorReservations = 0;
  private cursorReservationsDrained?: () => void;
  private closed = false;
  private closePromise?: Promise<void>;

  constructor(private readonly config: ServerConfig) {
    const auth =
      config.username !== undefined
        ? { username: config.username, password: config.password ?? "" }
        : undefined;
    const agentOptions = this.createAgentOptions();
    this.rootDatabase = new Database({
      url: config.databaseUrl,
      ...(auth ? { auth } : {}),
      ...(agentOptions ? { agentOptions } : {}),
      poolSize: 3,
      timeout: config.requestTimeoutMs,
    });
    this.cleanupTimer = setInterval(() => {
      void this.cleanupExpiredCursors();
    }, 1_000);
    this.cleanupTimer.unref();
  }

  private createAgentOptions(): Record<string, unknown> | undefined {
    if (!this.config.databaseUrl.startsWith("https://")) {
      return undefined;
    }
    const connect: Record<string, unknown> = {
      rejectUnauthorized: this.config.tlsRejectUnauthorized,
    };
    if (this.config.tlsCaFile) {
      connect.ca = readFileSync(this.config.tlsCaFile, "utf8");
    }
    return { connect };
  }

  private assertDatabaseAllowed(databaseName: string): void {
    if (
      this.config.allowedDatabases.size > 0 &&
      !this.config.allowedDatabases.has(databaseName)
    ) {
      throw new UserFacingError(`Database "${databaseName}" is not allowed by server policy`);
    }
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new UserFacingError("The server is shutting down");
    }
  }

  private assertQueryActive(signal?: AbortSignal): void {
    this.assertOpen();
    if (signal?.aborted) {
      throw new UserFacingError("Query was cancelled by the client");
    }
  }

  private documentKey(collectionName: string, documentId: string): string {
    const parts = documentId.split("/");
    if (parts.length > 2 || (parts.length === 2 && parts[0] !== collectionName)) {
      throw new UserFacingError(
        "Document ID must be a key or a collection/key identifier matching collectionName",
      );
    }
    const key = parts[parts.length - 1];
    if (
      key.length === 0 ||
      key.length > 254 ||
      key === "." ||
      key === ".." ||
      !/^[A-Za-z0-9_:.@()+,=;$!*'%-]+$/.test(key)
    ) {
      throw new UserFacingError("Document ID contains an invalid or unsafe document key");
    }
    return key;
  }

  private isCollectionAllowed(databaseName: string, collectionName: string): boolean {
    return (
      this.config.allowedCollections.size === 0 ||
      this.config.allowedCollections.has(`${databaseName}/${collectionName}`)
    );
  }

  private assertCollectionAllowed(databaseName: string, collectionName: string): void {
    this.assertDatabaseAllowed(databaseName);
    if (!this.isCollectionAllowed(databaseName, collectionName)) {
      throw new UserFacingError(
        `Collection "${databaseName}/${collectionName}" is not allowed by server policy`,
      );
    }
  }

  private assertCollectionsAllowed(databaseName: string, collectionNames: string[]): void {
    for (const collectionName of collectionNames) {
      this.assertCollectionAllowed(databaseName, collectionName);
    }
  }

  private async declaredReadCollections(
    database: Database,
    databaseName: string,
    plannedCollections: string[],
  ): Promise<string[]> {
    if (this.config.allowedCollections.size === 0) {
      return unique(plannedCollections);
    }
    // Declaring a collection that does not exist fails the whole transaction,
    // so a stale allowlist entry must not be declared.
    const existing = new Set(
      (await database.listCollections(false)).map((collection) => collection.name),
    );
    const prefix = `${databaseName}/`;
    return [...this.config.allowedCollections]
      .filter((entry) => entry.startsWith(prefix))
      .map((entry) => entry.slice(prefix.length))
      .filter((collectionName) => existing.has(collectionName));
  }

  private getDatabase(databaseName: string): Database {
    this.assertOpen();
    this.assertDatabaseAllowed(databaseName);
    const existing = this.databaseConnections.get(databaseName);
    if (existing) {
      return existing;
    }
    const auth =
      this.config.username !== undefined
        ? { username: this.config.username, password: this.config.password ?? "" }
        : undefined;
    const agentOptions = this.createAgentOptions();
    const database = new Database({
      url: this.config.databaseUrl,
      databaseName,
      ...(auth ? { auth } : {}),
      ...(agentOptions ? { agentOptions } : {}),
      poolSize: 3,
      timeout: this.config.requestTimeoutMs,
    });
    this.databaseConnections.set(databaseName, database);
    return database;
  }

  async listDatabases(): Promise<string[]> {
    this.assertOpen();
    // Unlike /_api/database, this endpoint does not require access to _system.
    const databases = await this.rootDatabase.listUserDatabases();
    return databases
      .filter(
        (databaseName) =>
          this.config.allowedDatabases.size === 0 ||
          this.config.allowedDatabases.has(databaseName),
      )
      .sort();
  }

  async listCollections(databaseName: string): Promise<CollectionSummary[]> {
    const database = this.getDatabase(databaseName);
    const collections = await database.listCollections(true);
    return collections
      .filter((collection) => this.isCollectionAllowed(databaseName, collection.name))
      .map((collection) => ({
        name: collection.name,
        type: collection.type === 3 ? ("edge" as const) : ("document" as const),
      }))
      .sort(sortByName);
  }

  async collectionCounts(
    databaseName: string,
    collectionNames: string[],
  ): Promise<Record<string, number>> {
    const database = this.getDatabase(databaseName);
    const counts = await Promise.all(
      collectionNames.map(async (collectionName) => {
        try {
          const count = await database.collection(collectionName).count();
          return [collectionName, count.count] as const;
        } catch {
          // A missing count must not hide the rest of the collection list.
          return undefined;
        }
      }),
    );
    return Object.fromEntries(
      counts.filter((entry): entry is readonly [string, number] => entry !== undefined),
    );
  }

  async listGraphs(databaseName: string): Promise<GraphSummary[]> {
    const database = this.getDatabase(databaseName);
    const graphs = await database.listGraphs();
    return graphs
      .filter((graph) =>
        [
          ...graph.edgeDefinitions.flatMap((edge) => [
            collectionName(edge.collection),
            ...collectionNames(edge.from),
            ...collectionNames(edge.to),
          ]),
          ...graph.orphanCollections,
        ].every((collectionName) => this.isCollectionAllowed(databaseName, collectionName)),
      )
      .map((graph) => ({
        name: graph.name,
        edgeDefinitions: graph.edgeDefinitions.map((edge) => ({
          collection: collectionName(edge.collection),
          from: collectionNames(edge.from),
          to: collectionNames(edge.to),
        })),
        ...(graph.orphanCollections.length > 0
          ? { orphanCollections: graph.orphanCollections }
          : {}),
      }))
      .sort(sortByName);
  }

  async listViews(databaseName: string): Promise<ViewSummary[]> {
    const database = this.getDatabase(databaseName);
    const descriptions = await database.listViews();
    const views = await Promise.all(
      descriptions.map(async (description) => {
        const properties = asRecord(
          await database.view(description.name).properties(),
        );
        if (description.type === "search-alias") {
          const indexes = (
            Array.isArray(properties.indexes) ? properties.indexes : []
          ).map((index) => {
            const record = asRecord(index);
            return {
              collection: String(record.collection),
              index: String(record.index),
            };
          });
          return {
            name: description.name,
            type: description.type,
            collections: [...new Set(indexes.map((index) => index.collection))].sort(),
            indexes,
          } satisfies ViewSummary;
        }
        const links = asRecord(properties.links);
        const compactLinks = Object.fromEntries(
          Object.entries(links).map(([collection, link]) => {
            const definition = { ...asRecord(link) };
            // Drop defaults and per-link noise; nested field definitions stay.
            if (definition.storeValues === "none") {
              delete definition.storeValues;
            }
            if (definition.trackListPositions === false) {
              delete definition.trackListPositions;
            }
            if (!isNonEmptyRecord(definition.fields)) {
              delete definition.fields;
            }
            return [collection, definition];
          }),
        );
        const primarySort = Array.isArray(properties.primarySort)
          ? properties.primarySort.map((entry) => asRecord(entry))
          : [];
        return {
          name: description.name,
          type: description.type,
          collections: Object.keys(links).sort(),
          ...(Object.keys(compactLinks).length > 0 ? { links: compactLinks } : {}),
          ...(primarySort.length > 0 ? { primarySort } : {}),
        } satisfies ViewSummary;
      }),
    );
    return views
      .filter((view) =>
        view.collections.every((collectionName) =>
          this.isCollectionAllowed(databaseName, collectionName),
        ),
      )
      .sort(sortByName);
  }

  async inferSchema(
    databaseName: string,
    collectionName: string,
    sampleSize: number,
    signal?: AbortSignal,
  ): Promise<InferredSchema> {
    this.assertCollectionAllowed(databaseName, collectionName);
    if (!Number.isSafeInteger(sampleSize) || sampleSize < 1 || sampleSize > 1_000) {
      throw new UserFacingError("sampleSize must be an integer between 1 and 1000");
    }
    const page = await this.executeReadQuery(
      databaseName,
      INFER_SCHEMA_QUERY,
      { "@collection": collectionName, sampleSize },
      1,
      signal,
    );
    const result = asRecord(page.rows[0]);
    return {
      sampledDocuments:
        typeof result.sampledDocuments === "number" ? result.sampledDocuments : 0,
      fields: Array.isArray(result.fields)
        ? result.fields.map((field) => {
            const record = asRecord(field);
            return {
              path: String(record.path),
              types: asRecord(record.types) as Record<string, number>,
            };
          })
        : [],
      truncated: result.truncated === true,
    };
  }

  async describeCollection(
    databaseName: string,
    collectionName: string,
  ): Promise<Record<string, unknown>> {
    this.assertCollectionAllowed(databaseName, collectionName);
    const collection = this.getDatabase(databaseName).collection(collectionName);
    const [properties, indexes, count] = await Promise.all([
      collection.properties(),
      collection.indexes(),
      collection.count(),
    ]);
    return {
      databaseName,
      collectionName,
      documentCount: count.count,
      properties: asRecord(properties),
      indexes: Array.isArray(indexes) ? indexes : [],
    };
  }

  async readDocument(
    databaseName: string,
    collectionName: string,
    documentId: string,
  ): Promise<unknown> {
    this.assertCollectionAllowed(databaseName, collectionName);
    const key = this.documentKey(collectionName, documentId);
    const document = await this.getDatabase(databaseName)
      .collection(collectionName)
      .document(key);
    const bytes = Buffer.byteLength(JSON.stringify(document), "utf8");
    if (bytes > this.config.maxBytes) {
      throw new UserFacingError(
        `Document is ${bytes} bytes and exceeds the ${this.config.maxBytes}-byte response limit`,
      );
    }
    return document;
  }

  private assertDocumentWritesEnabled(): void {
    if (!this.config.enableDocumentWrites) {
      throw new UserFacingError("Document write operations are disabled by server policy");
    }
  }

  private assertReadWriteQueryEnabled(): void {
    if (!this.config.enableReadWriteQuery) {
      throw new UserFacingError("Write-capable AQL is disabled by server policy");
    }
  }

  private assertDocumentPayload(payload: Record<string, unknown>): void {
    const bytes = Buffer.byteLength(JSON.stringify(payload), "utf8");
    if (bytes > Math.floor(this.config.maxBytes * 0.75)) {
      throw new UserFacingError(
        `Document payload exceeds 75% of the ${this.config.maxBytes}-byte response budget`,
      );
    }
  }

  async insertDocument(
    databaseName: string,
    collectionName: string,
    document: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    this.assertDocumentWritesEnabled();
    this.assertCollectionAllowed(databaseName, collectionName);
    this.assertDocumentPayload(document);
    if ("_id" in document || "_rev" in document) {
      throw new UserFacingError("Insert payload must not provide _id or _rev");
    }
    const result = await this.getDatabase(databaseName)
      .collection(collectionName)
      .save(document);
    return operationMetadata(result);
  }

  async updateDocument(
    databaseName: string,
    collectionName: string,
    documentId: string,
    revision: string,
    patch: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    this.assertDocumentWritesEnabled();
    this.assertCollectionAllowed(databaseName, collectionName);
    const key = this.documentKey(collectionName, documentId);
    this.assertDocumentPayload(patch);
    if (["_id", "_key", "_rev"].some((field) => field in patch)) {
      throw new UserFacingError("Update patch must not modify _id, _key, or _rev");
    }
    const result = await this.getDatabase(databaseName)
      .collection(collectionName)
      .update(key, patch, { ifMatch: revision });
    return operationMetadata(result);
  }

  async deleteDocument(
    databaseName: string,
    collectionName: string,
    documentId: string,
    revision: string,
  ): Promise<Record<string, unknown>> {
    this.assertDocumentWritesEnabled();
    this.assertCollectionAllowed(databaseName, collectionName);
    const key = this.documentKey(collectionName, documentId);
    const result = await this.getDatabase(databaseName)
      .collection(collectionName)
      .remove(key, { ifMatch: revision });
    return operationMetadata(result);
  }

  private validateQueryInput(query: string, bindVars: Record<string, unknown>): void {
    if (!query.trim()) {
      throw new UserFacingError("AQL query cannot be empty");
    }
    if (query.length > 100_000) {
      throw new UserFacingError("AQL query exceeds the 100,000-character limit");
    }
    const bindVarsBytes = Buffer.byteLength(JSON.stringify(bindVars), "utf8");
    if (bindVarsBytes > this.config.maxBytes) {
      throw new UserFacingError(
        `Bind variables exceed the ${this.config.maxBytes}-byte request limit`,
      );
    }
  }

  private async getReadOnlyPlan(
    databaseName: string,
    query: string,
    bindVars: Record<string, unknown>,
  ): Promise<ExplainSummary> {
    this.validateQueryInput(query, bindVars);
    const database = this.getDatabase(databaseName);
    const explanation = await database.explain(query, bindVars, {
      maxNumberOfPlans: 1,
    });
    const plan = explanation.plan;
    if (plan.isModificationQuery || plan.collections.some((item) => item.type === "write")) {
      throw new UserFacingError(
        "readQuery rejected a data-modification query; use readWriteQuery only when writes are explicitly enabled",
      );
    }
    const { collections, views } = splitPlannedViews(plan);
    this.assertCollectionsAllowed(
      databaseName,
      unique(collections.map((collection) => collection.name)),
    );
    return {
      databaseName,
      isModificationQuery: plan.isModificationQuery,
      estimatedCost: plan.estimatedCost,
      estimatedNrItems: plan.estimatedNrItems,
      collections,
      views,
      rules: plan.rules,
      nodes: plan.nodes.map((node) => ({
        type: node.type,
        estimatedCost: node.estimatedCost,
        estimatedNrItems: node.estimatedNrItems,
      })),
      warnings: explanation.warnings,
    };
  }

  async explainReadQuery(
    databaseName: string,
    query: string,
    bindVars: Record<string, unknown>,
  ): Promise<ExplainSummary> {
    return this.getReadOnlyPlan(databaseName, query, bindVars);
  }

  private assertPageSize(pageSize: number): void {
    if (!Number.isSafeInteger(pageSize) || pageSize <= 0 || pageSize > this.config.maxRows) {
      throw new UserFacingError(
        `pageSize must be between 1 and the configured maximum of ${this.config.maxRows}`,
      );
    }
  }

  private async reserveCursorCapacity(): Promise<void> {
    this.assertOpen();
    await this.cleanupExpiredCursors();
    this.assertOpen();
    if (
      this.cursorSessions.size + this.cursorReservations >=
      this.config.maxActiveCursors
    ) {
      throw new UserFacingError(
        `The server already has ${this.config.maxActiveCursors} active cursors; consume or let one expire before starting another query`,
      );
    }
    this.cursorReservations += 1;
  }

  private releaseCursorCapacity(): void {
    this.cursorReservations -= 1;
    if (this.cursorReservations === 0) {
      this.cursorReservationsDrained?.();
      this.cursorReservationsDrained = undefined;
    }
  }

  async executeReadQuery(
    databaseName: string,
    query: string,
    bindVars: Record<string, unknown>,
    pageSize: number,
    signal?: AbortSignal,
  ): Promise<QueryPage> {
    this.assertPageSize(pageSize);
    this.assertQueryActive(signal);
    await this.reserveCursorCapacity();
    try {
      this.assertQueryActive(signal);
      const plan = await this.getReadOnlyPlan(databaseName, query, bindVars);
      this.assertQueryActive(signal);
      const database = this.getDatabase(databaseName);
      const readCollections = await this.declaredReadCollections(
        database,
        databaseName,
        plan.collections.map((collection) => collection.name),
      );
      const transactionOptions = {
        allowImplicit: false,
        // ArangoDB supports this stream-transaction option even though arangojs
        // does not currently expose it in TransactionOptions.
        ttl: this.config.cursorTtlSeconds + 5,
      };
      const transaction = await database.beginTransaction(
        { read: readCollections },
        transactionOptions,
      );

      try {
        this.assertQueryActive(signal);
        const cursor = (await transaction.step(() =>
          database.query<unknown>(query, bindVars, {
            batchSize: pageSize,
            count: false,
            stream: true,
            ttl: this.config.cursorTtlSeconds,
            maxRuntime: this.config.maxRuntimeSeconds,
            memoryLimit: this.config.memoryLimitBytes,
            timeout: this.config.requestTimeoutMs,
            maxWarningCount: 10,
          }),
        )) as Cursor<unknown>;
        const session: CursorSession = {
          token: randomUUID(),
          databaseName,
          cursor,
          transaction,
          expiresAt: Date.now() + this.config.cursorTtlSeconds * 1_000,
          pending: [],
          isWrite: false,
        };
        return await this.consumeOrStoreSession(session, pageSize, signal);
      } catch (error) {
        await transaction.abort().catch(() => undefined);
        throw error;
      }
    } finally {
      this.releaseCursorCapacity();
    }
  }

  async executeWriteQuery(
    databaseName: string,
    query: string,
    bindVars: Record<string, unknown>,
    pageSize: number,
    signal?: AbortSignal,
  ): Promise<QueryPage> {
    this.assertReadWriteQueryEnabled();
    this.assertPageSize(pageSize);
    this.assertQueryActive(signal);
    await this.reserveCursorCapacity();
    try {
      this.assertQueryActive(signal);
      this.validateQueryInput(query, bindVars);
      const database = this.getDatabase(databaseName);
      const explanation = await database.explain(query, bindVars, {
        maxNumberOfPlans: 1,
      });
      this.assertQueryActive(signal);
      const plannedCollections = splitPlannedViews(explanation.plan).collections;
      this.assertCollectionsAllowed(
        databaseName,
        unique(plannedCollections.map((collection) => collection.name)),
      );
      const writeCollections = unique(
        plannedCollections
          .filter((collection) => collection.type === "write")
          .map((collection) => collection.name),
      );
      const readCollections = (
        await this.declaredReadCollections(
          database,
          databaseName,
          plannedCollections
            .filter((collection) => collection.type === "read")
            .map((collection) => collection.name),
        )
      ).filter((collectionName) => !writeCollections.includes(collectionName));
      const transactionOptions = {
        allowImplicit: false,
        // See the corresponding read transaction note above.
        ttl: this.config.cursorTtlSeconds + 5,
      };
      const transaction = await database.beginTransaction(
        { read: readCollections, write: writeCollections },
        transactionOptions,
      );
      let spool: ResultSpool | undefined;
      let committed = false;

      try {
        this.assertQueryActive(signal);
        const cursor = (await transaction.step(() =>
          database.query<unknown>(query, bindVars, {
            batchSize: pageSize,
            count: false,
            stream: false,
            ttl: this.config.cursorTtlSeconds,
            maxRuntime: this.config.maxRuntimeSeconds,
            memoryLimit: this.config.memoryLimitBytes,
            timeout: this.config.requestTimeoutMs,
            maxWarningCount: 10,
          }),
        )) as Cursor<unknown>;
        spool = await this.spoolWriteResults(transaction, cursor, signal);
        this.assertQueryActive(signal);
        await transaction.commit();
        committed = true;
        const session: CursorSession = {
          token: randomUUID(),
          databaseName,
          cursor,
          expiresAt: Date.now() + this.config.cursorTtlSeconds * 1_000,
          pending: [],
          isWrite: true,
          spool,
        };
        // Once committed, cancellation cannot roll back the write. Return its
        // result instead of reporting that the write was cancelled.
        return await this.consumeOrStoreSession(session, pageSize);
      } catch (error) {
        if (spool) {
          await this.removeSpool(spool);
        }
        if (!committed) {
          await transaction.abort().catch(() => undefined);
        }
        throw error;
      }
    } finally {
      this.releaseCursorCapacity();
    }
  }

  async continueQuery(
    token: string,
    pageSize: number,
    signal?: AbortSignal,
  ): Promise<QueryPage> {
    this.assertOpen();
    this.assertPageSize(pageSize);
    const session = this.cursorSessions.get(token);
    if (!session) {
      throw new UserFacingError("Query cursor was not found or has expired");
    }
    // Moving a session out of the map must retain its capacity while a page is
    // being fetched; otherwise concurrent queries can claim the same slot.
    this.cursorReservations += 1;
    this.cursorSessions.delete(token);
    try {
      if (session.expiresAt <= Date.now()) {
        await this.finishSession(session, false);
        throw new UserFacingError("Query cursor has expired");
      }
      session.expiresAt = Date.now() + this.config.cursorTtlSeconds * 1_000;
      return await this.consumeOrStoreSession(session, pageSize, signal);
    } finally {
      this.releaseCursorCapacity();
    }
  }

  private async consumeOrStoreSession(
    session: CursorSession,
    pageSize: number,
    signal?: AbortSignal,
  ): Promise<QueryPage> {
    try {
      const page = await this.readPage(session, pageSize, signal);
      if (page.hasMore) {
        this.cursorSessions.set(session.token, session);
        page.nextCursor = session.token;
      } else {
        await this.finishSession(session, true);
      }
      return page;
    } catch (error) {
      await this.finishSession(session, false);
      throw error;
    }
  }

  private async readPage(
    session: CursorSession,
    pageSize: number,
    signal?: AbortSignal,
  ): Promise<QueryPage> {
    const rows: unknown[] = [];
    let bytes = 2;

    while (rows.length < pageSize) {
      if (!session.isWrite) {
        this.assertQueryActive(signal);
      }

      let item: unknown;
      if (session.pending.length > 0) {
        item = session.pending.shift();
      } else if (session.spool) {
        item = await this.readSpoolItem(session.spool);
      } else {
        item = session.transaction
          ? await session.transaction.step(() => session.cursor.next())
          : await session.cursor.next();
      }

      if (!session.isWrite) {
        this.assertQueryActive(signal);
      }

      if (item === undefined) {
        break;
      }
      const serialized = JSON.stringify(item);
      const itemBytes = Buffer.byteLength(serialized, "utf8") + (rows.length ? 1 : 0);
      if (bytes + itemBytes > this.config.maxBytes) {
        if (rows.length > 0) {
          session.pending.unshift(item);
          break;
        }
        if (session.isWrite) {
          const marker = {
            _mcpResultOmitted: true,
            serializedBytes: itemBytes,
            reason: "Write succeeded but this result row exceeded the response budget",
          };
          const markerBytes = Buffer.byteLength(JSON.stringify(marker), "utf8") +
            (rows.length ? 1 : 0);
          if (bytes + markerBytes > this.config.maxBytes) {
            session.pending.unshift(marker);
            break;
          }
          rows.push(marker);
          bytes += markerBytes;
          continue;
        }
        throw new UserFacingError(
          `A single result row exceeds the ${this.config.maxBytes}-byte response limit; project fewer fields in the AQL query`,
        );
      }
      rows.push(item);
      bytes += itemBytes;
    }

    const extra = session.cursor.extra ?? {};
    const stats = extra.stats ? asRecord(extra.stats) : undefined;
    const page: QueryPage = {
      rows,
      rowCount: rows.length,
      bytes,
      hasMore: this.sessionHasMore(session),
      warnings: Array.isArray(extra.warnings) ? extra.warnings : [],
      stats,
    };
    if (session.isWrite) {
      // Kept apart from stats so envelope trimming cannot hide the counts.
      page.writeStats = {
        writesExecuted:
          typeof stats?.writesExecuted === "number" ? stats.writesExecuted : 0,
        writesIgnored:
          typeof stats?.writesIgnored === "number" ? stats.writesIgnored : 0,
      };
    }
    if (page.hasMore) {
      page.nextCursor = session.token;
    }

    const refreshPageMetadata = (): void => {
      page.rowCount = rows.length;
      page.bytes = Buffer.byteLength(JSON.stringify(rows), "utf8");
      page.hasMore = this.sessionHasMore(session);
      page.nextCursor = page.hasMore ? session.token : undefined;
    };

    let envelopeBytes = queryPageEnvelopeBytes(page);
    if (envelopeBytes > this.config.maxBytes && page.stats) {
      delete page.stats;
      envelopeBytes = queryPageEnvelopeBytes(page);
    }
    let removedRowForEnvelope = false;
    while (envelopeBytes > this.config.maxBytes && rows.length > 0) {
      removedRowForEnvelope = true;
      session.pending.unshift(rows.pop());
      refreshPageMetadata();
      envelopeBytes = queryPageEnvelopeBytes(page);
    }
    if (removedRowForEnvelope && rows.length === 0) {
      if (!session.isWrite) {
        throw new UserFacingError(
          `A single result row and its complete MCP response envelope exceed the ${this.config.maxBytes}-byte response limit; project fewer fields in the AQL query`,
        );
      }
      const omitted = session.pending.shift();
      rows.push({
        _mcpResultOmitted: true,
        serializedBytes: Buffer.byteLength(JSON.stringify(omitted), "utf8"),
        reason: "Write succeeded but this result row exceeded the response budget",
      });
      refreshPageMetadata();
      envelopeBytes = queryPageEnvelopeBytes(page);
    }
    if (envelopeBytes > this.config.maxBytes) {
      throw new UserFacingError(
        `A single result row and its complete MCP response envelope exceed the ${this.config.maxBytes}-byte response limit; project fewer fields in the AQL query`,
      );
    }
    return page;
  }

  private async finishSession(session: CursorSession, commit: boolean): Promise<void> {
    this.cursorSessions.delete(session.token);
    if (!commit && session.cursor.hasNext) {
      const kill = () => session.cursor.kill();
      if (session.transaction) {
        await session.transaction.step(kill).catch(() => undefined);
      } else {
        await kill().catch(() => undefined);
      }
    }
    if (session.transaction) {
      if (commit) {
        await session.transaction.commit();
      } else {
        await session.transaction.abort().catch(() => undefined);
      }
    }
    if (session.spool) {
      await this.removeSpool(session.spool);
    }
  }

  private sessionHasMore(session: CursorSession): boolean {
    return session.pending.length > 0 ||
      (session.spool ? session.spool.offset < session.spool.size : session.cursor.hasNext);
  }

  private async spoolWriteResults(
    transaction: Transaction,
    cursor: Cursor<unknown>,
    signal?: AbortSignal,
  ): Promise<ResultSpool> {
    const path = join(tmpdir(), `arangodb-mcp-write-${randomUUID()}`);
    const file = await open(path, "wx+", 0o600);
    const spool: ResultSpool = { file, path, offset: 0, size: 0 };
    try {
      while (cursor.hasNext) {
        this.assertQueryActive(signal);
        const item = await transaction.step(() => cursor.next());
        this.assertQueryActive(signal);
        if (item === undefined) {
          break;
        }
        const payload = Buffer.from(JSON.stringify(item), "utf8");
        const header = Buffer.allocUnsafe(8);
        header.writeBigUInt64BE(BigInt(payload.length));
        const recordBytes = header.length + payload.length;
        if (spool.size + recordBytes > this.config.maxWriteSpoolBytes) {
          throw new UserFacingError(
            `Buffered write-query results exceed the ${this.config.maxWriteSpoolBytes}-byte spool limit; the transaction was rolled back. Return fewer or smaller values, or raise ARANGO_MCP_MAX_WRITE_SPOOL_BYTES`,
          );
        }
        await file.write(header);
        await file.write(payload);
        spool.size += recordBytes;
      }
      return spool;
    } catch (error) {
      await transaction.step(() => cursor.kill()).catch(() => undefined);
      await this.removeSpool(spool);
      throw error;
    }
  }

  private async readSpoolItem(spool: ResultSpool): Promise<unknown> {
    if (spool.offset >= spool.size) {
      return undefined;
    }
    const header = Buffer.allocUnsafe(8);
    await this.readExactly(spool.file, header, spool.offset);
    spool.offset += header.length;
    const length = Number(header.readBigUInt64BE());
    if (!Number.isSafeInteger(length) || length > spool.size - spool.offset) {
      throw new Error("Invalid write result spool record");
    }
    const payload = Buffer.allocUnsafe(length);
    await this.readExactly(spool.file, payload, spool.offset);
    spool.offset += length;
    return JSON.parse(payload.toString("utf8"));
  }

  private async readExactly(file: FileHandle, buffer: Buffer, position: number): Promise<void> {
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await file.read(
        buffer,
        offset,
        buffer.length - offset,
        position + offset,
      );
      if (bytesRead === 0) {
        throw new Error("Unexpected end of write result spool");
      }
      offset += bytesRead;
    }
  }

  private async removeSpool(spool: ResultSpool): Promise<void> {
    await spool.file.close().catch(() => undefined);
    await unlink(spool.path).catch(() => undefined);
  }

  private cleanupExpiredCursors(): Promise<void> {
    if (!this.cursorCleanup) {
      this.cursorCleanup = (async () => {
        try {
          const now = Date.now();
          const expired = [...this.cursorSessions.values()].filter(
            (session) => session.expiresAt <= now,
          );
          await Promise.all(expired.map((session) => this.finishSession(session, false)));
        } finally {
          this.cursorCleanup = undefined;
        }
      })();
    }
    return this.cursorCleanup;
  }

  async sampleDocuments(
    databaseName: string,
    collectionName: string,
    limit: number,
    fields: string[],
    signal?: AbortSignal,
  ): Promise<QueryPage> {
    this.assertCollectionAllowed(databaseName, collectionName);
    if (!Number.isSafeInteger(limit) || limit <= 0 || limit > Math.min(20, this.config.maxRows)) {
      throw new UserFacingError(
        `Sample limit must be between 1 and ${Math.min(20, this.config.maxRows)}`,
      );
    }
    return this.executeReadQuery(
      databaseName,
      `FOR doc IN @@collection
       SORT doc._key
       LIMIT @limit
       RETURN LENGTH(@fields) == 0 ? doc : KEEP(doc, @fields)`,
      { "@collection": collectionName, limit, fields },
      limit,
      signal,
    );
  }

  async health(): Promise<Record<string, unknown>> {
    this.assertOpen();
    const [databases, availability] = await Promise.all([
      this.listDatabases(),
      this.rootDatabase.availability(true),
    ]);
    // /_api/version requires access to the addressed database, and a
    // least-privilege user usually has none on _system.
    const version =
      databases.length > 0 ? await this.getDatabase(databases[0]).version() : undefined;
    return {
      status: availability === false ? "unavailable" : "ok",
      availability,
      arangoVersion: version?.version,
      server: version?.server,
      documentWritesEnabled: this.config.enableDocumentWrites,
      readWriteQueryEnabled: this.config.enableReadWriteQuery,
      diagnosticToolsEnabled: this.config.enableDiagnosticTools,
      activeCursors: this.cursorSessions.size,
      limits: {
        maxRows: this.config.maxRows,
        maxBytes: this.config.maxBytes,
        maxWriteSpoolBytes: this.config.maxWriteSpoolBytes,
        maxRuntimeSeconds: this.config.maxRuntimeSeconds,
        memoryLimitBytes: this.config.memoryLimitBytes,
        cursorTtlSeconds: this.config.cursorTtlSeconds,
      },
      allowedDatabases:
        this.config.allowedDatabases.size > 0
          ? [...this.config.allowedDatabases].sort()
          : "all databases visible to the ArangoDB user",
      allowedCollections:
        this.config.allowedCollections.size > 0
          ? [...this.config.allowedCollections].sort()
          : "all collections visible to the ArangoDB user",
    };
  }

  close(): Promise<void> {
    if (!this.closePromise) {
      this.closed = true;
      clearInterval(this.cleanupTimer);
      this.closePromise = this.closeConnections();
    }
    return this.closePromise;
  }

  private async closeConnections(): Promise<void> {
    if (this.cursorReservations > 0) {
      await new Promise<void>((resolve) => {
        this.cursorReservationsDrained = resolve;
      });
    }
    await this.cursorCleanup;
    await Promise.all(
      [...this.cursorSessions.values()].map((session) => this.finishSession(session, false)),
    );
    for (const database of this.databaseConnections.values()) {
      database.close();
    }
    this.rootDatabase.close();
  }
}
