import assert from "node:assert/strict";
import { test } from "node:test";
import { accountEnvironment, activeAccount, availableAccounts, preferredAccount, afterQuotaExhausted, isQuotaFailure } from "../server/internal/accounts.js";

test("aswap account selection uses actual active account on Windows", () => {
  const active = activeAccount();
  assert.ok(active === "A" || active === "B");
  assert.equal(preferredAccount("gemini-model"), active);
  assert.deepEqual(accountEnvironment(active), {});
  const accounts = availableAccounts();
  assert.ok(accounts.includes("A"));
  if (process.platform === "win32") assert.ok(accounts.includes("B"));
});
test("quota failover is conservative and non-quota errors cannot trigger it", () => {
  for (const e of ["429 Too Many Requests", "RESOURCE_EXHAUSTED", "quota exceeded", "rate limited"]) {
    assert.equal(isQuotaFailure(e), true, e);
  }
  for (const e of ["Unauthorized", "Permission denied", "Invalid model", "interrupted"]) {
    assert.equal(isQuotaFailure(e), false, e);
  }
  const model = "test-accounts-" + process.pid;
  const primary = activeAccount();
  const other = primary === "A" ? "B" : "A";
  const next = afterQuotaExhausted(primary, model);
  assert.equal(next, availableAccounts().includes(other) ? other : null);
  if (next) assert.equal(afterQuotaExhausted(next, model), null, "no quota-failover loop");
});