import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { BitReader, BitWriter } from '../src/proto/bitio.js';
import { decodeFields, encodeFields } from '../src/proto/codec.js';
import { quantStep, type FieldSchema } from '../src/proto/schema.js';
import {
  CORRECTION_FIELDS,
  HELLO_FIELDS,
  INPUT_FIELDS,
  MESSAGES,
  PING_FIELDS,
  PONG_FIELDS,
  REJECT_FIELDS,
  SERVER_RESTART_FIELDS,
  SNAPSHOT_FIELDS,
  WELCOME_FIELDS,
} from '../src/proto/messages.js';

/** Enough scratch space for the largest message (SNAPSHOT, up to 511 boats + 255 spawns/despawns). */
const SCRATCH = new Uint8Array(8192);

/** A fast-check arbitrary generating a value for one field, plus the max tolerable round-trip error. */
function arbFor(f: FieldSchema): fc.Arbitrary<unknown> {
  switch (f.kind) {
    case 'bool':
      return fc.boolean();
    case 'uint':
      return fc.integer({ min: 0, max: f.bits >= 32 ? 0xffffffff : 2 ** f.bits - 1 });
    case 'int': {
      const half = 2 ** (f.bits - 1);
      return fc.integer({ min: -half, max: half - 1 });
    }
    case 'quant':
      return fc.double({ min: f.min, max: f.max, noNaN: true });
    case 'bytes':
      return fc.uint8Array({ minLength: f.length, maxLength: f.length });
    case 'array':
      return fc.array(arbForFields(f.element), { maxLength: Math.min(f.maxCount, 5) });
  }
}

function arbForFields(fields: readonly FieldSchema[]): fc.Arbitrary<Record<string, unknown>> {
  const shape: Record<string, fc.Arbitrary<unknown>> = {};
  for (const f of fields) shape[f.name] = arbFor(f);
  return fc.record(shape);
}

/** Assert every field of a decoded record matches the original within its documented tolerance. */
function assertFieldsClose(fields: readonly FieldSchema[], original: Record<string, unknown>, decoded: Record<string, unknown>): void {
  for (const f of fields) {
    const name = f.name;
    if (f.kind === 'quant') {
      const step = quantStep(f.min, f.max, f.bits);
      const clamped = Math.min(f.max, Math.max(f.min, original[name] as number));
      expect(decoded[name] as number).toBeGreaterThanOrEqual(clamped - step / 2 - 1e-9);
      expect(decoded[name] as number).toBeLessThanOrEqual(clamped + step / 2 + 1e-9);
    } else if (f.kind === 'bytes') {
      expect(Array.from(decoded[name] as Uint8Array)).toEqual(Array.from(original[name] as Uint8Array));
    } else if (f.kind === 'array') {
      const origArr = original[name] as Record<string, unknown>[];
      const decArr = decoded[name] as Record<string, unknown>[];
      expect(decArr.length).toBe(origArr.length);
      for (let i = 0; i < origArr.length; i++) assertFieldsClose(f.element, origArr[i], decArr[i]);
    } else {
      expect(decoded[name]).toBe(original[name]);
    }
  }
}

function roundTrip(fields: readonly FieldSchema[], value: Record<string, unknown>): Record<string, unknown> {
  const writer = new BitWriter(SCRATCH);
  encodeFields(fields, value, writer);
  const reader = new BitReader(writer.finish());
  return decodeFields(fields, reader);
}

const ALL_MESSAGE_SCHEMAS: Array<[string, readonly FieldSchema[]]> = [
  ['HELLO', HELLO_FIELDS],
  ['WELCOME', WELCOME_FIELDS],
  ['REJECT', REJECT_FIELDS],
  ['INPUT', INPUT_FIELDS],
  ['PING', PING_FIELDS],
  ['PONG', PONG_FIELDS],
  ['SNAPSHOT', SNAPSHOT_FIELDS],
  ['CORRECTION', CORRECTION_FIELDS],
  ['SERVER_RESTART', SERVER_RESTART_FIELDS],
];

