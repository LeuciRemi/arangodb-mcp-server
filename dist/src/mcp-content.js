/** Bound the serialized error result, including JSON escaping and its envelope. */
export function boundedToolErrorResult(message, maxBytes) {
    const resultFor = (text) => ({
        content: [{ type: "text", text }],
        isError: true,
    });
    const fits = (text) => Buffer.byteLength(JSON.stringify(resultFor(text)), "utf8") <= maxBytes;
    if (fits(message)) {
        return resultFor(message);
    }
    const suffix = "… [truncated]";
    let low = 0;
    let high = message.length;
    const prefix = (length) => message.slice(0, length).replace(/[\uD800-\uDBFF]$/u, "");
    while (low < high) {
        const middle = Math.ceil((low + high) / 2);
        if (fits(prefix(middle) + suffix)) {
            low = middle;
        }
        else {
            high = middle - 1;
        }
    }
    return resultFor(prefix(low) + suffix);
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
