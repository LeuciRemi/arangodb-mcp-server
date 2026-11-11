import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import test from "node:test";

import { ArangoDBService } from "../../dist/src/arangodb-service.js";
import { parseConfig } from "../../dist/src/config.js";
import { queryPageEnvelopeBytes } from "../../dist/src/mcp-content.js";

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function createService(
  t,
  {
    rows = [1, 2, 3],
    limits = {},
    hooks = {},
    plan,
    existingCollections = ["public"],
    allowedCollections = "test/public",
  } = {},
) {
  const config = {
    ...parseConfig([], {
      ARANGO_URL: "http://127.0.0.1:1",
      ARANGO_ALLOWED_DATABASES: "test",
      ARANGO_ALLOWED_COLLECTIONS: allowedCollections,
      ARANGO_ENABLE_DOCUMENT_WRITES: "true",
      ARANGO_ENABLE_READ_WRITE_QUERY: "true",
    }),
    ...limits,
  };
  const service = new ArangoDBService(config);
  const events = [];
  const selectors = [];
  const spoolPaths = [];
  const transactions = [];
  const listCollectionCalls = [];
  const removeSpool = service.removeSpool.bind(service);
  service.removeSpool = async (spool) => {
    spoolPaths.push(spool.path);
    await removeSpool(spool);
  };
  const transaction = {
    step: (callback) => callback(),
    async commit() {
      events.push("commit");
      await hooks.commit?.();
    },
    async abort() {
      events.push("abort");
      await hooks.abort?.();
    },
  };
  const database = {
    async explain() {
      events.push("explain");
      await hooks.explain?.();
      return {
        plan: plan ?? {
          collections: [{ name: "public", type: "read" }],
          isModificationQuery: false,
          estimatedCost: 1,
          estimatedNrItems: rows.length,
          nodes: [],
          rules: [],
        },
        warnings: [],
      };
    },
    async listCollections(includeSystem) {
      listCollectionCalls.push(includeSystem);
      await hooks.listCollections?.();
      return existingCollections.map((name) => ({ name }));
    },
    async beginTransaction(readWrite, options) {
      events.push("begin");
      transactions.push({ readWrite, options });
      await hooks.begin?.();
      return transaction;
    },
    async query() {
      events.push("query");
      await hooks.query?.();
      let index = 0;
      return {
        extra: {},
        get hasNext() { return index < rows.length; },
        async next() {
          events.push("next");
          await hooks.next?.(index);
          return rows[index++];
        },
        async kill() {
          events.push("kill");
          index = rows.length;
        },
      };
    },
    collection(name) {
      events.push("collection");
      assert.equal(name, "public");
      const operation = async (key) => {
        selectors.push(key);
        return { _key: key, _rev: "revision" };
      };
      return { document: operation, update: operation, remove: operation };
    },
    close() { events.push("close"); },
  };
  service.databaseConnections.set("test", database);
  t.after(async () => {
    await service.close();
    for (const path of spoolPaths) {
      await assert.rejects(access(path), { code: "ENOENT" });
    }
  });
  return {
    service,
    config,
    events,
    selectors,
    spoolPaths,
    transactions,
    listCollectionCalls,
  };
}

test("rejects unsafe document selectors before accessing a collection", async (t) => {
  const { service, events } = createService(t);
  const invalid = [
    "public/../secret/key", "public/key/extra", "other/key", "public/",
    ".", "..", "public/..", "key\\other", "key?query", "key#fragment",
    "key\n", "", "x".repeat(255),
  ];
  for (const selector of invalid) {
    await assert.rejects(service.readDocument("test", "public", selector), /Document ID/);
    await assert.rejects(
      service.updateDocument("test", "public", selector, "revision", { value: 1 }),
      /Document ID/,
    );
    await assert.rejects(
      service.deleteDocument("test", "public", selector, "revision"), /Document ID/,
    );
  }
  assert.deepEqual(events, []);
});

test("accepts ArangoDB key punctuation and normalizes matching document IDs", async (t) => {
  const { service, selectors } = createService(t);
  const keys = ["normal-key", "_:.@()+,=;$!*'%-", "x".repeat(254)];
  for (const key of keys) {
    await service.readDocument("test", "public", key);
    await service.updateDocument("test", "public", `public/${key}`, "revision", {});
    await service.deleteDocument("test", "public", `public/${key}`, "revision");
  }
  assert.deepEqual(selectors, keys.flatMap((key) => [key, key, key]));
});

test("does not start a write when the request is already cancelled", async (t) => {
  const { service, events } = createService(t);
  await assert.rejects(
    service.executeWriteQuery("test", "RETURN 1", {}, 1, AbortSignal.abort()),
    /cancelled by the client/,
  );
  assert.deepEqual(events, []);
});

