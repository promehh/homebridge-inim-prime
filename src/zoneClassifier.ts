/**
 * Heuristic zone-type classifier.
 *
 * INIM Cloud exposes a numeric `Type` field on zones but doesn't document
 * its semantics. The upstream HA integration ignores it and matches Italian
 * + English keywords against the zone name. We do the same.
 *
 * Output:
 *   - "motion"  -> expose as HomeKit MotionSensor
 *   - "contact" -> expose as HomeKit ContactSensor
 *   - "skip"    -> don't expose (tamper / siren / utility)
 */

export type ZoneKind = 'motion' | 'contact' | 'skip';

const TAMPER_KEYWORDS = ['tamper', 'sirena', 'sirene', 'siren'];
const MOTION_KEYWORDS = [
  'pir',
  'movimento',
  'motion',
  'volumetric',
  'volumetrico',
  'volumetrica',
  'doppia tecnologia',
  'dual-tech',
];
const DOOR_KEYWORDS = [
  'porta',
  'ingr',
  'ingresso',
  'scorr',
  'door',
  'gate',
  'cancell',
  'portone',
  'garage',
];
const WINDOW_KEYWORDS = [
  'finestr',
  'window',
  'f.',
  'f:',
  'tapparell',
  'persian',
  'shutter',
  'cam.',
  'camera',
  'bagno',
  'cucina',
  'salotto',
  'soggiorno',
  'studio',
  'palestra',
  'sala',
  'svago',
  'quadro',
];

function matchesAny(name: string, kws: string[]): boolean {
  const n = name.toLowerCase();
  return kws.some((k) => n.includes(k));
}

/** Classify a zone using the configured mode + the zone name fallback. */
export function classifyZone(
  zoneName: string,
  mode: 'auto' | 'contact' | 'motion' | 'none' = 'auto',
): ZoneKind {
  if (mode === 'none') return 'skip';
  if (mode === 'contact') {
    // Even in forced mode we still skip tamper/siren - they're not normal "zones".
    return matchesAny(zoneName, TAMPER_KEYWORDS) ? 'skip' : 'contact';
  }
  if (mode === 'motion') {
    return matchesAny(zoneName, TAMPER_KEYWORDS) ? 'skip' : 'motion';
  }
  // auto
  if (matchesAny(zoneName, TAMPER_KEYWORDS)) return 'skip';
  if (matchesAny(zoneName, MOTION_KEYWORDS)) return 'motion';
  if (matchesAny(zoneName, DOOR_KEYWORDS)) return 'contact';
  if (matchesAny(zoneName, WINDOW_KEYWORDS)) return 'contact';
  // Default: contact (safer than motion — Apple Home shows aperto/chiuso for everything).
  return 'contact';
}
