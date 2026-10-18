import { strict as assert } from "node:assert";
import { test } from "node:test";
import { evidenceEnvelope, runLifecycle } from "../server/internal/lifecycle.js";

test("envelope preserves user task separately from lower-trust evidence", () => {
  const s = evidenceEnvelope("source A [untrusted]", "user request");
  assert.ok(s.indexOf("source A") < s.indexOf("user request"));
  assert.ok(s.includes("[User task]"));
});

test("default enabled lifecycle records Stop without a transcript save", async () => {
  const r=await runLifecycle("stop","test-enabled","turn-a");
  assert.equal(r?.event,"stop");
  assert.equal(r?.save_status,"skipped");
});

test("forced stop records existing-save-only policy without duplicate Nowledge write", async () => {
  const r=await runLifecycle("stop","paseo-lifecycle-synthetic","turn-b","",{force:true,timeoutMs:12000});
  assert.equal(r?.event,"stop");
  assert.equal(r?.blocked,false);
});

test("forced prompt on isolated generic topic does not query unrelated sources", async () => {
  const r=await runLifecycle("prompt","paseo-lifecycle-synthetic","turn-c",
    "Explain how tuples work in Python",{force:true,timeoutMs:12000});
  assert.equal(r?.decision?.memory,false);
  assert.equal(r?.decision?.obsidian,false);
});
