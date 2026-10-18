// Modified from Paseo 0.11.1: invocation-hook steering and document runtime integration.
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type {
  ProviderCatalog,
  ProviderConfigChanges,
  ProviderEvent,
  ProviderPersistence,
  ProviderPrompt,
  ProviderSessionConfig,
  ProviderLaunch,
  ProviderTimelineItem,
  ProviderUsage,
} from "@getpaseo/plugin/server/provider";
import { startDriver, selection, type Driver } from "./process.js";
import { accountEnvironment, afterQuotaExhausted, isQuotaFailure, preferredAccount, switchAccount, type AgAccount } from "./accounts.js";
import { validateSelection } from "./catalog.js";
import { PromptFiles } from "./prompt.js";
import { SteeringBridge } from "./steering.js";
import { toolItem } from "./timeline.js";
import { recoverAntigravityMessages } from "./history.js";
import { evidenceEnvelope, runLifecycle, LIFECYCLE_ENABLED } from "./lifecycle.js";
import { AntigravityError, diagnostic, type Frame, type Step } from "./wire.js";

const persistenceSchema = z
  .object({ version: z.literal(1), data: z.object({ conversationId: z.string().min(1) }).strict() })
  .strict();
interface Turn {
  id: string;
  input: string;
  text: Map<number, string>;
  usageSteps: Set<number>;
  tools: Map<string, Extract<ProviderTimelineItem, { type: "tool_call" }>>;
  usage: Required<Pick<ProviderUsage, "inputTokens" | "outputTokens" | "cachedInputTokens">>;
}
type State =
  | { type: "dormant" }
  | { type: "starting"; driver: Driver }
  | { type: "idle"; driver: Driver }
  | { type: "running"; driver: Driver; turn: Turn }
  | { type: "stopping"; driver: Driver }
  | { type: "closed" };
interface SessionOptions {
  id: string;
  config: ProviderSessionConfig;
  launch: ProviderLaunch;
  catalog(): ProviderCatalog;
  persistence?: ProviderPersistence;
  history: "replay" | "skip";
  emit(event: ProviderEvent): void;
}

export class Session {
  private state: State = { type: "dormant" };
  private account: AgAccount = "A";
  private pendingAccount: AgAccount | null = null;
  private config: ProviderSessionConfig;
  private conversationId: string | null;
  private firstMessage: boolean;
  private readonly promptFiles: PromptFiles;
  private readonly steering = new SteeringBridge();
  private readonly reportedDenials = new Map<string, number>();
  private startupContext = "";
  private startupPending = true;
  private readonly observedSubagents = new Set<string>();
  private readonly stoppedTurnIds = new Set<string>();
  private lifecycleEnabled(): boolean {
    return LIFECYCLE_ENABLED || this.config.env?.PASEO_AI_CONTEXT_LIFECYCLE === "1";
  }

  constructor(private readonly options: SessionOptions) {
    this.config = { ...options.config, mode: options.config.mode ?? "full-access" };
    this.promptFiles = new PromptFiles({ ...options.launch.env, ...this.config.env });
    this.conversationId = options.persistence
      ? persistenceSchema.parse(options.persistence).data.conversationId
      : null;
    this.firstMessage = this.conversationId === null;
    validateSelection(this.config, options.catalog());
  }

