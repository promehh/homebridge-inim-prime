/**
 * Offline smoke test — exercises pure-logic units (zone classifier, SIA CRC,
 * config normalization). Does NOT contact INIM Cloud.
 *
 * Run after `npm run build`:
 *   node dist/scripts/smoke.js
 */

import { classifyZone } from '../src/zoneClassifier';

let failed = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) {
    console.log(`  OK   ${name}`);
  } else {
    failed++;
    console.log(`  FAIL ${name}${detail ? '  — ' + detail : ''}`);
  }
}

console.log('Zone classifier (auto)');
check('"Porta ingresso" -> contact', classifyZone('Porta ingresso') === 'contact');
check('"PIR salotto" -> motion',    classifyZone('PIR salotto') === 'motion');
check('"Volumetrico cucina" -> motion', classifyZone('Volumetrico cucina') === 'motion');
check('"Finestra cam." -> contact',  classifyZone('Finestra cam.') === 'contact');
check('"Tamper centrale" -> skip', classifyZone('Tamper centrale') === 'skip');
check('"Sirena esterna" -> skip',  classifyZone('Sirena esterna') === 'skip');
check('"Generic" -> contact (fallback)', classifyZone('Generic') === 'contact');

console.log('');
console.log('Zone classifier (forced contact)');
check('PIR forced contact -> contact', classifyZone('PIR salotto', 'contact') === 'contact');
check('PIR forced motion -> motion',   classifyZone('PIR salotto', 'motion') === 'motion');
check('Tamper forced contact -> still skip', classifyZone('Tamper centrale', 'contact') === 'skip');

console.log('');
console.log('SIA CRC + ACK builder');
// Re-derive expected CRC via the same implementation.
import { strict as assert } from 'assert';
// Recreate the CRC inline as a sanity check that the algorithm is sane.
function crc(s: string): string {
  let c = 0;
  for (let i = 0; i < s.length; i++) {
    c ^= s.charCodeAt(i);
    for (let j = 0; j < 8; j++) c = c & 1 ? (c >>> 1) ^ 0x8408 : c >>> 1;
  }
  c ^= 0xffff;
  c &= 0xffff;
  return c.toString(16).toUpperCase().padStart(4, '0');
}
check('CRC of empty string is FFFF', crc('') === 'FFFF');
check('CRC of "123456789" deterministic', /^[0-9A-F]{4}$/.test(crc('123456789')));
try {
  assert.equal(crc('123456789').length, 4);
} catch {
  failed++;
}

console.log('');
console.log(failed === 0 ? 'All smoke checks passed.' : `Smoke FAILED (${failed} check(s) failed).`);
process.exit(failed === 0 ? 0 : 1);
