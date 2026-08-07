export class UserFacingError extends Error {
    constructor(message) {
        super(message);
        this.name = "UserFacingError";
    }
}
function errorFields(error) {
    if (!error || typeof error !== "object") {
        return { message: String(error) };
    }
    const candidate = error;
    return {
        code: typeof candidate.code === "number" || typeof candidate.code === "string"
            ? candidate.code
            : undefined,
        errorNum: typeof candidate.errorNum === "number" ? candidate.errorNum : undefined,
        message: typeof candidate.errorMessage === "string"
            ? candidate.errorMessage
            : typeof candidate.message === "string"
                ? candidate.message
                : undefined,
    };
}
function redact(value, config) {
    let redacted = value;
    for (const secret of [config.password, config.username]) {
        if (secret) {
            redacted = redacted.split(secret).join("[redacted]");
        }
    }
    try {
        const url = new URL(config.databaseUrl);
        redacted = redacted.split(url.toString()).join(`${url.protocol}//${url.host}`);
    }
    catch {
        // Configuration already validates the URL. Keep error handling defensive.
    }
    return redacted.replace(/https?:\/\/[^\s/@:]+:[^\s/@]+@/g, "https://[redacted]@");
}
export function publicErrorMessage(error, config) {
    if (error instanceof UserFacingError) {
        return error.message;
    }
    const fields = errorFields(error);
    const prefix = fields.errorNum
        ? `ArangoDB error ${fields.errorNum}`
        : fields.code
            ? `ArangoDB request failed (${fields.code})`
            : "ArangoDB request failed";
    const detail = fields.message ? `: ${fields.message}` : "";
    return redact(`${prefix}${detail}`, config);
}
