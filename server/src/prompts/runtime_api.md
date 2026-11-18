# The `aide` runtime API (version 1)

A program is the BODY of a function. It runs as `new Function("aide", src)(aide)` inside the headset, in a sandbox.
Only the `aide` object is available: no `fetch`, no DOM (`document`, `window`), no storage, no `import`, no `eval`,
no timers (`setTimeout`/`setInterval`: use `aide.onFrame`). If the program throws, or a frame callback takes more than
its budget (about 4 ms per frame), the runtime stops it and reports the error.

## Coordinates
- Units are metres and seconds. `+y` is up. `+z` points toward the user, `-z` away from them, `+x` to the user's right.
- `aide.scene` is a `THREE.Group` owned by the program, placed at the spot the agent chose (`at`). When `at` is a
  table, the group origin sits ON the table top, so `y = 0` is the table surface. Everything you add goes in
  `aide.scene`. All positions from `aide.hands` and `aide.surfaces` are already in `aide.scene` local coordinates.
- Arrays `[x, y, z]` and `THREE.Vector3` are both accepted wherever a position is asked for.
- The user is seated. Keep everything within 0.6 m of the origin and above `y = -0.05`. Tables are small:
  assume a usable area of about 0.8 m x 0.5 m unless `aide.surfaces` says otherwise.

## Reference

### `aide.THREE`
The three.js module (r17x). Use `new aide.THREE.Mesh(...)`, `aide.THREE.Vector3`, `MeshStandardMaterial`, etc.

### `aide.scene: THREE.Group`
Add your objects here (`aide.scene.add(mesh)`). Removed automatically when the program stops.

### `aide.hands: { left: Hand, right: Hand }`
```
Hand = {
  visible: boolean,           // tracked this frame
  pinching: boolean,          // thumb and index touching
  pinchStrength: number,      // 0..1
  pinchPoint: THREE.Vector3,  // midpoint of thumb tip and index tip
  velocity: THREE.Vector3,    // index fingertip velocity, m/s
  joints: { wrist, palm, thumbTip, indexTip, middleTip, ringTip, pinkyTip }  // THREE.Vector3 each
}
```
The objects are updated in place every frame: read them inside `aide.onFrame`, and `clone()` a vector to keep it.

### `aide.surfaces: Surface[]`
```
Surface = { id: string, label: string,            // "table", "desk", "counter", "wall", "floor", ...
            center: THREE.Vector3, top: number,   // top = y of the surface in scene coordinates
            size: { x: number, z: number } }      // extent in metres
```
The surface the program was placed on (if any) is `aide.surfaces.find(s => s.id === aide.anchorSurfaceId)`.
Tables, desks, counters and the floor are static colliders for `aide.physics`.

### `aide.anchorSurfaceId: string | null`

### `aide.onFrame(fn: (dt: number, t: number) => void): () => void`
Called every frame. `dt` = seconds since last frame (clamped to 0.05), `t` = seconds since start. Returns an
unsubscribe function. Do not allocate new objects every frame if you can avoid it.

### `aide.onPinch(fn: (e: { hand: "left"|"right", point: THREE.Vector3, object: THREE.Object3D|null }) => void): () => void`
Called once when a pinch starts. `object` is the nearest object made by `aide.spawn` (or registered with
`aide.physics.add`) within 8 cm of the pinch point, or `null`. To know when the pinch ends, watch
`aide.hands[e.hand].pinching` in `onFrame`. Poking: compare `aide.hands.right.joints.indexTip` to an object's
position in `onFrame`.

### `aide.physics`
Simple built-in rigid body physics for spheres and boxes, with gravity (-9.81 m/s^2) and the static surfaces.
- `aide.physics.add(obj, { shape: "sphere"|"box", radius?, size?: [x,y,z], mass = 1, bounce = 0.4, friction = 0.4, isStatic = false }) -> Body`
- `aide.physics.remove(obj)`
- `aide.physics.onCollide(obj, fn: (other: THREE.Object3D | "surface") => void)`
- `Body = { velocity: THREE.Vector3, angularVelocity: THREE.Vector3, isStatic: boolean, sleeping: boolean }`,
  also available as `obj.body`. Set `obj.body.velocity` to throw or putt. Setting `obj.position` teleports.

