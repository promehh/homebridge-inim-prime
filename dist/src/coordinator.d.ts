/**
 * Coordinator: orchestrates REST polling, WebSocket events, and (optional)
 * SIA-IP push, into a single in-memory cache of devices/areas/zones/scenarios.
 */
import { EventEmitter } from 'events';
import { Logger } from './logger';
import { InimClient } from './inimClient';
import { InimArea, InimDevice, InimScenario, InimZone, PluginConfig } from './types';
export interface CoordinatorEvents {
    snapshot: (devices: InimDevice[]) => void;
    change: () => void;
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
    start(): Promise<void>;
    stop(): void;
    refreshNow(): Promise<void>;
    private schedulePoll;
    private pollOnce;
    private applyWsEvent;
}