  async open(requestId: string, capabilities: readonly string[]): Promise<void> {
    // Paseo requests replay separately from ordinary interactive startup.
    // History-only resume must not spawn agy or run slow source-preflight hooks.
    const replay = this.options.history === "replay" && this.conversationId !== null;
    if (!replay) await this.ensureDriver();
    if (replay) this.account = preferredAccount(this.config.model);
    if (!replay && this.lifecycleEnabled()) {
      try {
        const context = await runLifecycle("start", this.options.id, "", "", {force: this.lifecycleEnabled()});
        this.startupContext = context?.context ?? "";
      } catch {
        this.emit({type:"session.notice",sessionId:this.options.id,notice:{
          id:this.options.id+":memory-startup-unavailable",severity:"warning",
          title:"Nowledge startup context unavailable",
          description:"Source-dependent tasks still require per-prompt evidence."}});
      }
    }
    this.emit({
      type: "session.opened",
      requestId,
      sessionId: this.options.id,
      capabilities,
      restoration: "core",
      persistence: this.config.persist ? this.persistence() : undefined,
      cwd: this.config.cwd,
      title: this.config.title,
    });
    if (replay && this.conversationId !== null) {
      try {
        const restored = await recoverAntigravityMessages(this.conversationId);
        for (const item of restored) this.item(item);
        if (restored.length > 0) this.emit({ type: "session.notice", sessionId: this.options.id, notice: {
          id: this.options.id + ":history-restored", severity: "info",
          title: "Antigravity history restored",
          description: String(restored.length) + " user and assistant messages recovered from the native conversation database.",
        } });
      } catch (error) {
        this.emit({ type: "session.notice", sessionId: this.options.id, notice: {
          id: this.options.id + ":history-recovery-error", severity: "warning",
          title: "Native Antigravity history recovery failed",
          description: error instanceof Error ? error.message : String(error),
        } });
      }
    }
    this.publishFullAccessNotice();
    this.emit({ type: "session.notice", sessionId: this.options.id, notice: {
      id: this.options.id + ":account", severity: "info",
      title: "Gemini account " + this.account,
      description: "aswap slot " + (this.account === "A" ? "1" : "2") + " (Windows shared login).",
    } });
    this.publishConfig();
    this.emit({ type: "session.commands", sessionId: this.options.id, commands: [] });
    this.emit({ type: "session.ready", requestId, sessionId: this.options.id });
  }

