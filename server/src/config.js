import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const SERVER_ROOT = path.resolve(here, '..');

function readKey() {
  if (process.env.META_API_KEY) return process.env.META_API_KEY.trim();
  const file = process.env.META_API_KEY_FILE || path.join(os.homedir(), '.meta_api_key');
  try {
    return fs.readFileSync(file, 'utf8').trim();
  } catch {
    return '';
  }
}

const num = (v, d) => (v === undefined || v === '' || Number.isNaN(Number(v)) ? d : Number(v));

export function loadConfig(overrides = {}) {
  const cfg = {
    port: num(process.env.PORT, 8787),
    host: process.env.HOST || '0.0.0.0',
    sslCert: process.env.SSL_CERT || '',
    sslKey: process.env.SSL_KEY || '',
    webDist: process.env.WEB_DIST || path.resolve(SERVER_ROOT, '../web/dist'),
    dataDir: process.env.AIDE_DATA_DIR || path.join(SERVER_ROOT, 'data'),
    apiBase: process.env.META_API_BASE || 'https://api.meta.ai/v1',
    apiKey: readKey(),
    agentModel: process.env.AIDE_AGENT_MODEL || 'muse-ember-1.0',
    agentMaxTokens: num(process.env.AIDE_AGENT_MAX_TOKENS, 4000),
    agentReasoning: process.env.AIDE_AGENT_REASONING ?? 'low', // '' to leave the model default
    agentFallbackModel: process.env.AIDE_AGENT_FALLBACK_MODEL || '',
    codegenModel: process.env.AIDE_CODEGEN_MODEL || 'muse-spark-1.3',
    codegenFallbackModel: process.env.AIDE_CODEGEN_FALLBACK_MODEL || 'muse-ember-1.0',
    transcribeModel: process.env.AIDE_TRANSCRIBE_MODEL || 'muse-voice-transcribe-1.0',
    modelTimeoutMs: num(process.env.AIDE_MODEL_TIMEOUT_MS, 45000),
    codegenTimeoutMs: num(process.env.AIDE_CODEGEN_TIMEOUT_MS, 120000),
    modelRetries: num(process.env.AIDE_MODEL_RETRIES, 2),
    toolTimeoutMs: num(process.env.AIDE_TOOL_TIMEOUT_MS, 15000),
    maxSteps: num(process.env.AIDE_MAX_STEPS, 14),
    greet: process.env.AIDE_GREET !== '0',
    operatorToken: process.env.OPERATOR_TOKEN || '',
    // cost guard
    modelPerMin: num(process.env.AIDE_MODEL_PER_MIN, 20),
    modelPerSession: num(process.env.AIDE_MODEL_PER_SESSION, 300),
    codegenPerSession: num(process.env.AIDE_CODEGEN_PER_SESSION, 8),
    transcribePerMin: num(process.env.AIDE_TRANSCRIBE_PER_MIN, 12),
    globalModelPerMin: num(process.env.AIDE_GLOBAL_MODEL_PER_MIN, 300),
    globalCodegenPerHour: num(process.env.AIDE_GLOBAL_CODEGEN_PER_HOUR, 150),
    maxSessions: num(process.env.AIDE_MAX_SESSIONS, 40),
    maxSessionsPerIp: num(process.env.AIDE_MAX_SESSIONS_PER_IP, 4),
    maxQueued: num(process.env.AIDE_MAX_QUEUED, 4),
    greetMaxTokens: num(process.env.AIDE_GREET_MAX_TOKENS, 600),
    warmOnHello: process.env.AIDE_WARM !== '0',
    maxHistory: num(process.env.AIDE_MAX_HISTORY, 48),
  };
  return { ...cfg, ...overrides };
}
