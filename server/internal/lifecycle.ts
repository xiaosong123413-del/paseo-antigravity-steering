import { spawn } from "node:child_process";

export type LifecycleEvent = "start" | "prompt" | "subagent" | "stop";
export type LifecycleReply = {
  event: LifecycleEvent;
  blocked: boolean;
  save_status?: string;
  context: string;
  issues: string[];
  decision?: { memory: boolean; obsidian: boolean; requires_existing_source: boolean };
  memory: { status: string };
  obsidian: { status: string };
};

export const LIFECYCLE_ENABLED = process.env.PASEO_AI_CONTEXT_LIFECYCLE !== "0";
const BRIDGE = process.env.PASEO_AI_CONTEXT_BRIDGE || "E:/Projects/ai-context-core/lifecycle_bridge.py";

export function evidenceEnvelope(context: string, userPrompt: string): string {
  if (!context.trim()) return userPrompt;
  // Keep the user message distinct; retrieved context is lower-trust reference material.
  return `[AI Context preflight: read-only reference material]\n${context}\n[/AI Context preflight]\n\n[User task]\n${userPrompt}`;
}

export async function runLifecycle(
  event: LifecycleEvent,
  session: string,
  turn: string,
  text = "",
  opts: { force?: boolean; timeoutMs?: number } = {},
): Promise<LifecycleReply | null> {
  if (!opts.force && !LIFECYCLE_ENABLED) return null;
  const timeout = opts.timeoutMs ?? (event === "prompt" ? 25_000 : 12_000);
  return await new Promise<LifecycleReply>((resolve, reject) => {
    const child = spawn("python", ["-X", "utf8", BRIDGE, "--event", event,
      "--session", session, "--turn", turn], { windowsHide: true, stdio: "pipe" });
    let output = "";
    let finished = false;
    const deadline = setTimeout(() => {
      if (finished) return;
      finished = true;
      child.kill();
      reject(new Error("AI Context lifecycle timed out"));
    }, timeout);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (piece: string) => {
      output += piece;
      if (output.length > 65_536) {
        child.kill();
        if (!finished) {
          finished = true;
          clearTimeout(deadline);
          reject(new Error("AI Context lifecycle output too large"));
        }
      }
    });
    child.on("error", () => {
      if (!finished) {
        finished = true;
        clearTimeout(deadline);
        reject(new Error("AI Context lifecycle child process failed"));
      }
    });
    child.on("close", (code) => {
      if (finished) return;
      finished = true;
      clearTimeout(deadline);
      if (code !== 0) {
        reject(new Error("AI Context lifecycle exit not successful"));
        return;
      }
      try {
        const data: unknown = JSON.parse(output);
        if (typeof data !== "object" || data === null) throw new Error("invalid payload");
        const value = data as LifecycleReply;
        if (value.event !== event || typeof value.blocked !== "boolean" ||
            typeof value.context !== "string" || !Array.isArray(value.issues)) {
          throw new Error("invalid response contract");
        }
        resolve(value);
      } catch {
        reject(new Error("AI Context lifecycle returned invalid JSON"));
      }
    });
    child.stdin.on("error", () => undefined);
    child.stdin.end(text.slice(0, 15_000));
  });
}
