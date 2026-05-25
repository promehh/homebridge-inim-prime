/**
 * INIM Cloud REST client (TypeScript).
 *
 * Protocol notes (all empirically derived from upstream HA integration):
 * - All calls are HTTP GET to https://api.inimcloud.com/?req=<URL-encoded JSON>.
 * - Even mutations are GET. Don't switch to POST.
 * - First call MUST be RegisterClient -> returns an opaque token + TTL.
 * - Response always { Status:number, Data?:..., ErrMsg?:string }; Status===0 = OK.
 * - Status in {18,19,20,27} means "token gone": re-authenticate and retry once.
 * - DeviceId is int for RequestPoll/ActivateScenario but STRING for
 *   InsertAreas/InsertZone — keep both behaviours exactly.
 * - ClientId must persist across re-auths (single InimClient instance).
 */

import { randomUUID } from 'crypto';
import { Logger } from './logger';
import {
  InimDevice,
  InimResponse,
  GetDevicesExtendedData,
  RegisterClientData,
} from './types';

const BASE_URL = 'https://api.inimcloud.com/';
const AUTH_ERROR_CODES = new Set<number>([18, 19, 20, 27]);
const ALL_INFO_BITMASK = '16908287'; // 0x01020FFF
const REQUEST_POLL_WAIT_MS = 5000; // empirically: 2s is too short, 5s works

export class InimAuthError extends Error {
  constructor(msg: string, public code: number) {
    super(msg);
    this.name = 'InimAuthError';
  }
}

export class InimApiError extends Error {
  constructor(msg: string, public code: number) {
    super(msg);
    this.name = 'InimApiError';
  }
}

export interface InimClientOptions {
  username: string;
  password: string;
  logger: Logger;
  /** Override the User-Agent / client identity (rarely needed). */
  clientName?: string;
  /** Override the persistent ClientId (mostly for tests). */
  clientId?: string;
  /** HTTP request timeout in ms. Default 20000. */
  requestTimeoutMs?: number;
}

export class InimClient {
  private readonly username: string;
  private readonly password: string;
  private readonly clientName: string;
  private readonly logger: Logger;
  private readonly timeoutMs: number;
  private readonly clientId: string;

  private token: string | null = null;
  private tokenExpiresAt: number | null = null;

  constructor(opts: InimClientOptions) {
    this.username = opts.username;
    this.password = opts.password;
    this.logger = opts.logger;
    this.clientName = opts.clientName ?? 'Homebridge';
    this.timeoutMs = opts.requestTimeoutMs ?? 20000;
    // Persisted for the lifetime of the instance (matches HA integration).
    this.clientId = opts.clientId ?? `hb-${randomUUID()}`;
  }

  /** Current token, may be null if never authenticated yet. */
  get currentToken(): string | null {
    return this.token;
  }
  get currentClientId(): string {
    return this.clientId;
  }

  /** Force a fresh authentication (RegisterClient). */
  async authenticate(): Promise<void> {
    const clientInfo = JSON.stringify({
      name: 'homebridge-inim-prime',
      version: '1.0.0',
      device: 'Homebridge',
      brand: 'Homebridge',
      platform: 'linux',
    });
    const req = {
      Node: '',
      Name: '',
      ClientIP: '',
      Method: 'RegisterClient',
      ClientId: '',
      Token: '',
      Params: {
        Username: this.username,
        Password: this.password,
        ClientId: this.clientId,
        ClientName: this.clientName,
        ClientInfo: clientInfo,
        Role: '1',
        Brand: '0',
      },
    };
    this.logger.debug('Authenticating with INIM Cloud as', this.username);
    const resp = await this.rawRequest<RegisterClientData>(req);
    if (resp.Status !== 0 || !resp.Data?.Token) {
      throw new InimApiError(
        `Authentication failed (Status=${resp.Status})`,
        resp.Status,
      );
    }
    this.token = resp.Data.Token;
    const ttl = resp.Data.TTL ?? 86400;
    this.tokenExpiresAt = Date.now() + ttl * 1000;
    this.logger.info(
      `INIM Cloud authentication OK (token valid ~${Math.round(ttl / 3600)}h)`,
    );
  }

  /** Ensure we have a token; authenticate if not. */
  private async ensureAuthenticated(): Promise<void> {
    if (!this.token) {
      await this.authenticate();
    }
  }

  /**
   * Issue an authenticated RPC with one-shot reauth on expired-token errors.
   */
  private async callWithReauth<T>(
    method: string,
    extra: Record<string, unknown>,
    params: Record<string, unknown>,
  ): Promise<InimResponse<T>> {
    await this.ensureAuthenticated();
    const build = (): Record<string, unknown> => ({
      Node: 'inimhome',
      Name: 'it.inim.inimutenti',
      ClientIP: '',
      Method: method,
      Token: this.token,
      ClientId: this.clientId,
      Context: null,
      Params: params,
      ...extra,
    });
    try {
      return await this.rawRequest<T>(build());
    } catch (e) {
      if (e instanceof InimAuthError) {
        this.logger.warn(
          `Token expired (code ${e.code}), re-authenticating and retrying ${method}…`,
        );
        this.token = null;
        await this.authenticate();
        return await this.rawRequest<T>(build());
      }
      throw e;
    }
  }