test("rejects cancelled or non-allowlisted schema inference before querying", async (t) => {
  const { service, events } = createService(t);
  await assert.rejects(
    service.inferSchema("test", "public", 10, AbortSignal.abort()),
    /cancelled by the client/,
  );
  await assert.rejects(
    service.inferSchema("test", "hidden", 10),
    /Collection "test\/hidden" is not allowed by server policy/,
  );
  assert.deepEqual(events, []);
});

test("rolls back cancellation before execution and while draining write results", async (t) => {
  for (const stage of ["explain", "begin", "next"]) {
    await t.test(stage, async (t) => {
      const controller = new AbortController();
      const { service, events, spoolPaths } = createService(t, {
        hooks: { [stage]: () => controller.abort() },
      });
      await assert.rejects(
        service.executeWriteQuery("test", "RETURN 1", {}, 1, controller.signal),
        /cancelled by the client/,
      );
      assert.ok(!events.includes("commit"));
      assert.equal(events.filter((event) => event === "abort").length, stage === "explain" ? 0 : 1);
      if (stage === "next") {
        assert.ok(events.includes("kill"));
        assert.equal(spoolPaths.length, 1);
      } else {
        assert.ok(!events.includes("query"));
      }
    });
  }
});

test("checks cancellation after the spool completes and before committing", async (t) => {
  const controller = new AbortController();
  const { service, events, spoolPaths } = createService(t);
  const spoolWriteResults = service.spoolWriteResults.bind(service);
  service.spoolWriteResults = async (...args) => {
    const spool = await spoolWriteResults(...args);
    controller.abort();
    return spool;
  };
  await assert.rejects(
    service.executeWriteQuery("test", "RETURN 1", {}, 1, controller.signal),
    /cancelled by the client/,
  );
  assert.ok(!events.includes("commit"));
  assert.equal(events.filter((event) => event === "abort").length, 1);
  assert.equal(spoolPaths.length, 1);
});

test("reports committed writes successfully when cancellation arrives during commit", async (t) => {
  const controller = new AbortController();
  const { service, events } = createService(t, {
    rows: ["saved-1", "saved-2"],
    hooks: { commit: () => controller.abort() },
  });
  const first = await service.executeWriteQuery("test", "RETURN 1", {}, 1, controller.signal);
  assert.deepEqual(first.rows, ["saved-1"]);
  const last = await service.continueQuery(first.nextCursor, 1, controller.signal);
  assert.deepEqual(last.rows, ["saved-2"]);
  assert.equal(last.hasMore, false);
  assert.equal(events.filter((event) => event === "commit").length, 1);
  assert.ok(!events.includes("abort"));
});

test("paginates fitting write rows without replacing rows that exceed the remaining page space", async (t) => {
  const rows = Array.from({ length: 5 }, (_, i) => `${i}:` + "x".repeat(898));
  const { service, config } = createService(t, { rows, limits: { maxBytes: 4096 } });
  let page = await service.executeWriteQuery("test", "RETURN 1", {}, 5);
  const received = [];
  for (;;) {
    assert.ok(queryPageEnvelopeBytes(page) <= config.maxBytes);
    received.push(...page.rows);
    if (!page.hasMore) break;
    page = await service.continueQuery(page.nextCursor, 5);
  }
  assert.deepEqual(received, rows);
});

test("still returns an omission marker for individually oversized write results", async (t) => {
  const { service, config } = createService(t, {
    rows: ["x".repeat(6000), "small"], limits: { maxBytes: 4096 },
  });
  const page = await service.executeWriteQuery("test", "RETURN 1", {}, 2);
  assert.equal(page.rows[0]._mcpResultOmitted, true);
  assert.equal(page.rows[1], "small");
  assert.equal(page.hasMore, false);
  assert.ok(queryPageEnvelopeBytes(page) <= config.maxBytes);
});

test("keeps the cursor slot reserved during continuation and releases it after completion", { timeout: 5000 }, async (t) => {
  const fetching = deferred();
  const release = deferred();
  t.after(() => release.resolve());
  const { service } = createService(t, {
    limits: { maxActiveCursors: 1 },
    hooks: { next: async (index) => {
      if (index === 1) {
        fetching.resolve();
        await release.promise;
      }
    } },
  });
  const first = await service.executeReadQuery("test", "RETURN 1", {}, 1);
  const continuation = service.continueQuery(first.nextCursor, 1);
  try {
    await fetching.promise;
    await assert.rejects(
      service.executeReadQuery("test", "RETURN 1", {}, 1), /1 active cursors/,
    );
  } finally {
    release.resolve();
  }
  const second = await continuation;
  assert.deepEqual(second.rows, [2]);
  const last = await service.continueQuery(second.nextCursor, 1);
  assert.equal(last.hasMore, false);
  assert.deepEqual((await service.executeReadQuery("test", "RETURN 1", {}, 3)).rows, [1, 2, 3]);
});

