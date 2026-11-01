"use strict";
const assert = require("node:assert/strict");
const test = require("node:test");
const { connectionConfig } = require("../src/db");

const POOLER = "postgresql://postgres.abcref:[YOUR-PASSWORD]@aws-1-eu-central-1.pooler.supabase.com:6543/postgres";

test("DATABASE_PASSWORD replaces the placeholder and survives special characters", () => {
  const { connectionString } = connectionConfig({ DATABASE_URL: POOLER, DATABASE_PASSWORD: "p@ss#w/rd?%1" });
  const url = new URL(connectionString);
  assert.equal(decodeURIComponent(url.password), "p@ss#w/rd?%1");
  assert.equal(url.username, "postgres.abcref");
});

test("placeholder password without DATABASE_PASSWORD is a setup error", () => {
  assert.throws(() => connectionConfig({ DATABASE_URL: POOLER }), (e) => e.setup && /placeholder/.test(e.hint));
  const underscored = POOLER.replace("[YOUR-PASSWORD]", "YOUR_DATABASE_PASSWORD");
  assert.throws(() => connectionConfig({ DATABASE_URL: underscored }), (e) => e.setup && /placeholder/.test(e.hint));
});

test("direct Supabase host is rejected on Vercel", () => {
  const direct = "postgresql://postgres:secret@db.abcref.supabase.co:5432/postgres";
  assert.throws(() => connectionConfig({ DATABASE_URL: direct, VERCEL: "1" }), (e) => /Transaction pooler/.test(e.hint));
  assert.doesNotThrow(() => connectionConfig({ DATABASE_URL: direct }));
});

test("pooler without project ref in the user name is a setup error", () => {
  const bad = "postgresql://postgres:secret@aws-1-eu-central-1.pooler.supabase.com:6543/postgres";
  assert.throws(() => connectionConfig({ DATABASE_URL: bad }), (e) => /postgres\.<project-ref>/.test(e.hint));
});

test("sslmode and pgbouncer parameters and surrounding quotes are removed", () => {
  const { connectionString } = connectionConfig({
    DATABASE_URL: `"postgresql://postgres.abcref:secret@aws-1-eu-central-1.pooler.supabase.com:6543/postgres?sslmode=require&pgbouncer=true"`,
  });
  assert.equal(new URL(connectionString).search, "");
});
