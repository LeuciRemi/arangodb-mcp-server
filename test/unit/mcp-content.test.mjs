import assert from "node:assert/strict";
import test from "node:test";

import {
  boundedObjectResult,
  boundedQueryPageResult,
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

test("measures the complete envelope with a compatible text fallback", () => {
  const page = {
    rows: [{ value: "x".repeat(400) }],
    rowCount: 1,
    bytes: 414,
    hasMore: false,
    warnings: [],
  };
  const result = boundedQueryPageResult(page, 2048);

  assert.match(result.content[0].text, /Returned 1 row/);
  assert.match(result.content[0].text, /"rows"/);
  assert.match(result.content[0].text, /"value"/);
  assert.ok(envelopeBytes(result) <= 2048);
  assert.ok(result.content[0].text.includes("x".repeat(100)));
  assert.throws(() => boundedQueryPageResult(page, 256), /complete MCP tool response/i);
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
