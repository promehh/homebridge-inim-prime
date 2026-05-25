/**
 * Coordinator: orchestrates REST polling, WebSocket events, and (optional)
 * SIA-IP push, into a single in-memory cache of devices/areas/zones/scenarios.
 */

import { EventEmitter } from 'events';
import { Logger } from './logger';
import { InimClient } from './inimClient';
import { InimWebSocket } from './inimWebSocket';
import { SiaServer } from './siaServer';
import {
  InimArea,
  InimDevice,
  InimScenario,
  InimZone,
  PluginConfig,
  WsEventInner,
} from './types';

export interface CoordinatorEvents {
  snapshot: (devices: InimDevice[]) => void;
  change: () => void;
  error: (err: Error) => void;
}

export declare interface Coordinator {
  on<K extends keyof CoordinatorEvents>(event: K, listener: CoordinatorEvents[K]): this;
  emit<K extends keyof CoordinatorEvents>(event: K, ...args: Parameters<CoordinatorEvents[K]>): boolean;
}

export class Coordinator extends EventEmitter {
  private devices: InimDevice[] = [];
  private pollTimer: NodeJS.Timeout | null = null;
  private ws: InimWebSocket | null = null;
  private sia: SiaServer | null = null;
  private stopped = false;
  private inFlightPoll: Promise<void> | null = null;

  constructor(
    private readonly client: InimClient,
    private readonly config: PluginConfig,
    private readonly logger: Logger,
  ) {
    super();
    // Each accessory registers a 'change' listener; with many zones/areas/scenarios
    // we routinely exceed Node's default cap of 10. Raise it so we don't pollute
    // logs with MaxListenersExceededWarning.
    this.setMaxListeners(200);
  }

  getDevices(): InimDevice[] { return this.devices; }

  findArea(deviceId: number, areaId: number): InimArea | undefined {
    return this.devices.find((d) => d.DeviceId === deviceId)?.Areas.find((a) => a.AreaId === areaId);
  }
  findZone(deviceId: number, zoneId: number): InimZone | undefined {
    return this.devices.find((d) => d.DeviceId === deviceId)?.Zones.find((z) => z.ZoneId === zoneId);
  }
  findScenario(deviceId: number, scenarioId: number): InimScenario | undefined {
    return this.devices.find((d) => d.DeviceId === deviceId)?.Scenarios.find((s) => s.ScenarioId === scenarioId);
  }

  async start(): Promise<void> {
    this.logger.info('Starting INIM Cloud coordinator…');
    await this.client.authenticate();
    this.devices = await this.client.getDevicesExtended();
    this.logger.info(
      `Loaded ${this.devices.length} device(s) from INIM Cloud: ` +
        this.devices.map((d) => `${d.Name} (id=${d.DeviceId})`).join(', '),
    );
    this.emit('snapshot', this.devices);
    this.emit('change');

    this.ws = new InimWebSocket({
      logger: this.logger,
      urlProvider: async () => {
        if (!this.client.currentToken) await this.client.authenticate();
        return this.client.buildWebSocketUrl();
      },
      reauthOnReconnect: async () => { await this.client.authenticate(); },
      onEvent: (evt) => this.applyWsEvent(evt),
      onUnknownEvent: () => {
        this.refreshNow().catch((e) =>
          this.logger.warn(`Forced refresh after WS hint failed: ${e.message}`),
        );
      },
    });
    await this.ws.start();

    if (this.config.useSiaIp) {
      try {
        this.sia = new SiaServer({
          port: this.config.siaIpPort ?? 6001,
          accountFilter: this.config.siaAccountId,
          logger: this.logger,
          onAreaUpdate: ({ areaId, armed }) => {
            for (const d of this.devices) {
              const a = d.Areas.find((x) => x.AreaId === areaId);
              if (a) { a.Armed = armed ? 1 : 4; this.emit('change'); break; }
            }
          },
          onZoneUpdate: ({ zoneId, open }) => {
            for (const d of this.devices) {
              const z = d.Zones.find((x) => x.ZoneId === zoneId);
              if (z) {
                z.Status = open ? 2 : 1;
                if (open) z.AlarmMemory = 1;
                this.emit('change');
                break;
              }
            }
          },
        });
        await this.sia.start();
      } catch (e) {
        this.logger.warn(
          `SIA-IP listener failed to start: ${(e as Error).message}. Continuing without SIA.`,
        );
        this.sia = null;
      }
    }

    this.schedulePoll();
  }

  stop(): void {
    this.stopped = true;
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.pollTimer = null;
    this.ws?.stop();
    this.sia?.stop();
  }

  async refreshNow(): Promise<void> {
    if (this.inFlightPoll) return this.inFlightPoll;
    this.inFlightPoll = this.pollOnce().finally(() => { this.inFlightPoll = null; });
    return this.inFlightPoll;
  }

  private schedulePoll(): void {
    if (this.stopped) return;
    const intervalSec = Math.max(15, this.config.pollIntervalSeconds ?? 60);
    this.pollTimer = setTimeout(() => {
      this.pollOnce()
        .catch((e) => this.logger.warn(`Polling cycle failed: ${(e as Error).message}`))
        .finally(() => this.schedulePoll());
    }, intervalSec * 1000);
  }

  private async pollOnce(): Promise<void> {
    const deviceIds = this.devices.map((d) => d.DeviceId);
    try { await this.client.pollAndWait(deviceIds); }
    catch (e) { this.logger.debug(`RequestPoll failed (continuing): ${(e as Error).message}`); }
    const fresh = await this.client.getDevicesExtended();
    this.devices = fresh;
    this.emit('snapshot', fresh);
    this.emit('change');
  }

  private applyWsEvent(evt: WsEventInner): void {
    const device = this.devices.find((d) => d.DeviceId === evt.Device_Id);
    if (!device) {
      this.logger.debug(`WS event for unknown DeviceId=${evt.Device_Id}; forcing refresh.`);
      this.refreshNow().catch(() => undefined);
      return;
    }
    let changed = false;
    for (const zu of evt.ZoneList ?? []) {
      const z = device.Zones.find((zz) => zz.ZoneId === zu.ZoneId);
      if (z) { Object.assign(z, zu); changed = true; }
    }
    for (const au of evt.AreaList ?? []) {
      const a = device.Areas.find((aa) => aa.AreaId === au.AreaId);
      if (a) { Object.assign(a, au); changed = true; }
    }
    if (changed) {
      this.logger.debug(
        `WS event applied to ${device.Name}: ${(evt.ZoneList ?? []).length} zones, ${(evt.AreaList ?? []).length} areas`,
      );
      this.emit('change');
    }
  }
}
