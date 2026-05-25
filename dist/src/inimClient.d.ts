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
import { Logger } from './logger';
import { InimDevice } from './types';
export declare class InimAuthError extends Error {
    code: number;
    constructor(msg: string, code: number);
}
export declare class InimApiError extends Error {
    code: number;
    constructor(msg: string, code: number);
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
export declare class InimClient {
    private readonly username;
    private readonly password;
    private readonly clientName;
    private readonly logger;
    private readonly timeoutMs;
    private readonly clientId;
    private token;
    private tokenExpiresAt;
    constructor(opts: InimClientOptions);
    /** Current token, may be null if never authenticated yet. */
    get currentToken(): string | null;
    get currentClientId(): string;
    /** Force a fresh authentication (RegisterClient). */
    authenticate(): Promise<void>;
    /** Ensure we have a token; authenticate if not. */
    private ensureAuthenticated;
    /**
     * Issue an authenticated RPC with one-shot reauth on expired-token errors.
     */
    private callWithReauth;
    /** Wake the panel so the cloud has fresh data. Caller must wait ~5s. */
    requestPoll(deviceId: number): Promise<void>;
    /** Convenience helper: poll all known devices then sleep 5s. */
    pollAndWait(deviceIds: number[]): Promise<void>;
    /** Full snapshot of all devices/areas/zones/scenarios. */
    getDevicesExtended(): Promise<InimDevice[]>;
    /** Activate a panel-defined scenario by ID. No user code required. */
    activateScenario(deviceId: number, scenarioId: number): Promise<void>;
    /**
     * Arm or disarm one or more areas.
     * `arm=true` => Mode 0 (-> Armed=1); `arm=false` => Mode 3 (-> Armed=4).
     * Note: DeviceId is stringified — server quirk, matches HA integration.
     */
    insertAreas(deviceId: number, areaIds: number[], arm: boolean, userCode: string): Promise<void>;
    /**
     * Bypass or reinstate a zone.
     * `bypass=true` => Mode 3, `bypass=false` => Mode 0 (reversed vs InsertAreas).
     */
    insertZone(deviceId: number, zoneId: number, bypass: boolean, userCode: string): Promise<void>;
    /** Build the WebSocket URL using the current token. */
    buildWebSocketUrl(): string;
    /**
     * Raw GET to the INIM Cloud HTTP endpoint. Encodes the request body in
     * the `req` query string, parses the JSON response, and surfaces auth/
     * application errors via specific Error subclasses.
     */
    private rawRequest;
}
