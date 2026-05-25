/**
 * HomeKit accessory handlers.
 *
 * One class per kind of exposed object:
 *   - AreaSecuritySystemHandler: per-area SecuritySystem.
 *   - GlobalSecuritySystemHandler: a single SecuritySystem covering the whole device
 *     (and optionally mapped to scenarios for stay/away/night).
 *   - ScenarioSwitchHandler: a stateless-ish Switch that activates a scenario.
 *   - AreaSwitchHandler: a Switch that arms/disarms one area.
 *   - ContactZoneHandler / MotionZoneHandler: zone sensors.
 *
 * Each handler stores its config in `accessory.context` so it survives
 * Homebridge restarts.
 */

import type { PlatformAccessory, Service, CharacteristicValue } from 'homebridge';
import { Logger } from './logger';
import { InimClient } from './inimClient';
import { Coordinator } from './coordinator';
import { InimArea, InimDevice, PluginConfig } from './types';

/** Constants from the Homebridge Characteristic.SecuritySystem*State enums.
 *  We don't hardcode them here — we read them from the API at construction time.
 */
interface SecConstants {
  STAY_ARM: number;
  AWAY_ARM: number;
  NIGHT_ARM: number;
  DISARMED: number;
  ALARM_TRIGGERED: number;
}

export interface HandlerEnv {
  api: import('homebridge').API;
  logger: Logger;
  client: InimClient;
  coordinator: Coordinator;
  config: PluginConfig;
}

// ---------- helpers --------------------------------------------------------

function readSecConstants(api: import('homebridge').API): SecConstants {
  const C = api.hap.Characteristic;
  return {
    STAY_ARM: C.SecuritySystemCurrentState.STAY_ARM,
    AWAY_ARM: C.SecuritySystemCurrentState.AWAY_ARM,
    NIGHT_ARM: C.SecuritySystemCurrentState.NIGHT_ARM,
    DISARMED: C.SecuritySystemCurrentState.DISARMED,
    ALARM_TRIGGERED: C.SecuritySystemCurrentState.ALARM_TRIGGERED,
  };
}

function isAlarming(area: InimArea | undefined): boolean {
  if (!area) return false;
  if (typeof area.Alarm === 'boolean') return area.Alarm;
  return !!area.Alarm;
}

function armedToHkCurrent(area: InimArea | undefined, sec: SecConstants): number {
  if (!area) return sec.DISARMED;
  if (isAlarming(area)) return sec.ALARM_TRIGGERED;
  switch (area.Armed) {
    case 1:
      return sec.AWAY_ARM;
    case 2:
    case 3:
      return sec.STAY_ARM;
    case 4:
    default:
      return sec.DISARMED;
  }
}

function ensureAccessoryInformation(
  acc: PlatformAccessory,
  api: import('homebridge').API,
  device: InimDevice,
): void {
  const C = api.hap.Characteristic;
  const info =
    acc.getService(api.hap.Service.AccessoryInformation) ??
    acc.addService(api.hap.Service.AccessoryInformation);
  info.setCharacteristic(C.Manufacturer, 'INIM Electronics');
  info.setCharacteristic(C.Model, `${device.ModelFamily ?? 'Prime'} ${device.ModelNumber ?? ''}`.trim());
  info.setCharacteristic(C.SerialNumber, device.SerialNumber ?? `dev-${device.DeviceId}`);
  const fwMajor = device.FirmwareVersionMajor ?? 0;
  const fwMinor = device.FirmwareVersionMinor ?? 0;
  info.setCharacteristic(C.FirmwareRevision, `${fwMajor}.${fwMinor}`);
}

// ---------- AreaSecuritySystemHandler -------------------------------------

export class AreaSecuritySystemHandler {
  private service: Service;
  private sec: SecConstants;

  constructor(
    private readonly env: HandlerEnv,
    private readonly accessory: PlatformAccessory,
    private readonly deviceId: number,
    private readonly areaId: number,
  ) {
    const { api } = env;
    this.sec = readSecConstants(api);

    const device = env.coordinator
      .getDevices()
      .find((d) => d.DeviceId === deviceId);
    if (device) ensureAccessoryInformation(accessory, api, device);

    this.service =
      accessory.getService(api.hap.Service.SecuritySystem) ??
      accessory.addService(api.hap.Service.SecuritySystem);

    const C = api.hap.Characteristic;
    this.service
      .getCharacteristic(C.SecuritySystemCurrentState)
      .onGet(() => this.getCurrentState());
    this.service
      .getCharacteristic(C.SecuritySystemTargetState)
      .onGet(() => this.getTargetState())
      .onSet((v) => this.setTargetState(v));

    env.coordinator.on('change', () => this.pushUpdate());
  }