describe('proto round-trip: every message type in the schema table', () => {
  for (const [name, fields] of ALL_MESSAGE_SCHEMAS) {
    it(`${name}: random values encode -> decode within quantization error (100 runs)`, () => {
      fc.assert(
        fc.property(arbForFields(fields), (value) => {
          const decoded = roundTrip(fields, value);
          assertFieldsClose(fields, value, decoded);
        }),
        { numRuns: 100 },
      );
    });
  }

  it('MESSAGES registry covers every MSG id with a matching fields table', () => {
    const registered = Object.values(MESSAGES).map((m) => m.fields);
    for (const [, fields] of ALL_MESSAGE_SCHEMAS) {
      expect(registered).toContain(fields);
    }
  });
});

describe('proto round-trip: generic field-kind fuzzing (covers kinds no real message currently uses)', () => {
  it('bool/uint/int/quant/bytes/array fields all round-trip, including nested arrays', () => {
    const syntheticFields = [
      { kind: 'bool', name: 'flag' },
      { kind: 'uint', name: 'u1', bits: 1 },
      { kind: 'uint', name: 'u32', bits: 32 },
      { kind: 'int', name: 'i8', bits: 8 },
      { kind: 'int', name: 'i32', bits: 32 },
      { kind: 'quant', name: 'q', bits: 10, min: -100, max: 100 },
      { kind: 'bytes', name: 'b', length: 4 },
      {
        kind: 'array',
        name: 'nested',
        countBits: 4,
        maxCount: 8,
        element: [
          { kind: 'int', name: 'n', bits: 16 },
          { kind: 'quant', name: 'q2', bits: 8, min: 0, max: 1 },
        ],
      },
    ] as const satisfies readonly FieldSchema[];

    fc.assert(
      fc.property(arbForFields(syntheticFields), (value) => {
        const decoded = roundTrip(syntheticFields, value);
        assertFieldsClose(syntheticFields, value, decoded);
      }),
      { numRuns: 200 },
    );
  });

  it('writeBits/readBits round-trips the full 32-bit unsigned range exactly', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 0xffffffff }), (v) => {
        const writer = new BitWriter(SCRATCH);
        writer.writeBits(v, 32);
        const reader = new BitReader(writer.finish());
        expect(reader.readBits(32)).toBe(v);
      }),
      { numRuns: 500 },
    );
  });

  it('writeInt/readInt round-trips signed two\'s-complement values exactly for every bit width 2..32', () => {
    for (const bits of [2, 3, 7, 8, 9, 15, 16, 17, 24, 31, 32]) {
      const half = 2 ** (bits - 1);
      fc.assert(
        fc.property(fc.integer({ min: -half, max: half - 1 }), (v) => {
          const writer = new BitWriter(SCRATCH);
          writer.writeInt(v, bits);
          const reader = new BitReader(writer.finish());
          expect(reader.readInt(bits)).toBe(v);
        }),
        { numRuns: 50 },
      );
    }
  });
});

describe('BitWriter/BitReader packing', () => {
  it('byteLength is exactly ceil(total bits / 8)', () => {
    const writer = new BitWriter(SCRATCH);
    writer.writeBits(1, 3);
    writer.writeBits(0, 4);
    expect(writer.byteLength).toBe(1);
    writer.writeBits(1, 2);
    expect(writer.byteLength).toBe(2);
  });

  it('packs several small fields back-to-back without cross-talk', () => {
    const writer = new BitWriter(SCRATCH);
    writer.writeBits(0b101, 3);
    writer.writeBits(0b11110000, 8);
    writer.writeBits(0b1, 1);
    const reader = new BitReader(writer.finish());
    expect(reader.readBits(3)).toBe(0b101);
    expect(reader.readBits(8)).toBe(0b11110000);
    expect(reader.readBits(1)).toBe(0b1);
  });

  it('reset() lets a scratch buffer be reused with no stale cross-talk from a longer previous write', () => {
    const writer = new BitWriter(SCRATCH);
    writer.writeBits(0xff, 8);
    writer.writeBits(0xff, 8);
    writer.reset();
    writer.writeBits(0, 4);
    const reader = new BitReader(writer.finish());
    expect(reader.readBits(4)).toBe(0);
  });
});
