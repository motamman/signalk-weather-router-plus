import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { iterateGrib2 } from './grib2';
import { aecDecode, AecError } from './ccsds';
import { buildStep } from '../data/forecast';

const fixture = path.join(__dirname, '..', '..', 'test-data', 'ecmwf_10u10v_3steps.grib2');
const truthPath = path.join(__dirname, '..', '..', 'test-data', 'ecmwf_10u10v_3steps.truth.json');

interface Truth {
  shortName: string;
  step: number;
  Ni: number;
  Nj: number;
  dataDate: number;
  dataTime: number;
  latitudeOfFirstGridPointInDegrees: number;
  longitudeOfFirstGridPointInDegrees: number;
  iDirectionIncrementInDegrees: number;
  count: number;
  min: number;
  max: number;
  sum: number;
  sha256_f64le: string;
  sampleStride: number;
  samples: number[];
}

test('ECMWF CCSDS-packed GRIB2 decodes to exactly what eccodes produces', () => {
  const buf = new Uint8Array(fs.readFileSync(fixture));
  const truth = JSON.parse(fs.readFileSync(truthPath, 'utf8')) as Truth[];
  const msgs = [...iterateGrib2(buf)];
  assert.equal(msgs.length, truth.length);
  msgs.forEach((m, i) => {
    const t = truth[i];
    assert.equal(m.grid.ni, t.Ni);
    assert.equal(m.grid.nj, t.Nj);
    assert.equal(m.product.forecastHours, t.step);
    assert.equal(m.grid.la1, t.latitudeOfFirstGridPointInDegrees);
    assert.equal(m.grid.lo1, t.longitudeOfFirstGridPointInDegrees);
    assert.equal(m.grid.di, t.iDirectionIncrementInDegrees);
    const param = m.product.parameterNumber === 2 ? '10u' : '10v';
    assert.equal(param, t.shortName);
    const vals = m.decode();
    assert.equal(vals.length, t.count);
    // Full-array hash of the little-endian float64 bytes, as eccodes wrote them.
    const hash = createHash('sha256')
      .update(Buffer.from(vals.buffer, vals.byteOffset, vals.byteLength))
      .digest('hex');
    assert.equal(hash, t.sha256_f64le, `${t.shortName} +${t.step}h: decoded values differ from eccodes`);
    let mn = Infinity;
    let mx = -Infinity;
    let sum = 0;
    for (let k = 0; k < vals.length; k++) {
      if (vals[k] < mn) mn = vals[k];
      if (vals[k] > mx) mx = vals[k];
      sum += vals[k];
    }
    assert.equal(mn, t.min);
    assert.equal(mx, t.max);
    assert.ok(Math.abs(sum - t.sum) < 1e-6 * Math.abs(t.sum) + 1e-6);
    t.samples.forEach((s, k) => assert.equal(vals[k * t.sampleStride], s));
  });
});

test('reference time is parsed from section 1', () => {
  const buf = new Uint8Array(fs.readFileSync(fixture));
  const truth = JSON.parse(fs.readFileSync(truthPath, 'utf8')) as Truth[];
  const m = [...iterateGrib2(buf)][0];
  const d = truth[0].dataDate;
  const hm = truth[0].dataTime;
  const want = Date.UTC(Math.floor(d / 10000), Math.floor((d % 10000) / 100) - 1, d % 100, Math.floor(hm / 100), hm % 100);
  assert.equal(m.referenceTime.getTime(), want);
});

test('CCSDS decoder rejects invalid configuration and truncated streams', () => {
  assert.throws(() => aecDecode(new Uint8Array(8), { bitsPerSample: 0, blockSize: 32, rsi: 128, flags: 14 }, 10), AecError);
  assert.throws(() => aecDecode(new Uint8Array(8), { bitsPerSample: 12, blockSize: 33, rsi: 128, flags: 14 }, 10), AecError);
  assert.throws(() => aecDecode(new Uint8Array(8), { bitsPerSample: 12, blockSize: 32, rsi: 5000, flags: 14 }, 10), AecError);
  // Too few bytes for the requested samples in the uncompressed option.
  const uncompressed = new Uint8Array([0xf0, 0x00]); // id=15 (uncompressed) then not enough data
  assert.throws(() => aecDecode(uncompressed, { bitsPerSample: 12, blockSize: 32, rsi: 128, flags: 14 }, 32), AecError);
});

test('CCSDS decoder handles a hand-built zero block', () => {
  // idLen=4 for 12-bit samples. id=0 → low entropy, sub-bit 0 → zero block,
  // reference sample (12 bits, preprocess on) = 0x123, then fs "1" → zeroBlocks=1
  // (single block of 32 zeros minus the reference).
  // Bits: 0000 0 000100100011 1 → pad
  const bits = '0000' + '0' + '000100100011' + '1';
  const padded = bits.padEnd(Math.ceil(bits.length / 8) * 8, '0');
  const bytes = new Uint8Array(padded.length / 8);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(padded.slice(i * 8, i * 8 + 8), 2);
  const out = aecDecode(bytes, { bitsPerSample: 12, blockSize: 32, rsi: 128, flags: 14 }, 32);
  assert.equal(out.length, 32);
  assert.equal(out[0], 0x123); // reference sample passes through the preprocessor unchanged
  // Zero deltas map back to the reference value under the unsigned preprocessor.
  for (let i = 1; i < 32; i++) assert.equal(out[i], 0x123);
});

