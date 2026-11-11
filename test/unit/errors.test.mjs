import assert from "node:assert/strict";
import test from "node:test";

import { parseConfig } from "../../dist/src/config.js";
import {
  publicErrorMessage,
  redactErrorMessage,
  UserFacingError,
} from "../../dist/src/errors.js";

function createConfig(env = {}) {
  return parseConfig([], {
    ARANGO_URL: "http://db.example.test:8529",
    ...env,
  });
}

test("appends a WITH hint to dynamic collection resolution errors", () => {
  const config = createConfig();
  const message = publicErrorMessage(
    { errorNum: 1652, errorMessage: "collection or view not found" },
    config,
  );
  assert.match(
    message,
    /^ArangoDB error 1652: collection or view not found\. Declare collections that are accessed dynamically \(DOCUMENT\(\), anonymous traversals\) in a leading WITH statement$/,
  );

  const unrelated = publicErrorMessage(
    { errorNum: 1203, errorMessage: "collection or view not found" },
    config,
  );
  assert.match(unrelated, /^ArangoDB error 1203: collection or view not found$/);
});

test("redacts URL credentials without changing the scheme", () => {
  const config = createConfig();
  assert.equal(
    redactErrorMessage("connect ECONNREFUSED http://user:pass@db.example.test:8529", config),
    "connect ECONNREFUSED http://[redacted]@db.example.test:8529",
  );
  assert.equal(
    redactErrorMessage("https://user:pass@db.example.test:8529 refused", config),
    "https://[redacted]@db.example.test:8529 refused",
  );
});

test("redacts configured credentials and still reports user-facing messages", () => {
  const config = createConfig({
    ARANGO_USERNAME: "review-user",
    ARANGO_PASSWORD: "review-secret",
  });
  assert.equal(
    redactErrorMessage("review-user could not authenticate with review-secret", config),
    "[redacted] could not authenticate with [redacted]",
  );
  assert.equal(
    publicErrorMessage(
      new UserFacingError("connect http://review-user:review-secret@db.example.test:8529"),
      config,
    ),
    "connect http://[redacted]@db.example.test:8529",
  );
});
