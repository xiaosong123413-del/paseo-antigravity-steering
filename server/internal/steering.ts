import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { z } from "zod";

const hookInput = z.object({ conversationId: z.string().min(1) });

export class SteeringBridge {
  private server: Server | null = null;
  private url: string | null = null;
  private readonly capability = randomBytes(24).toString("hex");
  private conversationId: string | null = null;
  private active = false;
  private pending: string[] = [];

  async start(): Promise<string> {
    if (this.url) return this.url;
    const server = createServer((request, response) => {
      void this.handle(request, response).catch(() => {
        if (!response.headersSent) response.writeHead(400);
        response.end("{}");
      });
    });
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
      });
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Steering bridge did not bind");
    this.url = `http://127.0.0.1:${address.port}/${this.capability}`;
    return this.url;
  }

  bindConversation(id: string): void {
    this.conversationId = id;
  }

  beginTurn(): void {
    this.pending = [];
    this.active = true;
  }

  enqueue(message: string): void {
    if (!this.active) throw new Error("Steering requires an active turn");
    this.pending.push(message);
  }

  take(): string[] {
    if (!this.active) return [];
    const messages = this.pending;
    this.pending = [];
    return messages;
  }

  endTurn(): void {
    this.active = false;
    this.pending = [];
  }

  async close(): Promise<void> {
    this.endTurn();
    const server = this.server;
    this.server = null;
    this.url = null;
    if (!server) return;
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
      server.closeAllConnections();
    });
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const stage = request.url === `/${this.capability}/pre` ? "pre"
      : request.url === `/${this.capability}/post` ? "post" : null;
    if (request.method !== "POST" || stage === null) {
      response.writeHead(404).end();
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of request) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      size += buffer.length;
      if (size > 4096) {
        response.writeHead(413).end();
        return;
      }
      chunks.push(buffer);
    }
    const input: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    const parsed = hookInput.safeParse(input);
    if (!parsed.success) {
      response.writeHead(400).end();
      return;
    }
    const messages = parsed.data.conversationId === this.conversationId ? this.take() : [];
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify(messages.length === 0 ? {} : {
      injectSteps: messages.map((userMessage) => ({ userMessage })),
      ...(stage === "post" ? { terminationBehavior: "force_continue" } : {}),
    }));
  }
}
