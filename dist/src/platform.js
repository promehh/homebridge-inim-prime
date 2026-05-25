"use strict";
/**
 * Homebridge dynamic platform for INIM Prime alarm systems.
 *
 * Lifecycle:
 *   1. Homebridge calls the constructor with config.
 *   2. configureAccessory() is called once per cached accessory loaded from disk.
 *   3. After didFinishLaunching:
 *        - we authenticate to INIM Cloud
 *        - get the device snapshot
 *        - reconcile accessories: reuse cached, create new, unregister obsolete
 *        - start WS + (optional) SIA + polling loop
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.InimPrimePlatform = void 0;
const settings_1 = require("./settings");
const inimClient_1 = require("./inimClient");
const coordinator_1 = require("./coordinator");
const logger_1 = require("./logger");
const zoneClassifier_1 = require("./zoneClassifier");
const accessories_1 = require("./accessories");
const UNCONFIGURED_AREA_RE = /^area\s*\d+$/i;
class InimPrimePlatform {
    constructor(log, config, api) {
        this.api = api;
        this.cachedAccessories = new Map();
        this.logger = log;
        this.Service = api.hap.Service;
        this.Characteristic = api.hap.Characteristic;
        this.cfg = this.normalizeConfig(config);
        this.verboseLogger = (0, logger_1.withDebug)(log, this.cfg.debug === true);
        this.client = new inimClient_1.InimClient({
            username: this.cfg.username,
            password: this.cfg.password,
            logger: this.verboseLogger,
        });
        this.coordinator = new coordinator_1.Coordinator(this.client, this.cfg, this.verboseLogger);
        this.coordinator.on('error', (e) => this.logger.error(`Coordinator error: ${e.message}`));
        this.api.on('didFinishLaunching', () => {
            this.boot().catch((e) => {
                this.logger.error(`Boot failed: ${e.message}`);
                this.logger.error(`Plugin will keep retrying in the background. Check credentials in config.json.`);
                // Retry the boot every 60s.
                setInterval(() => {
                    this.boot().catch(() => undefined);
                }, 60000);
            });
        });
        this.api.on('shutdown', () => this.coordinator.stop());
    }
    /** Required by DynamicPlatformPlugin. Called once per cached accessory. */
    configureAccessory(accessory) {
        this.cachedAccessories.set(accessory.UUID, accessory);
    }
    // ---- boot --------------------------------------------------------------
    normalizeConfig(raw) {
        const errors = [];
        if (!raw.username)
            errors.push('username');
        if (!raw.password)
            errors.push('password');
        if (!raw.userCode)
            errors.push('userCode');
        if (errors.length > 0) {
            throw new Error(`Missing required config field(s): ${errors.join(', ')}. ` +
                `Edit config.json or use the Homebridge UI to fill them in.`);
        }
        return {
            platform: settings_1.PLATFORM_NAME,
            name: raw.name ?? 'INIM Prime',
            username: String(raw.username),
            password: String(raw.password),
            userCode: String(raw.userCode),
            pollIntervalSeconds: Number(raw.pollIntervalSeconds ?? 60),
            zoneMapping: raw.zoneMapping ?? 'auto',
            exposeExtraSceneSwitches: raw.exposeExtraSceneSwitches !== false,
            areaMode: raw.areaMode ?? 'perArea',
            sceneMapping: raw.sceneMapping ?? {},
            useSiaIp: !!raw.useSiaIp,
            siaIpPort: Number(raw.siaIpPort ?? 6001),
            siaAccountId: raw.siaAccountId ? String(raw.siaAccountId) : undefined,
            debug: !!raw.debug,
        };
    }
    async boot() {
        this.logger.info('Booting INIM Prime platform…');
        await this.coordinator.start();
        this.syncAccessories();
        this.coordinator.on('snapshot', () => {
            // If a snapshot reveals new areas/zones/scenarios, sync again.
            this.syncAccessories();
        });
    }
    // ---- accessory reconciliation -----------------------------------------
    uuidFor(ctx) {
        const key = JSON.stringify(ctx);
        return this.api.hap.uuid.generate(`inim-prime:${key}`);
    }
    displayNameFor(device, ctx) {
        switch (ctx.kind) {
            case 'global-sec':
                return `${device.Name} Allarme`;
            case 'area-sec': {
                const a = device.Areas.find((x) => x.AreaId === ctx.areaId);
                return `${device.Name} - ${a?.Name ?? 'Area ' + ctx.areaId}`;
            }
            case 'area-switch': {
                const a = device.Areas.find((x) => x.AreaId === ctx.areaId);
                return `${a?.Name ?? 'Area ' + ctx.areaId} switch`;
            }
            case 'scene-switch': {
                const s = device.Scenarios.find((x) => x.ScenarioId === ctx.scenarioId);
                return `Scenario ${s?.Name ?? '#' + ctx.scenarioId}`;
            }
            case 'zone-contact':
            case 'zone-motion': {
                const z = device.Zones.find((x) => x.ZoneId === ctx.zoneId);
                return z?.Name ?? `Zona ${ctx.zoneId}`;
            }
        }
    }
    shouldExposeZone(zone) {
        if (zone.Visibility === 0)
            return { expose: false, kind: 'contact' };
        const k = (0, zoneClassifier_1.classifyZone)(zone.Name, this.cfg.zoneMapping ?? 'auto');
        if (k === 'skip')
            return { expose: false, kind: 'contact' };
        return { expose: true, kind: k };
    }
    syncAccessories() {
        const devices = this.coordinator.getDevices();
        const desired = new Map();
        for (const device of devices) {
            // Areas
            const visibleAreas = device.Areas.filter((a) => !UNCONFIGURED_AREA_RE.test(a.Name?.trim() ?? ''));
            if (this.cfg.areaMode === 'perArea') {
                for (const a of visibleAreas) {
                    const ctx = {
                        kind: 'area-sec',
                        deviceId: device.DeviceId,
                        areaId: a.AreaId,
                    };
                    desired.set(this.uuidFor(ctx), { ctx, device });
                }
            }
            else if (this.cfg.areaMode === 'globalOnly') {
                const ctx = { kind: 'global-sec', deviceId: device.DeviceId };
                desired.set(this.uuidFor(ctx), { ctx, device });
            }
            else if (this.cfg.areaMode === 'globalPlusSwitches') {
                const g = { kind: 'global-sec', deviceId: device.DeviceId };
                desired.set(this.uuidFor(g), { ctx: g, device });
                for (const a of visibleAreas) {
                    const ctx = {
                        kind: 'area-switch',
                        deviceId: device.DeviceId,
                        areaId: a.AreaId,
                    };
                    desired.set(this.uuidFor(ctx), { ctx, device });
                }
            }
            // Scenarios
            if (this.cfg.exposeExtraSceneSwitches) {
                for (const s of device.Scenarios) {
                    const ctx = {
                        kind: 'scene-switch',
                        deviceId: device.DeviceId,
                        scenarioId: s.ScenarioId,
                    };
                    desired.set(this.uuidFor(ctx), { ctx, device });
                }
            }
            // Zones
            for (const z of device.Zones) {
                const decision = this.shouldExposeZone(z);
                if (!decision.expose)
                    continue;
                const ctx = {
                    kind: decision.kind === 'motion' ? 'zone-motion' : 'zone-contact',
                    deviceId: device.DeviceId,
                    zoneId: z.ZoneId,
                };
                desired.set(this.uuidFor(ctx), { ctx, device });
            }
        }
        // Unregister anything cached that's no longer desired.
        const toUnregister = [];
        for (const [uuid, acc] of this.cachedAccessories.entries()) {
            if (!desired.has(uuid))
                toUnregister.push(acc);
        }
        if (toUnregister.length > 0) {
            this.api.unregisterPlatformAccessories(settings_1.PLUGIN_NAME, settings_1.PLATFORM_NAME, toUnregister);
            for (const a of toUnregister)
                this.cachedAccessories.delete(a.UUID);
            this.logger.info(`Removed ${toUnregister.length} stale accessory(ies).`);
        }
        // Register / wire up.
        const env = {
            api: this.api,
            logger: this.verboseLogger,
            client: this.client,
            coordinator: this.coordinator,
            config: this.cfg,
        };
        for (const [uuid, { ctx, device }] of desired.entries()) {
            let acc = this.cachedAccessories.get(uuid);
            const name = this.displayNameFor(device, ctx);
            let isNew = false;
            if (!acc) {
                acc = new this.api.platformAccessory(name, uuid);
                isNew = true;
            }
            else if (acc.displayName !== name) {
                acc.displayName = name;
            }
            acc.context = { ...ctx };
            this.attachHandler(env, acc, ctx);
            if (isNew) {
                this.api.registerPlatformAccessories(settings_1.PLUGIN_NAME, settings_1.PLATFORM_NAME, [acc]);
                this.cachedAccessories.set(uuid, acc);
                this.logger.info(`Added accessory: ${name}`);
            }
        }
    }
    attachHandler(env, acc, ctx) {
        switch (ctx.kind) {
            case 'area-sec':
                new accessories_1.AreaSecuritySystemHandler(env, acc, ctx.deviceId, ctx.areaId);
                break;
            case 'global-sec':
                new accessories_1.GlobalSecuritySystemHandler(env, acc, ctx.deviceId);
                break;
            case 'area-switch':
                new accessories_1.AreaSwitchHandler(env, acc, ctx.deviceId, ctx.areaId);
                break;
            case 'scene-switch':
                new accessories_1.ScenarioSwitchHandler(env, acc, ctx.deviceId, ctx.scenarioId);
                break;
            case 'zone-contact':
                new accessories_1.ContactZoneHandler(env, acc, ctx.deviceId, ctx.zoneId);
                break;
            case 'zone-motion':
                new accessories_1.MotionZoneHandler(env, acc, ctx.deviceId, ctx.zoneId);
                break;
        }
    }
}
exports.InimPrimePlatform = InimPrimePlatform;
