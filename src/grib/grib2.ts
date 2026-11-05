/**
 * Minimal GRIB2 reader for regular lat/lon fields.
 *
 * Supports:
 *  - Section 3 grid definition template 3.0 (lat/lon, Plate Carree)
 *  - Section 4 product definition template 4.0 (instant, point in time),
 *    4.1 (one member of an ensemble at a point in time: 4.0 and the
 *    member) and 4.8 (statistically processed over a time range, e.g. a
 *    maximum gust or an accumulation), enough to identify the parameter,
 *    its forecast step and the ensemble member
 *  - Section 5 data representation templates 5.0 (simple packing) and
 *    5.42 (CCSDS / libaec)
 *  - Section 6 bit maps (indicator 0 = present, 254 = reuse previous,
 *    255 = none)
 *
 * Anything else throws a Grib2Error naming the message and template, so
 * unsupported input is never silently mis-decoded.
 *
 * Octet numbering in comments follows the WMO tables (1-based).
 */

import { aecDecode } from './ccsds';

export class Grib2Error extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'Grib2Error';
  }
}

export interface Grib2Grid {
  /** Points along a parallel (columns). */
  ni: number;
  /** Points along a meridian (rows). */
  nj: number;
  /** Latitude of the first grid point, degrees. */
  la1: number;
  /** Longitude of the first grid point, degrees, as coded (may be 0..360). */
  lo1: number;
  la2: number;
  lo2: number;
  /** Increments in degrees (positive). */
  di: number;
  dj: number;
  /** Raw scanning mode flags (octet 72 of template 3.0). */
  scanningMode: number;
  /** True when rows run south-to-north (scanning mode bit 2 set). */
  jScansPositively: boolean;
  /** True when columns run west-to-east (scanning mode bit 1 clear). */
  iScansPositively: boolean;
}

export interface Grib2Product {
  discipline: number;
  parameterCategory: number;
  parameterNumber: number;
  productDefinitionTemplate: number;
  typeOfFirstFixedSurface: number;
  /** Value of the first fixed surface (e.g. 10 for 10 m above ground), NaN when missing. */
  firstFixedSurfaceValue: number;
  /**
   * Forecast step in hours from the reference time: the instant (4.0), or
   * the END of the time range (4.8), the time the statistic is valid at.
   * A 4.8 message's own forecast time is the start of its range: ECMWF's
   * 3 h gust says 2 (the maximum over 2–3 h), its 3 h wind says 3.
   */
  forecastHours: number;
  /** Length of the time range in hours (4.8); 0 for an instant (4.0, 4.1), and for a 4.8 range that is still empty (step 0). */
  intervalHours: number;
  /**
   * The ensemble member (template 4.1, octets 35–37): `type` from code table 4.6 (0 the unperturbed control, 3 and 4 a
   * negatively and a positively perturbed member), `member` its number (0 for the control), `size` the number of
   * forecasts in the ensemble. Absent for a forecast that is not an ensemble member.
   */
  ensemble?: { type: number; member: number; size: number };
}

export interface Grib2Packing {
  dataRepresentationTemplate: number;
  referenceValue: number;
  binaryScaleFactor: number;
  decimalScaleFactor: number;
  bitsPerValue: number;
  /** Only for template 5.42. */
  ccsds?: { flags: number; blockSize: number; rsi: number };
  /** Number of values coded in section 7. */
  numberOfValues: number;
}

export interface Grib2Message {
  /** Byte offset of the message within the buffer it was read from. */
  offset: number;
  /** Total message length in bytes. */
  length: number;
  discipline: number;
  centre: number;
  /** Reference (analysis) time as a UTC Date. */
  referenceTime: Date;
  grid: Grib2Grid;
  product: Grib2Product;
  packing: Grib2Packing;
  /** Total data points on the grid (ni*nj for regular grids). */
  numberOfDataPoints: number;
  /** True when a bit map is present (some points missing). */
  hasBitmap: boolean;
  /**
   * Decode the field. Returns one value per grid point in scanning
   * order, NaN where the bit map marks a point as missing. `scratch`
   * buffers (reused across calls by a bulk loader) avoid allocating
   * ~12 MB per 0.25° global field; the returned array is then a view of
   * `scratch.out` and is overwritten by the next call.
   */
  decode(scratch?: DecodeScratch): Float64Array;
}

