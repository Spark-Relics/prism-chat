/** Minimal logger contract. Plug winston/pino by implementing this interface. */
export interface Logger {
  debug(msg: string, meta?: Record<string, unknown>): void;
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
}

export const consoleLogger: Logger = {
  debug: (m, meta) => console.debug(`[prism] ${m}`, meta ?? ""),
  info: (m, meta) => console.info(`[prism] ${m}`, meta ?? ""),
  warn: (m, meta) => console.warn(`[prism] ${m}`, meta ?? ""),
  error: (m, meta) => console.error(`[prism] ${m}`, meta ?? ""),
};

export const noopLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};
