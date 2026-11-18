# helpers for clip scripts
R=./r.sh
SEAT='{"x":-0.3,"y":1.27,"z":-0.5}'
ISLAND='{"x":-0.3,"y":1.05,"z":-1.3}'
recv() { $R '{"op":"received"}'; }
idle() { $R "{\"op\":\"waitIdle\",\"since\":$1,\"timeout\":${2:-150}}"; }
seat() { $R "{\"op\":\"head\",\"pos\":$SEAT,\"target\":$ISLAND,\"dur\":${1:-1.6}}" >/dev/null; }
lookat() { $R "{\"op\":\"head\",\"pos\":${2:-$SEAT},\"target\":$1,\"dur\":${3:-1.6}}" >/dev/null; }
wait_s() { $R "{\"op\":\"wait\",\"s\":$1}" >/dev/null; }
log_since() { $R "{\"op\":\"eval\",\"js\":\"window.__aide.app.received.slice($1).map(m=>m.type==='tool_call'?('TOOL '+m.name+' '+JSON.stringify(m.args).slice(0,220)):(m.type==='say'?'SAY '+m.text:m.type+' '+(m.text??''))).join('\\\\n')\"}"; }
wpos() { $R "{\"op\":\"eval\",\"js\":\"(()=>{const o=$1; if(!o) return null; const v=o.getWorldPosition(o.position.clone()); return {x:+v.x.toFixed(3),y:+v.y.toFixed(3),z:+v.z.toFixed(3)};})()\"}"; }
