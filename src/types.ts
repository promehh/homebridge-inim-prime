/**
 * Shared types for the INIM Cloud protocol and Homebridge plugin.
 * Field names mirror the cloud API JSON exactly.
 */

export interface InimArea {
  AreaId: number;
  Name: string;
  /** 1 = armed, 2/3 = partial, 4 = disarmed. */
  Armed: number;
  /** Boolean or int; truthy = currently triggered. */
  Alarm: boolean | number;
  AlarmMemory?: number;
  Tamper?: number;
  TamperMemory?: number;
  AutoInsert?: number;
}

export interface InimZone {
  ZoneId: number;
  Name: string;
  /** 1 = closed, 2 = open. */
  Status: number;
  AlarmMemory?: number;
  TamperMemory?: number;
  /** 0 = active, >0 = bypassed. */
  Bypassed?: number;
  OutputOn?: number;
  OutputValue?: number;
  /** Area IDs this zone belongs to. */
  Areas?: number[];
  /** Numeric zone-type bitfield (semantics not fully documented). */
  Type?: number;
  TerminalId?: number;
  Visibility?: number;
  Voltage?: number;
  Power?: number;
}

export interface InimScenario {
  ScenarioId: number;
  Name: string;
}

export interface InimDevice {
  DeviceId: number;
  Name: string;
  SerialNumber?: string;
  ModelFamily?: string;
  ModelNumber?: string;
  FirmwareVersionMajor?: number;
  FirmwareVersionMinor?: number;
  Voltage?: number;
  ActiveScenario?: number;
  NetworkStatus?: number;
  Faults?: number;
  Areas: InimArea[];
  Zones: InimZone[];
  Scenarios: InimScenario[];
  Peripherals?: unknown[];
  Thermostats?: unknown[];
  Blinds?: unknown[];
}

export interface InimResponse<T = unknown> {
  Status: number;
  Data?: T;
  Message?: string;
}

export interface GetDevicesExtendedData {
  Devices: InimDevice[];
}

export interface RegisterClientData {
  Token: string;
  TTL?: number;
}

/** WebSocket inner event payload (after the double-JSON unwrap). */
export interface WsEventInner {
  Device_Id: number;
  ZoneList?: Array<Partial<InimZone> & { Device_Id: number; ZoneId: number }>;
  AreaList?: Array<Partial<InimArea> & { Device_Id: number; AreaId: number }>;
}

export type WsEventListener = (evt: WsEventInner) => void;
export type SnapshotListener = (devices: InimDevice[]) => void;

export interface PluginConfig {
  platform: string;
  name?: string;
  username: string;
  password: string;
  userCode: string;
  pollIntervalSeconds?: number;
  zoneMapping?: 'auto' | 'contact' | 'motion' | 'none';
  exposeExtraSceneSwitches?: boolean;
  areaMode?: 'perArea' | 'globalOnly' | 'globalPlusSwitches';
  sceneMapping?: {
    stayScenarioId?: number;
    awayScenarioId?: number;
    nightScenarioId?: number;
    disarmScenarioId?: number;
  };
  useSiaIp?: boolean;
  siaIpPort?: number;
  siaAccountId?: string;
  debug?: boolean;
}