  private getCurrentState(): number {
    const area = this.env.coordinator.findArea(this.deviceId, this.areaId);
    return armedToHkCurrent(area, this.sec);
  }
  private getTargetState(): number {
    const c = this.getCurrentState();
    return c === this.sec.ALARM_TRIGGERED ? this.sec.AWAY_ARM : c;
  }
  private async setTargetState(value: CharacteristicValue): Promise<void> {
    const arm = value !== this.sec.DISARMED;
    this.env.logger.info(
      `[Area ${this.areaId}] Set target ${value} -> ${arm ? 'ARM' : 'DISARM'}`,
    );
    try {
      await this.env.client.insertAreas(
        this.deviceId,
        [this.areaId],
        arm,
        this.env.config.userCode,
      );
      // Optimistic update — the WS event / next poll will confirm.
      const area = this.env.coordinator.findArea(this.deviceId, this.areaId);
      if (area) {
        area.Armed = arm ? 1 : 4;
        this.pushUpdate();
      }
    } catch (e) {
      this.env.logger.error(
        `[Area ${this.areaId}] Arm/disarm failed: ${(e as Error).message}`,
      );
      throw new this.env.api.hap.HapStatusError(
        this.env.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE,
      );
    }
  }
  private pushUpdate(): void {
    const C = this.env.api.hap.Characteristic;
    const cur = this.getCurrentState();
    this.service.updateCharacteristic(C.SecuritySystemCurrentState, cur);
    this.service.updateCharacteristic(
      C.SecuritySystemTargetState,
      cur === this.sec.ALARM_TRIGGERED ? this.sec.AWAY_ARM : cur,
    );
  }
}

// ---------- GlobalSecuritySystemHandler -----------------------------------

export class GlobalSecuritySystemHandler {
  private service: Service;
  private sec: SecConstants;

  constructor(
    private readonly env: HandlerEnv,
    private readonly accessory: PlatformAccessory,
    private readonly deviceId: number,
  ) {
    const { api } = env;
    this.sec = readSecConstants(api);

    const device = env.coordinator
      .getDevices()
      .find((d) => d.DeviceId === deviceId);
    if (device) ensureAccessoryInformation(accessory, api, device);

    this.service =
      accessory.getService(api.hap.Service.SecuritySystem) ??
      accessory.addService(api.hap.Service.SecuritySystem);
    const C = api.hap.Characteristic;
    this.service
      .getCharacteristic(C.SecuritySystemCurrentState)
      .onGet(() => this.getCurrentState());
    this.service
      .getCharacteristic(C.SecuritySystemTargetState)
      .onGet(() => this.getTargetState())
      .onSet((v) => this.setTargetState(v));

    env.coordinator.on('change', () => this.pushUpdate());
  }

