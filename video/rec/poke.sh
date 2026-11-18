#!/bin/sh
# Poke a spawned box of the running program with the right index finger: hover above, press down to its top, lift.
# usage: poke.sh <program id> <js predicate on o (spawned object)>
. ./lib.sh
P=$1; PRED=$2
B=$($R "{\"op\":\"eval\",\"js\":\"(()=>{const p=window.__aide.app.runtime.programs.get('$P'); const o=[...p.spawned].find(o=>$PRED); if(!o) return null; const top=o.position.clone(); top.y+=o.scale.y/2+0.004; const w=p.scene.localToWorld(top); return {x:+w.x.toFixed(4),y:+w.y.toFixed(4),z:+w.z.toFixed(4)};})()\"}")
echo "poke $B"
[ "$B" = "null" ] && exit 1
UP=$(echo $B | python3 -c "import json,sys;d=json.load(sys.stdin);d['y']+=0.09;d['z']+=0.04;print(json.dumps(d))")
$R "{\"op\":\"hand\",\"side\":\"right\",\"pos\":$UP,\"dur\":0.9}" >/dev/null
$R '{"op":"mark","kind":"user_action","data":{"action":"poke"}}' >/dev/null
$R "{\"op\":\"hand\",\"side\":\"right\",\"pos\":$B,\"dur\":0.3}" >/dev/null
$R "{\"op\":\"hand\",\"side\":\"right\",\"pos\":$UP,\"dur\":0.3}" >/dev/null
