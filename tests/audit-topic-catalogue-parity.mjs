// tests/audit-topic-catalogue-parity.mjs
//
// Ledger task T113 (board item B13). Verifies the server's fallback audit topic
// catalogue (AUDIT_TOPICS, used whenever a caller sends no catalog of its own -
// which is every call the desktop makes today) matches the extension's
// data/topics.json exactly: same topic count, same ids, same display names.
//
// This is the regression guard for a drift that was real and silent: the server
// carried 20 topics while the extension shipped 27, missing Investments,
// Derivatives, GovtGrants, Forex, CashFlow, IndAS101 and GeneralAudit entirely.
// A desktop caller (which sends no catalog) got the smaller, stale list with no
// error and no way to notice. This test reads both sources directly rather than
// hardcoding either one, so a future edit to either file without the other fails
// here instead of drifting silently again.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

process.env.NODE_ENV = process.env.NODE_ENV || "development";
process.env.JWT_SECRET = process.env.JWT_SECRET || "local-verification-only";
process.env.MONGODB_URI =
  process.env.MONGODB_URI || "mongodb://127.0.0.1:27017/capro-audit-topic-check";

const { AUDIT_TOPICS } = await import("../src/controllers/audit.controller.js");

const here = dirname(fileURLToPath(import.meta.url));
const topicsJsonPath = join(here, "..", "..", "audit-nlp-extension", "data", "topics.json");
const extensionTopics = JSON.parse(readFileSync(topicsJsonPath, "utf8")).topics;

let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed++;
  } catch (error) {
    failed++;
    failures.push(`${name}: ${error.message}`);
  }
}

test("server catalogue has exactly as many topics as the extension ships", () => {
  assert.equal(
    AUDIT_TOPICS.length,
    extensionTopics.length,
    `server has ${AUDIT_TOPICS.length}, extension has ${extensionTopics.length}`,
  );
});

test("every extension topic id exists in the server catalogue", () => {
  const serverIds = new Set(AUDIT_TOPICS.map((t) => t.id));
  const missing = extensionTopics
    .map((t) => t.id)
    .filter((id) => !serverIds.has(id));
  assert.deepEqual(missing, [], `server is missing: ${missing.join(", ")}`);
});

test("every server topic id exists in the extension catalogue", () => {
  const extensionIds = new Set(extensionTopics.map((t) => t.id));
  const extra = AUDIT_TOPICS.map((t) => t.id).filter((id) => !extensionIds.has(id));
  assert.deepEqual(extra, [], `server has topics the extension does not: ${extra.join(", ")}`);
});

test("no duplicate ids in the server catalogue", () => {
  const ids = AUDIT_TOPICS.map((t) => t.id);
  assert.equal(new Set(ids).size, ids.length, "server catalogue has a duplicate id");
});

test("each server topic name is non-empty and reasonably matches the extension's display name", () => {
  const byId = new Map(extensionTopics.map((t) => [t.id, t.display_name]));
  for (const topic of AUDIT_TOPICS) {
    assert.ok(topic.name && topic.name.length > 0, `${topic.id} has an empty name`);
    const extensionName = byId.get(topic.id);
    if (extensionName) {
      assert.equal(
        topic.name,
        extensionName,
        `${topic.id}: server says "${topic.name}", extension says "${extensionName}"`,
      );
    }
  }
});

console.log(`audit topic catalogue parity: ${passed}/${passed + failed} passed`);
if (failures.length > 0) {
  for (const failure of failures) console.error(`  FAIL ${failure}`);
  process.exit(1);
}
