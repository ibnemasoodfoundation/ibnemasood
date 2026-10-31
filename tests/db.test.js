"use strict";
const assert = require("node:assert/strict");
const test = require("node:test");
const { logDatabaseError } = require("../src/db");

test("database error logs contain a safe code, not error details", () => {
  const originalError = console.error;
  const logs = [];
  console.error = (entry) => logs.push(entry);

  try {
    const error = Object.assign(
      new Error("password=hunter2 postgres://user:hunter2@example.invalid/db"),
      { code: "28P01", detail: "sensitive user detail" }
    );
    logDatabaseError("query", error);
  } finally {
    console.error = originalError;
  }

  assert.deepEqual(JSON.parse(logs[0]), {
    event: "database_error",
    operation: "query",
    code: "28P01",
  });
});

test("database error logger replaces unsafe codes", () => {
  const originalError = console.error;
  const logs = [];
  console.error = (entry) => logs.push(entry);

  try {
    logDatabaseError("schema_init", Object.assign(new Error("failure"), { code: "bad code with details" }));
  } finally {
    console.error = originalError;
  }

  assert.deepEqual(JSON.parse(logs[0]), {
    event: "database_error",
    operation: "schema_init",
    code: "UNKNOWN",
  });
});
