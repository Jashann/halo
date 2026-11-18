# Regenerates web/src/runtime/examples.ts from server/src/prompts/runtime_api.md (the agent's few-shot examples).
import json, re, pathlib
root = pathlib.Path(__file__).resolve().parents[2]
s = (root / 'server/src/prompts/runtime_api.md').read_text()
b = re.findall(r"```js\n(.*?)```", s, re.S)
assert len(b) >= 3, len(b)
out = """// Built-in example programs, copied verbatim from server/src/prompts/runtime_api.md (the agent's few-shot
// references): golf, the four-stroke engine and the agent map. Used by tests and the desktop demo.
// Regenerate with: python3 web/scripts/sync-examples.py (a unit test compares them).

export const GOLF_JS = %s;

export const ENGINE_JS = %s;

export const AGENTMAP_JS = %s;

export const EXAMPLES: Record<string, string> = { golf: GOLF_JS, engine: ENGINE_JS, agentmap: AGENTMAP_JS };
""" % (json.dumps(b[0]), json.dumps(b[1]), json.dumps(b[2]))
(root / 'web/src/runtime/examples.ts').write_text(out)
print('examples synced')