  private getCurrentState(): number {
    const device = this.env.coordinator
      .getDevices()
      .find((d) => d.DeviceId === this.deviceId);
    if (!device) return this.sec.DISARMED;
    // Alarm flag on any area => triggered.
    if (device.Areas.some(isAlarming)) return this.sec.ALARM_TRIGGERED;

    // If scene mapping defined, prefer scenario-based current state.
    const sceneMap = this.env.config.sceneMapping ?? {};
    const active = device.ActiveScenario;
    if (typeof active === 'number') {
      if (sceneMap.disarmScenarioId === active) return this.sec.DISARMED;
      if (sceneMap.stayScenarioId === active) return this.sec.STAY_ARM;
      if (sceneMap.awayScenarioId === active) return this.sec.AWAY_ARM;
      if (sceneMap.nightScenarioId === active) return this.sec.NIGHT_ARM;
    }
    // Fallback: aggregate area state.
    const armedCounts = { full: 0, partial: 0, disarmed: 0 };
    for (const a of device.Areas) {
      if (a.Armed === 1) armedCounts.full += 1;
      else if (a.Armed === 2 || a.Armed === 3) armedCounts.partial += 1;
      else armedCounts.disarmed += 1;
    }
    if (armedCounts.full === 0 && armedCounts.partial === 0) return this.sec.DISARMED;
    if (armedCounts.disarmed === 0 && armedCounts.partial === 0) return this.sec.AWAY_ARM;
    return this.sec.STAY_ARM;
  }
  private getTargetState(): number {
    const c = this.getCurrentState();
    return c === this.sec.ALARM_TRIGGERED ? this.sec.AWAY_ARM : c;
  }
  private async setTargetState(value: CharacteristicValue): Promise<void> {
    const device = this.env.coordinator
      .getDevices()
      .find((d) => d.DeviceId === this.deviceId);
    if (!device) {
      throw new this.env.api.hap.HapStatusError(
        this.env.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE,
      );
    }
    const v = Number(value);
    const sceneMap = this.env.config.sceneMapping ?? {};
    let scenarioId: number | undefined;
    if (v === this.sec.STAY_ARM) scenarioId = sceneMap.stayScenarioId;
    else if (v === this.sec.AWAY_ARM) scenarioId = sceneMap.awayScenarioId;
    else if (v === this.sec.NIGHT_ARM) scenarioId = sceneMap.nightScenarioId;
    else if (v === this.sec.DISARMED) scenarioId = sceneMap.disarmScenarioId;

    try {
      if (typeof scenarioId === 'number') {
        this.env.logger.info(
          `[Global] Set target ${v} -> ActivateScenario(${scenarioId})`,
        );
        await this.env.client.activateScenario(this.deviceId, scenarioId);
      } else {
        // Fallback: arm or disarm ALL configured areas via InsertAreas.
        const areaIds = device.Areas.map((a) => a.AreaId);
        if (areaIds.length === 0) return;
        const arm = v !== this.sec.DISARMED;
        this.env.logger.info(
          `[Global] Set target ${v} -> InsertAreas(${arm ? 'arm' : 'disarm'} all ${areaIds.length})`,
        );
        await this.env.client.insertAreas(
          this.deviceId,
          areaIds,
          arm,
          this.env.config.userCode,
        );
        // Optimistic
        for (const a of device.Areas) a.Armed = arm ? 1 : 4;
      }
      this.pushUpdate();
    } catch (e) {
      this.env.logger.error(
        `[Global] Set target failed: ${(e as Error).message}`,
      );
      throw new this.env.api.hap.HapStatusError(
        this.env.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE,
      );
    }
  }
  private pushUpdate(): void {
    const C = this.env.api.hap.Characteristic;
    const cur = this.getCurrentState();
    this.service.updateCharacteristic(C.SecuritySystemCurrentState, cur);
    this.service.updateCharacteristic(
      C.SecuritySystemTargetState,
      cur === this.sec.ALARM_TRIGGERED ? this.sec.AWAY_ARM : cur,
    );
  }
}

// ---------- ScenarioSwitchHandler -----------------------------------------

export class ScenarioSwitchHandler {
  private service: Service;

  constructor(
    private readonly env: HandlerEnv,
    private readonly accessory: PlatformAccessory,
    private readonly deviceId: number,
    private readonly scenarioId: number,
  ) {
    const { api } = env;
    const device = env.coordinator
      .getDevices()
      .find((d) => d.DeviceId === deviceId);
    if (device) ensureAccessoryInformation(accessory, api, device);

    this.service =
      accessory.getService(api.hap.Service.Switch) ??
      accessory.addService(api.hap.Service.Switch);
    const C = api.hap.Characteristic;
    this.service
      .getCharacteristic(C.On)
      .onGet(() => this.isActive())
      .onSet((v) => this.setOn(v));

    env.coordinator.on('change', () => {
      this.service.updateCharacteristic(C.On, this.isActive());
    });
  }

  private isActive(): boolean {
    const d = this.env.coordinator
      .getDevices()
      .find((dd) => dd.DeviceId === this.deviceId);
    return d?.ActiveScenario === this.scenarioId;
  }
  private async setOn(v: CharacteristicValue): Promise<void> {
    if (!v) {
      // Switching a scenario "off" doesn't really apply. Reflect actual state
      // back to HomeKit after a short delay so the switch flips back if needed.
      setTimeout(() => {
        this.service.updateCharacteristic(
          this.env.api.hap.Characteristic.On,
          this.isActive(),
        );
      }, 500);
      return;
    }
    try {
      this.env.logger.info(`[Scenario ${this.scenarioId}] Activate`);
      await this.env.client.activateScenario(this.deviceId, this.scenarioId);
      const d = this.env.coordinator
        .getDevices()
        .find((dd) => dd.DeviceId === this.deviceId);
      if (d) d.ActiveScenario = this.scenarioId;
    } catch (e) {
      this.env.logger.error(
        `[Scenario ${this.scenarioId}] Activate failed: ${(e as Error).message}`,
      );
      throw new this.env.api.hap.HapStatusError(
        this.env.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE,
      );
    }
  }
}

