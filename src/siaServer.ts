/**
 * Optional SIA-IP listener.
 *
 * The panel connects OUT to us (we bind a TCP port). Each frame is SIA-DCS
 * over a tiny line-protocol with CRC-16/X.25. We must ACK every frame.
 *
 * Protocol summary:
 *   frame  = "\n" CRC4 LEN4 PAYLOAD "\r"
 *   PAYLOAD = "\"SIA-DCS\"" SEQ4 RECEIVER "#" ACCOUNT "[" EVENT "]" "_" TS
 *   CRC = CRC-16/X.25 (poly 0x8408 reflected, init 0x0000, xor-out 0xFFFF)
 *   ACK = "\"ACK\"" SEQ RECEIVER "#" ACCOUNT "[]" "_" TS
 *
 * Inside EVENT, after splitting on '|', element [1] looks like:
 *   <modifier><partition><event-class><id>(^extra^)?
 * e.g. "Nri01BA001", "Nri01OP001", "Nnn02BR003".
 *
 * Event classes we care about:
 *   CG/CA/CL/CP -> area armed
 *   OA/OP/OR    -> area disarmed
 *   BA/TA       -> zone alarm   (Status=2, AlarmMemory=1)
 *   BR/TR       -> zone restore (Status=1)
 *
 * Zone/area IDs from SIA are 1-indexed; INIM Cloud API is 0-indexed → subtract 1.
 */

import { createServer, Server, Socket } from 'net';
import { Logger } from './logger';

export type SiaAreaUpdate = { areaId: number; armed: boolean };
export type SiaZoneUpdate = { zoneId: number; open: boolean };

export interface SiaServerOptions {
  port: number;
  accountFilter?: string;
  onAreaUpdate: (u: SiaAreaUpdate) => void;
  onZoneUpdate: (u: SiaZoneUpdate) => void;
  logger: Logger;
}

const AREA_ARM_CODES = new Set(['CG', 'CA', 'CL', 'CP']);
const AREA_DISARM_CODES = new Set(['OA', 'OP', 'OR']);
const ZONE_ALARM_CODES = new Set(['BA', 'TA']);
const ZONE_RESTORE_CODES = new Set(['BR', 'TR']);

function calculateCrc(data: string): string {
  let crc = 0;
  for (let i = 0; i < data.length; i++) {
    crc ^= data.charCodeAt(i);
    for (let j = 0; j < 8; j++) {
      if (crc & 1) crc = (crc >>> 1) ^ 0x8408;
      else crc = crc >>> 1;
    }
  }
  crc ^= 0xffff;
  crc &= 0xffff;
  return crc.toString(16).toUpperCase().padStart(4, '0');
}

function formatTimestamp(d = new Date()): string {
  const pad = (n: number, w = 2) => n.toString().padStart(w, '0');
  return (
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` +
    `,${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${d.getFullYear()}`
  );
}

function buildAck(seq: string, receiver: string, account: string): string {
  const payload = `"ACK"${seq}${receiver}#${account}[]_${formatTimestamp()}`;
  const lenStr = payload.length.toString(16).toUpperCase().padStart(4, '0');
  const crc = calculateCrc(`${lenStr}${payload}`);
  return `\n${crc}${lenStr}${payload}\r`;
}

export class SiaServer {
  private server: Server | null = null;
  private connections = new Set<Socket>();

  constructor(private readonly opts: SiaServerOptions) {}

  async start(): Promise<void> {
    return new Promise((resolve, reject) => {
      const server = createServer((socket) => this.handleClient(socket));
      this.server = server;
      server.once('error', reject);
      server.listen(this.opts.port, '0.0.0.0', () => {
        this.opts.logger.info(
          `SIA-IP listener on 0.0.0.0:${this.opts.port}` +
            (this.opts.accountFilter
              ? ` (account filter "${this.opts.accountFilter}")`
              : ''),
        );
        server.off('error', reject);
        resolve();
      });
    });
  }

  stop(): void {
    if (this.server) {
      try {
        this.server.close();
      } catch {
        /* ignore */
      }
      this.server = null;
    }
    for (const c of this.connections) c.destroy();
    this.connections.clear();
  }

  private handleClient(socket: Socket): void {
    this.connections.add(socket);
    socket.setEncoding('ascii');
    socket.setTimeout(120_000);
    this.opts.logger.debug(
      `SIA-IP client connected: ${socket.remoteAddress}:${socket.remotePort}`,
    );

    let buffer = '';
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      // Frames end with \r; process all complete frames in the buffer.
      let idx = buffer.indexOf('\r');
      while (idx >= 0) {
        const frame = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        this.processFrame(frame, socket);
        idx = buffer.indexOf('\r');
      }
    });
    socket.on('timeout', () => {
      this.opts.logger.debug('SIA-IP client idle timeout');
      socket.destroy();
    });
    socket.on('error', (e) => {
      this.opts.logger.debug(`SIA-IP client error: ${e.message}`);
    });
    socket.on('close', () => {
      this.connections.delete(socket);
      this.opts.logger.debug('SIA-IP client disconnected');
    });
  }

  private processFrame(rawFrame: string, socket: Socket): void {
    let frame = rawFrame;
    if (frame.startsWith('\n')) frame = frame.slice(1);
    if (frame.length < 8) return;
    if (!frame.includes('"SIA-DCS"')) return;

    const header = frame.match(/"SIA-DCS"(\d{4})([^#]+)#(\d+)/);
    if (!header) return;
    const seq = header[1];
    const receiver = header[2];
    const account = header[3];

    // ACK is always sent, even for filtered/unhandled messages.
    try {
      socket.write(buildAck(seq, receiver, account));
    } catch (e) {
      this.opts.logger.debug(`ACK write failed: ${(e as Error).message}`);
    }

    if (this.opts.accountFilter && this.opts.accountFilter !== account) {
      this.opts.logger.debug(
        `SIA-IP frame ignored (account ${account} != ${this.opts.accountFilter})`,
      );
      return;
    }

    const evtMatch = frame.match(/\[(.*?)\]/);
    if (!evtMatch) return;
    const parts = evtMatch[1].split('|');
    if (parts.length < 2) return;
    const core = parts[1];
    const m = core.match(/([A-Z])(ri\d+|pi\d+|[a-z]{2}\d+)([A-Z]{2})(\d*)/);
    if (!m) return;
    const eventClass = m[3];
    const idStr = m[4];
    if (!idStr) return;
    const id = parseInt(idStr, 10) - 1; // SIA is 1-indexed, INIM API is 0-indexed
    if (Number.isNaN(id) || id < 0) return;

    if (AREA_ARM_CODES.has(eventClass)) {
      this.opts.logger.debug(`SIA: area ${id} armed (${eventClass})`);
      this.opts.onAreaUpdate({ areaId: id, armed: true });
    } else if (AREA_DISARM_CODES.has(eventClass)) {
      this.opts.logger.debug(`SIA: area ${id} disarmed (${eventClass})`);
      this.opts.onAreaUpdate({ areaId: id, armed: false });
    } else if (ZONE_ALARM_CODES.has(eventClass)) {
      this.opts.logger.debug(`SIA: zone ${id} alarm (${eventClass})`);
      this.opts.onZoneUpdate({ zoneId: id, open: true });
    } else if (ZONE_RESTORE_CODES.has(eventClass)) {
      this.opts.logger.debug(`SIA: zone ${id} restore (${eventClass})`);
      this.opts.onZoneUpdate({ zoneId: id, open: false });
    } else {
      this.opts.logger.debug(`SIA: unhandled event class ${eventClass}`);
    }
  }
}
