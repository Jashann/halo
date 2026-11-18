// Model client with a provider abstraction. A provider knows how to talk to one API; a ModelClient holds an
// ordered chain of {provider, model} per role ("agent", "codegen") and falls through on failure.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class ModelError extends Error {
  constructor(message, { status, retryable, body } = {}) {
    super(message);
    this.name = 'ModelError';
    this.status = status;
    this.retryable = retryable;
    this.body = body;
  }
}

// Removes the API key from anything that could end up in a log or a client message.
export function scrub(text, key) {
  let s = String(text ?? '');
  if (key && key.length > 8) s = s.split(key).join('[redacted]');
  return s.replace(/Bearer\s+[A-Za-z0-9._\-]+/g, 'Bearer [redacted]');
}

// OpenAI-compatible chat/completions provider (Meta Model API by default).
export class OpenAICompatProvider {
  constructor({ name = 'meta', baseUrl, apiKey, fetchImpl = globalThis.fetch, retries = 2, backoffMs = 600 }) {
    this.name = name;
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.apiKey = apiKey;
    this.fetch = fetchImpl;
    this.retries = retries;
    this.backoffMs = backoffMs;
  }

  async chat({ model, messages, tools, toolChoice, maxTokens, reasoningEffort, temperature, timeoutMs = 45000 }) {
    if (!this.apiKey) throw new ModelError('No API key configured', { retryable: false });
    const body = { model, messages };
    if (tools && tools.length) {
      body.tools = tools;
      if (toolChoice) body.tool_choice = toolChoice;
    }
    if (maxTokens) body.max_tokens = maxTokens;
    if (reasoningEffort) body.reasoning_effort = reasoningEffort;
    if (temperature !== undefined) body.temperature = temperature;

    let lastErr;
    for (let attempt = 0; attempt <= this.retries; attempt++) {
      if (attempt > 0) await sleep(this.backoffMs * 2 ** (attempt - 1));
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      const t0 = Date.now();
      try {
        const res = await this.fetch(`${this.baseUrl}/chat/completions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.apiKey}` },
          body: JSON.stringify(body),
          signal: ctrl.signal,
        });
        const text = await res.text();
        if (!res.ok) {
          const retryable = res.status === 429 || res.status >= 500;
          throw new ModelError(`HTTP ${res.status}: ${scrub(text, this.apiKey).slice(0, 400)}`, {
            status: res.status,
            retryable,
          });
        }
        const json = JSON.parse(text);
        const choice = json.choices?.[0] || {};
        const msg = choice.message || {};
        return {
          content: typeof msg.content === 'string' ? msg.content : '',
          toolCalls: (msg.tool_calls || []).map((tc) => ({
            id: tc.id,
            name: tc.function?.name,
            arguments: tc.function?.arguments ?? '{}',
          })),
          finishReason: choice.finish_reason,
          usage: json.usage,
          model: json.model || model,
          provider: this.name,
          latencyMs: Date.now() - t0,
        };
      } catch (err) {
        const aborted = err.name === 'AbortError';
        lastErr =
          err instanceof ModelError
            ? err
            : new ModelError(aborted ? `Timed out after ${timeoutMs} ms` : scrub(err.message, this.apiKey), {
                retryable: true,
              });
        if (!lastErr.retryable) break;
      } finally {
        clearTimeout(timer);
      }
    }
    throw lastErr;
  }
}

export class ModelClient {
  // chains: { agent: [{provider, model, opts}], codegen: [...] }
  constructor(chains, { log = () => {} } = {}) {
    this.chains = chains;
    this.log = log;
  }

  async call(role, req) {
    const chain = this.chains[role];
    if (!chain || !chain.length) throw new ModelError(`No model configured for role ${role}`);
    let lastErr;
    for (const link of chain) {
      try {
        const out = await link.provider.chat({ ...(link.opts || {}), ...req, model: link.model });
        this.log({ role, model: link.model, latencyMs: out.latencyMs, tools: out.toolCalls.map((t) => t.name), finish: out.finishReason, outTokens: out.usage?.completion_tokens, reasoningTokens: out.usage?.completion_tokens_details?.reasoning_tokens, contentChars: out.content.length });
        return out;
      } catch (err) {
        lastErr = err;
        this.log({ role, model: link.model, error: err.message });
      }
    }
    throw lastErr;
  }
}

export function buildModelClient(cfg, { fetchImpl, log } = {}) {
  const meta = new OpenAICompatProvider({
    name: 'meta',
    baseUrl: cfg.apiBase,
    apiKey: cfg.apiKey,
    fetchImpl,
    retries: cfg.modelRetries,
  });
  const agentOpts = { maxTokens: cfg.agentMaxTokens, timeoutMs: cfg.modelTimeoutMs };
  if (cfg.agentReasoning) agentOpts.reasoningEffort = cfg.agentReasoning;
  const agent = [{ provider: meta, model: cfg.agentModel, opts: agentOpts }];
  if (cfg.agentFallbackModel)
    agent.push({ provider: meta, model: cfg.agentFallbackModel, opts: { maxTokens: 2500, timeoutMs: cfg.modelTimeoutMs } });
  const spark = { maxTokens: 12000, reasoningEffort: 'low', timeoutMs: cfg.codegenTimeoutMs };
  const codegen = [{ provider: meta, model: cfg.codegenModel, opts: cfg.codegenModel.startsWith('muse-spark') ? spark : { maxTokens: 6000, timeoutMs: cfg.codegenTimeoutMs } }];
  if (cfg.codegenFallbackModel)
    codegen.push({
      provider: meta,
      model: cfg.codegenFallbackModel,
      opts: cfg.codegenFallbackModel.startsWith('muse-spark') ? spark : { maxTokens: 6000, timeoutMs: cfg.codegenTimeoutMs },
    });
  return new ModelClient({ agent, codegen }, { log });
}
