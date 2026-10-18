import assert from "node:assert/strict";
import { test } from "node:test";
import type { ProviderLaunch } from "@getpaseo/plugin/server/provider";
import { probe } from "../server/internal/process.js";

test(
  "provider discovery allows a cold Antigravity startup longer than ten seconds",
  { timeout: 20_000 },
  async () => {
    const launch: ProviderLaunch = {
      command: process.execPath,
      args: ["-e", "setTimeout(() => process.stdout.write('ready'), 10_250)"],
      env: {},
    };

    assert.equal(await probe({ launch, args: [] }), "ready");
  },
);
