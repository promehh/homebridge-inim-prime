"use strict";
/**
 * Coordinator: orchestrates REST polling, WebSocket events, and (optional)
 * SIA-IP push, into a single in-memory cache of devices/areas/zones/scenarios.
 *
 * Emits change notifications via Node's EventEmitter so accessories can update
 * HomeKit characteristics without rebuilding the platform.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.Coordinator = void 0;
const events_1 = require("events");
const inimWebSocket_1 = require("./inimWebSocket");
const siaServer_1 = require("./siaServer");
class Coordinator extends events_1.EventEmitter {
    constructor(client, config, logger) {
        super();
        this.client = client;
        this.config = config;
        this.logger = logger;
        this.devices = [];
        this.pollTimer = null;
        this.ws = null;
        this.sia = null;
        this.stopped = false;
        this.inFlightPoll = null;
        // Each accessory registers a 'change' listener once at startup; with the
        // listener-leak fix in v0.1.4 these don't accumulate anymore. Keep a safety
        // margin above Node's default 10 to support installations with many zones.
        this.setMaxListeners(64);
    }
    getDevices() {
        return this.devices;
    }
    findArea(deviceId, areaId) {
        return this.devices
            .find((d) => d.DeviceId === deviceId)
            ?.Areas.find((a) => a.AreaId === areaId);
    }
    findZone(deviceId, zoneId) {
        return this.devices
            .find((d) => d.DeviceId === deviceId)
            ?.Zones.find((z) => z.ZoneId === zoneId);
    }
    findScenario(deviceId, scenarioId) {
        return this.devices
            .find((d) => d.DeviceId === deviceId)
            ?.Scenarios.find((s) => s.ScenarioId === scenarioId);
    }
    /**
     * Initial bootstrap: authenticate, do the first GetDevicesExtended, then
     * start WS + SIA + polling.
     */
    async start() {
        this.logger.info('Starting INIM Cloud coordinator…');
        await this.client.authenticate();
        // First read: no RequestPoll (we don't have device IDs yet).
        this.devices = await this.client.getDevicesExtended();
        this.logger.info(`Loaded ${this.devices.length} device(s) from INIM Cloud: ${this.devices
            .map((d) => `${d.Name} (id=${d.DeviceId})`)
            .join(', ')}`);
        this.emit('snapshot', this.devices);
        this.emit('change');
        // Start WS.
        this.ws = new inimWebSocket_1.InimWebSocket({
            logger: this.logger,
            urlProvider: async () => {
                if (!this.client.currentToken)
                    await this.client.authenticate();
                return this.client.buildWebSocketUrl();
            },
            reauthOnReconnect: async () => {
                await this.client.authenticate();
            },
            onEvent: (evt) => this.applyWsEvent(evt),
            onUnknownEvent: () => {
                // The HA integration forces a refresh; do the same.
                this.refreshNow().catch((e) => this.logger.warn(`Forced refresh after WS hint failed: ${e.message}`));
            },
        });
        await this.ws.start();
        // Start SIA-IP if requested.
        if (this.config.useSiaIp) {
            try {
                this.sia = new siaServer_1.SiaServer({
                    port: this.config.siaIpPort ?? 6001,
                    accountFilter: this.config.siaAccountId,
                    logger: this.logger,
                    onAreaUpdate: ({ areaId, armed }) => {
                        for (const d of this.devices) {
                            const a = d.Areas.find((x) => x.AreaId === areaId);
                            if (a) {
                                a.Armed = armed ? 1 : 4;
                                this.emit('change');
                                break;
                            }
                        }
                    },
                    onZoneUpdate: ({ zoneId, open }) => {
                        for (const d of this.devices) {
                            const z = d.Zones.find((x) => x.ZoneId === zoneId);
                            if (z) {
                                z.Status = open ? 2 : 1;
                                if (open)
                                    z.AlarmMemory = 1;
                                this.emit('change');
                                break;
                            }
                        }
                    },
                });
                await this.sia.start();
            }
            catch (e) {
                this.logger.warn(`SIA-IP listener failed to start: ${e.message}. ` +
                    `Continuing without SIA (WebSocket still active).`);
                this.sia = null;
            }
        }
        // Start polling loop.
        this.schedulePoll();
    }
    stop() {
        this.stopped = true;
        if (this.pollTimer)
            clearTimeout(this.pollTimer);
        this.pollTimer = null;
        this.ws?.stop();
        this.sia?.stop();
    }
    /** Trigger an immediate full refresh; safe to call concurrently. */
    async refreshNow() {
        if (this.inFlightPoll)
            return this.inFlightPoll;
        this.inFlightPoll = this.pollOnce().finally(() => {
            this.inFlightPoll = null;
        });
        return this.inFlightPoll;
    }
    // ---- internals -------------------------------------------------------
    schedulePoll() {
        if (this.stopped)
            return;
        const intervalSec = Math.max(15, this.config.pollIntervalSeconds ?? 60);
        this.pollTimer = setTimeout(() => {
            this.pollOnce()
                .catch((e) => this.logger.warn(`Polling cycle failed: ${e.message}`))
                .finally(() => this.schedulePoll());
        }, intervalSec * 1000);
    }
    async pollOnce() {
        const deviceIds = this.devices.map((d) => d.DeviceId);
        try {
            await this.client.pollAndWait(deviceIds);
        }
        catch (e) {
            this.logger.debug(`RequestPoll failed (continuing): ${e.message}`);
        }
        const fresh = await this.client.getDevicesExtended();
        this.devices = fresh;
        this.emit('snapshot', fresh);
        this.emit('change');
    }
    applyWsEvent(evt) {
        const targetDeviceId = evt.Device_Id;
        const device = this.devices.find((d) => d.DeviceId === targetDeviceId);
        if (!device) {
            this.logger.debug(`WS event for unknown DeviceId=${targetDeviceId}; forcing full refresh.`);
            this.refreshNow().catch(() => undefined);
            return;
        }
        let changed = false;
        for (const zu of evt.ZoneList ?? []) {
            const z = device.Zones.find((zz) => zz.ZoneId === zu.ZoneId);
            if (z) {
                Object.assign(z, zu);
                changed = true;
            }
        }
        for (const au of evt.AreaList ?? []) {
            const a = device.Areas.find((aa) => aa.AreaId === au.AreaId);
            if (a) {
                Object.assign(a, au);
                changed = true;
            }
        }
        if (changed) {
            this.logger.debug(`WS event applied to device ${device.Name}: ` +
                `${(evt.ZoneList ?? []).length} zone updates, ` +
                `${(evt.AreaList ?? []).length} area updates`);
            this.emit('change');
        }
    }
}
exports.Coordinator = Coordinator;
