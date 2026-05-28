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

import type {
  API,
  Logging,
  PlatformAccessory,
  PlatformConfig,
  DynamicPlatformPlugin,
} from 'homebridge';

import { PLATFORM_NAME, PLUGIN_NAME } from './settings';
import { InimClient } from './inimClient';
import { Coordinator } from './coordinator';
import { withDebug } from './logger';
import { PluginConfig, InimDevice, InimZone } from './types';
import { classifyZone } from './zoneClassifier';
import {
  AreaSecuritySystemHandler,
  AreaSwitchHandler,
  ContactZoneHandler,
  GlobalSecuritySystemHandler,
  HandlerEnv,
  MotionZoneHandler,
  ScenarioSwitchHandler,
} from './accessories';

const UNCONFIGURED_AREA_RE = /^area\s*\d+$/i;

interface CtxBase {
  deviceId: number;
}
interface AreaCtx extends CtxBase {
  kind: 'area-sec' | 'area-switch';
  areaId: number;
}
interface GlobalCtx extends CtxBase {
  kind: 'global-sec';
}
interface SceneCtx extends CtxBase {
  kind: 'scene-switch';
  scenarioId: number;
}
interface ZoneCtx extends CtxBase {
  kind: 'zone-contact' | 'zone-motion';
  zoneId: number;
}
type AccessoryCtx = AreaCtx | GlobalCtx | SceneCtx | ZoneCtx;

export class InimPrimePlatform implements DynamicPlatformPlugin {
  public readonly Service: typeof import('homebridge').Service;
  public readonly Characteristic: typeof import('homebridge').Characteristic;

  private readonly logger: Logging;
  private readonly verboseLogger: ReturnType<typeof withDebug>;
  private readonly cfg: PluginConfig;
  private readonly client: InimClient;
  private readonly coordinator: Coordinator;
  private readonly cachedAccessories = new Map<string, PlatformAccessory>();
  /** UUIDs whose handler has already been attached (subscribed to coordinator events).
   *  Without this, every call to syncAccessories() would attach a new handler →
   *  the Coordinator EventEmitter would accumulate one extra 'change' listener per
   *  accessory per poll cycle, eventually triggering MaxListenersExceededWarning. */
  private readonly attachedHandlers = new Set<string>();

  constructor(
    log: Logging,
    config: PlatformConfig,
    public readonly api: API,
  ) {
    this.logger = log;
    this.Service = api.hap.Service;
    this.Characteristic = api.hap.Characteristic;

    this.cfg = this.normalizeConfig(config);
    this.verboseLogger = withDebug(log, this.cfg.debug === true);

    this.client = new InimClient({
      username: this.cfg.username,
      password: this.cfg.password,
      logger: this.verboseLogger,
    });
    this.coordinator = new Coordinator(this.client, this.cfg, this.verboseLogger);

    this.coordinator.on('error', (e) =>
      this.logger.error(`Coordinator error: ${e.message}`),
    );

    this.api.on('didFinishLaunching', () => {
      this.boot().catch((e) => {
        this.logger.error(`Boot failed: ${(e as Error).message}`);
        this.logger.error(
          `Plugin will keep retrying in the background. Check credentials in config.json.`,
        );
        // Retry the boot every 60s.
        setInterval(() => {
          this.boot().catch(() => undefined);
        }, 60_000);
      });
    });
    this.api.on('shutdown', () => this.coordinator.stop());
  }

  /** Required by DynamicPlatformPlugin. Called once per cached accessory. */
  configureAccessory(accessory: PlatformAccessory): void {
    this.cachedAccessories.set(accessory.UUID, accessory);
  }

  // ---- boot --------------------------------------------------------------

  private normalizeConfig(raw: PlatformConfig): PluginConfig {
    const errors: string[] = [];
    if (!raw.username) errors.push('username');
    if (!raw.password) errors.push('password');
    if (!raw.userCode) errors.push('userCode');
    if (errors.length > 0) {
      throw new Error(
        `Missing required config field(s): ${errors.join(', ')}. ` +
          `Edit config.json or use the Homebridge UI to fill them in.`,
      );
    }
    return {
      platform: PLATFORM_NAME,
      name: (raw.name as string) ?? 'INIM Prime',
      username: String(raw.username),
      password: String(raw.password),
      userCode: String(raw.userCode),
      pollIntervalSeconds: Number(raw.pollIntervalSeconds ?? 60),
      zoneMapping: (raw.zoneMapping as PluginConfig['zoneMapping']) ?? 'auto',
      exposeExtraSceneSwitches: raw.exposeExtraSceneSwitches !== false,
      areaMode: (raw.areaMode as PluginConfig['areaMode']) ?? 'perArea',
      sceneMapping: (raw.sceneMapping as PluginConfig['sceneMapping']) ?? {},
      useSiaIp: !!raw.useSiaIp,
      siaIpPort: Number(raw.siaIpPort ?? 6001),
      siaAccountId: raw.siaAccountId ? String(raw.siaAccountId) : undefined,
      debug: !!raw.debug,
    };
  }

