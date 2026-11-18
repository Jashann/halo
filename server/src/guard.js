// Cost guard: sliding-window limits per connection and across the whole process, so a public link cannot run up
// the model bill. Every paid call (agent model, codegen, transcription) asks the guard first.

export class LimitError extends Error {
  constructor(kind, message) {
    super(message);
    this.name = 'LimitError';
    this.kind = kind;
  }
}

export class Window {
  constructor(max, ms) {
    this.max = max;
    this.ms = ms;
    this.hits = [];
  }
  take(now = Date.now()) {
    while (this.hits.length && now - this.hits[0] >= this.ms) this.hits.shift();
    if (this.max > 0 && this.hits.length >= this.max) return false;
    this.hits.push(now);
    return true;
  }
}

// Shared by all sessions in the process.
export class GlobalGuard {
  constructor(cfg) {
    this.cfg = cfg;
    this.model = new Window(cfg.globalModelPerMin, 60000);
    this.codegen = new Window(cfg.globalCodegenPerHour, 3600000);
  }
}

export class SessionGuard {
  constructor(cfg, global) {
    this.cfg = cfg;
    this.global = global;
    this.model = new Window(cfg.modelPerMin, 60000);
    this.transcribe = new Window(cfg.transcribePerMin, 60000);
    this.codegenUsed = 0;
    this.modelUsed = 0;
  }

  modelCall() {
    if (this.cfg.modelPerSession > 0 && this.modelUsed >= this.cfg.modelPerSession)
      throw new LimitError('session', 'model call limit for this session reached');
    if (!this.model.take()) throw new LimitError('rate', 'too many model calls this minute');
    if (this.global && !this.global.model.take()) throw new LimitError('global', 'server is busy');
    this.modelUsed++;
  }

  codegenCall() {
    if (this.codegenUsed >= this.cfg.codegenPerSession) throw new LimitError('codegen', 'code generation limit for this session reached');
    if (this.global && !this.global.codegen.take()) throw new LimitError('global', 'code generation is busy, try later');
    this.codegenUsed++;
  }

  transcribeCall() {
    if (!this.transcribe.take()) throw new LimitError('rate', 'too many voice clips this minute');
  }
}

// Wraps a ModelClient so every call is counted (role "codegen" counts against the codegen budget too).
export function guardedModels(models, guard) {
  return {
    call(role, req) {
      if (role === 'codegen') guard.codegenCall();
      else guard.modelCall();
      return models.call(role, req);
    },
  };
}
