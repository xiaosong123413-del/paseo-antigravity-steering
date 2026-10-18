import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { promisify } from "node:util";
import type { ProviderTimelineItem } from "@getpaseo/plugin/server/provider";

const execAsync = promisify(execFile);
const inlineReplayScript = "\"\"\"Read-only reconstruction of user/assistant messages from Antigravity CLI SQLite trajectory.\"\"\"\nimport argparse, json, sqlite3, pathlib, sys\n\ndef varint(buf, i):\n    val = 0\n    for n in range(10):\n        if i >= len(buf): raise ValueError(\"truncated varint\")\n        c = buf[i]; i += 1; val |= (c & 127) << (7*n)\n        if c < 128: return val,i\n    raise ValueError(\"invalid varint\")\n\ndef fields(buf):\n    i = 0\n    while i < len(buf):\n        tag,i = varint(buf,i)\n        field, wire = tag >> 3,tag & 7\n        if not field: break\n        if wire == 0:\n            value,i = varint(buf,i)\n        elif wire == 1:\n            value = buf[i:i+8]; i += 8\n        elif wire == 5:\n            value = buf[i:i+4]; i += 4\n        elif wire == 2:\n            size,i = varint(buf,i)\n            if size > len(buf)-i or size < 0: break\n            value = buf[i:i+size]; i += size\n        else: break\n        yield field,wire,value\n\ndef response_text(raw,kind):\n    outer,preferred = (19,(2,)) if kind==\"user\" else (20,(1,8))\n    for f,w,child in fields(raw):\n        if f != outer or w != 2: continue\n        inner=dict((key,value) for key,wire,value in fields(child) if wire==2)\n        for key in preferred:\n            val=inner.get(key)\n            if not val:continue\n            try: text=val.decode(\"utf-8\")\n            except UnicodeDecodeError: continue\n            if text.strip():return text\n    return None\n\ndef reconstruct(db):\n    items=[]\n    active=None\n    conn=sqlite3.connect(\"file:\"+pathlib.Path(db).as_posix()+\"?mode=ro\",uri=True)\n    try:\n        for idx,typ,raw in conn.execute(\"SELECT idx,step_type,step_payload FROM steps WHERE step_type IN (14,15) ORDER BY idx\"):\n            if not raw: continue\n            try: msg=response_text(raw,\"user\" if typ==14 else \"assistant\")\n            except ValueError: continue\n            if not msg:continue\n            if typ==14:\n                if active:items.extend(active)\n                active=[{\"type\":\"user_message\",\"id\":\"agy-history-user-\"+str(idx),\"text\":msg}]\n            elif active is not None:\n                item={\"type\":\"assistant_message\",\"id\":\"agy-history-assistant-\"+str(idx),\"text\":msg}\n                if len(active)>1:active[1]=item\n                else:active.append(item)\n        if active:items.extend(active)\n    finally:conn.close()\n    return items\n\ndef main():\n    ap=argparse.ArgumentParser()\n    ap.add_argument(\"--db\",required=True)\n    ap.add_argument(\"--output\")\n    ap.add_argument(\"--max-items\",type=int,default=500)\n    args=ap.parse_args()\n    entries=reconstruct(args.db)\n    if args.max_items>0:entries=entries[-args.max_items:]\n    if args.output:\n        dest=pathlib.Path(args.output);dest.parent.mkdir(parents=True,exist_ok=True)\n        with dest.open(\"w\",encoding=\"utf8\") as out:\n            for item in entries:out.write(json.dumps(item,ensure_ascii=False)+\"\\n\")\n    else:\n        for item in entries:print(json.dumps(item,ensure_ascii=False))\n    print(\"RECONSTRUCTED\",len(entries),\"users\",sum(i[\"type\"]==\"user_message\" for i in entries),\"assistants\",sum(i[\"type\"]==\"assistant_message\" for i in entries),file=sys.stderr)\n\nif __name__==\"__main__\":main()\n";
export async function recoverAntigravityMessages(id: string): Promise<ProviderTimelineItem[]> {
  if (!/^[a-f0-9-]{36}$/i.test(id)) return [];
  const db = join(homedir(), ".gemini", "antigravity-cli", "conversations", id + ".db");
  if (!existsSync(db)) return [];
  const { stdout } = await execAsync("python", ["-c", inlineReplayScript, "--db", db, "--max-items", "800"], {
    windowsHide: true, timeout: 25000, maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, PYTHONIOENCODING: "utf-8" },
  });
  return stdout.split(/\r?\n/).filter(Boolean).map((line) => {
    const obj: unknown = JSON.parse(line);
    if (typeof obj !== "object" || obj === null || !("id" in obj) || typeof obj.id !== "string" ||
      !("type" in obj) || (obj.type !== "user_message" && obj.type !== "assistant_message") ||
      !("text" in obj) || typeof obj.text !== "string") throw new Error("Invalid Antigravity history");
    return { type: obj.type, id: obj.id, text: obj.text } as ProviderTimelineItem;
  });
}
