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
/** Classify a zone using the configured mode + the zone name fallback. */
export declare function classifyZone(zoneName: string, mode?: 'auto' | 'contact' | 'motion' | 'none'): ZoneKind;
