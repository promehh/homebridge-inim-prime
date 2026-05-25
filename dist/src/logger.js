"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ConsoleLogger = void 0;
exports.withDebug = withDebug;
class ConsoleLogger {
    constructor(verbose = false) {
        this.verbose = verbose;
    }
    debug(message, ...parameters) {
        if (this.verbose)
            console.log('[DEBUG]', message, ...parameters);
    }
    info(message, ...parameters) {
        console.log('[INFO ]', message, ...parameters);
    }
    warn(message, ...parameters) {
        console.warn('[WARN ]', message, ...parameters);
    }
    error(message, ...parameters) {
        console.error('[ERROR]', message, ...parameters);
    }
}
exports.ConsoleLogger = ConsoleLogger;
/** Wraps a logger to only forward debug() calls when `debug=true`. */
function withDebug(base, debug) {
    if (debug)
        return base;
    return {
        debug: () => undefined,
        info: base.info.bind(base),
        warn: base.warn.bind(base),
        error: base.error.bind(base),
    };
}