// ---------------------------------------------------------------------
// Low-level readers

function u8(b: Uint8Array, o: number): number {
  return b[o];
}
function u16(b: Uint8Array, o: number): number {
  return (b[o] << 8) | b[o + 1];
}
function u32(b: Uint8Array, o: number): number {
  return ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
}
function u64(b: Uint8Array, o: number): number {
  const hi = u32(b, o);
  const lo = u32(b, o + 4);
  if (hi > 0x1fffff) throw new Grib2Error('64-bit length exceeds 2^53');
  return hi * 2 ** 32 + lo;
}
/** GRIB2 signed integers: sign bit + magnitude (regulation 92.1.5). */
function s16(b: Uint8Array, o: number): number {
  const v = u16(b, o);
  return v & 0x8000 ? -(v & 0x7fff) : v;
}
function s32(b: Uint8Array, o: number): number {
  const v = u32(b, o);
  return v & 0x80000000 ? -(v & 0x7fffffff) : v;
}
function f32(b: Uint8Array, o: number): number {
  return new DataView(b.buffer, b.byteOffset + o, 4).getFloat32(0, false);
}

const MISSING_U32 = 0xffffffff;

// ---------------------------------------------------------------------

interface Sections {
  s1: number; // absolute offsets of section starts
  s3: number;
  s4: number;
  s5: number;
  s6: number;
  s7: number;
}

/**
 * Iterate over every GRIB2 message in a buffer. Bytes between messages
 * (e.g. index padding) are skipped by scanning for the "GRIB" magic.
 */
export function* iterateGrib2(buf: Uint8Array): Generator<Grib2Message> {
  let pos = 0;
  while (pos + 16 <= buf.length) {
    // Scan for "GRIB".
    if (!(buf[pos] === 0x47 && buf[pos + 1] === 0x52 && buf[pos + 2] === 0x49 && buf[pos + 3] === 0x42)) {
      pos++;
      continue;
    }
    const edition = u8(buf, pos + 7);
    if (edition !== 2) throw new Grib2Error(`GRIB edition ${edition} at offset ${pos} is not supported`);
    const length = u64(buf, pos + 8);
    if (pos + length > buf.length) {
      throw new Grib2Error(`message at offset ${pos} claims ${length} bytes but only ${buf.length - pos} remain`);
    }
    yield parseMessage(buf.subarray(pos, pos + length), pos);
    pos += length;
  }
}

/** Parse exactly one message starting at byte 0 of `msg`. */
export function parseGrib2Message(msg: Uint8Array): Grib2Message {
  return parseMessage(msg, 0);
}

