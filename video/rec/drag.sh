#!/bin/sh
# Drag a spawned object of program $1 (index $2 among objects matching JS predicate $3) to local point $4 ("x,y,z").
. ./lib.sh
P=$1; I=$2; PRED=$3; TO=$4
G=$($R "{\"op\":\"eval\",\"js\":\"(()=>{const p=window.__aide.app.runtime.programs.get('$P'); const o=[...p.spawned].filter(o=>$PRED)[$I]; const top=o.position.clone(); top.y+=o.scale.y/2+0.006; const w=(v)=>{const x=p.scene.localToWorld(v.clone()); return {x:+x.x.toFixed(4),y:+x.y.toFixed(4),z:+x.z.toFixed(4)};}; const t=top.clone().set($TO); const mid=top.clone().lerp(t,0.5); mid.y+=0.07; return {from:w(top), mid:w(mid), to:w(t)};})()\"}")
echo "$G"
F=$(echo $G | python3 -c "import json,sys;print(json.dumps(json.load(sys.stdin)['from']))")
M=$(echo $G | python3 -c "import json,sys;print(json.dumps(json.load(sys.stdin)['mid']))")
T=$(echo $G | python3 -c "import json,sys;print(json.dumps(json.load(sys.stdin)['to']))")
A=$(echo $G | python3 -c "import json,sys;d=json.load(sys.stdin)['from'];d['y']+=0.08;d['z']+=0.04;print(json.dumps(d))")
$R "{\"op\":\"hand\",\"side\":\"right\",\"pos\":$A,\"dur\":1.0}" >/dev/null
$R "{\"op\":\"hand\",\"side\":\"right\",\"pos\":$F,\"dur\":0.5}" >/dev/null
$R '{"op":"pinch","value":1,"dur":0.12}' >/dev/null
wait_s 0.35
$R "{\"op\":\"hand\",\"side\":\"right\",\"pos\":$M,\"dur\":0.8}" >/dev/null
$R "{\"op\":\"hand\",\"side\":\"right\",\"pos\":$T,\"dur\":0.8}" >/dev/null
wait_s 0.3
$R '{"op":"pinch","value":0,"dur":0.12}' >/dev/null
wait_s 0.4
U=$(echo $T | python3 -c "import json,sys;d=json.load(sys.stdin);d['y']+=0.1;d['z']+=0.08;print(json.dumps(d))")
$R "{\"op\":\"hand\",\"side\":\"right\",\"pos\":$U,\"dur\":0.8}" >/dev/null