### `aide.spawn(kind, opts) -> THREE.Object3D`
Creates a ready-made object, adds it to `aide.scene` and returns it. Every spawned object has `.remove()`.
Common opts: `position`, `color` (CSS string), `physics` (`true` or physics opts as above).
- `"ball"`: `{ radius = 0.03 }`. A sphere. With `physics` it rolls and bounces.
- `"box"`: `{ size = [0.1, 0.1, 0.1] }`.
- `"cup"`: `{ radius = 0.05, height = 0.07 }`. An open cup standing on its base at `position`, static collider
  walls. Extra: `cup.contains(point) -> boolean` (true when the point is inside the cup below the rim).
- `"target"`: `{ radius = 0.06 }`. A flat ring target facing +z. Extra: `target.hitTest(point, margin = 0) -> boolean`.
- `"label"`: `{ text, size = 0.03 }` (`size` = text height in metres; >= 0.025 for readability). Always faces the
  user. Extra: `label.setText(text)`.
- `"arrow"`: `{ from, to }`. Extra: `arrow.setEnds(from, to)`.
- `"line"`: `{ points: [p0, p1, ...], width = 0.004 }`. Extra: `line.setPoints(points)`.
- `"burst"`: `{ count = 24 }`. A short particle burst at `position`; removes itself.

### `aide.panel(spec) -> { update(spec), close() }`
A small floating panel next to the program. `spec = { title, text?, bullets?, buttons?: [{id, label}], position? }`.
Button presses call `spec.onButton(id)` if given.

### `aide.score(n: number)`
Report the current score (shown on a score chip and sent to the agent as event `game_score`).

### `aide.say(text: string)`
Show a short speech line from the agent (one sentence, under ~15 words).

### `aide.emit(name: string, data: object)`
Send a custom event to the agent (arrives as `[event] name: data`). Use it for things the agent must react to, for
example `aide.emit('task_moved', { task: 'Newsletter', to: 'Sales', from: 'Marketing' })`. At most a few per
minute: never call it every frame.

### `aide.time() -> number`
Seconds since the program started.

### `aide.sound.pop() / .score() / .chime() / .tick()`
Short built-in sound effects.

### `aide.done(summary?: string)`
End the program (game over, explanation finished). The summary goes back to the agent as event `code_done`.
The objects stay visible until the agent stops the program, so the user can look at a final score.

## Rules for programs
1. Hands only: pinch, poke, grab (pinch and move), open palm. No controllers, keyboard, voice or gaze required.
2. Seated and safe: nothing flies at the user's face, no strobe or fast flashing, no need to stand, lean or reach
   further than 0.6 m. Moving objects stay over the table.
3. Readable: labels >= 0.025 m tall, high contrast, at most a few words each.
4. Cheap: under 150 meshes, share geometries and materials, no per-frame allocation in hot loops, no
   `while (true)` and no unbounded loops.
5. Start with one `aide.say(...)` that tells the user what to do in one sentence. End games with `aide.done(...)`.
6. Guard against missing data: hands may be invisible (`visible === false`), `aide.surfaces` may be empty.