function parseMessage(m: Uint8Array, absOffset: number): Grib2Message {
  const discipline = u8(m, 6);
  const length = u64(m, 8);

  const sec: Partial<Sections> = {};
  let p = 16;
  while (p < length) {
    // Section 8 is the literal "7777".
    if (m[p] === 0x37 && m[p + 1] === 0x37 && m[p + 2] === 0x37 && m[p + 3] === 0x37) break;
    const secLen = u32(m, p);
    const secNum = u8(m, p + 4);
    if (secLen < 5) throw new Grib2Error(`section ${secNum} at ${absOffset + p} has length ${secLen}`);
    switch (secNum) {
      case 1:
        sec.s1 = p;
        break;
      case 2:
        break; // local use, ignored
      case 3:
        sec.s3 = p;
        break;
      case 4:
        sec.s4 = p;
        break;
      case 5:
        sec.s5 = p;
        break;
      case 6:
        sec.s6 = p;
        break;
      case 7:
        sec.s7 = p;
        break;
      default:
        throw new Grib2Error(`unknown section number ${secNum} at ${absOffset + p}`);
    }
    p += secLen;
  }
  for (const k of ['s1', 's3', 's4', 's5', 's6', 's7'] as const) {
    if (sec[k] === undefined) throw new Grib2Error(`message at ${absOffset} lacks section ${k.slice(1)}`);
  }
  const s = sec as Sections;

  // ---- Section 1: identification
  const centre = u16(m, s.s1 + 5);
  const year = u16(m, s.s1 + 12);
  const month = u8(m, s.s1 + 14);
  const day = u8(m, s.s1 + 15);
  const hour = u8(m, s.s1 + 16);
  const minute = u8(m, s.s1 + 17);
  const second = u8(m, s.s1 + 18);
  const referenceTime = new Date(Date.UTC(year, month - 1, day, hour, minute, second));

  // ---- Section 3: grid definition
  const { grid, numberOfDataPoints } = readGrid(m, s.s3);

  // ---- Section 4: product definition
  const pdt = u16(m, s.s4 + 7);
  const q = s.s4 - 1;
  if (pdt !== 0 && pdt !== 1 && pdt !== 8) {
    throw new Grib2Error(`product definition template 4.${pdt} not supported (only 4.0, 4.1 and 4.8)`);
  }
  const parameterCategory = u8(m, q + 10);
  const parameterNumber = u8(m, q + 11);
  const timeUnit = u8(m, q + 18);
  const forecastTime = s32(m, q + 19);
  const typeOfFirstFixedSurface = u8(m, q + 23);
  // Octet 24: scale factor, 25–28: scaled value (all ones = missing).
  const surfScale = u8(m, q + 24);
  const surfScaled = u32(m, q + 25);
  const firstFixedSurfaceValue =
    surfScale === 0xff || surfScaled === 0xffffffff ? NaN : surfScaled / 10 ** (surfScale > 127 ? -(surfScale & 0x7f) : surfScale);
  const startHours = forecastTime * timeUnitHours(timeUnit);
  let forecastHours = startHours;
  let intervalHours = 0;
  if (pdt === 8) {
    // Octets 35–41: end of the overall time interval (UTC), the time the
    // statistic is valid at (WMO GRIB2 code table 4.8).
    if (u32(m, s.s4) < 58) throw new Grib2Error(`product definition template 4.8 section too short (${u32(m, s.s4)} octets)`);
    const endMs = Date.UTC(u16(m, q + 35), u8(m, q + 37) - 1, u8(m, q + 38), u8(m, q + 39), u8(m, q + 40), u8(m, q + 41));
    const endHours = (endMs - referenceTime.getTime()) / 3_600_000;
    if (!(endHours >= startHours))
      throw new Grib2Error(`template 4.8 time range ends (+${endHours} h) before it starts (+${startHours} h)`);
    forecastHours = endHours;
    intervalHours = endHours - startHours;
  }
  const product: Grib2Product = {
    discipline,
    parameterCategory,
    parameterNumber,
    productDefinitionTemplate: pdt,
    typeOfFirstFixedSurface,
    firstFixedSurfaceValue,
    forecastHours,
    intervalHours,
  };
  if (pdt === 1) {
    // Octets 1–34 as template 4.0; then the type of ensemble forecast, the perturbation number and the ensemble's size.
    if (u32(m, s.s4) < 37) throw new Grib2Error(`product definition template 4.1 section too short (${u32(m, s.s4)} octets)`);
    product.ensemble = { type: u8(m, q + 35), member: u8(m, q + 36), size: u8(m, q + 37) };
  }

  // ---- Section 5: data representation
  const numberOfValues = u32(m, s.s5 + 5);
  const drt = u16(m, s.s5 + 9);
  const r = s.s5 - 1;
  if (drt !== 0 && drt !== 42) {
    throw new Grib2Error(`data representation template 5.${drt} not supported (only 5.0 and 5.42)`);
  }
  const packing: Grib2Packing = {
    dataRepresentationTemplate: drt,
    referenceValue: f32(m, r + 12),
    binaryScaleFactor: s16(m, r + 16),
    decimalScaleFactor: s16(m, r + 18),
    bitsPerValue: u8(m, r + 20),
    numberOfValues,
  };
  if (drt === 42) {
    packing.ccsds = { flags: u8(m, r + 22), blockSize: u8(m, r + 23), rsi: u16(m, r + 24) };
  }

  // ---- Section 6: bit map
  const bitmapIndicator = u8(m, s.s6 + 5);
  let bitmap: Uint8Array | null = null;
  if (bitmapIndicator === 0) {
    const s6len = u32(m, s.s6);
    bitmap = m.subarray(s.s6 + 6, s.s6 + s6len);
    if (bitmap.length * 8 < numberOfDataPoints) {
      throw new Grib2Error(`bit map has ${bitmap.length} bytes for ${numberOfDataPoints} points`);
    }
  } else if (bitmapIndicator !== 255) {
    throw new Grib2Error(`bit map indicator ${bitmapIndicator} not supported (only 0 and 255)`);
  }
  if (!bitmap && numberOfValues !== numberOfDataPoints) {
    throw new Grib2Error(`no bit map but numberOfValues ${numberOfValues} != points ${numberOfDataPoints}`);
  }

  // ---- Section 7: data
  const s7len = u32(m, s.s7);
  const data = m.subarray(s.s7 + 5, s.s7 + s7len);

  const decode = (scratch?: DecodeScratch): Float64Array => unpack(data, packing, bitmap, numberOfDataPoints, scratch);

  return {
    offset: absOffset,
    length,
    discipline,
    centre,
    referenceTime,
    grid,
    product,
    packing,
    numberOfDataPoints,
    hasBitmap: bitmap !== null,
    decode,
  };
}

