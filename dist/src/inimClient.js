"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.InimClient = exports.InimApiError = exports.InimAuthError = void 0;
const crypto_1 = require("crypto");
const BASE_URL = 'https://api.inimcloud.com/';
const AUTH_ERROR_CODES = new Set([18, 19, 20, 27]);
const ALL_INFO_BITMASK = '16908287'; // 0x01020FFF
const REQUEST_POLL_WAIT_MS = 5000; // empirically: 2s is too short, 5s works
class InimAuthError extends Error {
    constructor(msg, code) {
        super(msg);
        this.code = code;
        this.name = 'InimAuthError';
    }
}
exports.InimAuthError = InimAuthError;
class InimApiError extends Error {
    constructor(msg, code) {
        super(msg);
        this.code = code;
        this.name = 'InimApiError';
    }
}
exports.InimApiError = InimApiError;
class InimClient {
    constructor(opts) {
        this.token = null;
        this.tokenExpiresAt = null;
        this.username = opts.username;
        this.password = opts.password;
        this.logger = opts.logger;
        this.clientName = opts.clientName ?? 'Homebridge';
        this.timeoutMs = opts.requestTimeoutMs ?? 20000;
        // Persisted for the lifetime of the instance (matches HA integration).
        this.clientId = opts.clientId ?? `hb-${(0, crypto_1.randomUUID)()}`;
    }
    /** Current token, may be null if never authenticated yet. */
    get currentToken() {
        return this.token;
    }
    get currentClientId() {
        return this.clientId;
    }
    /** Force a fresh authentication (RegisterClient). */
    async authenticate() {
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
        const resp = await this.rawRequest(req);
        if (resp.Status !== 0 || !resp.Data?.Token) {
            throw new InimApiError(`Authentication failed (Status=${resp.Status})`, resp.Status);
        }
        this.token = resp.Data.Token;
        const ttl = resp.Data.TTL ?? 86400;
        this.tokenExpiresAt = Date.now() + ttl * 1000;
        this.logger.info(`INIM Cloud authentication OK (token valid ~${Math.round(ttl / 3600)}h)`);
    }
    /** Ensure we have a token; authenticate if not. */
    async ensureAuthenticated() {
        if (!this.token) {
            await this.authenticate();
        }
    }
    /**
     * Issue an authenticated RPC with one-shot reauth on expired-token errors.
     */
    async callWithReauth(method, extra, params) {
        await this.ensureAuthenticated();
        const build = () => ({
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
            return await this.rawRequest(build());
        }
        catch (e) {
            if (e instanceof InimAuthError) {
                this.logger.warn(`Token expired (code ${e.code}), re-authenticating and retrying ${method}…`);
                this.token = null;
                await this.authenticate();
                return await this.rawRequest(build());
            }
            throw e;
        }
    }
    /** Wake the panel so the cloud has fresh data. Caller must wait ~5s. */
    async requestPoll(deviceId) {
        // Special envelope: Name = "Home Assistant" historically, Context = "intrusion".
        await this.callWithReauth('RequestPoll', { Name: 'Homebridge', Context: 'intrusion' }, { DeviceId: deviceId, Type: 5 });
    }
    /** Convenience helper: poll all known devices then sleep 5s. */
    async pollAndWait(deviceIds) {
        if (deviceIds.length === 0)
            return;
        await Promise.all(deviceIds.map((id) => this.requestPoll(id)));
        await new Promise((r) => setTimeout(r, REQUEST_POLL_WAIT_MS));
    }
    /** Full snapshot of all devices/areas/zones/scenarios. */
    async getDevicesExtended() {
        const resp = await this.callWithReauth('GetDevicesExtended', {}, { Info: ALL_INFO_BITMASK });
        return resp.Data?.Devices ?? [];
    }
    /** Activate a panel-defined scenario by ID. No user code required. */
    async activateScenario(deviceId, scenarioId) {
        await this.callWithReauth('ActivateScenario', {}, { ScenarioId: scenarioId, DeviceId: deviceId });
    }
    /**
     * Arm or disarm one or more areas.
     * `arm=true` => Mode 0 (-> Armed=1); `arm=false` => Mode 3 (-> Armed=4).
     * Note: DeviceId is stringified — server quirk, matches HA integration.
     */
    async insertAreas(deviceId, areaIds, arm, userCode) {
        await this.callWithReauth('InsertAreas', {}, {
            AreaIds: areaIds,
            Mode: arm ? 0 : 3,
            DeviceId: String(deviceId),
            Code: userCode,
        });
    }
    /**
     * Bypass or reinstate a zone.
     * `bypass=true` => Mode 3, `bypass=false` => Mode 0 (reversed vs InsertAreas).
     */
    async insertZone(deviceId, zoneId, bypass, userCode) {
        await this.callWithReauth('InsertZone', {}, {
            ZoneId: zoneId,
            Mode: bypass ? 3 : 0,
            DeviceId: String(deviceId),
            Code: userCode,
            Value: 0,
        });
    }
    /** Build the WebSocket URL using the current token. */
    buildWebSocketUrl() {
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
        return `wss://ws.inimcloud.com/events?req=${encodeURIComponent(JSON.stringify(req))}`;
    }
    // ---- internal --------------------------------------------------------
    /**
     * Raw GET to the INIM Cloud HTTP endpoint. Encodes the request body in
     * the `req` query string, parses the JSON response, and surfaces auth/
     * application errors via specific Error subclasses.
     */
    async rawRequest(body) {
        const url = `${BASE_URL}?req=${encodeURIComponent(JSON.stringify(body))}`;
        this.logger.debug(`HTTP GET ${url.length}b -> INIM Cloud`);
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.timeoutMs);
        let resp;
        try {
            resp = await fetch(url, { method: 'GET', signal: controller.signal });
        }
        catch (e) {
            throw new Error(`Network error contacting INIM Cloud: ${e.message}`);
        }
        finally {
            clearTimeout(timer);
        }
        if (!resp.ok) {
            throw new Error(`INIM Cloud HTTP ${resp.status} ${resp.statusText} on ${body.Method}`);
        }
        const text = await resp.text();
        let parsed;
        try {
            parsed = JSON.parse(text);
        }
        catch {
            throw new Error(`Cannot parse INIM Cloud response as JSON: ${text.slice(0, 200)}`);
        }
        if (parsed.Status === 0) {
            return parsed;
        }
        const msg = parsed.Message ?? `INIM Cloud error code ${parsed.Status} on ${body.Method}`;
        if (AUTH_ERROR_CODES.has(parsed.Status)) {
            throw new InimAuthError(msg, parsed.Status);
        }
        throw new InimApiError(msg, parsed.Status);
    }
}
exports.InimClient = InimClient;
