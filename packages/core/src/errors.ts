/** Prism error hierarchy shared by core and adapters. */

export type PrismErrorCode =
  | "CONFIG_ERROR"
  | "CHANNEL_NOT_FOUND"
  | "UNSUPPORTED_BLOCK"
  | "VERIFY_FAILED"
  | "PARSE_FAILED"
  | "SEND_FAILED"
  | "TIMEOUT"
  | "RATE_LIMITED"
  | "AUTH_FAILED"
  | "INTERNAL";

export class PrismError extends Error {
  readonly code: PrismErrorCode;
  /** When true the outbox may retry the delivery. */
  readonly retryable: boolean;
  readonly detail?: unknown;

  constructor(
    code: PrismErrorCode,
    message: string,
    opts?: { retryable?: boolean; detail?: unknown; cause?: unknown }
  ) {
    super(message, opts?.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = "PrismError";
    this.code = code;
    this.retryable = opts?.retryable ?? false;
    this.detail = opts?.detail;
  }
}

export class ConfigurationError extends PrismError {
  constructor(message: string, detail?: unknown) {
    super("CONFIG_ERROR", message, { detail });
    this.name = "ConfigurationError";
  }
}

export class ChannelNotFoundError extends PrismError {
  constructor(channel: string) {
    super("CHANNEL_NOT_FOUND", `Channel "${channel}" is not registered. Did you forget prism.use(adapter)?`);
    this.name = "ChannelNotFoundError";
  }
}

export class VerifyError extends PrismError {
  constructor(message: string, detail?: unknown) {
    super("VERIFY_FAILED", message, { detail });
    this.name = "VerifyError";
  }
}
