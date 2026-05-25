/**
 * INIM Cloud WebSocket client.
 *
 * - Connects to wss://ws.inimcloud.com/events?req=<token-bearing JSON>.
 * - Server idle timeout ~120s. We send the literal text frame "@ " every 115s.
 * - The server's reply is `{"Type":"PONG"}`.
 * - EVENT messages carry a double-encoded payload: `Data.Data` is a JSON
 *   string that must be parsed a second time to get { ZoneList, AreaList }.
 * - Auto-reconnect with 10s backoff. On reconnect the URL is rebuilt so a
 *   fresh token can be picked up if the REST client has re-authenticated.
 */
import { Logger } from './logger';
import { WsEventListener } from './types';
export interface InimWebSocketOptions {
    /** Returns the current WS URL (token-bearing). Called on each reconnect. */
    urlProvider: () => string | Promise<string>;
    /** Forced reauth before rebuilding the URL. Optional. */
    reauthOnReconnect?: () => Promise<void>;
    onEvent: WsEventListener;
    /** Called whenever a non-dict EVENT payload arrives (caller should re-poll). */
    onUnknownEvent?: () => void;
    logger: Logger;
}
export declare class InimWebSocket {
    private readonly opts;
    private ws;
    private pingTimer;
    private reconnectTimer;
    private stopped;
    constructor(opts: InimWebSocketOptions);
    /** Start the connection loop. */
    start(): Promise<void>;
    /** Stop and prevent further reconnects. */
    stop(): void;
    private connect;
    private scheduleReconnect;
    private handleMessage;
}
