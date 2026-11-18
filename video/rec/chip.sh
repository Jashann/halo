#!/bin/sh
# Poke chip N (0-based) with the right hand while glancing at the chip bar, then look back at the island.
R=./r.sh
I=$1
P=$($R "{\"op\":\"eval\",\"js\":\"(()=>{const c=window.__aide.app.chips; const el=c.doc.getElementById('chip-$I'); return el.getWorldPosition(c.holder.position.clone()).toArray();})()\"}")
X=$(echo $P | python3 -c "import json,sys;print(json.load(sys.stdin)[0])"); Y=$(echo $P | python3 -c "import json,sys;print(json.load(sys.stdin)[1])"); Z=$(echo $P | python3 -c "import json,sys;print(json.load(sys.stdin)[2])")
$R "{\"op\":\"head\",\"pos\":{\"x\":-0.31,\"y\":1.27,\"z\":-0.5},\"target\":{\"x\":$X,\"y\":$Y,\"z\":$Z},\"dur\":1.4}" >/dev/null
$R "{\"op\":\"hand\",\"side\":\"right\",\"pos\":{\"x\":$(python3 -c "print($X+0.05)"),\"y\":$(python3 -c "print($Y+0.08)"),\"z\":$(python3 -c "print($Z+0.06)")},\"dur\":0.9}" >/dev/null
$R "{\"op\":\"hand\",\"side\":\"right\",\"pos\":{\"x\":$X,\"y\":$(python3 -c "print($Y+0.01)"),\"z\":$Z},\"dur\":0.4}" >/dev/null
$R "{\"op\":\"mark\",\"kind\":\"user_action\",\"data\":{\"action\":\"pokes chip $I\"}}" >/dev/null
$R "{\"op\":\"eval\",\"js\":\"window.__aide.app.chips.press($I)\"}"
$R "{\"op\":\"hand\",\"side\":\"right\",\"pos\":{\"x\":$(python3 -c "print($X+0.15)"),\"y\":$(python3 -c "print($Y-0.05)"),\"z\":$(python3 -c "print($Z+0.15)")},\"dur\":0.8}" >/dev/null
$R '{"op":"head","pos":{"x":-0.3,"y":1.27,"z":-0.5},"target":{"x":-0.3,"y":1.07,"z":-1.3},"dur":1.6}' >/dev/null