test("releases a continuation reservation after cursor failure", async (t) => {
  let fail = true;
  const { service, events } = createService(t, {
    limits: { maxActiveCursors: 1 },
    hooks: { next: (index) => {
      if (index === 1 && fail) throw new Error("cursor unavailable");
    } },
  });
  const first = await service.executeReadQuery("test", "RETURN 1", {}, 1);
  await assert.rejects(service.continueQuery(first.nextCursor, 1), /cursor unavailable/);
  assert.ok(events.includes("abort"));
  fail = false;
  assert.deepEqual((await service.executeReadQuery("test", "RETURN 1", {}, 3)).rows, [1, 2, 3]);
});

test("shutdown waits for an active continuation to abort before closing connections", { timeout: 5000 }, async (t) => {
  const fetching = deferred();
  const release = deferred();
  t.after(() => release.resolve());
  const { service, events } = createService(t, {
    hooks: { next: async (index) => {
      if (index === 1) {
        fetching.resolve();
        await release.promise;
      }
    } },
  });
  const first = await service.executeReadQuery("test", "RETURN 1", {}, 1);
  const continuation = service.continueQuery(first.nextCursor, 1);
  const rejected = assert.rejects(continuation, /shutting down/);
  await fetching.promise;
  const closing = service.close();
  assert.equal(service.close(), closing);
  try {
    assert.ok(!events.includes("close"));
    await assert.rejects(service.executeReadQuery("test", "RETURN 1", {}, 1), /shutting down/);
    await assert.rejects(service.continueQuery(first.nextCursor, 1), /shutting down/);
    await assert.rejects(service.readDocument("test", "public", "key"), /shutting down/);
  } finally {
    release.resolve();
  }
  await rejected;
  await closing;
  assert.ok(events.indexOf("abort") < events.indexOf("close"));
  assert.equal(events.filter((event) => event === "close").length, 1);
});

test("declares only existing allowlisted collections in the read transaction", async (t) => {
  const { service, transactions, listCollectionCalls } = createService(t, {
    allowedCollections: "test/public,test/ghost",
  });
  const page = await service.executeReadQuery("test", "RETURN 1", {}, 3);
  assert.deepEqual(page.rows, [1, 2, 3]);
  assert.deepEqual(
    listCollectionCalls,
    [false],
    "system collections are included so allowlisted system collections stay declared",
  );
  assert.deepEqual(transactions.map(({ readWrite }) => readWrite), [{ read: ["public"] }]);
  assert.deepEqual(transactions.map(({ options }) => options.allowImplicit), [false]);
});

test("authorises views through their linked collections, not their names", async (t) => {
  const plan = {
    collections: [
      { name: "public", type: "read" },
      { name: "linked", type: "read" },
      { name: "search_view", type: "read" },
    ],
    isModificationQuery: false,
    estimatedCost: 1,
    estimatedNrItems: 2,
    nodes: [
      { type: "SingletonNode", estimatedCost: 1, estimatedNrItems: 1 },
      { type: "EnumerateViewNode", view: "search_view", estimatedCost: 1, estimatedNrItems: 2 },
    ],
    rules: [],
  };
  const { service, transactions } = createService(t, {
    rows: ["a", "b"],
    plan,
    existingCollections: ["public", "linked"],
    allowedCollections: "test/public,test/linked",
  });
  const aql = "FOR doc IN search_view RETURN doc._key";

  const explanation = await service.explainReadQuery("test", aql, {});
  assert.deepEqual(explanation.views, ["search_view"]);
  assert.deepEqual(explanation.collections, [
    { name: "public", type: "read" },
    { name: "linked", type: "read" },
  ]);

  const page = await service.executeReadQuery("test", aql, {}, 2);
  assert.deepEqual(page.rows, ["a", "b"]);
  assert.deepEqual(transactions.map(({ readWrite }) => readWrite), [
    { read: ["public", "linked"] },
  ]);
  assert.deepEqual(transactions.map(({ options }) => options.allowImplicit), [false]);
});

test("rejects a view whose linked collections are not all allowlisted", async (t) => {
  const plan = {
    collections: [
      { name: "public", type: "read" },
      { name: "hidden", type: "read" },
      { name: "search_view", type: "read" },
    ],
    isModificationQuery: false,
    estimatedCost: 1,
    estimatedNrItems: 2,
    nodes: [
      { type: "EnumerateViewNode", view: "search_view", estimatedCost: 1, estimatedNrItems: 2 },
    ],
    rules: [],
  };
  const { service, transactions } = createService(t, { plan });
  await assert.rejects(
    service.executeReadQuery("test", "FOR doc IN search_view RETURN doc._key", {}, 1),
    /Collection "test\/hidden" is not allowed by server policy/,
  );
  assert.deepEqual(transactions, [], "a rejected view query must not open a transaction");
});
