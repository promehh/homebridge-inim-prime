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
import type { API, Logging, PlatformAccessory, PlatformConfig, DynamicPlatformPlugin } from 'homebridge';
export declare class InimPrimePlatform implements DynamicPlatformPlugin {
    readonly api: API;
    readonly Service: typeof import('homebridge').Service;
    readonly Characteristic: typeof import('homebridge').Characteristic;
    private readonly logger;
    private readonly verboseLogger;
    private readonly cfg;
    private readonly client;
    private readonly coordinator;
    private readonly cachedAccessories;
    constructor(log: Logging, config: PlatformConfig, api: API);
    /** Required by DynamicPlatformPlugin. Called once per cached accessory. */
    configureAccessory(accessory: PlatformAccessory): void;
    private normalizeConfig;
    private boot;
    private uuidFor;
    private displayNameFor;
    private shouldExposeZone;
    private syncAccessories;
    private attachHandler;
}
