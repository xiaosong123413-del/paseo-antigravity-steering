import assert from "node:assert/strict";
import { test } from "node:test";
import { agyEnvironment, windowsProxy } from "../server/internal/proxy.js";

test("explicit HTTPS proxy is preserved", () => {
  const env = agyEnvironment({ HTTPS_PROXY: "http://localhost:1234", NO_PROXY: "example.com" });
  assert.equal(env.HTTPS_PROXY, "http://localhost:1234");
  assert.equal(env.NO_PROXY, "example.com");
});
test("Windows user proxy is injected with local bypass", () => {
  const proxy = windowsProxy();
  const env = agyEnvironment({});
  if (proxy) {
    assert.equal(env.HTTPS_PROXY, proxy);
    assert.equal(env.HTTP_PROXY, proxy);
    assert.match(env.NO_PROXY ?? "", /127[.]0[.]0[.]1/);
  } else {
    assert.equal(env.HTTPS_PROXY, undefined);
  }
  console.log("WinINET proxy detected:", proxy ?? "none");
});