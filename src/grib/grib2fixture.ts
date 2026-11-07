/**
 * The GRIB2 fixture for the tests (grib2.test.ts, data/ensemble.test.ts): ECMWF's real 10u/10v messages at three steps
 * (test-data/ecmwf_10u10v_3steps.grib2, template 4.0), and that file's first message rebuilt as one member of an
 * ensemble (template 4.1), as ECMWF's ensemble files (enfo, waef) code every member.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

export const GRIB2_FIXTURE = path.join(__dirname, '..', '..', 'test-data', 'ecmwf_10u10v_3steps.grib2');

/** Byte offsets (0-based) of sections 1 and 4 of the first message of `b`. */
export function sectionsOf(b: Uint8Array): { s1: number; s4: number } {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const out: Record<number, number> = {};
  for (let p = 16; p < b.length - 4;) {
    if (b[p] === 0x37 && b[p + 1] === 0x37 && b[p + 2] === 0x37 && b[p + 3] === 0x37) break;
    out[b[p + 4]] = p;
    p += dv.getUint32(p);
  }
  return { s1: out[1], s4: out[4] };
}

/** The fixture's first message alone (template 4.0, 10u at +0 h). */
export function firstMessage(): Uint8Array {
  const all = new Uint8Array(fs.readFileSync(GRIB2_FIXTURE));
  const first = new DataView(all.buffer, all.byteOffset).getUint32(12); // octets 13–16 of the 64-bit length (under 4 GB)
  return all.subarray(0, first);
}

/**
 * The fixture's first message as template 4.1: template 4.0 and `octets` more of the three ECMWF writes (the type of
 * ensemble forecast, the member's number, the ensemble's size; 3 for a whole member, fewer for a section cut short of
 * them), every length and the template number set as they would be.
 */
export function asEnsembleMember(type: number, member: number, size: number, octets = 3): Uint8Array {
  const b = firstMessage();
  const { s4 } = sectionsOf(b);
  const s4len = new DataView(b.buffer, b.byteOffset).getUint32(s4);
  if (s4len !== 34) throw new Error(`the fixture's section 4 is ${s4len} octets, not template 4.0's 34`);
  const extra = [type, member, size].slice(0, octets);
  const out = new Uint8Array(b.length + extra.length);
  out.set(b.subarray(0, s4 + 34), 0);
  out.set(extra, s4 + 34);
  out.set(b.subarray(s4 + 34), s4 + 34 + extra.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(12, out.length); // total length
  dv.setUint32(s4, 34 + extra.length); // section 4 length
  dv.setUint16(s4 + 7, 1); // template 4.1
  return out;
}
