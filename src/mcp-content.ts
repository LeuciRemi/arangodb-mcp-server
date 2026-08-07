import type { QueryPage } from "./arangodb-service.js";

export interface ToolContentResult {
  [key: string]: unknown;
  content: Array<{ type: "text"; text: string }>;
  structuredContent: Record<string, unknown>;
}

function serializedEnvelopeBytes(result: ToolContentResult): number {
  return Buffer.byteLength(
    JSON.stringify({
      content: result.content,
      structuredContent: result.structuredContent,
    }),
    "utf8",
  );
}

function jsonTextFallback(value: Record<string, unknown>): string {
  return JSON.stringify(value);
}

export function queryPageResult(page: QueryPage): ToolContentResult {
  const continuation = page.hasMore
    ? " Use nextCursor with continueQuery to fetch the next page."
    : "";
  const structuredContent: Record<string, unknown> = { ...page };
  return {
    content: [
      {
        type: "text",
        text: `Returned ${page.rowCount} row(s).${continuation}\n${jsonTextFallback(structuredContent)}`,
      },
    ],
    structuredContent,
  };
}

export function queryPageEnvelopeBytes(page: QueryPage): number {
  return serializedEnvelopeBytes(queryPageResult(page));
}

export function boundedQueryPageResult(
  page: QueryPage,
  maxBytes: number,
): ToolContentResult {
  const result = queryPageResult(page);
  const bytes = serializedEnvelopeBytes(result);
  if (bytes > maxBytes) {
    throw new Error(
      `Complete MCP tool response is ${bytes} bytes and exceeds the configured ${maxBytes}-byte limit`,
    );
  }
  return result;
}

export function boundedObjectResult(
  structuredContent: Record<string, unknown>,
  maxBytes: number,
): ToolContentResult {
  const result: ToolContentResult = {
    content: [{ type: "text", text: jsonTextFallback(structuredContent) }],
    structuredContent,
  };
  const bytes = serializedEnvelopeBytes(result);
  if (bytes > maxBytes) {
    throw new Error(
      `Complete MCP tool response is ${bytes} bytes and exceeds the configured ${maxBytes}-byte limit`,
    );
  }
  return result;
}
