#!/bin/sh
. ./lib.sh
W="(v)=>{const p=window.__aide.app.runtime.programs.get('solar-system'); const x=p.scene.localToWorld(p.scene.position.clone().set(...v)); return {x:+x.x.toFixed(4),y:+x.y.toFixed(4),z:+x.z.toFixed(4)};}"
A=$($R "{\"op\":\"eval\",\"js\":\"($W)([0.3,0.28,0.28])\"}"); B=$($R "{\"op\":\"eval\",\"js\":\"($W)([-0.25,0.28,0.32])\"}")
$R "{\"op\":\"hand\",\"side\":\"right\",\"pos\":$A,\"dur\":1.1}" >/dev/null
$R '{"op":"pinch","value":1,"dur":0.1}' >/dev/null
wait_s 0.25
$R '{"op":"mark","kind":"user_action","data":{"action":"pinch empty space and swipe to spin"}}' >/dev/null
$R "{\"op\":\"hand\",\"side\":\"right\",\"pos\":$B,\"dur\":0.55}" >/dev/null
$R '{"op":"eval","js":"window.IWER_DEVICE.hands.right.setPinchValueImmediate(0)"}' >/dev/null
wait_s 4
# pinch Earth to pause it and show its name
E=$($R "{\"op\":\"eval\",\"js\":\"(()=>{const p=window.__aide.app.runtime.programs.get('solar-system'); const o=[...p.spawned].find(o=>o.userData.kind==='ball'&&o.material.color.getHexString()==='3a8de0'); const v=o.getWorldPosition(o.position.clone()); return {x:+v.x.toFixed(4),y:+(v.y+0.004).toFixed(4),z:+v.z.toFixed(4)};})()\"}")
AB=$(echo $E | python3 -c "import json,sys;d=json.load(sys.stdin);d['y']+=0.08;d['z']+=0.05;print(json.dumps(d))")
$R "{\"op\":\"hand\",\"side\":\"right\",\"pos\":$AB,\"dur\":0.9}" >/dev/null
E=$($R "{\"op\":\"eval\",\"js\":\"(()=>{const p=window.__aide.app.runtime.programs.get('solar-system'); const o=[...p.spawned].find(o=>o.userData.kind==='ball'&&o.material.color.getHexString()==='3a8de0'); const v=o.getWorldPosition(o.position.clone()); return {x:+v.x.toFixed(4),y:+(v.y+0.004).toFixed(4),z:+v.z.toFixed(4)};})()\"}")
$R "{\"op\":\"hand\",\"side\":\"right\",\"pos\":$E,\"dur\":0.3}" >/dev/null
$R '{"op":"mark","kind":"user_action","data":{"action":"pinch Earth"}}' >/dev/null
$R '{"op":"pinch","value":1,"dur":0.1}' >/dev/null
wait_s 0.5
$R '{"op":"pinch","value":0,"dur":0.1}' >/dev/null
$R "{\"op\":\"hand\",\"side\":\"right\",\"pos\":$AB,\"dur\":0.8}" >/dev/null