// Template 4.8 (a statistic over a time range): the message's own forecast
// time is the START of its range; it is valid at the END. ECMWF's 3 h file
// holds the 10 m gust as "start 2 h, 1 h long, ends 03:00" next to the 3 h
// wind, so read as the start it fell an hour before the wind and the step
// failed to build. The fixture is ECMWF's real step-0 gust (2026-10-03 00Z,
// an empty range, all zeros); a copy is patched to the real 3 h header.
const gustFixture = path.join(__dirname, '..', '..', 'test-data', 'ecmwf_10fg_0h.grib2');

/** Byte offsets (0-based) of sections 1 and 4 of the first message. */
function sectionsOf(b: Uint8Array): { s1: number; s4: number } {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const out: Record<number, number> = {};
  for (let p = 16; p < b.length - 4;) {
    if (b[p] === 0x37 && b[p + 1] === 0x37 && b[p + 2] === 0x37 && b[p + 3] === 0x37) break;
    out[b[p + 4]] = p;
    p += dv.getUint32(p);
  }
  return { s1: out[1], s4: out[4] };
}

/** The step-0 gust re-dated: reference `ref`, range from +startH for lenH hours. */
function gustAt(ref: Date, startH: number, lenH: number): Uint8Array {
  const b = new Uint8Array(fs.readFileSync(gustFixture));
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const { s1, s4 } = sectionsOf(b);
  const setTime = (o: number, d: Date): void => {
    dv.setUint16(o, d.getUTCFullYear());
    b[o + 2] = d.getUTCMonth() + 1;
    b[o + 3] = d.getUTCDate();
    b[o + 4] = d.getUTCHours();
    b[o + 5] = d.getUTCMinutes();
    b[o + 6] = d.getUTCSeconds();
  };
  setTime(s1 + 12, ref); // section 1 octets 13–19
  const q = s4 - 1; // q + n = octet n of section 4
  dv.setInt32(q + 19, startH); // forecast time (unit: hour)
  setTime(q + 35, new Date(ref.getTime() + (startH + lenH) * 3_600_000)); // end of the range
  dv.setUint32(q + 50, lenH); // length of the time range
  return b;
}

test('template 4.8: valid at the end of its time range; step 0 is an empty range', () => {
  const [m0] = [...iterateGrib2(new Uint8Array(fs.readFileSync(gustFixture)))];
  assert.equal(m0.product.productDefinitionTemplate, 8);
  assert.equal(m0.product.parameterNumber, 22, '10 m wind gust (0.2.22)');
  assert.equal(m0.product.forecastHours, 0);
  assert.equal(m0.product.intervalHours, 0, 'nothing has happened yet at step 0');
  assert.ok(
    m0.decode().every(v => v === 0),
    'ECMWF codes the empty range as zeros everywhere'
  );

  const ref = new Date('2026-10-03T00:00:00Z');
  const [m3] = [...iterateGrib2(gustAt(ref, 2, 1))];
  assert.equal(m3.product.forecastHours, 3, 'the 3 h file: maximum over 2–3 h, valid at 3 h');
  assert.equal(m3.product.intervalHours, 1);

  // A 4.0 field's time is unchanged: the wind fixture still reads 0, 3, 6.
  const wind = [...iterateGrib2(new Uint8Array(fs.readFileSync(fixture)))];
  assert.deepEqual(
    wind.map(w => [w.product.forecastHours, w.product.intervalHours]),
    [
      [0, 0],
      [0, 0],
      [3, 0],
      [3, 0],
      [6, 0],
      [6, 0],
    ]
  );
});

test('template 4.8: a gust and the wind of the same file build one step', () => {
  const wind = [...iterateGrib2(new Uint8Array(fs.readFileSync(fixture)))].filter(w => w.product.forecastHours === 3);
  const [gust] = [...iterateGrib2(gustAt(wind[0].referenceTime, 2, 1))];
  const step = buildStep(
    [
      { param: '10u', message: wind[0] },
      { param: '10v', message: wind[1] },
      { param: '10fg', message: gust },
    ],
    { west: -75, south: 36, east: -65, north: 45 }
  );
  assert.equal(step.stepHours, 3);
  assert.ok(step.fields.has('10fg'));
});

test('template 4.8: the step-0 gust (an empty range, coded 0 everywhere) is left out of the step', () => {
  const wind = [...iterateGrib2(new Uint8Array(fs.readFileSync(fixture)))].filter(w => w.product.forecastHours === 0);
  const [gust0] = [...iterateGrib2(gustAt(wind[0].referenceTime, 0, 0))];
  const step = buildStep(
    [
      { param: '10u', message: wind[0] },
      { param: '10v', message: wind[1] },
      { param: '10fg', message: gust0 },
    ],
    { west: -75, south: 36, east: -65, north: 45 }
  );
  assert.ok(!step.fields.has('10fg'), 'no real value: the field is absent, not 0');
  assert.ok(step.fields.has('10u'));
});

test('template 4.8: a range that ends before it starts is refused', () => {
  const b = gustAt(new Date('2026-10-03T00:00:00Z'), 2, 1);
  const { s4 } = sectionsOf(b);
  b[s4 - 1 + 39] = 1; // end hour 01:00, start +2 h
  assert.throws(() => [...iterateGrib2(b)], /ends \(\+1 h\) before it starts \(\+2 h\)/);
});
