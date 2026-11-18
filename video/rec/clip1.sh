#!/bin/sh
# Clip 1: Start page -> mixed reality -> onboarding card -> Halo's greeting and suggestion chips.
R=./r.sh
$R '{"op":"startClip","name":"01_start"}'
$R '{"op":"wait","s":3.5}'
$R '{"op":"clickStart"}'
$R '{"op":"head","pos":{"x":-0.3,"y":1.3,"z":-0.36},"target":{"x":-0.3,"y":1.08,"z":-1.3}}'
$R '{"op":"wait","s":1.2}'
$R '{"op":"head","pos":{"x":-0.3,"y":1.27,"z":-0.5},"target":{"x":-0.3,"y":1.07,"z":-1.3},"dur":5}'
$R '{"op":"waitIdle","since":0,"timeout":60}'
$R '{"op":"wait","s":1.5}'
# poke "Got it" with the right index finger (the card closes on contact)
B=$($R '{"op":"eval","js":"(()=>{const r=window.__aide.app.panels.recs.get(\"__onboarding\"); if(!r) return null; const v=r.doc.getElementById(\"btn-ok\").getWorldPosition(r.holder.position.clone()); return v.toArray();})()"}')
echo "button $B"
X=$(echo $B | python3 -c "import json,sys;print(json.load(sys.stdin)[0])"); Y=$(echo $B | python3 -c "import json,sys;print(json.load(sys.stdin)[1])"); Z=$(echo $B | python3 -c "import json,sys;print(json.load(sys.stdin)[2])")
$R "{\"op\":\"hand\",\"side\":\"right\",\"pos\":{\"x\":$X,\"y\":$(python3 -c "print($Y-0.01)"),\"z\":$(python3 -c "print($Z+0.12)")},\"dur\":1.3}"
$R "{\"op\":\"hand\",\"side\":\"right\",\"pos\":{\"x\":$X,\"y\":$Y,\"z\":$(python3 -c "print($Z+0.005)")},\"dur\":0.45}"
$R '{"op":"mark","kind":"user_action","data":{"action":"pokes Got it"}}'
$R '{"op":"eval","js":"window.__aide.app.panels.press(\"__onboarding\",\"ok\",\"Got it\")"}'
$R "{\"op\":\"hand\",\"side\":\"right\",\"pos\":{\"x\":$(python3 -c "print($X+0.08)"),\"y\":$(python3 -c "print($Y-0.18)"),\"z\":$(python3 -c "print($Z+0.25)")},\"dur\":1.2}"
# glance down-left at the suggestion chips, then back
$R '{"op":"head","pos":{"x":-0.32,"y":1.27,"z":-0.5},"target":{"x":-0.62,"y":0.85,"z":-0.95},"dur":2.2}'
$R '{"op":"wait","s":1.5}'
$R '{"op":"head","pos":{"x":-0.3,"y":1.27,"z":-0.5},"target":{"x":-0.3,"y":1.07,"z":-1.3},"dur":2}'
$R '{"op":"wait","s":1}'
$R '{"op":"stopClip"}'
