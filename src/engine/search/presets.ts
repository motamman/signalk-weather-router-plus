/**
 * Search-accuracy presets for the isochrone search: how wide the beam is.
 * `normal` is the routing settings as they are; `moderate` and `maximum` are
 * the two beams measured on a Raspberry Pi 5 on 2026-10-08 (same
 * forecast run, fixed departures): on a 1,240 km passage the moderate beam
 * arrived 80 minutes earlier than the standard settings in 128 s of wall
 * time (17 s standard), the maximum one 94 minutes earlier in 363 s; on a
 * 5 h harbour beat 29 and 32 minutes earlier in about 5 s. A route
 * request chooses with `search`; an explicit `stages` in the request
 * still wins over the preset's.
 */

export const SEARCH_PRESETS = ['normal', 'moderate', 'maximum'] as const;
export type SearchPreset = (typeof SEARCH_PRESETS)[number];
export const DEFAULT_SEARCH: SearchPreset = 'normal';

export interface BeamSettings {
  stages: number;
  subsectors: number;
  headings: number;
  headingIncrementDeg: number;
}

const BEAMS: Record<Exclude<SearchPreset, 'normal'>, BeamSettings> = {
  moderate: { stages: 40, subsectors: 100, headings: 60, headingIncrementDeg: 1 },
  maximum: { stages: 40, subsectors: 150, headings: 120, headingIncrementDeg: 0.5 },
};

/** The beam for a preset: the routing settings for `normal`, else the preset's values. */
export function beamFor(preset: SearchPreset, settings: BeamSettings): BeamSettings {
  return preset === 'normal' ? { ...settings } : { ...BEAMS[preset] };
}
