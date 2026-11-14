/**
 * Error types. Every error carries a plain-language message the CLI, the
 * dashboard and the HTTP layer can show as-is — no stack traces to users.
 */

export class SuiError extends Error {
  /**
   * @param {string} message plain-language message, safe to show a user
   * @param {{code?: string, status?: number, retryable?: boolean, detail?: string, cause?: unknown}} [opts]
   */
  constructor(message, opts = {}) {
    super(message);
    this.name = 'SuiError';
    this.code = opts.code ?? 'sui_error';
    this.status = opts.status ?? 500;
    this.retryable = opts.retryable ?? false;
    this.detail = opts.detail ?? null;
    if (opts.cause) this.cause = opts.cause;
  }

  toJSON() {
    return {
      error: {
        message: this.message,
        type: this.code,
        retryable: this.retryable,
        detail: this.detail,
      },
    };
  }
}

/** A provider call failed. Retryable decides whether the router moves to the next target. */
export class ProviderError extends SuiError {
  /**
   * @param {string} message
   * @param {{code?: string, status?: number, retryable?: boolean, provider?: string, model?: string, detail?: string, retryAfterMs?: number, cause?: unknown}} [opts]
   */
  constructor(message, opts = {}) {
    super(message, { status: 502, code: opts.code ?? 'provider_error', ...opts });
    this.retryAfterMs = Number(opts.retryAfterMs ?? 0) || 0;
    this.name = 'ProviderError';
    this.provider = opts.provider ?? null;
    this.model = opts.model ?? null;
  }
}

/** Bad config. Always fatal, always names the field. */
export class ConfigError extends SuiError {
  /**
   * @param {string} message
   * @param {{detail?: string, path?: string}} [opts]
   */
  constructor(message, opts = {}) {
    super(message, { status: 400, code: 'config_error', detail: opts.detail });
    this.name = 'ConfigError';
    this.path = opts.path ?? null;
  }
}

/** Nothing left to try: every target was open, over budget, or unauthorised. */
export class ExhaustedError extends SuiError {
  /**
   * @param {string} message
   * @param {{attempts?: Array<{model: string, reason: string}>, detail?: string}} [opts]
   */
  constructor(message, opts = {}) {
    super(message, { status: 503, code: 'no_route_available', detail: opts.detail });
    this.name = 'ExhaustedError';
    this.attempts = opts.attempts ?? [];
  }

  toJSON() {
    return {
      error: {
        message: this.message,
        type: this.code,
        retryable: true,
        attempts: this.attempts,
      },
    };
  }
}
