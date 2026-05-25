/**
 * Optional SIA-IP listener.
 *
 * The panel connects OUT to us (we bind a TCP port). Each frame is SIA-DCS
 * over a tiny line-protocol with CRC-16/X.25. We must ACK every frame.
 *
 * Protocol summary:
 *   frame  = "\n" CRC4 LEN4 PAYLOAD "\r"
 *   PAYLOAD = "\"SIA-DCS\"" SEQ4 RECEIVER "#" ACCOUNT "[" EVENT "]" "_" TS
 *   CRC = CRC-16/X.25 (poly 0x8408 reflected, init 0x0000, xor-out 0xFFFF)
 *   ACK = "\"ACK\"" SEQ RECEIVER "#" ACCOUNT "[]" "_" TS
 *
 * Inside EVENT, after splitting on '|', element [1] looks like:
 *   <modifier><partition><event-class><id>(^extra^)?
 * e.g. "Nri01BA001", "Nri01OP001", "Nnn02BR003".
 *
 * Event classes we care about:
 *   CG/CA/CL/CP -> area armed
 *   OA/OP/OR    -> area disarmed
 *   BA/TA       -> zone alarm   (Status=2, AlarmMemory=1)
 *   BR/TR       -> zone restore (Status=1)
 *
 * Zone/area IDs from SIA are 1-indexed; INIM Cloud API is 0-indexed → subtract 1.
 */
import { Logger } from './logger';
export type SiaAreaUpdate = {
    areaId: number;
    armed: boolean;
};
export type SiaZoneUpdate = {
    zoneId: number;
    open: boolean;
};
export interface SiaServerOptions {
    port: number;
    accountFilter?: string;
    onAreaUpdate: (u: SiaAreaUpdate) => void;
    onZoneUpdate: (u: SiaZoneUpdate) => void;
    logger: Logger;
}
export declare class SiaServer {
    private readonly opts;
    private server;
    private connections;
    constructor(opts: SiaServerOptions);
    start(): Promise<void>;
    stop(): void;
    private handleClient;
    private processFrame;
}
