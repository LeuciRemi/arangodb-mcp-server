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
  type: number;
  status: number;
  isSystem: boolean;
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
}

export interface ExplainSummary {
  databaseName: string;
  isModificationQuery: boolean;
  estimatedCost: number;
  estimatedNrItems: number;
  collections: Array<{ name: string; type: "read" | "write" }>;
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

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

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
  private cleaningExpiredCursors = false;
  private cursorReservations = 0;

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

  private assertCollectionAllowed(databaseName: string, collectionName: string): void {
    this.assertDatabaseAllowed(databaseName);
    if (
      this.config.allowedCollections.size > 0 &&
      !this.config.allowedCollections.has(`${databaseName}/${collectionName}`)
    ) {
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

  private declaredReadCollections(
    databaseName: string,
    plannedCollections: string[],
  ): string[] {
    if (this.config.allowedCollections.size === 0) {
      return unique(plannedCollections);
    }
    const prefix = `${databaseName}/`;
    return [...this.config.allowedCollections]
      .filter((entry) => entry.startsWith(prefix))
      .map((entry) => entry.slice(prefix.length));
  }

  private getDatabase(databaseName: string): Database {
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
    });
    this.databaseConnections.set(databaseName, database);
    return database;
  }

  async listDatabases(): Promise<string[]> {
    const databases = await this.rootDatabase.databases();
    return databases
      .map((database) => database.name)
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
      .filter(
        (collection) =>
          this.config.allowedCollections.size === 0 ||
          this.config.allowedCollections.has(`${databaseName}/${collection.name}`),
      )
      .map((collection) => ({
        name: collection.name,
        type: collection.type,
        status: collection.status,
        isSystem: collection.isSystem,
      }))
      .sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
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
    const document = await this.getDatabase(databaseName)
      .collection(collectionName)
      .document(documentId);
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
      .save(document, { returnNew: true });
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
    this.assertDocumentPayload(patch);
    if (["_id", "_key", "_rev"].some((field) => field in patch)) {
      throw new UserFacingError("Update patch must not modify _id, _key, or _rev");
    }
    const result = await this.getDatabase(databaseName)
      .collection(collectionName)
      .update(documentId, patch, { ifMatch: revision, returnNew: true });
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
    const result = await this.getDatabase(databaseName)
      .collection(collectionName)
      .remove(documentId, { ifMatch: revision, returnOld: true });
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
    const collectionNames = unique(plan.collections.map((collection) => collection.name));
    this.assertCollectionsAllowed(databaseName, collectionNames);
    return {
      databaseName,
      isModificationQuery: plan.isModificationQuery,
      estimatedCost: plan.estimatedCost,
      estimatedNrItems: plan.estimatedNrItems,
      collections: plan.collections,
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
    await this.cleanupExpiredCursors();
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

  async executeReadQuery(
    databaseName: string,
    query: string,
    bindVars: Record<string, unknown>,
    pageSize: number,
    signal?: AbortSignal,
  ): Promise<QueryPage> {
    this.assertPageSize(pageSize);
    await this.reserveCursorCapacity();
    try {
      const plan = await this.getReadOnlyPlan(databaseName, query, bindVars);
      const database = this.getDatabase(databaseName);
      const readCollections = this.declaredReadCollections(
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
      this.cursorReservations -= 1;
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
    await this.reserveCursorCapacity();
    try {
      this.validateQueryInput(query, bindVars);
      const database = this.getDatabase(databaseName);
      const explanation = await database.explain(query, bindVars, {
        maxNumberOfPlans: 1,
      });
      const plannedCollections = explanation.plan.collections;
      this.assertCollectionsAllowed(
        databaseName,
        unique(plannedCollections.map((collection) => collection.name)),
      );
      const writeCollections = unique(
        plannedCollections
          .filter((collection) => collection.type === "write")
          .map((collection) => collection.name),
      );
      const readCollections = this.declaredReadCollections(
        databaseName,
        plannedCollections
          .filter((collection) => collection.type === "read")
          .map((collection) => collection.name),
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

      try {
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
        spool = await this.spoolWriteResults(transaction, cursor);
        await transaction.commit();
        const session: CursorSession = {
          token: randomUUID(),
          databaseName,
          cursor,
          expiresAt: Date.now() + this.config.cursorTtlSeconds * 1_000,
          pending: [],
          isWrite: true,
          spool,
        };
        return await this.consumeOrStoreSession(session, pageSize, signal);
      } catch (error) {
        if (spool) {
          await this.removeSpool(spool);
        }
        await transaction.abort().catch(() => undefined);
        throw error;
      }
    } finally {
      this.cursorReservations -= 1;
    }
  }

  async continueQuery(
    token: string,
    pageSize: number,
    signal?: AbortSignal,
  ): Promise<QueryPage> {
    this.assertPageSize(pageSize);
    const session = this.cursorSessions.get(token);
    if (!session) {
      throw new UserFacingError("Query cursor was not found or has expired");
    }
    this.cursorSessions.delete(token);
    if (session.expiresAt <= Date.now()) {
      await this.finishSession(session, false);
      throw new UserFacingError("Query cursor has expired");
    }
    session.expiresAt = Date.now() + this.config.cursorTtlSeconds * 1_000;
    return this.consumeOrStoreSession(session, pageSize, signal);
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
      if (signal?.aborted) {
        throw new UserFacingError("Query was cancelled by the client");
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

      if (item === undefined) {
        break;
      }
      const serialized = JSON.stringify(item);
      const itemBytes = Buffer.byteLength(serialized, "utf8") + (rows.length ? 1 : 0);
      if (bytes + itemBytes > this.config.maxBytes) {
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
        if (rows.length === 0) {
          throw new UserFacingError(
            `A single result row exceeds the ${this.config.maxBytes}-byte response limit; project fewer fields in the AQL query`,
          );
        }
        session.pending.unshift(item);
        break;
      }
      rows.push(item);
      bytes += itemBytes;
    }

    const extra = session.cursor.extra ?? {};
    const page: QueryPage = {
      rows,
      rowCount: rows.length,
      bytes,
      hasMore: this.sessionHasMore(session),
      warnings: Array.isArray(extra.warnings) ? extra.warnings : [],
      stats: extra.stats ? asRecord(extra.stats) : undefined,
    };
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
  ): Promise<ResultSpool> {
    const path = join(tmpdir(), `arangodb-mcp-write-${randomUUID()}`);
    const file = await open(path, "wx+", 0o600);
    const spool: ResultSpool = { file, path, offset: 0, size: 0 };
    try {
      while (cursor.hasNext) {
        const item = await transaction.step(() => cursor.next());
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

  private async cleanupExpiredCursors(): Promise<void> {
    if (this.cleaningExpiredCursors) {
      return;
    }
    this.cleaningExpiredCursors = true;
    try {
      const now = Date.now();
      const expired = [...this.cursorSessions.values()].filter(
        (session) => session.expiresAt <= now,
      );
      await Promise.all(expired.map((session) => this.finishSession(session, false)));
    } finally {
      this.cleaningExpiredCursors = false;
    }
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
    const [version, availability] = await Promise.all([
      this.rootDatabase.version(true),
      this.rootDatabase.availability(true),
    ]);
    return {
      status: availability === false ? "unavailable" : "ok",
      availability,
      arangoVersion: version.version,
      server: version.server,
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

  async close(): Promise<void> {
    clearInterval(this.cleanupTimer);
    await Promise.all(
      [...this.cursorSessions.values()].map((session) => this.finishSession(session, false)),
    );
    for (const database of this.databaseConnections.values()) {
      database.close();
    }
    this.rootDatabase.close();
  }
}
