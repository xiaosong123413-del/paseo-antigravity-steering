"""Read-only reconstruction of user/assistant messages from Antigravity CLI SQLite trajectory."""
import argparse, json, sqlite3, pathlib, sys

def varint(buf, i):
    val = 0
    for n in range(10):
        if i >= len(buf): raise ValueError("truncated varint")
        c = buf[i]; i += 1; val |= (c & 127) << (7*n)
        if c < 128: return val,i
    raise ValueError("invalid varint")

def fields(buf):
    i = 0
    while i < len(buf):
        tag,i = varint(buf,i)
        field, wire = tag >> 3,tag & 7
        if not field: break
        if wire == 0:
            value,i = varint(buf,i)
        elif wire == 1:
            value = buf[i:i+8]; i += 8
        elif wire == 5:
            value = buf[i:i+4]; i += 4
        elif wire == 2:
            size,i = varint(buf,i)
            if size > len(buf)-i or size < 0: break
            value = buf[i:i+size]; i += size
        else: break
        yield field,wire,value

def response_text(raw,kind):
    outer,preferred = (19,(2,)) if kind=="user" else (20,(1,8))
    for f,w,child in fields(raw):
        if f != outer or w != 2: continue
        inner=dict((key,value) for key,wire,value in fields(child) if wire==2)
        for key in preferred:
            val=inner.get(key)
            if not val:continue
            try: text=val.decode("utf-8")
            except UnicodeDecodeError: continue
            if text.strip():return text
    return None

def reconstruct(db):
    items=[]
    active=None
    conn=sqlite3.connect("file:"+pathlib.Path(db).as_posix()+"?mode=ro",uri=True)
    try:
        for idx,typ,raw in conn.execute("SELECT idx,step_type,step_payload FROM steps WHERE step_type IN (14,15) ORDER BY idx"):
            if not raw: continue
            try: msg=response_text(raw,"user" if typ==14 else "assistant")
            except ValueError: continue
            if not msg:continue
            if typ==14:
                if active:items.extend(active)
                active=[{"type":"user_message","id":"agy-history-user-"+str(idx),"text":msg}]
            elif active is not None:
                item={"type":"assistant_message","id":"agy-history-assistant-"+str(idx),"text":msg}
                if len(active)>1:active[1]=item
                else:active.append(item)
        if active:items.extend(active)
    finally:conn.close()
    return items

def main():
    ap=argparse.ArgumentParser()
    ap.add_argument("--db",required=True)
    ap.add_argument("--output")
    ap.add_argument("--max-items",type=int,default=500)
    args=ap.parse_args()
    entries=reconstruct(args.db)
    if args.max_items>0:entries=entries[-args.max_items:]
    if args.output:
        dest=pathlib.Path(args.output);dest.parent.mkdir(parents=True,exist_ok=True)
        with dest.open("w",encoding="utf8") as out:
            for item in entries:out.write(json.dumps(item,ensure_ascii=False)+"\n")
    else:
        for item in entries:print(json.dumps(item,ensure_ascii=False))
    print("RECONSTRUCTED",len(entries),"users",sum(i["type"]=="user_message" for i in entries),"assistants",sum(i["type"]=="assistant_message" for i in entries),file=sys.stderr)

if __name__=="__main__":main()
