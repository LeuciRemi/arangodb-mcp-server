const TRUNCATION_SUFFIX = "… [truncated]";
/** Return the longest prefix of message (plus a truncation marker) accepted by fits. */
function truncateToFit(message, fits) {
    if (fits(message)) {
        return message;
    }
    let low = 0;
    let high = message.length;
    const prefix = (length) => message.slice(0, length).replace(/[\uD800-\uDBFF]$/u, "");
    while (low < high) {
        const middle = Math.ceil((low + high) / 2);
        if (fits(prefix(middle) + TRUNCATION_SUFFIX)) {
            low = middle;
        }
        else {
            high = middle - 1;
        }
    }
    return prefix(low) + TRUNCATION_SUFFIX;
}
/** Bound the serialized error result, including JSON escaping and its envelope. */
export function boundedToolErrorResult(message, maxBytes) {
    const resultFor = (text) => ({
        content: [{ type: "text", text }],
        isError: true,
    });
    return resultFor(truncateToFit(message, (text) => Buffer.byteLength(JSON.stringify(resultFor(text)), "utf8") <= maxBytes));
}
/**
 * Bound a JSON-RPC error object. Error data is kept only when the complete
 * error still fits; otherwise it is dropped before the message is truncated.
 */
export function boundedProtocolError(error, maxBytes) {
    const size = (value) => Buffer.byteLength(JSON.stringify(value), "utf8");
    if (size(error) <= maxBytes) {
        return error;
    }
    const errorFor = (message) => ({ code: error.code, message });
    return errorFor(truncateToFit(error.message, (text) => size(errorFor(text)) <= maxBytes));
}
function serializedEnvelopeBytes(result) {
    return Buffer.byteLength(JSON.stringify({
        content: result.content,
        structuredContent: result.structuredContent,
    }), "utf8");
}
function jsonTextFallback(value) {
    return JSON.stringify(value);
}
export function queryPageResult(page) {
    const continuation = page.hasMore
        ? " Use nextCursor with continueQuery to fetch the next page."
        : "";
    const structuredContent = { ...page };
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
export function queryPageEnvelopeBytes(page) {
    return serializedEnvelopeBytes(queryPageResult(page));
}
export function boundedQueryPageResult(page, maxBytes) {
    const result = queryPageResult(page);
    const bytes = serializedEnvelopeBytes(result);
    if (bytes > maxBytes) {
        throw new Error(`Complete MCP tool response is ${bytes} bytes and exceeds the configured ${maxBytes}-byte limit`);
    }
    return result;
}
export function boundedObjectResult(structuredContent, maxBytes) {
    const result = {
        content: [{ type: "text", text: jsonTextFallback(structuredContent) }],
        structuredContent,
    };
    const bytes = serializedEnvelopeBytes(result);
    if (bytes > maxBytes) {
        throw new Error(`Complete MCP tool response is ${bytes} bytes and exceeds the configured ${maxBytes}-byte limit`);
    }
    return result;
}