  async prompt(prompt: ProviderPrompt): Promise<void> {
    if (prompt.delivery === "steer") {
      const { text, nativeText } = await this.promptFiles.encode(prompt);
      const enhanced = await this.preparePrompt(nativeText, prompt.clientMessageId, false);
      if (this.state.type !== "running")
        throw new AntigravityError("Steering requires an active turn", "TURN_NOT_ACTIVE");
      this.steering.enqueue(enhanced);
      this.emit({
        type: "session.prompt_result",
        sessionId: this.options.id,
        clientMessageId: prompt.clientMessageId,
        result: { type: "steer", turnId: this.state.turn.id },
      });
      this.item({ type: "user_message", id: prompt.clientMessageId, clientMessageId: prompt.clientMessageId, text });
      return;
    }
    if (this.state.type === "running")
      throw new AntigravityError(
        "Antigravity already has an active turn; wait for it to finish",
        "TURN_ACTIVE",
      );
    const { text, nativeText } = await this.promptFiles.encode(prompt);
    const enhanced = await this.preparePrompt(nativeText, prompt.clientMessageId, true);
    await this.ensureDriver();
    if (this.state.type !== "idle") throw new AntigravityError("Antigravity session is not ready");
    const driver = this.state.driver;
    const turn: Turn = {
      id: randomUUID(),
      input: enhanced,
      text: new Map(),
      usageSteps: new Set(),
      tools: new Map(),
      usage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 },
    };
    this.state = { type: "running", driver, turn };
    this.steering.beginTurn();
    this.emit({
      type: "session.prompt_result",
      sessionId: this.options.id,
      clientMessageId: prompt.clientMessageId,
      result: { type: "turn", turnId: turn.id },
    });
    this.emit({
      type: "session.turn",
      sessionId: this.options.id,
      turnId: turn.id,
      state: "started",
    });
    this.item({
      type: "user_message",
      id: prompt.clientMessageId,
      clientMessageId: prompt.clientMessageId,
      text,
    });
    const driverText =
      this.firstMessage && this.config.systemPrompt
        ? `${this.config.systemPrompt}\n\n${enhanced}`
        : enhanced;
    try {
      await driver.prompt(driverText);
      this.firstMessage = false;
      this.startupPending = false;
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      this.failTurn(new AntigravityError(error.message));
      await driver.stop("interrupt");
    }
  }

  private recordStop(turnId: string, reason: "completed" | "failed" | "canceled"): void {
    if (!this.lifecycleEnabled() || this.stoppedTurnIds.has(turnId)) return;
    this.stoppedTurnIds.add(turnId);
    const payload = JSON.stringify({native_conversation_id: this.conversationId, reason});
    // Nonblocking for Paseo; Nowledge imports its native Antigravity transcript with
    // session-id based reconciliation. A failed save is logged, never reported as success.
    void runLifecycle("stop", this.options.id, turnId, payload, {
      force: true, timeoutMs: 85_000
    }).catch(() => undefined);
  }

  private async preparePrompt(nativeText: string, promptId: string, withStartup: boolean): Promise<string> {
    if (!this.lifecycleEnabled()) return nativeText;
    let checked;
    try {
      checked = await runLifecycle("prompt", this.options.id, promptId, nativeText, {force: this.lifecycleEnabled()});
    } catch {
      throw new AntigravityError("AI Context source preflight unavailable; no task submitted",
        "AI_CONTEXT_PREFLIGHT_UNAVAILABLE");
    }
    if (checked?.blocked) {
      throw new AntigravityError("Required source evidence missing; no task submitted",
        "AI_CONTEXT_REQUIRED_SOURCE_MISSING");
    }
    const initial = withStartup && this.startupPending ? this.startupContext : "";
    return evidenceEnvelope([initial, checked?.context || ""].filter(Boolean).join("\n\n"), nativeText);
  }

  configure(changes: ProviderConfigChanges): void {
    const config = {
      ...this.config,
      model: changes.model === null ? undefined : (changes.model ?? this.config.model),
      mode: changes.mode === null ? "full-access" : (changes.mode ?? this.config.mode),
      thinkingOption:
        changes.thinkingOption === null
          ? undefined
          : (changes.thinkingOption ?? this.config.thinkingOption),
    };
    if (changes.settings && Object.keys(changes.settings).length > 0)
      throw new AntigravityError("Antigravity has no configurable settings");
    validateSelection(config, this.options.catalog());
    this.config = config;
    this.publishConfig();
  }

  async interrupt(): Promise<void> {
    this.steering.endTurn();
    if (this.state.type !== "running") return;
    const { driver, turn } = this.state;
    this.state = { type: "stopping", driver };
    await driver.stop("interrupt");
    this.finishTools(turn, "canceled");
    this.recordStop(turn.id, "canceled");
    this.emit({
      type: "session.turn",
      sessionId: this.options.id,
      turnId: turn.id,
      state: "canceled",
    });
    this.state = { type: "dormant" };
  }

  async close(): Promise<void> {
    this.steering.endTurn();
    const state = this.state;
    this.state = { type: "closed" };
    try {
      if (state.type !== "dormant" && state.type !== "closed") await state.driver.stop("close");
    } finally {
      await this.promptFiles.close();
      await this.steering.close();
    }
    if (state.type === "running") {
      this.finishTools(state.turn, "canceled");
      this.recordStop(state.turn.id, "canceled");
      this.emit({
        type: "session.turn",
        sessionId: this.options.id,
        turnId: state.turn.id,
        state: "canceled",
      });
    }
  }

  private publishFullAccessNotice(): void {
    this.emit({
      type: "session.notice",
      sessionId: this.options.id,
      notice: {
        id: `${this.options.id}:full-access`,
        severity: "warning",
        title: "Antigravity is running with full access",
        description:
          "Antigravity's CLI cannot ask for permission when another app drives it, so Paseo starts it with --dangerously-skip-permissions. Every tool call, including shell commands, runs without asking.",
      },
    });
  }

  private async ensureDriver(): Promise<void> {
    if (this.state.type === "closed") throw new AntigravityError("Antigravity session is closed");
    if (this.state.type === "stopping") {
      await this.state.driver.stop("interrupt");
      this.state = { type: "dormant" };
    }
    if (this.state.type === "idle" && this.state.driver.selection !== selection(this.config)) {
      const driver = this.state.driver;
      this.state = { type: "stopping", driver };
      await driver.stop("close");
      this.state = { type: "dormant" };
    }
    if (this.state.type !== "dormant") return;
    this.reportedDenials.clear();
    if (this.pendingAccount !== null) {
      await switchAccount(this.pendingAccount);
      this.pendingAccount = null;
    }
    const steeringUrl = await this.steering.start();
    this.account = preferredAccount(this.config.model);
    const driver = startDriver({
      launch: this.options.launch,
      config: {
        ...this.config,
        env: { ...this.config.env, PASEO_AGY_STEERING_URL: steeringUrl, ...accountEnvironment(this.account) },
      },
      conversationId: this.conversationId,
      onFrame: (frame) => this.accept(frame),
      onExit: (error) => this.failTurn(error),
    });
    this.state = { type: "starting", driver };
    try {
      const init = await driver.ready;
      if (this.conversationId !== null && init.conversation_id !== this.conversationId)
        throw new AntigravityError(
          "Antigravity restored a different conversation",
          "INVALID_RESUME",
        );
      this.conversationId = init.conversation_id;
      this.steering.bindConversation(init.conversation_id);
      this.state = { type: "idle", driver };
      if (this.config.persist)
        this.emit({
          type: "session.persistence",
          sessionId: this.options.id,
          persistence: this.persistence(),
        });
    } catch (error) {
      this.state = { type: "dormant" };
      await driver.stop("interrupt");
      throw error;
    }
  }

  private accept(frame: Frame): void {
    if (this.state.type !== "running") return;
    const { turn, driver } = this.state;
    if (frame.event === "step_update") {
      this.acceptStep(frame.step_update, turn);
      return;
    }
    if (frame.event !== "result") return;
    const result = frame.result;
    const denied = takeNewDenials(result.denied_actions, this.reportedDenials);
    if (denied.length > 0) {
      this.emit({
        type: "session.notice",
        sessionId: this.options.id,
        notice: {
          id: `${turn.id}:denied`,
          severity: "warning",
          title: denialNoticeTitle(denied),
          description: "Antigravity's own policy denied it.",
        },
      });
    }
    if (result.status === "ERROR") {
      if (isQuotaFailure(result.error)) {
        const next = afterQuotaExhausted(this.account, this.config.model);
        if (next) {
          this.pendingAccount = next;
          const safeRetry = turn.tools.size === 0 && turn.text.size === 0;
          this.emit({ type: "session.notice", sessionId: this.options.id, notice: {
            id: turn.id + ":quota-switch", severity: "warning",
            title: "Antigravity account " + this.account + " reached its quota",
            description: safeRetry
              ? "Switching to account " + next + " and retrying this turn."
              : "Next turn will use account " + next + "; this turn cannot be replayed safely.",
          } });
          if (safeRetry) {
            this.state = { type: "stopping", driver };
            void (async () => {
              await driver.stop("interrupt");
              if (this.state.type !== "stopping" || this.state.driver !== driver) return;
              this.state = { type: "dormant" };
              await this.ensureDriver();
              const activeState = this.state as State;
              if (activeState.type !== "idle") throw new AntigravityError("Account fallback not ready");
              const replacement = activeState.driver;
              this.state = { type: "running", driver: replacement, turn };
              await replacement.prompt(turn.input);
            })().catch((error: unknown) => {
              const message = error instanceof Error ? error.message : String(error);
              this.finishTools(turn, "failed");
              this.recordStop(turn.id, "failed");
              this.emit({ type: "session.turn", sessionId: this.options.id, turnId: turn.id,
                state: "failed", error: { message: "Account fallback failed: " + message } });
            });
            return;
          }
        }
      }
      const canceled = result.error === "interrupted";
      this.finishTools(turn, canceled ? "canceled" : "failed");
      this.recordStop(turn.id, canceled ? "canceled" : "failed");
      this.retire(driver);
      this.emit({
        type: "session.turn",
        sessionId: this.options.id,
        turnId: turn.id,
        state: canceled ? "canceled" : "failed",
        error: { message: diagnostic(result.error) },
      });
    } else {
      // Input admitted after the final hook still belongs to the active Paseo task.
      const pending = this.steering.take();
      if (pending.length > 0) {
        void driver.prompt(pending.join("\n\n")).catch((error: unknown) => {
          this.failTurn(new AntigravityError(error instanceof Error ? error.message : String(error)));
        });
        return;
      }
      this.steering.endTurn();
      this.finishTools(turn, "completed");
      this.recordStop(turn.id, "completed");
      this.state = { type: "idle", driver };
      this.emit({
        type: "session.turn",
        sessionId: this.options.id,
        turnId: turn.id,
        state: "completed",
      });
    }
  }

  private acceptStep(step: Step, turn: Turn): void {
    const id = `${turn.id}:${step.step_index}`;
    if (step.step_type === "subagent" && !this.observedSubagents.has(id)) {
      this.observedSubagents.add(id);
      // The native child has already started. This is an audit, NOT a pre-start hook.
      void runLifecycle("subagent", this.options.id, turn.id, "", {force: this.lifecycleEnabled()}).catch(() => undefined);
    }
    if (step.step_type === "agent_response") {
      const previous = turn.text.get(step.step_index) || "";
      const text = previous + step.text_delta;
      turn.text.set(step.step_index, text);
      if (step.text_delta) this.item({ type: "assistant_message", id, messageId: id, text });
      if (step.state === "DONE" && step.usage && !turn.usageSteps.has(step.step_index)) {
        turn.usageSteps.add(step.step_index);
        turn.usage.inputTokens += step.usage.input_tokens;
        turn.usage.outputTokens += step.usage.output_tokens;
        turn.usage.cachedInputTokens += step.usage.cache_read_tokens;
        this.emit({
          type: "session.usage",
          sessionId: this.options.id,
          turnId: turn.id,
          usage: { ...turn.usage },
        });
      }
    } else if (step.step_type === "tool" || step.step_type === "subagent") {
      const item = toolItem(step, id);
      turn.tools.set(id, item);
      this.item(item);
    }
  }

  private failTurn(error: AntigravityError): void {
    const state = this.state;
    if (state.type !== "running" && state.type !== "idle") return;
    this.retire(state.driver);
    if (state.type === "running") {
      this.finishTools(state.turn, "failed");
      this.recordStop(state.turn.id, "failed");
      this.emit({
        type: "session.turn",
        sessionId: this.options.id,
        turnId: state.turn.id,
        state: "failed",
        error: { message: error.message, code: error.code },
      });
    } else
      this.emit({
        type: "session.runtime_failed",
        sessionId: this.options.id,
        error: { message: error.message, code: error.code },
      });
  }

  private retire(driver: Driver): void {
    this.steering.endTurn();
    this.state = { type: "stopping", driver };
    void driver.stop("interrupt").then(() => {
      if (this.state.type === "stopping" && this.state.driver === driver)
        this.state = { type: "dormant" };
      return undefined;
    });
  }

  private finishTools(turn: Turn, status: "completed" | "failed" | "canceled"): void {
    for (const item of turn.tools.values()) {
      if (item.status !== "running") continue;
      if (status === "failed") this.item({ ...item, status, error: "Antigravity turn failed" });
      else this.item({ ...item, status, error: null });
    }
  }

  private persistence(): ProviderPersistence {
    if (this.conversationId === null) throw new AntigravityError("Antigravity has no conversation");
    return { version: 1, data: { conversationId: this.conversationId } };
  }

  private publishConfig(): void {
    this.emit({
      type: "session.config",
      sessionId: this.options.id,
      config: {
        model: this.config.model,
        mode: this.config.mode || "full-access",
        models: this.options.catalog().models,
        modes: this.options.catalog().modes,
        thinkingOptions: [],
        settings: [],
      },
    });
  }
  private item(item: ProviderTimelineItem): void {
    this.emit({ type: "timeline.item", sessionId: this.options.id, item });
  }
  private emit(event: ProviderEvent): void {
    this.options.emit(event);
  }
}

// Native results contain every denial since this driver started, including repeated actions.
function takeNewDenials(
  actions: Extract<Frame, { event: "result" }>["result"]["denied_actions"],
  reported: Map<string, number>,
) {
  const counts = new Map<string, number>();
  const fresh = actions.filter((action) => {
    const key = JSON.stringify([action.action, action.display_name]);
    const count = (counts.get(key) ?? 0) + 1;
    counts.set(key, count);
    return count > (reported.get(key) ?? 0);
  });
  for (const [key, count] of counts) reported.set(key, Math.max(count, reported.get(key) ?? 0));
  return fresh;
}

function denialNoticeTitle(
  actions: Extract<Frame, { event: "result" }>["result"]["denied_actions"],
): string {
  if (actions.length > 1) return `${actions.length} actions denied`;
  return actions[0].action === "command" ? "Shell command denied" : "Action denied";
}
