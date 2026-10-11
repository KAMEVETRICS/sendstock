import { test } from "node:test";
import assert from "node:assert/strict";
import { signInitData, verifyInitData } from "./telegram-auth.ts";

const TOKEN = "123456:TEST-token";
const now = Date.UTC(2026, 9, 7, 12, 0, 0);
const user = JSON.stringify({ id: 42, first_name: "Alice", username: "alice_b" });

function fields(extra: Record<string, string> = {}) {
  return { auth_date: String(now / 1000 - 60), query_id: "AAE", user, start_param: "claim_abc123", ...extra };
}

test("accepts correctly signed data", () => {
  const v = verifyInitData(signInitData(fields(), TOKEN), TOKEN, 3600, now);
  assert.ok(v);
  assert.equal(v.user.id, 42);
  assert.equal(v.user.username, "alice_b");
  assert.equal(v.startParam, "claim_abc123");
});

test("rejects a different bot token", () => {
  assert.equal(verifyInitData(signInitData(fields(), "999:other"), TOKEN, 3600, now), null);
});

test("rejects tampered fields", () => {
  const signed = signInitData(fields(), TOKEN);
  const tampered = signed.replace(encodeURIComponent('"id":42'), encodeURIComponent('"id":43'));
  assert.notEqual(tampered, signed);
  assert.equal(verifyInitData(tampered, TOKEN, 3600, now), null);
});

test("rejects stale data", () => {
  const old = fields({ auth_date: String(now / 1000 - 7200) });
  assert.equal(verifyInitData(signInitData(old, TOKEN), TOKEN, 3600, now), null);
});

test("rejects missing or malformed hash", () => {
  assert.equal(verifyInitData(new URLSearchParams(fields()).toString(), TOKEN, 3600, now), null);
  assert.equal(verifyInitData(new URLSearchParams({ ...fields(), hash: "zz" }).toString(), TOKEN, 3600, now), null);
});
