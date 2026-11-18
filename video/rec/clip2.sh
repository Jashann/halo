#!/bin/sh
. ./lib.sh
$R "{\"op\":\"open\",\"url\":\"http://localhost:8788/?demo=1&user=cook-$(date +%s)\"}" >/dev/null
$R '{"op":"clickStart"}' >/dev/null
seat 0.1
idle 0 60 >/dev/null
wait_s 1.5
$R '{"op":"startClip","name":"02_cook"}' >/dev/null
wait_s 1.5
N=$(recv); $R '{"op":"say","text":"What can I cook?"}' >/dev/null; idle $N; log_since $N
wait_s 2.5
N=$(recv); ./chip.sh 0 >/dev/null; idle $N; log_since $N
wait_s 2.5
N=$(recv); $R '{"op":"say","text":"Show me the cut"}' >/dev/null; idle $N; log_since $N
G=$(wpos "window.__aide.app.ghost.active && window.__aide.app.ghost.group"); echo "ghost $G"
if [ "$G" != "null" ]; then
  GX=$(echo $G | python3 -c "import json,sys;d=json.load(sys.stdin);print(json.dumps({'x':d['x'],'y':d['y']+0.06,'z':d['z']}))")
  NEAR=$(echo $G | python3 -c "import json,sys;d=json.load(sys.stdin);s={'x':-0.3,'y':1.27,'z':-0.5};print(json.dumps({'x':s['x']+(d['x']-s['x'])*0.35,'y':1.2,'z':s['z']+(d['z']-s['z'])*0.35}))")
  lookat "$GX" "$SEAT" 1.8
  wait_s 1
  $R '{"op":"mark","kind":"hero","data":{"shot":"ghost hands push-in"}}' >/dev/null
  lookat "$GX" "$NEAR" 3.5
  wait_s 4.5
  lookat "$GX" "$SEAT" 2.5
fi
# ask for the timer: poke the chip that mentions a timer if there is one, else say it
TI=$($R '{"op":"eval","js":"window.__aide.app.chips.chips.findIndex(c=>/timer/i.test(c.label))"}')
N=$(recv); if [ "$TI" -ge 0 ]; then ./chip.sh $TI >/dev/null; else $R '{"op":"say","text":"Set a timer for the veggies"}' >/dev/null; fi; idle $N; log_since $N
T=$(wpos "[...window.__aide.app.timers.items.values()][0]?.group"); echo "timer $T"
if [ "$T" != "null" ]; then lookat "$T" "$SEAT" 1.8; wait_s 2.5; fi
seat 1.6
$R '{"op":"eval","js":"window.__halo_set_camera(\"samples/pan.jpg\")"}' >/dev/null
N=$(recv); $R '{"op":"say","text":"Take a look at my pan. Is it done?"}' >/dev/null; idle $N; log_since $N
wait_s 3
$R '{"op":"stopClip"}'
