import { test } from "node:test";
import assert from "node:assert/strict";
import { parseTipArgs, TIP_USAGE } from "./parse.ts";

const limits = { min: 1, max: 50 };

function ok(text: string) {
  const r = parseTipArgs(text, limits);
  assert.ok(r.ok, `expected "${text}" to parse, got ${!r.ok && r.error}`);
  return r.args;
}

function err(text: string) {
  const r = parseTipArgs(text, limits);
  assert.ok(!r.ok, `expected "${text}" to fail`);
  return r.error;
}

test("standard order", () => {
  assert.deepEqual(ok("@alice_b 5 NVDA"), { amountUsd: 5, ticker: "NVDA", mention: "alice_b" });
});

test("any order, dollar signs, lowercase ticker", () => {
  assert.deepEqual(ok("$2.50 nvda @alice_b"), { amountUsd: 2.5, ticker: "NVDA", mention: "alice_b" });
  assert.deepEqual(ok("TSLA 10$ @bobby"), { amountUsd: 10, ticker: "TSLA", mention: "bobby" });
  assert.deepEqual(ok("5 $NVDAB"), { amountUsd: 5, ticker: "NVDAB", mention: null });
});

test("reply form has no mention", () => {
  assert.equal(ok("5 NVDA").mention, null);
});

test("limits", () => {
  assert.equal(err("@alice 0.5 NVDA"), "The minimum tip is $1.");
  assert.equal(err("@alice 51 NVDA"), "The maximum tip is $50.");
});

test("rejects garbage", () => {
  assert.equal(err(""), TIP_USAGE);
  assert.equal(err("@alice NVDA"), TIP_USAGE);
  assert.equal(err("@alice 5"), TIP_USAGE);
  assert.equal(err("@alice 5 NVDA TSLA"), TIP_USAGE);
  assert.equal(err("@alice @bobby 5 NVDA"), "You can tip one person at a time.");
  assert.match(err("@alice 5 NV-DA"), /didn't understand "NV-DA"/);
  assert.match(err("@alice 5.123 NVDA"), /didn't understand "5.123"/);
});
