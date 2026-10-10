import assert from "node:assert/strict";
import { test } from "node:test";
import { SteeringBridge } from "../server/internal/steering.js";

async function invoke(url: string, stage: string, conversationId: string): Promise<unknown> {
  const response = await fetch(`${url}/${stage}`, {
    method: "POST",
    body: JSON.stringify({ conversationId }),
  });
  assert.equal(response.status, 200);
  return response.json();
}

test("steers are injected once, in order, only into their active conversation", async () => {
  const bridge = new SteeringBridge();
  try {
    const url = await bridge.start();
    bridge.bindConversation("conversation-a");
    bridge.beginTurn();
    bridge.enqueue("first correction");
    bridge.enqueue("second correction");
    assert.deepEqual(await invoke(url, "pre", "conversation-b"), {});
    assert.deepEqual(await invoke(url, "pre", "conversation-a"), {
      injectSteps: [{ userMessage: "first correction" }, { userMessage: "second correction" }],
    });
    assert.deepEqual(await invoke(url, "post", "conversation-a"), {});
  } finally {
    await bridge.close();
  }
});

test("post-invocation steering continues the same execution loop", async () => {
  const bridge = new SteeringBridge();
  try {
    const url = await bridge.start();
    bridge.bindConversation("conversation-a");
    bridge.beginTurn();
    bridge.enqueue("change direction");
    assert.deepEqual(await invoke(url, "post", "conversation-a"), {
      injectSteps: [{ userMessage: "change direction" }],
      terminationBehavior: "force_continue",
    });
  } finally {
    await bridge.close();
  }
});

test("interrupt clears pending steers and idle sessions reject new ones", async () => {
  const bridge = new SteeringBridge();
  try {
    const url = await bridge.start();
    bridge.bindConversation("conversation-a");
    bridge.beginTurn();
    bridge.enqueue("must be discarded");
    bridge.endTurn();
    assert.deepEqual(await invoke(url, "pre", "conversation-a"), {});
    assert.throws(() => bridge.enqueue("idle"), /active turn/);
    bridge.beginTurn();
    assert.deepEqual(bridge.take(), []);
  } finally {
    await bridge.close();
  }
});

test("requests without the session capability cannot consume queued messages", async () => {
  const bridge = new SteeringBridge();
  try {
    const url = await bridge.start();
    bridge.bindConversation("conversation-a");
    bridge.beginTurn();
    bridge.enqueue("private correction");
    const invalid = new URL(url);
    invalid.pathname = "/invalid/pre";
    const response = await fetch(invalid, { method: "POST", body: JSON.stringify({ conversationId: "conversation-a" }) });
    assert.equal(response.status, 404);
    assert.deepEqual(bridge.take(), ["private correction"]);
  } finally {
    await bridge.close();
  }
});
