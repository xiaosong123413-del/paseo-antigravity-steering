import { execFileSync } from "node:child_process";

let cached: string | null | undefined;

export function windowsProxy(): string | null {
  if (process.platform !== "win32") return null;
  if (cached !== undefined) return cached;
  cached = null;
  try {
    const registryKey = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings";
    const enabled = execFileSync("reg", ["query", registryKey, "/v", "ProxyEnable"], { encoding: "utf8", timeout: 1500 });
    if (!enabled.includes("0x1")) return null;
    const entry = execFileSync("reg", ["query", registryKey, "/v", "ProxyServer"], { encoding: "utf8", timeout: 1500 });
    const record = entry.split("\n").find(line => line.includes("ProxyServer") && line.includes("REG_SZ"));
    let address = record?.split("REG_SZ")[1]?.trim() ?? "";
    if (address.includes(";")) {
      address = address.split(";").find(x => x.trim().startsWith("https="))?.trim().slice(6) ?? "";
    }
    address = address.replace("http://", "");
    const allowedHost = address.startsWith("127.0.0.1:") || address.startsWith("localhost:");
    const port = Number(address.split(":")[1]);
    if (allowedHost && Number.isInteger(port) && port > 0 && port < 65536) cached = "http://" + address;
  } catch { /* Keep the unmodified CLI environment if Windows settings are inaccessible. */ }
  return cached;
}

export function agyEnvironment(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  if (env.HTTPS_PROXY || env.https_proxy || env.ALL_PROXY || env.all_proxy) return env;
  const proxy = env.PASEO_AGY_PROXY || windowsProxy();
  if (!proxy) return env;
  env.HTTPS_PROXY = proxy;
  env.HTTP_PROXY ||= proxy;
  const local = "localhost,127.0.0.1,::1";
  env.NO_PROXY = env.NO_PROXY ? env.NO_PROXY + "," + local : local;
  return env;
}