/** Section 3 (grid definition template 3.0) starting at offset `s3` of `m`. */
function readGrid(m: Uint8Array, s3: number): { grid: Grib2Grid; numberOfDataPoints: number } {
  const gridSource = u8(m, s3 + 5);
  const numberOfDataPoints = u32(m, s3 + 6);
  const optListOctets = u8(m, s3 + 10);
  const gdt = u16(m, s3 + 12);
  if (gridSource !== 0) throw new Grib2Error(`grid definition source ${gridSource} not supported`);
  if (gdt !== 0) throw new Grib2Error(`grid definition template 3.${gdt} not supported (only 3.0 lat/lon)`);
  if (optListOctets !== 0) throw new Grib2Error('quasi-regular grids (optional point list) not supported');
  const g = s3 - 1; // so that g + octetNumber addresses the octet
  const ni = u32(m, g + 31);
  const nj = u32(m, g + 35);
  if (ni === MISSING_U32 || nj === MISSING_U32) throw new Grib2Error('Ni/Nj missing: quasi-regular grid not supported');
  const basicAngle = u32(m, g + 39);
  const subdivisions = u32(m, g + 43);
  let unit = 1e-6;
  if (!(basicAngle === 0 || basicAngle === MISSING_U32) || !(subdivisions === MISSING_U32 || subdivisions === 0)) {
    if (basicAngle === 0 || subdivisions === 0 || subdivisions === MISSING_U32) {
      throw new Grib2Error(`unsupported basic angle ${basicAngle} / subdivisions ${subdivisions}`);
    }
    unit = basicAngle / subdivisions;
  }
  const la1 = s32(m, g + 47) * unit;
  const lo1 = s32(m, g + 51) * unit;
  const la2 = s32(m, g + 56) * unit;
  const lo2 = s32(m, g + 60) * unit;
  const di = u32(m, g + 64) * unit;
  const dj = u32(m, g + 68) * unit;
  const scanningMode = u8(m, g + 72);
  if (scanningMode & 0x20) throw new Grib2Error('scanning mode with adjacent points in j direction not supported');
  if (scanningMode & 0x10) throw new Grib2Error('boustrophedonic scanning not supported');
  if (scanningMode & 0x0f) throw new Grib2Error(`scanning mode 0x${scanningMode.toString(16)} not supported`);
  const grid: Grib2Grid = {
    ni,
    nj,
    la1,
    lo1,
    la2,
    lo2,
    di,
    dj,
    scanningMode,
    jScansPositively: (scanningMode & 0x40) !== 0,
    iScansPositively: (scanningMode & 0x80) === 0,
  };
  if (ni * nj !== numberOfDataPoints) {
    throw new Grib2Error(`ni*nj = ${ni * nj} but numberOfDataPoints = ${numberOfDataPoints}`);
  }
  return { grid, numberOfDataPoints };
}

/**
 * The grid of the first message from the start of a GRIB2 file alone
 * (sections 0 to 3; the rest of the message need not be there), so a
 * product's extent can be learnt from its first few kilobytes.
 */
export function parseGrib2Grid(head: Uint8Array): Grib2Grid {
  if (!(head[0] === 0x47 && head[1] === 0x52 && head[2] === 0x49 && head[3] === 0x42)) throw new Grib2Error('not a GRIB message');
  const edition = u8(head, 7);
  if (edition !== 2) throw new Grib2Error(`GRIB edition ${edition} is not supported`);
  let p = 16;
  while (p + 5 <= head.length) {
    const secLen = u32(head, p);
    const secNum = u8(head, p + 4);
    if (secLen < 5) throw new Grib2Error(`section ${secNum} at ${p} has length ${secLen}`);
    if (secNum === 3) {
      if (p + secLen > head.length) break;
      return readGrid(head, p).grid;
    }
    if (secNum > 3) throw new Grib2Error(`section ${secNum} before any grid definition`);
    p += secLen;
  }
  throw new Grib2Error(`no grid definition in the first ${head.length} bytes`);
}

