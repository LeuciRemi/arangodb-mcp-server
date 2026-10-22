import type { QueryPage } from "./arangodb-service.js";

const TRUNCATION_SUFFIX = "… [truncated]";

/** Return the longest prefix of message (plus a truncation marker) accepted by fits. */
function truncateToFit(message: string, fits: (text: string) => boolean): string {
  if (fits(message)) {
    return message;
  }
  let low = 0;
  let high = message.length;
  const prefix = (length: number) =>
    message.slice(0, length).replace(/[\uD800-\uDBFF]$/u, "");
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (fits(prefix(middle) + TRUNCATION_SUFFIX)) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }
  return prefix(low) + TRUNCATION_SUFFIX;
}

/** Bound the serialized error result, including JSON escaping and its envelope. */
export function boundedToolErrorResult(message: string, maxBytes: number) {
  const resultFor = (text: string) => ({
    content: [{ type: "text" as const, text }],
    isError: true as const,
  });
  return resultFor(
    truncateToFit(
      message,
      (text) => Buffer.byteLength(JSON.stringify(resultFor(text)), "utf8") <= maxBytes,
    ),
  );
}

/**
 * Bound a JSON-RPC error object. Error data is kept only when the complete
 * error still fits; otherwise it is dropped before the message is truncated.
 */
export function boundedProtocolError(
  error: { code: number; message: string; data?: unknown },
  maxBytes: number,
): { code: number; message: string; data?: unknown } {
  const size = (value: unknown) => Buffer.byteLength(JSON.stringify(value), "utf8");
  if (size(error) <= maxBytes) {
    return error;
  }
  const errorFor = (message: string) => ({ code: error.code, message });
  return errorFor(truncateToFit(error.message, (text) => size(errorFor(text)) <= maxBytes));
}

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
