/**
 * Coordinator: orchestrates REST polling, WebSocket events, and (optional)
 * SIA-IP push, into a single in-memory cache of devices/areas/zones/scenarios.
 *
 * Emits change notifications via Node's EventEmitter so accessories can update
 * HomeKit characteristics without rebuilding the platform.
 */
import { EventEmitter } from 'events';
import { Logger } from './logger';
import { InimClient } from './inimClient';
import { InimArea, InimDevice, InimScenario, InimZone, PluginConfig } from './types';
export interface CoordinatorEvents {
    /** A full snapshot (REST) has been refreshed. */
    snapshot: (devices: InimDevice[]) => void;
    /** Any state change (REST poll diff, WS event, or SIA push). */
    change: () => void;
    /** Fatal error from the background loop. */
    error: (err: Error) => void;
}
export declare interface Coordinator {
    on<K extends keyof CoordinatorEvents>(event: K, listener: CoordinatorEvents[K]): this;
    emit<K extends keyof CoordinatorEvents>(event: K, ...args: Parameters<CoordinatorEvents[K]>): boolean;
}
export declare class Coordinator extends EventEmitter {
    private readonly client;
    private readonly config;
    private readonly logger;
    private devices;
    private pollTimer;
    private ws;
    private sia;
    private stopped;
    private inFlightPoll;
    constructor(client: InimClient, config: PluginConfig, logger: Logger);
    getDevices(): InimDevice[];
    findArea(deviceId: number, areaId: number): InimArea | undefined;
    findZone(deviceId: number, zoneId: number): InimZone | undefined;
    findScenario(deviceId: number, scenarioId: number): InimScenario | undefined;
    /**
     * Initial bootstrap: authenticate, do the first GetDevicesExtended, then
     * start WS + SIA + polling.
     */
    start(): Promise<void>;
    stop(): void;
    /** Trigger an immediate full refresh; safe to call concurrently. */
    refreshNow(): Promise<void>;
    private schedulePoll;
    private pollOnce;
    private applyWsEvent;
}
