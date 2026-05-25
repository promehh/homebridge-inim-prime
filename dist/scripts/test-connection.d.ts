#!/usr/bin/env node
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
export {};
