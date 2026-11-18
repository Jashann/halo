#!/bin/sh
# One putt in the generated golf game: reach the ball, pinch, draw back, flick toward the hole, release mid-flick.
# usage: putt.sh <program id> <hole local x> <hole local z> <flick distance m> <flick seconds>
. ./lib.sh
P=$1; HX=$2; HZ=$3; D=${4:-0.16}; S=${5:-0.3}
G=$($R "{\"op\":\"eval\",\"js\":\"(()=>{const p=window.__aide.app.runtime.programs.get('$P'); const b=[...p.spawned].find(o=>o.userData.kind==='ball'); const T=b.position.clone(); const hole=T.clone().set($HX,b.position.y,$HZ); const dir=hole.clone().sub(b.position).setY(0).normalize(); const w=(v)=>{const x=p.scene.localToWorld(v.clone()); return {x:+x.x.toFixed(4),y:+x.y.toFixed(4),z:+x.z.toFixed(4)};}; const at=b.position.clone(); at.y+=0.012; return {ball:w(at), back:w(at.clone().addScaledVector(dir,-0.05)), fwd:w(at.clone().addScaledVector(dir,-0.05+$D)), hole:w(hole)};})()\"}")
echo "$G"
BALL=$(echo $G | python3 -c "import json,sys;print(json.dumps(json.load(sys.stdin)['ball']))")
BACK=$(echo $G | python3 -c "import json,sys;print(json.dumps(json.load(sys.stdin)['back']))")
FWD=$(echo $G | python3 -c "import json,sys;print(json.dumps(json.load(sys.stdin)['fwd']))")
ABOVE=$(echo $G | python3 -c "import json,sys;d=json.load(sys.stdin)['ball'];d['y']+=0.08;d['z']+=0.05;print(json.dumps(d))")
$R "{\"op\":\"hand\",\"side\":\"right\",\"pos\":$ABOVE,\"dur\":1.0}" >/dev/null
$R "{\"op\":\"hand\",\"side\":\"right\",\"pos\":$BALL,\"dur\":0.6}" >/dev/null
$R '{"op":"pinch","value":1,"dur":0.12}' >/dev/null
wait_s 0.4
$R "{\"op\":\"hand\",\"side\":\"right\",\"pos\":$BACK,\"dur\":0.7}" >/dev/null
wait_s 0.3
$R '{"op":"mark","kind":"user_action","data":{"action":"flick putt"}}' >/dev/null
$R "{\"op\":\"eval\",\"js\":\"(()=>{const d=window.IWER_DEVICE; d.remote.dispatch('animate_to',{device:'hand-right',position:$FWD,anchor:'index-tip',duration:$S,easing:'minimum-jerk'}); return new Promise(r=>setTimeout(()=>{d.hands.right.setPinchValueImmediate(0); r(true);}, $S*1000*0.45));})()\"}" >/dev/null
wait_s 0.6
$R "{\"op\":\"hand\",\"side\":\"right\",\"pos\":$ABOVE,\"dur\":0.8}" >/dev/null