## Example 1: golf into a cup on your table (hands-only putting game)
```js
const T = aide.THREE;
const BALL_R = 0.021;
const START = new T.Vector3(0, BALL_R, 0.12);
const HOLES = [[0, -0.32], [-0.18, -0.28], [0.2, -0.35]];
let hole = 0, strokes = 0, totalStrokes = 0, aiming = null, sinkTimer = 0, counted = false;

const cup = aide.spawn('cup', { position: [HOLES[0][0], 0, HOLES[0][1]], radius: 0.05, height: 0.06, color: '#f4f4f4' });
const flag = aide.spawn('label', { text: 'Hole 1', position: [HOLES[0][0], 0.16, HOLES[0][1]], size: 0.03 });
const ball = aide.spawn('ball', { position: START, radius: BALL_R, color: '#ffffff', physics: { mass: 0.046, bounce: 0.15, friction: 0.7 } });
const aimLine = aide.spawn('line', { points: [START, START], color: '#ffd400', width: 0.005 });
const info = aide.spawn('label', { text: 'Strokes: 0', position: [0, 0.3, -0.1], size: 0.03 });

aide.say('Pinch the ball, pull back like a slingshot, and let go to putt.');

aide.onPinch((e) => {
  if (e.object === ball && ball.body.velocity.length() < 0.05 && sinkTimer === 0) {
    aiming = { hand: e.hand, from: ball.position.clone() };
  }
});

const pull = new T.Vector3();
const tip = new T.Vector3();
function resetBall() {
  ball.position.copy(START);
  ball.body.velocity.set(0, 0, 0);
  counted = false;
}

aide.onFrame((dt) => {
  if (aiming) {
    const h = aide.hands[aiming.hand];
    pull.copy(aiming.from).sub(h.pinchPoint);
    pull.y = 0;
    if (pull.length() > 0.2) pull.setLength(0.2);
    tip.copy(ball.position).addScaledVector(pull, 2);
    aimLine.setPoints([ball.position, tip]);
    if (!h.pinching || !h.visible) {
      ball.body.velocity.copy(pull).multiplyScalar(7);
      strokes += 1; // the stroke counts at release, so a hole in one is 1
      counted = true;
      info.setText('Strokes: ' + strokes);
      aimLine.setPoints([START, START]);
      aiming = null;
    }
  }
  if (sinkTimer > 0) {
    sinkTimer -= dt;
    if (sinkTimer <= 0) {
      sinkTimer = 0;
      hole += 1;
      if (hole >= HOLES.length) {
        aide.say('All three holes done in ' + totalStrokes + ' strokes. Nice putting!');
        aide.done('golf finished, ' + totalStrokes + ' strokes over ' + HOLES.length + ' holes');
        return;
      }
      cup.position.set(HOLES[hole][0], 0, HOLES[hole][1]);
      flag.position.set(HOLES[hole][0], 0.16, HOLES[hole][1]);
      flag.setText('Hole ' + (hole + 1));
      strokes = 0;
      info.setText('Strokes: 0');
      resetBall();
    }
    return;
  }
  const speed = ball.body.velocity.length();
  if (!aiming && !counted && speed > 0.08) {
    strokes += 1; // a tap or nudge with the hand is a stroke too
    counted = true;
    info.setText('Strokes: ' + strokes);
  } else if (speed < 0.02) counted = false;
  if (cup.contains(ball.position)) {
    strokes = Math.max(1, strokes);
    totalStrokes += strokes;
    aide.spawn('burst', { position: cup.position, color: '#ffd400' });
    aide.say(strokes === 1 ? 'Hole in one!' : 'In! ' + strokes + ' strokes.');
    aide.score(totalStrokes);
    sinkTimer = 1.5;
  } else if (ball.position.y < -0.3 || Math.abs(ball.position.x) > 0.6 || Math.abs(ball.position.z) > 0.6) {
    aide.say('Off the table. Ball reset, plus one stroke.');
    strokes += 1;
    info.setText('Strokes: ' + strokes);
    resetBall();
  }
});
```