  private async boot(): Promise<void> {
    this.logger.info('Booting INIM Prime platform…');
    await this.coordinator.start();
    this.syncAccessories();
    this.coordinator.on('snapshot', () => {
      // If a snapshot reveals new areas/zones/scenarios, sync again.
      this.syncAccessories();
    });
  }

  // ---- accessory reconciliation -----------------------------------------

  private uuidFor(ctx: AccessoryCtx): string {
    const key = JSON.stringify(ctx);
    return this.api.hap.uuid.generate(`inim-prime:${key}`);
  }

  private displayNameFor(device: InimDevice, ctx: AccessoryCtx): string {
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

  private shouldExposeZone(zone: InimZone): {
    expose: boolean;
    kind: 'contact' | 'motion';
  } {
    if (zone.Visibility === 0) return { expose: false, kind: 'contact' };
    const k = classifyZone(zone.Name, this.cfg.zoneMapping ?? 'auto');
    if (k === 'skip') return { expose: false, kind: 'contact' };
    return { expose: true, kind: k };
  }

  private syncAccessories(): void {
    const devices = this.coordinator.getDevices();
    const desired = new Map<string, { ctx: AccessoryCtx; device: InimDevice }>();

    for (const device of devices) {
      // Areas
      const visibleAreas = device.Areas.filter(
        (a) => !UNCONFIGURED_AREA_RE.test(a.Name?.trim() ?? ''),
      );

      if (this.cfg.areaMode === 'perArea') {
        for (const a of visibleAreas) {
          const ctx: AccessoryCtx = {
            kind: 'area-sec',
            deviceId: device.DeviceId,
            areaId: a.AreaId,
          };
          desired.set(this.uuidFor(ctx), { ctx, device });
        }
      } else if (this.cfg.areaMode === 'globalOnly') {
        const ctx: AccessoryCtx = { kind: 'global-sec', deviceId: device.DeviceId };
        desired.set(this.uuidFor(ctx), { ctx, device });
      } else if (this.cfg.areaMode === 'globalPlusSwitches') {
        const g: AccessoryCtx = { kind: 'global-sec', deviceId: device.DeviceId };
        desired.set(this.uuidFor(g), { ctx: g, device });
        for (const a of visibleAreas) {
          const ctx: AccessoryCtx = {
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
          const ctx: AccessoryCtx = {
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
        if (!decision.expose) continue;
        const ctx: AccessoryCtx = {
          kind: decision.kind === 'motion' ? 'zone-motion' : 'zone-contact',
          deviceId: device.DeviceId,
          zoneId: z.ZoneId,
        };
        desired.set(this.uuidFor(ctx), { ctx, device });
      }
    }

    // Unregister anything cached that's no longer desired.
    const toUnregister: PlatformAccessory[] = [];
    for (const [uuid, acc] of this.cachedAccessories.entries()) {
      if (!desired.has(uuid)) toUnregister.push(acc);
    }
    if (toUnregister.length > 0) {
      this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, toUnregister);
      for (const a of toUnregister) {
        this.cachedAccessories.delete(a.UUID);
        this.attachedHandlers.delete(a.UUID);
      }
      this.logger.info(`Removed ${toUnregister.length} stale accessory(ies).`);
    }

    // Register / wire up.
    const env: HandlerEnv = {
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
      } else if (acc.displayName !== name) {
        acc.displayName = name;
      }
      acc.context = { ...ctx };
      // Attach handler ONLY ONCE per accessory UUID. If syncAccessories() runs
      // again (after a polling refresh or snapshot), skip re-attaching to avoid
      // accumulating EventEmitter listeners on the Coordinator.
      if (!this.attachedHandlers.has(uuid)) {
        this.attachHandler(env, acc, ctx);
        this.attachedHandlers.add(uuid);
      }
      if (isNew) {
        this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [acc]);
        this.cachedAccessories.set(uuid, acc);
        this.logger.info(`Added accessory: ${name}`);
      }
    }
  }

  private attachHandler(env: HandlerEnv, acc: PlatformAccessory, ctx: AccessoryCtx): void {
    switch (ctx.kind) {
      case 'area-sec':
        new AreaSecuritySystemHandler(env, acc, ctx.deviceId, ctx.areaId);
        break;
      case 'global-sec':
        new GlobalSecuritySystemHandler(env, acc, ctx.deviceId);
        break;
      case 'area-switch':
        new AreaSwitchHandler(env, acc, ctx.deviceId, ctx.areaId);
        break;
      case 'scene-switch':
        new ScenarioSwitchHandler(env, acc, ctx.deviceId, ctx.scenarioId);
        break;
      case 'zone-contact':
        new ContactZoneHandler(env, acc, ctx.deviceId, ctx.zoneId);
        break;
      case 'zone-motion':
        new MotionZoneHandler(env, acc, ctx.deviceId, ctx.zoneId);
        break;
    }
  }
}
