// Tool schema shown to the agent model. Most tools run in the headset (sent to the client as tool_call);
// remember/recall run on the server; run_code is expanded on the server (brief -> generated JS) before the
// client sees it as {id, js, at}.

const place = {
  type: 'object',
  description:
    'Where in the room. near: a surface id from room() (best), or "front", "left", "right" (relative to the seated user). ' +
    'offset: optional [x, y, z] metres from that spot (y is up).',
  properties: {
    near: { type: 'string' },
    offset: { type: 'array', items: { type: 'number' }, minItems: 3, maxItems: 3 },
  },
  required: ['near'],
};

const vec3 = { type: 'array', items: { type: 'number' }, minItems: 3, maxItems: 3 };

const panelSpec = {
  type: 'object',
  description:
    'Panel content. Keep it short: at most ~6 lines of text or 6 list items; one idea per panel. ' +
    'Buttons are pressed by poking and come back as event "panel_button" {panel_id, button_id}.',
  properties: {
    subtitle: { type: 'string' },
    text: { type: 'string', description: 'A short paragraph (<= 240 characters).' },
    bullets: { type: 'array', items: { type: 'string' } },
    steps: { type: 'array', items: { type: 'string' }, description: 'Numbered steps (recipe, instructions).' },
    active_step: { type: 'integer', description: 'Index (0-based) of the step to emphasise.' },
    checklist: {
      type: 'array',
      items: { type: 'object', properties: { label: { type: 'string' }, done: { type: 'boolean' } }, required: ['label'] },
    },
    buttons: {
      type: 'array',
      items: { type: 'object', properties: { id: { type: 'string' }, label: { type: 'string' } }, required: ['id', 'label'] },
    },
    accent: { type: 'string', description: 'CSS colour for the accent bar, e.g. "#ffb000".' },
  },
};

function fn(name, description, properties = {}, required = []) {
  return { type: 'function', function: { name, description, parameters: { type: 'object', properties, required } } };
}

export const TOOLS = [
  fn(
    'look',
    'Capture what the user is looking at through the headset camera. Returns an image you will see in the next message. ' +
      'Use it before talking about anything physical (fridge contents, the pan, an object to explain).',
    { prompt: { type: 'string', description: 'What you are looking for, e.g. "ingredients in the fridge".' } }
  ),
  fn('room', 'Get the room: real surfaces (id, label such as table/wall/floor, size in metres, centre) and hand state. Call before placing things.'),
  fn(
    'show_panel',
    'Create a floating panel (your own UI) in the room. Reuse the same id to replace content.',
    {
      id: { type: 'string' },
      title: { type: 'string', description: '<= 32 characters' },
      spec: panelSpec,
      body_uikitml: { type: 'string', description: 'Optional raw UIKitML instead of spec. Prefer spec.' },
      place,
      size: { type: 'string', enum: ['small', 'medium', 'large'] },
    },
    ['id', 'title', 'place']
  ),
  fn(
    'update_panel',
    'Change part of an existing panel (e.g. move to the next recipe step, tick a checklist item).',
    {
      id: { type: 'string' },
      patch: {
        type: 'object',
        description: 'Fields to change: title, spec (merged), place, size.',
        properties: { title: { type: 'string' }, spec: panelSpec, place, size: { type: 'string', enum: ['small', 'medium', 'large'] } },
      },
    },
    ['id', 'patch']
  ),
  fn('close_panel', 'Remove a panel.', { id: { type: 'string' } }, ['id']),
  fn(
    'highlight',
    'Mark a real place in the room: "chop here", "pan goes here", "stove: 200 C / 400 F". Reuse id to move or relabel.',
    {
      id: { type: 'string' },
      target: {
        type: 'object',
        description: 'Either {surface_id, offset?} or {point: [x,y,z]} in room coordinates.',
        properties: { surface_id: { type: 'string' }, offset: vec3, point: vec3 },
      },
      label: { type: 'string', description: '<= 28 characters' },
      color: { type: 'string' },
      shape: { type: 'string', enum: ['ring', 'zone', 'arrow'] },
    },
    ['target', 'label']
  ),
  fn(
    'ghost_hands',
    'Show translucent demonstration hands performing a motion beside the user, looping a few times.',
    {
      motion: { type: 'string', enum: ['chop', 'dice', 'julienne', 'whisk', 'flip', 'stir', 'pinch', 'grab', 'custom'] },
      keyframes: {
        type: 'array',
        description: 'Only for motion "custom": [{t (s), hand: "left"|"right", pose: "open"|"pinch"|"fist"|"point", position: [x,y,z]}]',
        items: { type: 'object' },
      },
      at: place,
      label: { type: 'string', description: 'Caption under the hands, e.g. "Claw grip: fingertips tucked".' },
    },
    ['motion', 'at']
  ),
  fn(
    'timer',
    'Start a visible countdown anchored to a place (e.g. by the stove). Fires event "timer_done" {label} when it ends.',
    { label: { type: 'string' }, seconds: { type: 'number' }, at: place },
    ['label', 'seconds', 'at']
  ),
  fn(
    'run_code',
    'Build something custom in the room: a hands-only mini-game, a grabbable 3D explanation, a custom widget. ' +
      'Describe what to build in "brief"; a code generator writes and checks the program, then it runs in the headset. ' +
      'Takes 10-40 seconds, so say something short first. Reuse the id to replace a running program.',
    {
      id: { type: 'string' },
      brief: {
        type: 'string',
        description:
          'Detailed description: goal, objects, sizes in metres, interactions (pinch, poke, hand position), scoring, ' +
          'difficulty, when it ends, what to say. Mention the surface it sits on.',
      },
      at: place,
    },
    ['id', 'brief', 'at']
  ),
  fn(
    'clear_scene',
    'Remove everything you have placed (panels, highlights, ghost hands, timers, programs) except the ids in keep. ' +
      'Use it when the topic changes so old things do not linger. The orb and chips always stay.',
    { keep: { type: 'array', items: { type: 'string' }, description: 'ids to keep, e.g. a timer still running' } }
  ),
  fn(
    'set_chips',
    'Set the suggestion chips floating near the user (2 to 4 short phrases, under ~24 characters each). ' +
      'Poking a chip sends its text to you as if the user said it. Keep them fitted to the current moment.',
    { chips: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 4 } },
    ['chips']
  ),
  fn('stop_code', 'Stop a running program and remove what it built.', { id: { type: 'string' } }, ['id']),
  fn(
    'remember',
    'Save a fact about this user for future sessions (favourite game, dietary needs, skill level, likes).',
    { key: { type: 'string' }, value: { type: 'string' } },
    ['key', 'value']
  ),
  fn('recall', 'Look up something you saved about this user. Omit key to get everything.', { key: { type: 'string' } }),
];

export const TOOL_NAMES = TOOLS.map((t) => t.function.name);
export const SERVER_TOOLS = new Set(['remember', 'recall']);

// Per-tool client timeouts (ms); look may wait for a camera frame.
export const TOOL_TIMEOUTS = { look: 20000, run_code: 20000 };