## Example 2: how a four-stroke engine works (grabbable 3D explanation)
```js
const T = aide.THREE;
const root = new T.Group();
root.position.set(0, 0.02, -0.15);
aide.scene.add(root);

const steel = new T.MeshStandardMaterial({ color: '#9aa4ad', metalness: 0.6, roughness: 0.35 });
const glass = new T.MeshStandardMaterial({ color: '#7fb7ff', transparent: true, opacity: 0.18 });
const red = new T.MeshStandardMaterial({ color: '#e0523a' });
const blue = new T.MeshStandardMaterial({ color: '#3a8de0' });
const spark = new T.MeshStandardMaterial({ color: '#ffd400', emissive: '#ffb000', emissiveIntensity: 0 });

const cylinder = new T.Mesh(new T.CylinderGeometry(0.05, 0.05, 0.16, 32, 1, true), glass);
cylinder.position.y = 0.2;
const piston = new T.Mesh(new T.CylinderGeometry(0.047, 0.047, 0.04, 32), steel);
const rod = new T.Mesh(new T.BoxGeometry(0.012, 0.11, 0.012), steel);
const crank = new T.Mesh(new T.CylinderGeometry(0.035, 0.035, 0.02, 24), steel);
crank.rotation.x = Math.PI / 2;
crank.position.y = 0.06;
const intake = new T.Mesh(new T.CylinderGeometry(0.008, 0.008, 0.05, 12), blue);
const exhaust = new T.Mesh(new T.CylinderGeometry(0.008, 0.008, 0.05, 12), red);
intake.position.set(-0.025, 0.3, 0);
exhaust.position.set(0.025, 0.3, 0);
const plug = new T.Mesh(new T.SphereGeometry(0.01, 12, 12), spark);
plug.position.set(0, 0.29, 0);
const blockMat = new T.MeshStandardMaterial({ color: '#4a5058', metalness: 0.4, roughness: 0.6, transparent: true, opacity: 0.45 });
const crankcase = new T.Mesh(new T.BoxGeometry(0.14, 0.08, 0.09), blockMat);
crankcase.position.y = 0.06;
const head = new T.Mesh(new T.BoxGeometry(0.13, 0.03, 0.09), blockMat);
head.position.y = 0.295;
const pin = new T.Mesh(new T.SphereGeometry(0.008, 10, 10), red);
pin.position.z = 0.013;
const parts = [
  { mesh: cylinder, name: 'Cylinder', info: 'The chamber where fuel burns. The piston slides inside it.' },
  { mesh: piston, name: 'Piston', info: 'Pushed down by the burning gas. This push is the engine\'s power.' },
  { mesh: rod, name: 'Connecting rod', info: 'Links the piston to the crankshaft.' },
  { mesh: crank, name: 'Crankshaft', info: 'Turns the up-and-down motion into rotation that drives the wheels.' },
  { mesh: intake, name: 'Intake valve', info: 'Opens to let air and fuel in during the intake stroke.' },
  { mesh: exhaust, name: 'Exhaust valve', info: 'Opens to push burnt gas out during the exhaust stroke.' },
  { mesh: plug, name: 'Spark plug', info: 'Fires a spark that ignites the squeezed fuel and air.' },
  { mesh: crankcase, name: 'Crankcase', info: 'The lower block that holds the crankshaft and the oil.' },
  { mesh: head, name: 'Cylinder head', info: 'Closes the top of the cylinder and holds the valves and the spark plug.' },
];
for (const p of parts) root.add(p.mesh);
root.add(pin);
const tags = [
  { label: aide.spawn('label', { text: 'Intake', size: 0.025 }), at: [-0.08, 0.34, 0] },
  { label: aide.spawn('label', { text: 'Exhaust', size: 0.025 }), at: [0.08, 0.34, 0] },
  { label: aide.spawn('label', { text: 'Piston', size: 0.025 }), at: [0.1, 0.2, 0] },
  { label: aide.spawn('label', { text: 'Crankshaft', size: 0.025 }), at: [0.12, 0.06, 0] },
];
function placeTags() {
  for (const tg of tags) tg.label.position.set(root.position.x + tg.at[0], root.position.y + tg.at[1], root.position.z + tg.at[2]);
}
placeTags();

const strokeLabel = aide.spawn('label', { text: '', position: [0, 0.42, -0.15], size: 0.03 });
const partLabel = aide.spawn('label', { text: 'Pinch a part to learn about it', position: [0, 0.37, -0.15], size: 0.025 });
const STROKES = ['1. Intake: piston goes down, air and fuel come in', '2. Compression: piston goes up and squeezes',
  '3. Power: spark, the burning gas pushes the piston down', '4. Exhaust: piston goes up and pushes the burnt gas out'];

aide.say('This is one cylinder of a car engine. Pinch any part, or pinch the base and move it.');
const base = aide.spawn('box', { size: [0.16, 0.02, 0.1], position: [0, 0.01, -0.15], color: '#3b3f45' });

let angle = 0, speed = 1.2, grabbed = null, expanded = null, lastStroke = -1, seen = 0;
const offset = new T.Vector3();

aide.onPinch((e) => {
  if (e.object === base) {
    grabbed = e.hand;
    offset.copy(base.position).sub(e.point);
    return;
  }
  const local = e.point.clone().sub(root.position);
  let best = null, bestD = 0.06;
  for (const p of parts) {
    const d = p.mesh.position.distanceTo(local);
    if (d < bestD) { best = p; bestD = d; }
  }
  if (best) {
    if (expanded) expanded.mesh.scale.setScalar(1);
    expanded = best;
    best.mesh.scale.setScalar(1.35);
    partLabel.setText(best.name);
    aide.say(best.info);
    seen += 1;
    if (seen >= 4) aide.done('engine explanation: user explored ' + seen + ' parts');
  }
});

aide.onFrame((dt) => {
  if (grabbed) {
    const h = aide.hands[grabbed];
    if (!h.pinching || !h.visible) grabbed = null;
    else {
      base.position.copy(h.pinchPoint).add(offset);
      base.position.y = Math.max(0.01, base.position.y);
      root.position.set(base.position.x, base.position.y + 0.01, base.position.z);
      strokeLabel.position.set(base.position.x, base.position.y + 0.41, base.position.z);
      partLabel.position.set(base.position.x, base.position.y + 0.36, base.position.z);
      placeTags();
    }
  }
  angle = (angle + dt * speed) % (Math.PI * 4);
  const crankAngle = angle;
  const throwR = 0.03;
  const pinY = 0.06 + Math.cos(crankAngle) * throwR;
  const pinX = Math.sin(crankAngle) * throwR;
  const pistonY = pinY + Math.sqrt(0.11 * 0.11 - pinX * pinX) + 0.02;
  piston.position.set(0, pistonY, 0);
  rod.position.set(pinX / 2, (pinY + pistonY) / 2, 0);
  rod.rotation.z = Math.atan2(pinX, pistonY - pinY);
  crank.rotation.y = crankAngle;
  pin.position.x = pinX;
  pin.position.y = pinY;
  const stroke = Math.floor(angle / Math.PI);
  intake.position.y = stroke === 0 ? 0.285 : 0.3;
  exhaust.position.y = stroke === 3 ? 0.285 : 0.3;
  spark.emissiveIntensity = stroke === 2 && angle % Math.PI < 0.3 ? 3 : 0;
  if (stroke !== lastStroke) {
    lastStroke = stroke;
    strokeLabel.setText(STROKES[stroke]);
  }
});
```