  /** Wake the panel so the cloud has fresh data. Caller must wait ~5s. */
  async requestPoll(deviceId: number): Promise<void> {
    // Special envelope: Name = "Home Assistant" historically, Context = "intrusion".
    await this.callWithReauth<unknown>(
      'RequestPoll',
      { Name: 'Homebridge', Context: 'intrusion' },
      { DeviceId: deviceId, Type: 5 },
    );
  }

  /** Convenience helper: poll all known devices then sleep 5s. */
  async pollAndWait(deviceIds: number[]): Promise<void> {
    if (deviceIds.length === 0) return;
    await Promise.all(deviceIds.map((id) => this.requestPoll(id)));
    await new Promise((r) => setTimeout(r, REQUEST_POLL_WAIT_MS));
  }

  /** Full snapshot of all devices/areas/zones/scenarios. */
  async getDevicesExtended(): Promise<InimDevice[]> {
    const resp = await this.callWithReauth<GetDevicesExtendedData>(
      'GetDevicesExtended',
      {},
      { Info: ALL_INFO_BITMASK },
    );
    return resp.Data?.Devices ?? [];
  }

  /** Activate a panel-defined scenario by ID. No user code required. */
  async activateScenario(deviceId: number, scenarioId: number): Promise<void> {
    await this.callWithReauth<unknown>(
      'ActivateScenario',
      {},
      { ScenarioId: scenarioId, DeviceId: deviceId },
    );
  }

  /**
   * Arm or disarm one or more areas.
   * `arm=true` => Mode 0 (-> Armed=1); `arm=false` => Mode 3 (-> Armed=4).
   * Note: DeviceId is stringified — server quirk, matches HA integration.
   */
  async insertAreas(
    deviceId: number,
    areaIds: number[],
    arm: boolean,
    userCode: string,
  ): Promise<void> {
    await this.callWithReauth<unknown>(
      'InsertAreas',
      {},
      {
        AreaIds: areaIds,
        Mode: arm ? 0 : 3,
        DeviceId: String(deviceId),
        Code: userCode,
      },
    );
  }

  /**
   * Bypass or reinstate a zone.
   * `bypass=true` => Mode 3, `bypass=false` => Mode 0 (reversed vs InsertAreas).
   */
  async insertZone(
    deviceId: number,
    zoneId: number,
    bypass: boolean,
    userCode: string,
  ): Promise<void> {
    await this.callWithReauth<unknown>(
      'InsertZone',
      {},
      {
        ZoneId: zoneId,
        Mode: bypass ? 3 : 0,
        DeviceId: String(deviceId),
        Code: userCode,
        Value: 0,
      },
    );
  }

  /** Build the WebSocket URL using the current token. */
  buildWebSocketUrl(): string {
    if (!this.token) {
      throw new Error('Cannot build WebSocket URL: not authenticated yet.');
    }
    const req = {
      Node: 'inimhome',
      Name: 'it.inim.inimutenti',
      ClientIP: '',
      Method: 'WebSocketStart',
      Token: this.token,
      ClientId: this.clientId,
      Context: null,
      Params: { Brand: 0 },
    };
    return `wss://ws.inimcloud.com/events?req=${encodeURIComponent(
      JSON.stringify(req),
    )}`;
  }

  // ---- internal --------------------------------------------------------

  /**
   * Raw GET to the INIM Cloud HTTP endpoint. Encodes the request body in
   * the `req` query string, parses the JSON response, and surfaces auth/
   * application errors via specific Error subclasses.
   */
  private async rawRequest<T>(
    body: Record<string, unknown>,
  ): Promise<InimResponse<T>> {
    const url = `${BASE_URL}?req=${encodeURIComponent(JSON.stringify(body))}`;
    this.logger.debug(`HTTP GET ${url.length}b -> INIM Cloud`);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let resp: Response;
    try {
      resp = await fetch(url, { method: 'GET', signal: controller.signal });
    } catch (e) {
      throw new Error(
        `Network error contacting INIM Cloud: ${(e as Error).message}`,
      );
    } finally {
      clearTimeout(timer);
    }
    if (!resp.ok) {
      throw new Error(
        `INIM Cloud HTTP ${resp.status} ${resp.statusText} on ${body.Method}`,
      );
    }
    const text = await resp.text();
    let parsed: InimResponse<T>;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error(
        `Cannot parse INIM Cloud response as JSON: ${text.slice(0, 200)}`,
      );
    }
    if (parsed.Status === 0) {
      return parsed;
    }
    const msg =
      parsed.Message ?? `INIM Cloud error code ${parsed.Status} on ${body.Method}`;
    if (AUTH_ERROR_CODES.has(parsed.Status)) {
      throw new InimAuthError(msg, parsed.Status);
    }
    throw new InimApiError(msg, parsed.Status);
  }
}