function timeUnitHours(code: number): number {
  switch (code) {
    case 0:
      return 1 / 60;
    case 1:
      return 1;
    case 2:
      return 24;
    case 10:
      return 3;
    case 11:
      return 6;
    case 12:
      return 12;
    case 13:
      return 1 / 3600;
    default:
      throw new Grib2Error(`time range unit ${code} not supported`);
  }
}

/** Read `n` packed big-endian unsigned integers of `bits` bits each. */
/** Reusable decode buffers: `x` for the packed integers, `out` for the values. Grown on demand. */
export interface DecodeScratch {
  x?: Uint32Array;
  out?: Float64Array;
}

function unpackSimple(data: Uint8Array, bits: number, n: number, buf?: Uint32Array): Uint32Array {
  const out = buf && buf.length >= n ? buf.subarray(0, n) : new Uint32Array(n);
  if (bits === 0) {
    out.fill(0);
    return out; // all values equal the reference value
  }
  if (bits > 32) throw new Grib2Error(`simple packing with ${bits} bits per value not supported`);
  let acc = 0;
  let nbits = 0;
  let pos = 0;
  for (let i = 0; i < n; i++) {
    while (nbits < bits) {
      if (pos >= data.length) throw new Grib2Error('simple-packed data section too short');
      acc = acc * 256 + data[pos++];
      nbits += 8;
    }
    const rem = nbits - bits;
    const div = 2 ** rem;
    const v = Math.floor(acc / div);
    acc -= v * div;
    nbits = rem;
    out[i] = v;
  }
  return out;
}

function unpack(
  data: Uint8Array,
  packing: Grib2Packing,
  bitmap: Uint8Array | null,
  numberOfDataPoints: number,
  scratch?: DecodeScratch
): Float64Array {
  const n = packing.numberOfValues;
  if (scratch && (!scratch.x || scratch.x.length < n)) scratch.x = new Uint32Array(n);
  if (scratch && (!scratch.out || scratch.out.length < numberOfDataPoints)) scratch.out = new Float64Array(numberOfDataPoints);
  let x: Uint32Array;
  if (packing.dataRepresentationTemplate === 42) {
    const c = packing.ccsds!;
    if (packing.bitsPerValue === 0) {
      x = scratch ? scratch.x!.subarray(0, n).fill(0) : new Uint32Array(n);
    } else {
      x = aecDecode(
        data,
        {
          bitsPerSample: packing.bitsPerValue,
          blockSize: c.blockSize,
          rsi: c.rsi,
          flags: c.flags,
        },
        n,
        undefined,
        scratch?.x
      );
    }
  } else {
    x = unpackSimple(data, packing.bitsPerValue, n, scratch?.x);
  }

  // Regulation 92.9.4: Y = (R + X * 2^E) / 10^D. eccodes evaluates this
  // in double precision as (X * 2^E + R) * 10^-D; we do the same so the
  // results compare exactly.
  const bscale = 2 ** packing.binaryScaleFactor;
  const dscale = 10 ** -packing.decimalScaleFactor;
  const R = packing.referenceValue;

  const out = scratch ? scratch.out!.subarray(0, numberOfDataPoints) : new Float64Array(numberOfDataPoints);
  if (!bitmap) {
    for (let i = 0; i < n; i++) out[i] = (x[i] * bscale + R) * dscale;
    return out;
  }
  let k = 0;
  for (let i = 0; i < numberOfDataPoints; i++) {
    const bit = bitmap[i >> 3] & (0x80 >> (i & 7));
    if (bit) {
      if (k >= n) throw new Grib2Error('bit map marks more present points than values coded');
      out[i] = (x[k++] * bscale + R) * dscale;
    } else {
      out[i] = NaN;
    }
  }
  if (k !== n) throw new Grib2Error(`bit map marks ${k} present points but ${n} values coded`);
  return out;
}