## Example 3: agent map for organising work (grab a task card and drop it on another agent)
```js
const T = aide.THREE;
const AGENTS = [
  { name: 'Marketing', color: '#e0823a', x: -0.3 },
  { name: 'Sales', color: '#3ab06a', x: -0.1 },
  { name: 'Research', color: '#3a8de0', x: 0.1 },
  { name: 'Ops', color: '#a05ad0', x: 0.3 },
];
const TASKS = [
  { name: 'Launch post', agent: 'Marketing' }, { name: 'Newsletter', agent: 'Marketing' },
  { name: 'Follow up Acme', agent: 'Sales' }, { name: 'Demo deck', agent: 'Sales' },
  { name: 'Competitor scan', agent: 'Research' }, { name: 'Invoice run', agent: 'Ops' },
];
const PAD_Z = -0.28;

aide.spawn('label', { text: 'Your agents (sample data)', position: [0, 0.3, PAD_Z], size: 0.03 });
const hub = aide.spawn('ball', { radius: 0.025, color: '#ffffff', position: [0, 0.025, 0.02] });
for (const a of AGENTS) {
  a.pad = aide.spawn('box', { size: [0.15, 0.012, 0.1], color: a.color, position: [a.x, 0.006, PAD_Z] });
  a.label = aide.spawn('label', { text: a.name, position: [a.x, 0.09, PAD_Z - 0.03], size: 0.028 });
  aide.spawn('line', { points: [hub.position, [a.x, 0.012, PAD_Z]], color: a.color, width: 0.003 });
}
for (const t of TASKS) {
  t.card = aide.spawn('box', { size: [0.11, 0.01, 0.035], color: '#f4f4f4' });
  t.label = aide.spawn('label', { text: t.name, size: 0.025 });
}

function layout() {
  for (const a of AGENTS) {
    const mine = TASKS.filter((t) => t.agent === a.name);
    mine.forEach((t, i) => {
      if (t === grabbed) return;
      t.card.position.set(a.x, 0.018 + i * 0.012, PAD_Z + 0.09 + i * 0.045);
      t.label.position.set(a.x, t.card.position.y + 0.035, t.card.position.z);
    });
  }
}

let grabbed = null, hand = null, moves = 0;
layout();
aide.say('Here are your agents. Pinch a task card and drop it on another agent to hand it over.');

aide.onPinch((e) => {
  const t = TASKS.find((x) => x.card === e.object);
  if (t && !grabbed) {
    grabbed = t;
    hand = e.hand;
    aide.sound.pop();
  }
});

aide.onFrame(() => {
  if (!grabbed) return;
  const h = aide.hands[hand];
  if (h.pinching && h.visible) {
    grabbed.card.position.set(h.pinchPoint.x, Math.max(0.03, h.pinchPoint.y), h.pinchPoint.z);
    grabbed.label.position.set(grabbed.card.position.x, grabbed.card.position.y + 0.035, grabbed.card.position.z);
    return;
  }
  let best = null, bestD = 0.14;
  for (const a of AGENTS) {
    const d = Math.hypot(grabbed.card.position.x - a.x, grabbed.card.position.z - (PAD_Z + 0.06));
    if (d < bestD) { best = a; bestD = d; }
  }
  const t = grabbed;
  grabbed = null;
  if (best && best.name !== t.agent) {
    const from = t.agent;
    t.agent = best.name;
    moves += 1;
    aide.spawn('burst', { position: best.pad.position, color: best.color, count: 16 });
    aide.sound.chime();
    aide.emit('task_moved', { task: t.name, to: best.name, from: from });
  }
  layout();
});
```
