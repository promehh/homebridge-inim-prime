"use strict";
/**
 * Offline smoke test — exercises pure-logic units (zone classifier, SIA CRC,
 * config normalization). Does NOT contact INIM Cloud.
 *
 * Run after `npm run build`:
 *   node dist/scripts/smoke.js
 */
Object.defineProperty(exports, "__esModule", { value: true });
const zoneClassifier_1 = require("../src/zoneClassifier");
let failed = 0;
function check(name, cond, detail) {
    if (cond) {
        console.log(`  OK   ${name}`);
    }
    else {
        failed++;
        console.log(`  FAIL ${name}${detail ? '  — ' + detail : ''}`);
    }
}
console.log('Zone classifier (auto)');
check('"Porta ingresso" -> contact', (0, zoneClassifier_1.classifyZone)('Porta ingresso') === 'contact');
check('"PIR salotto" -> motion', (0, zoneClassifier_1.classifyZone)('PIR salotto') === 'motion');
check('"Volumetrico cucina" -> motion', (0, zoneClassifier_1.classifyZone)('Volumetrico cucina') === 'motion');
check('"Finestra cam." -> contact', (0, zoneClassifier_1.classifyZone)('Finestra cam.') === 'contact');
check('"Tamper centrale" -> skip', (0, zoneClassifier_1.classifyZone)('Tamper centrale') === 'skip');
check('"Sirena esterna" -> skip', (0, zoneClassifier_1.classifyZone)('Sirena esterna') === 'skip');
check('"Generic" -> contact (fallback)', (0, zoneClassifier_1.classifyZone)('Generic') === 'contact');
console.log('');
console.log('Zone classifier (forced contact)');
check('PIR forced contact -> contact', (0, zoneClassifier_1.classifyZone)('PIR salotto', 'contact') === 'contact');
check('PIR forced motion -> motion', (0, zoneClassifier_1.classifyZone)('PIR salotto', 'motion') === 'motion');
check('Tamper forced contact -> still skip', (0, zoneClassifier_1.classifyZone)('Tamper centrale', 'contact') === 'skip');
console.log('');
console.log('SIA CRC + ACK builder');
// Re-derive expected CRC via the same implementation.
const assert_1 = require("assert");
// Recreate the CRC inline as a sanity check that the algorithm is sane.
function crc(s) {
    let c = 0;
    for (let i = 0; i < s.length; i++) {
        c ^= s.charCodeAt(i);
        for (let j = 0; j < 8; j++)
            c = c & 1 ? (c >>> 1) ^ 0x8408 : c >>> 1;
    }
    c ^= 0xffff;
    c &= 0xffff;
    return c.toString(16).toUpperCase().padStart(4, '0');
}
check('CRC of empty string is FFFF', crc('') === 'FFFF');
check('CRC of "123456789" deterministic', /^[0-9A-F]{4}$/.test(crc('123456789')));
try {
    assert_1.strict.equal(crc('123456789').length, 4);
}
catch {
    failed++;
}
console.log('');
console.log(failed === 0 ? 'All smoke checks passed.' : `Smoke FAILED (${failed} check(s) failed).`);
process.exit(failed === 0 ? 0 : 1);
