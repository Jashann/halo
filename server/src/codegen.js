// Code generation for run_code (Spark) and validation of generated programs.
import * as acorn from 'acorn';
import { codegenSystemPrompt, codegenUserPrompt, codegenFixPrompt } from './prompts.js';

export const MAX_CODE_BYTES = 60000;

const FORBIDDEN_IDENTIFIERS = new Set([
  'fetch',
  'XMLHttpRequest',
  'WebSocket',
  'EventSource',
  'eval',
  'Function',
  'document',
  'window',
  'globalThis',
  'self',
  'parent',
  'top',
  'localStorage',
  'sessionStorage',
  'indexedDB',
  'navigator',
  'importScripts',
  'require',
  'process',
  'setTimeout',
  'setInterval',
  'Worker',
]);

// Pulls the program out of a model reply: the first ```js / ```javascript block, else any fenced block, else
// the whole reply.
export function extractCode(text) {
  const s = String(text || '');
  const tagged = s.match(/```(?:js|javascript|jsx|ts)\s*\n([\s\S]*?)```/i);
  if (tagged) return tagged[1].trim();
  const any = s.match(/```[a-z]*\s*\n([\s\S]*?)```/i);
  if (any) return any[1].trim();
  // unterminated fence (truncated reply)
  const open = s.match(/```(?:js|javascript)?\s*\n([\s\S]*)$/i);
  if (open) return open[1].trim();
  return s.trim();
}

// Browser globals that are also common variable names: allowed only when the program declares them itself.
const SOFT_FORBIDDEN = new Set(['self', 'parent', 'top', 'navigator', 'process', 'Worker']);

function collectPatternNames(pat, out) {
  if (!pat) return;
  if (pat.type === 'Identifier') out.add(pat.name);
  else if (pat.type === 'ObjectPattern') for (const p of pat.properties) collectPatternNames(p.type === 'RestElement' ? p.argument : p.value, out);
  else if (pat.type === 'ArrayPattern') for (const e of pat.elements) collectPatternNames(e, out);
  else if (pat.type === 'RestElement') collectPatternNames(pat.argument, out);
  else if (pat.type === 'AssignmentPattern') collectPatternNames(pat.left, out);
}

function isTruthyLiteral(node) {
  return node && node.type === 'Literal' && Boolean(node.value);
}

function walk(node, visit, parent = null) {
  if (!node || typeof node.type !== 'string') return;
  visit(node, parent);
  for (const key of Object.keys(node)) {
    if (key === 'type' || key === 'start' || key === 'end' || key === 'loc') continue;
    const child = node[key];
    if (Array.isArray(child)) for (const c of child) walk(c, visit, node);
    else if (child && typeof child.type === 'string') walk(child, visit, node);
  }
}

// Returns {ok, errors[]}. The program is the body of function(aide){...}.
export function validateCode(code) {
  const errors = [];
  if (typeof code !== 'string' || !code.trim()) return { ok: false, errors: ['empty program'] };
  if (Buffer.byteLength(code) > MAX_CODE_BYTES) errors.push(`program too large (> ${MAX_CODE_BYTES} bytes)`);

  let ast;
  try {
    ast = acorn.parse(`(function (aide) {\n${code}\n})`, { ecmaVersion: 'latest', sourceType: 'script' });
  } catch (e) {
    const line = e.loc ? ` (line ${e.loc.line - 1})` : '';
    return { ok: false, errors: [`syntax error: ${e.message.replace(/\s*\(\d+:\d+\)$/, '')}${line}`] };
  }

  const declared = new Set();
  walk(ast, (node) => {
    if (node.type === 'VariableDeclarator') collectPatternNames(node.id, declared);
    if ((node.type === 'FunctionDeclaration' || node.type === 'FunctionExpression' || node.type === 'ClassDeclaration') && node.id) declared.add(node.id.name);
    if (node.params) for (const p of node.params) collectPatternNames(p, declared);
    if (node.type === 'CatchClause' && node.param) collectPatternNames(node.param, declared);
  });

  const hits = new Set();
  walk(ast, (node, parent) => {
    if (node.type === 'Identifier' && FORBIDDEN_IDENTIFIERS.has(node.name) && !(SOFT_FORBIDDEN.has(node.name) && declared.has(node.name))) {
      const isPropKey = parent && parent.type === 'MemberExpression' && parent.property === node && !parent.computed;
      const isObjKey = parent && parent.type === 'Property' && parent.key === node && !parent.computed && !parent.shorthand;
      const isMethodKey = parent && parent.type === 'MethodDefinition' && parent.key === node;
      if (!isPropKey && !isObjKey && !isMethodKey) hits.add(`forbidden identifier: ${node.name}`);
    }
    if (node.type === 'ImportExpression') hits.add('forbidden: import()');
    if (node.type === 'MetaProperty') hits.add('forbidden: import.meta / new.target');
    if (node.type === 'WhileStatement' && isTruthyLiteral(node.test)) hits.add('forbidden: while(true) loop');
    if (node.type === 'DoWhileStatement' && isTruthyLiteral(node.test)) hits.add('forbidden: do..while(true) loop');
    if (node.type === 'ForStatement' && (!node.test || isTruthyLiteral(node.test))) hits.add('forbidden: for(;;) loop without a condition');
    if (node.type === 'MemberExpression' && node.computed && node.property.type === 'Literal' && FORBIDDEN_IDENTIFIERS.has(String(node.property.value)))
      hits.add(`forbidden member: ["${node.property.value}"]`);
    if (node.type === 'MemberExpression' && !node.computed && node.property.name === 'constructor')
      hits.add('forbidden: .constructor access');
  });
  errors.push(...hits);

  if (!/\baide\s*\./.test(code)) errors.push('program never uses the aide API');
  return { ok: errors.length === 0, errors };
}

export class CodeGenerator {
  constructor({ models, log = () => {} }) {
    this.models = models;
    this.log = log;
  }

  async ask(messages) {
    const out = await this.models.call('codegen', { messages });
    return { code: extractCode(out.content), latencyMs: out.latencyMs, model: out.model };
  }

  // Generates and validates; on validation failure asks once for a repair.
  async generate({ brief, surfaces, memory }) {
    const sys = { role: 'system', content: codegenSystemPrompt() };
    const t0 = Date.now();
    let { code, model } = await this.ask([sys, { role: 'user', content: codegenUserPrompt({ brief, surfaces, memory }) }]);
    let check = validateCode(code);
    let attempts = 1;
    if (!check.ok) {
      this.log({ codegen: 'repair', errors: check.errors });
      ({ code, model } = await this.ask([sys, { role: 'user', content: codegenFixPrompt({ brief, code, errors: check.errors }) }]));
      check = validateCode(code);
      attempts++;
    }
    return { ok: check.ok, code, errors: check.errors, attempts, model, latencyMs: Date.now() - t0 };
  }

  // Fix after a runtime error reported by the headset.
  async fix({ brief, code, error }) {
    const sys = { role: 'system', content: codegenSystemPrompt() };
    const t0 = Date.now();
    const out = await this.ask([sys, { role: 'user', content: codegenFixPrompt({ brief, code, errors: [`runtime error in the headset: ${error}`] }) }]);
    const check = validateCode(out.code);
    return { ok: check.ok, code: out.code, errors: check.errors, model: out.model, latencyMs: Date.now() - t0 };
  }
}
