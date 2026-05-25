#!/usr/bin/env node
"use strict";
/**
 * Standalone connection test.
 *
 * Usage:
 *   INIM_USER=you@example.com INIM_PASS=cloudpass node dist/scripts/test-connection.js
 *   # or
 *   node dist/scripts/test-connection.js --user you@example.com --pass cloudpass [--ws]
 *
 * Prints all device/area/zone/scenario IDs so you can fill in sceneMapping
 * in Homebridge config.json. Optionally opens the WebSocket for 60s to verify
 * real-time events.
 *
 * Run on the Raspberry Pi: useful as a first-step diagnostic, completely
 * independent from Homebridge.
 */
Object.defineProperty(exports, "__esModule", { value: true });
const inimClient_1 = require("../src/inimClient");
const inimWebSocket_1 = require("../src/inimWebSocket");
const logger_1 = require("../src/logger");
function arg(name) {
    const i = process.argv.indexOf(`--${name}`);
    if (i < 0)
        return undefined;
    return process.argv[i + 1];
}
async function main() {
    const user = arg('user') ?? process.env.INIM_USER;
    const pass = arg('pass') ?? process.env.INIM_PASS;
    const wantWs = process.argv.includes('--ws');
    const wantPoll = !process.argv.includes('--no-poll');
    const verbose = process.argv.includes('--verbose') || process.argv.includes('-v');
    if (!user || !pass) {
        console.error('Missing credentials. Pass them via --user / --pass or INIM_USER / INIM_PASS env vars.');
        process.exit(2);
    }
    const log = new logger_1.ConsoleLogger(verbose);
    const client = new inimClient_1.InimClient({ username: user, password: pass, logger: log });
    log.info('Step 1/3: authenticating…');
    await client.authenticate();
    log.info('Authenticated OK.');
    if (wantPoll) {
        log.info('Step 2/3: RequestPoll for all devices, wait 5s…');
        // We don't have device IDs yet — do an initial getDevicesExtended first.
        const initial = await client.getDevicesExtended();
        if (initial.length === 0) {
            log.warn('No devices returned by INIM Cloud. Check that your account has paired panels.');
            process.exit(1);
        }
        await client.pollAndWait(initial.map((d) => d.DeviceId));
    }
    log.info('Step 3/3: GetDevicesExtended…');
    const devices = await client.getDevicesExtended();
    log.info(`Found ${devices.length} device(s).`);
    for (const d of devices) {
        console.log('');
        console.log('═══════════════════════════════════════════════════════');
        console.log(`Device  id=${d.DeviceId}  name="${d.Name}"  model=${d.ModelFamily ?? '?'} ${d.ModelNumber ?? ''}` +
            `  fw=${d.FirmwareVersionMajor ?? '?'}.${d.FirmwareVersionMinor ?? '?'}`);
        console.log(`  ActiveScenario: ${d.ActiveScenario ?? '?'}`);
        console.log('');
        console.log(`  Areas (${d.Areas.length}):`);
        for (const a of d.Areas) {
            const armedLabel = a.Armed === 1
                ? 'ARMED'
                : a.Armed === 4
                    ? 'disarmed'
                    : `partial(${a.Armed})`;
            console.log(`    - AreaId=${a.AreaId}  name="${a.Name}"  ${armedLabel}` +
                (a.Alarm ? '  !!! ALARM !!!' : ''));
        }
        console.log('');
        console.log(`  Scenarios (${d.Scenarios.length}):`);
        for (const s of d.Scenarios) {
            const active = d.ActiveScenario === s.ScenarioId ? '  <- active' : '';
            console.log(`    - ScenarioId=${s.ScenarioId}  name="${s.Name}"${active}`);
        }
        console.log('');
        console.log(`  Zones (${d.Zones.length}):`);
        for (const z of d.Zones) {
            const stateLabel = z.Status === 2 ? 'OPEN' : 'closed';
            const bypass = z.Bypassed ? '  (bypassed)' : '';
            console.log(`    - ZoneId=${z.ZoneId}  name="${z.Name}"  ${stateLabel}` +
                `  areas=[${(z.Areas ?? []).join(',')}]${bypass}`);
        }
    }
    console.log('');
    console.log('═══════════════════════════════════════════════════════');
    console.log('Copy the IDs above into config.json (sceneMapping section).');
    console.log('');
    if (!wantWs) {
        log.info('Connection test complete. Pass --ws to also test WebSocket for 60s.');
        process.exit(0);
    }
    log.info('Opening WebSocket for 60s; trigger zones to see events…');
    const ws = new inimWebSocket_1.InimWebSocket({
        logger: log,
        urlProvider: () => client.buildWebSocketUrl(),
        reauthOnReconnect: () => client.authenticate(),
        onEvent: (evt) => {
            const summary = {
                Device_Id: evt.Device_Id,
                zones: (evt.ZoneList ?? []).length,
                areas: (evt.AreaList ?? []).length,
            };
            console.log('WS EVENT:', JSON.stringify(summary));
            console.log(JSON.stringify(evt, null, 2));
        },
        onUnknownEvent: () => console.log('WS EVENT (unknown format)'),
    });
    await ws.start();
    await new Promise((r) => setTimeout(r, 60000));
    ws.stop();
    log.info('WebSocket test done.');
    process.exit(0);
}
main().catch((e) => {
    console.error('FAILED:', e instanceof Error ? e.message : e);
    if (e instanceof Error && e.stack)
        console.error(e.stack);
    process.exit(1);
});
