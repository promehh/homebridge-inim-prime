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
import type { PlatformAccessory } from 'homebridge';
import { Logger } from './logger';
import { InimClient } from './inimClient';
import { Coordinator } from './coordinator';
import { PluginConfig } from './types';
export interface HandlerEnv {
    api: import('homebridge').API;
    logger: Logger;
    client: InimClient;
    coordinator: Coordinator;
    config: PluginConfig;
}
export declare class AreaSecuritySystemHandler {
    private readonly env;
    private readonly accessory;
    private readonly deviceId;
    private readonly areaId;
    private service;
    private sec;
    constructor(env: HandlerEnv, accessory: PlatformAccessory, deviceId: number, areaId: number);
    private getCurrentState;
    private getTargetState;
    private setTargetState;
    private pushUpdate;
}
export declare class GlobalSecuritySystemHandler {
    private readonly env;
    private readonly accessory;
    private readonly deviceId;
    private service;
    private sec;
    constructor(env: HandlerEnv, accessory: PlatformAccessory, deviceId: number);
    private getCurrentState;
    private getTargetState;
    private setTargetState;
    private pushUpdate;
}
export declare class ScenarioSwitchHandler {
    private readonly env;
    private readonly accessory;
    private readonly deviceId;
    private readonly scenarioId;
    private service;
    constructor(env: HandlerEnv, accessory: PlatformAccessory, deviceId: number, scenarioId: number);
    private isActive;
    private setOn;
}
export declare class AreaSwitchHandler {
    private readonly env;
    private readonly accessory;
    private readonly deviceId;
    private readonly areaId;
    private service;
    constructor(env: HandlerEnv, accessory: PlatformAccessory, deviceId: number, areaId: number);
    private isArmed;
    private setArmed;
}
export declare class ContactZoneHandler {
    private readonly env;
    private readonly accessory;
    private readonly deviceId;
    private readonly zoneId;
    private service;
    constructor(env: HandlerEnv, accessory: PlatformAccessory, deviceId: number, zoneId: number);
    private read;
}
export declare class MotionZoneHandler {
    private readonly env;
    private readonly accessory;
    private readonly deviceId;
    private readonly zoneId;
    private service;
    constructor(env: HandlerEnv, accessory: PlatformAccessory, deviceId: number, zoneId: number);
    private read;
}
