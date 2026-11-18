#!/bin/sh
. ./lib.sh
$R "{\"op\":\"open\",\"url\":\"http://localhost:8788/?demo=1&user=engine-$(date +%s)\"}" >/dev/null
$R '{"op":"clickStart"}' >/dev/null
seat 0.1
idle 0 60 >/dev/null
wait_s 1.5
$R '{"op":"startClip","name":"04_explain"}' >/dev/null
wait_s 1.5
N=$(recv); $R '{"op":"say","text":"Explain how an engine works"}' >/dev/null; idle $N 240; log_since $N | cut -c1-700
$R '{"op":"eval","js":"(()=>{const a=window.__aide.app; const m=a.received.filter(x=>x.type===\"tool_call\"&&x.name===\"run_code\").pop(); return m ? m.args.id + \"\\n\" + m.args.js : \"none\";})()"}' | python3 -c "import json,sys;print(json.loads(sys.stdin.read()))" > /tmp/aideprobe/engine_gen2.js
$R '{"op":"shot","path":"/tmp/aideprobe/c4b.png"}' >/dev/null
