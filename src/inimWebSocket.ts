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

import WebSocket from 'ws';
import { Logger } from './logger';
import { WsEventInner, WsEventListener } from './types';

const PING_INTERVAL_MS = 115_000;
const RECONNECT_DELAY_MS = 10_000;

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

export class InimWebSocket {
  private ws: WebSocket | null = null;
  private pingTimer: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private stopped = false;

  constructor(private readonly opts: InimWebSocketOptions) {}

  /** Start the connection loop. */
  async start(): Promise<void> {
    this.stopped = false;
    await this.connect();
  }

  /** Stop and prevent further reconnects. */
  stop(): void {
    this.stopped = true;
    if (this.pingTimer) clearInterval(this.pingTimer);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.pingTimer = null;
    this.reconnectTimer = null;
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        /* ignore */
      }
      this.ws = null;
    }
  }

  private async connect(): Promise<void> {
    if (this.stopped) return;
    let url: string;
    try {
      url = await Promise.resolve(this.opts.urlProvider());
    } catch (e) {
      this.opts.logger.warn(
        `Cannot build WS URL: ${(e as Error).message}. Retrying in 10s…`,
      );
      this.scheduleReconnect();
      return;
    }
    this.opts.logger.debug('Opening INIM WebSocket…');
    const ws = new WebSocket(url, { handshakeTimeout: 15_000 });
    this.ws = ws;

    ws.on('open', () => {
      this.opts.logger.info('INIM WebSocket connected (real-time updates active).');
      // Start the custom keep-alive.
      if (this.pingTimer) clearInterval(this.pingTimer);
      this.pingTimer = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          try {
            ws.send('@ ');
          } catch (err) {
            this.opts.logger.debug(
              `Ping send failed: ${(err as Error).message}`,
            );
          }
        }
      }, PING_INTERVAL_MS);
    });

    ws.on('message', (raw) => {
      const text = typeof raw === 'string' ? raw : raw.toString('utf8');
      this.handleMessage(text);
    });

    ws.on('error', (err) => {
      this.opts.logger.warn(`INIM WebSocket error: ${(err as Error).message}`);
      // Don't close manually here — 'close' will fire automatically.
    });

    ws.on('close', (code, reason) => {
      this.opts.logger.info(
        `INIM WebSocket closed (code=${code}, reason=${reason?.toString() || 'n/a'}).`,
      );
      if (this.pingTimer) {
        clearInterval(this.pingTimer);
        this.pingTimer = null;
      }
      this.ws = null;
      if (!this.stopped) {
        // If the close looks like an auth failure (4xxx) try a forced reauth.
        const looksLikeAuth =
          (code >= 4000 && code < 5000) || code === 1008 || code === 1011;
        if (looksLikeAuth && this.opts.reauthOnReconnect) {
          this.opts.logger.warn(
            'WebSocket closed with auth-looking code; will reauthenticate before reconnect.',
          );
          this.opts
            .reauthOnReconnect()
            .catch((e) =>
              this.opts.logger.warn(
                `Reauth before WS reconnect failed: ${(e as Error).message}`,
              ),
            )
            .finally(() => this.scheduleReconnect());
        } else {
          this.scheduleReconnect();
        }
      }
    });
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect().catch((e) =>
        this.opts.logger.warn(`Reconnect failed: ${(e as Error).message}`),
      );
    }, RECONNECT_DELAY_MS);
  }

  private handleMessage(text: string): void {
    let parsed: { Type?: string; Data?: { Data?: unknown } } | undefined;
    try {
      parsed = JSON.parse(text);
    } catch {
      this.opts.logger.debug(`Non-JSON WS frame ignored: ${text.slice(0, 80)}`);
      return;
    }
    if (!parsed?.Type) return;
    if (parsed.Type === 'PONG') {
      this.opts.logger.debug('WS PONG received.');
      return;
    }
    if (parsed.Type !== 'EVENT') {
      this.opts.logger.debug(`WS frame Type=${parsed.Type} (ignored).`);
      return;
    }
    const inner = parsed.Data?.Data;
    if (typeof inner !== 'string') {
      // Sometimes server sends a non-string payload; signal caller to re-poll.
      this.opts.logger.debug(
        'WS EVENT with non-string Data.Data; requesting full refresh.',
      );
      this.opts.onUnknownEvent?.();
      return;
    }
    let event: WsEventInner;
    try {
      event = JSON.parse(inner);
    } catch (e) {
      this.opts.logger.warn(
        `WS EVENT inner JSON parse failed: ${(e as Error).message}`,
      );
      return;
    }
    if (typeof event !== 'object' || event === null) {
      this.opts.onUnknownEvent?.();
      return;
    }
    this.opts.onEvent(event);
  }
}
