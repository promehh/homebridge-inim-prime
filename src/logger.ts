/**
 * Minimal logger interface compatible with Homebridge's Logging type.
 * Lets us run the client outside Homebridge for debugging.
 */
export interface Logger {
  debug(message: string, ...parameters: unknown[]): void;
  info(message: string, ...parameters: unknown[]): void;
  warn(message: string, ...parameters: unknown[]): void;
  error(message: string, ...parameters: unknown[]): void;
}

export class ConsoleLogger implements Logger {
  constructor(private readonly verbose: boolean = false) {}
  debug(message: string, ...parameters: unknown[]): void {
    if (this.verbose) console.log('[DEBUG]', message, ...parameters);
  }
  info(message: string, ...parameters: unknown[]): void {
    console.log('[INFO ]', message, ...parameters);
  }
  warn(message: string, ...parameters: unknown[]): void {
    console.warn('[WARN ]', message, ...parameters);
  }
  error(message: string, ...parameters: unknown[]): void {
    console.error('[ERROR]', message, ...parameters);
  }
}

/** Wraps a logger to only forward debug() calls when `debug=true`. */
export function withDebug(base: Logger, debug: boolean): Logger {
  if (debug) return base;
  return {
    debug: () => undefined,
    info: base.info.bind(base),
    warn: base.warn.bind(base),
    error: base.error.bind(base),
  };
}
