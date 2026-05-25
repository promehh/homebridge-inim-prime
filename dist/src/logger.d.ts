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
export declare class ConsoleLogger implements Logger {
    private readonly verbose;
    constructor(verbose?: boolean);
    debug(message: string, ...parameters: unknown[]): void;
    info(message: string, ...parameters: unknown[]): void;
    warn(message: string, ...parameters: unknown[]): void;
    error(message: string, ...parameters: unknown[]): void;
}
/** Wraps a logger to only forward debug() calls when `debug=true`. */
export declare function withDebug(base: Logger, debug: boolean): Logger;
