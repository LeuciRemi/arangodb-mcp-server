import assert from "node:assert/strict";
import test from "node:test";

import {
  boundedObjectResult,
  boundedQueryPageResult,
  queryPageEnvelopeBytes,
} from "../../dist/src/mcp-content.js";

function envelopeBytes(result) {
  return Buffer.byteLength(
    JSON.stringify({
      content: result.content,
      structuredContent: result.structuredContent,
    }),
    "utf8",
  );
}

function page(overrides = {}) {
  return {
    rows: [{ value: "x".repeat(400) }],
    rowCount: 1,
    bytes: 414,
    hasMore: false,
    warnings: [],
    ...overrides,
  };
}

test("returns only the public page fields and a compact JSON text fallback", () => {
  const result = boundedQueryPageResult(page(), 2048);

  assert.deepEqual(Object.keys(result.structuredContent).sort(), [
    "hasMore",
    "rowCount",
    "rows",
  ]);
  assert.equal(result.structuredContent.bytes, undefined);
  assert.equal("warnings" in result.structuredContent, false);
  assert.equal("stats" in result.structuredContent, false);
  assert.equal("nextCursor" in result.structuredContent, false);
  assert.match(result.content[0].text, /^Returned 1 row\(s\)\.\n/);
  assert.doesNotMatch(result.content[0].text, /continueQuery/);
  assert.deepEqual(
    JSON.parse(result.content[0].text.split("\n")[1]),
    result.structuredContent,
  );
  assert.ok(envelopeBytes(result) <= 2048);
  assert.throws(
    () => boundedQueryPageResult(page(), 256),
    /complete MCP tool response/i,
  );
});

test("adds only the optional fields the caller asked for", () => {
  const full = page({
    hasMore: true,
    nextCursor: "cursor-1",
    warnings: [{ code: 1, message: "careful" }],
    stats: { writesExecuted: 0, writesIgnored: 0 },
  });

  const plain = boundedQueryPageResult(full, 4096);
  assert.deepEqual(plain.structuredContent, {
    rows: full.rows,
    rowCount: 1,
    hasMore: true,
    nextCursor: "cursor-1",
    warnings: [{ code: 1, message: "careful" }],
  });
  assert.match(plain.content[0].text, /Use nextCursor with continueQuery/);

  const withStats = boundedQueryPageResult(full, 4096, { includeStats: true });
  assert.deepEqual(withStats.structuredContent.stats, {
    writesExecuted: 0,
    writesIgnored: 0,
  });

  const hidden = boundedQueryPageResult(page({ stats: { scannedFull: 3 } }), 4096);
  assert.equal("stats" in hidden.structuredContent, false);
});

test("carries write counts only when the writer opts in", () => {
  const written = page({ writeStats: { writesExecuted: 4, writesIgnored: 1 } });
  const result = boundedQueryPageResult(written, 4096, { includeWriteStats: true });
  assert.equal(result.structuredContent.writesExecuted, 4);
  assert.equal(result.structuredContent.writesIgnored, 1);
  assert.equal(queryPageEnvelopeBytes(written) >= envelopeBytes(result), true);
  assert.equal(
    "writesExecuted" in boundedQueryPageResult(written, 4096).structuredContent,
    false,
  );
});

test("applies the same complete-envelope budget to non-query tools", () => {
  const result = boundedObjectResult({ values: ["a", "b"] }, 1024);
  assert.ok(envelopeBytes(result) <= 1024);
  assert.match(result.content[0].text, /"values":\["a","b"\]/);
  assert.throws(
    () => boundedObjectResult({ value: "x".repeat(1024) }, 1024),
    /complete MCP tool response/i,
  );
});
