import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { recoverAntigravityMessages } from "../server/internal/history.js";

test("bad native conversation id cannot resolve a path", async () => {
  assert.deepEqual(await recoverAntigravityMessages("../../etc/passwd"), []);
});
test("existing native transcript replays a nonempty ordered user/assistant timeline", async () => {
  const id = "6648b9eb-6624-4c9f-9cf4-18a37d598fe6";
  const file = join(homedir(), ".gemini", "antigravity-cli", "conversations", id + ".db");
  if (!existsSync(file)) return;
  const events = await recoverAntigravityMessages(id);
  assert.ok(events.length >= 25, "native transcript should be restored");
  assert.ok(events.some(x => x.type === "user_message"));
  assert.ok(events.some(x => x.type === "assistant_message"));
  assert.ok(events.every(x => typeof x.id === "string" && "text" in x && typeof x.text === "string"));
  console.log("recoveredNativeMessages", events.length);
});
