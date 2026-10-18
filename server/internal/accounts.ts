import { execFile, execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { agyEnvironment } from "./proxy.js";

export type AgAccount = "A" | "B";
const execAsync = promisify(execFile);
const cooldown = new Map<string, number>();
// Managed local dependency; Windows credentials stay on this host.
const managedAswap = join(homedir(), "AppData", "Local", "paseo-antigravity-steering", "aswap", ".venv", "Scripts", "aswap.exe");
function aswapBin(): string {
  return process.env.PASEO_ASWAP_BIN || (existsSync(managedAswap) ? managedAswap : "aswap");
}


function aswapJson(command: "status" | "list"): any {
  const stdout = execFileSync(aswapBin(), [command, "--json", ...(command === "list" ? ["--cached"] : [])],
    { encoding: "utf8", windowsHide: true, timeout: 6000 });
  return JSON.parse(stdout);
}

export function activeAccount(): AgAccount {
  if (process.platform !== "win32") return "A";
  try {
    const status = aswapJson("status");
    const n = status.activeAccountNumber ?? status.accountNumber ?? status.active?.number;
    return n === 2 ? "B" : "A";
  } catch { return "A"; }
}

export function availableAccounts(): AgAccount[] {
  if (process.platform !== "win32") return ["A"];
  try {
    const status = aswapJson("list");
    const accounts: any[] = status.accounts ?? [];
    return accounts.filter((a) => !a.disabled && !a.quarantined && (a.number === 1 || a.number === 2))
      .map((a) => a.number === 2 ? "B" as const : "A" as const);
  } catch { return ["A"]; }
}

export function accountEnvironment(_account: AgAccount): NodeJS.ProcessEnv {
  return {}; // Windows agy login is in Credential Manager, not HOME/USERPROFILE.
}

export function preferredAccount(_model = ""): AgAccount {
  return activeAccount();
}

export function afterQuotaExhausted(account: AgAccount, model = ""): AgAccount | null {
  cooldown.set(account + ":" + model, Date.now() + 60 * 60 * 1000);
  const next = account === "A" ? "B" : "A";
  if (!availableAccounts().includes(next)) return null;
  if ((cooldown.get(next + ":" + model) ?? 0) > Date.now()) return null;
  return next;
}

export async function switchAccount(account: AgAccount): Promise<void> {
  if (process.platform !== "win32") throw new Error("aswap switching is only configured on Windows");
  if (!availableAccounts().includes(account)) throw new Error("Requested aswap account is unavailable");
  // aswap serializes Credential Manager writes. Already-running agy processes
  // keep their in-memory login, so the calling Session must stop its own driver
  // before switching; other agents remain on their existing account until restarted.
  const env = agyEnvironment(process.env);
  await execAsync(aswapBin(), ["switch", account === "A" ? "1" : "2", "--no-verify"],
    { env, windowsHide: true, timeout: 15000 });
  if (activeAccount() !== account) throw new Error("aswap did not activate the requested account");
}

export function isQuotaFailure(message: string): boolean {
  return /(?:429|resource[_ .-]?exhausted|quota.{0,45}(?:exceed|exhaust|reach|limit)|(?:reached|exceeded).{0,45}(?:quota|usage limit)|rate[_ -]?limit|too many requests|usage limit.{0,20}(?:reached|exceeded)|capacity exhausted)/i.test(message);
}
