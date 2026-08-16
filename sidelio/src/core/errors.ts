/**
 * Error taxonomy.
 *
 * Every failure surface in Sidelio maps to one of these codes. The API layer
 * translates the code to an HTTP status; the admin UI translates it to a
 * user-facing message and a recovery action. Adding a new failure mode means
 * adding a code here first, so no module can invent an untranslatable error.
 */

export const ERROR_CODES = {
  // Client
  VALIDATION_FAILED: 400,
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  PRECONDITION_FAILED: 412,
  PAYLOAD_TOO_LARGE: 413,
  UNSUPPORTED_SOURCE: 415,
  RATE_LIMITED: 429,

  // Tenancy / authorization
  CROSS_TENANT_ACCESS: 403,
  IMPORT_NOT_AUTHORIZED: 403,
  PLAN_LIMIT_REACHED: 402,

  // Import
  SOURCE_UNREACHABLE: 502,
  SOURCE_DISALLOWED_BY_ROBOTS: 403,
  EXTRACTION_FAILED: 422,

  // AI
  AI_PROVIDER_ERROR: 502,
  AI_QUOTA_EXCEEDED: 429,
  AI_UNSAFE_REQUEST: 422,
  AI_PLAN_NOT_APPLICABLE: 409,

  // Platform
  INTERNAL: 500,
  NOT_IMPLEMENTED: 501,
} as const;

export type ErrorCode = keyof typeof ERROR_CODES;

export interface ErrorDetail {
  /** Dotted path to the offending field, when applicable. */
  path?: string;
  message: string;
}

export class SidelioError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details: ErrorDetail[];
  /** Safe to show to an end user without leaking internals. */
  readonly userMessage: string;
  readonly retryable: boolean;

  constructor(
    code: ErrorCode,
    message: string,
    opts: { details?: ErrorDetail[]; userMessage?: string; retryable?: boolean; cause?: unknown } = {},
  ) {
    super(message, opts.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = 'SidelioError';
    this.code = code;
    this.status = ERROR_CODES[code];
    this.details = opts.details ?? [];
    this.userMessage = opts.userMessage ?? message;
    this.retryable = opts.retryable ?? (this.status >= 500 || code === 'RATE_LIMITED');
  }

  toJSON() {
    return {
      error: {
        code: this.code,
        message: this.userMessage,
        details: this.details,
        retryable: this.retryable,
      },
    };
  }
}

export const err = (
  code: ErrorCode,
  message: string,
  opts?: ConstructorParameters<typeof SidelioError>[2],
) => new SidelioError(code, message, opts);
