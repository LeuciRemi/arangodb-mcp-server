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