// ---------- AreaSwitchHandler ---------------------------------------------

export class AreaSwitchHandler {
  private service: Service;
  constructor(
    private readonly env: HandlerEnv,
    private readonly accessory: PlatformAccessory,
    private readonly deviceId: number,
    private readonly areaId: number,
  ) {
    const { api } = env;
    const device = env.coordinator
      .getDevices()
      .find((d) => d.DeviceId === deviceId);
    if (device) ensureAccessoryInformation(accessory, api, device);

    this.service =
      accessory.getService(api.hap.Service.Switch) ??
      accessory.addService(api.hap.Service.Switch);
    const C = api.hap.Characteristic;
    this.service
      .getCharacteristic(C.On)
      .onGet(() => this.isArmed())
      .onSet((v) => this.setArmed(!!v));
    env.coordinator.on('change', () =>
      this.service.updateCharacteristic(C.On, this.isArmed()),
    );
  }
  private isArmed(): boolean {
    const a = this.env.coordinator.findArea(this.deviceId, this.areaId);
    return !!a && a.Armed !== 4;
  }
  private async setArmed(arm: boolean): Promise<void> {
    try {
      this.env.logger.info(
        `[Area ${this.areaId} switch] Set ${arm ? 'arm' : 'disarm'}`,
      );
      await this.env.client.insertAreas(
        this.deviceId,
        [this.areaId],
        arm,
        this.env.config.userCode,
      );
      const a = this.env.coordinator.findArea(this.deviceId, this.areaId);
      if (a) a.Armed = arm ? 1 : 4;
    } catch (e) {
      this.env.logger.error(
        `[Area ${this.areaId} switch] Failed: ${(e as Error).message}`,
      );
      throw new this.env.api.hap.HapStatusError(
        this.env.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE,
      );
    }
  }
}

// ---------- ContactZoneHandler --------------------------------------------

export class ContactZoneHandler {
  private service: Service;
  constructor(
    private readonly env: HandlerEnv,
    private readonly accessory: PlatformAccessory,
    private readonly deviceId: number,
    private readonly zoneId: number,
  ) {
    const { api } = env;
    const device = env.coordinator
      .getDevices()
      .find((d) => d.DeviceId === deviceId);
    if (device) ensureAccessoryInformation(accessory, api, device);

    this.service =
      accessory.getService(api.hap.Service.ContactSensor) ??
      accessory.addService(api.hap.Service.ContactSensor);
    const C = api.hap.Characteristic;
    this.service
      .getCharacteristic(C.ContactSensorState)
      .onGet(() => this.read());
    env.coordinator.on('change', () =>
      this.service.updateCharacteristic(C.ContactSensorState, this.read()),
    );
  }
  private read(): number {
    const C = this.env.api.hap.Characteristic;
    const z = this.env.coordinator.findZone(this.deviceId, this.zoneId);
    // Status: 1 = closed, 2 = open
    const open = (z?.Status ?? 1) === 2;
    return open
      ? C.ContactSensorState.CONTACT_NOT_DETECTED
      : C.ContactSensorState.CONTACT_DETECTED;
  }
}

// ---------- MotionZoneHandler ---------------------------------------------

export class MotionZoneHandler {
  private service: Service;
  constructor(
    private readonly env: HandlerEnv,
    private readonly accessory: PlatformAccessory,
    private readonly deviceId: number,
    private readonly zoneId: number,
  ) {
    const { api } = env;
    const device = env.coordinator
      .getDevices()
      .find((d) => d.DeviceId === deviceId);
    if (device) ensureAccessoryInformation(accessory, api, device);

    this.service =
      accessory.getService(api.hap.Service.MotionSensor) ??
      accessory.addService(api.hap.Service.MotionSensor);
    const C = api.hap.Characteristic;
    this.service
      .getCharacteristic(C.MotionDetected)
      .onGet(() => this.read());
    env.coordinator.on('change', () =>
      this.service.updateCharacteristic(C.MotionDetected, this.read()),
    );
  }
  private read(): boolean {
    const z = this.env.coordinator.findZone(this.deviceId, this.zoneId);
    return (z?.Status ?? 1) === 2;
  }
}
