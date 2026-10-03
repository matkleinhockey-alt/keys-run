/**
 * The wire-format schema table. Every message type in packages/shared/src/proto/messages.ts is a
 * `readonly FieldSchema[]` built from the variants below; codec.ts's `encodeFields`/`decodeFields`
 * both walk that *same* array in the *same* order. That is the "single schema table from which
 * both encode and decode are generated" docs/ARCHITECTURE.md's protocol section calls for: there
 * is no hand-written decode path that can drift from a hand-written encode path, because there is
 * only one path, parameterised by direction.
 *
 * `InferFields<Fields>` mirrors the runtime shape at the type level (a small mapped-type trick
 * over `as const` field tuples), so message producers/consumers get real TS types without a
 * second, hand-maintained set of interfaces to keep in sync.
 */

export interface BoolField {
  kind: 'bool';
  name: string;
}

export interface UintField {
  kind: 'uint';
  name: string;
  /** 1..32. 32-bit fields (tick counters, ms timestamps) are supported — see bitio.ts. */
  bits: number;
}

export interface IntField {
  kind: 'int';
  name: string;
  /** 1..32, two's-complement. */
  bits: number;
}

/** Linear quantization of a float onto `bits` unsigned levels spanning [min,max]. */
export interface QuantField {
  kind: 'quant';
  name: string;
  bits: number;
  min: number;
  max: number;
}

/** Fixed-length raw bytes (e.g. a 32-byte session token). */
export interface BytesField {
  kind: 'bytes';
  name: string;
  length: number;
}

/** A length-prefixed (countBits wide) array of nested records sharing one `element` schema. */
export interface ArrayField {
  kind: 'array';
  name: string;
  countBits: number;
  maxCount: number;
  element: readonly FieldSchema[];
}

export type FieldSchema = BoolField | UintField | IntField | QuantField | BytesField | ArrayField;

export type FieldTSType<F extends FieldSchema> = F extends BoolField
  ? boolean
  : F extends UintField
    ? number
    : F extends IntField
      ? number
      : F extends QuantField
        ? number
        : F extends BytesField
          ? Uint8Array
          : F extends ArrayField
            ? InferFields<F['element']>[]
            : never;

/** Maps a `readonly FieldSchema[]` (as produced by `as const`) to the plain object type it decodes to. */
export type InferFields<Fields extends readonly FieldSchema[]> = {
  [K in Fields[number]['name']]: FieldTSType<Extract<Fields[number], { name: K }>>;
};

const MAX_QUANT_BITS = 24;

/** Quantize `value` (clamped to [min,max]) onto an unsigned `bits`-wide code. */
export function quantEncode(value: number, min: number, max: number, bits: number): number {
  if (bits <= 0 || bits > MAX_QUANT_BITS) throw new Error(`quantEncode: bits=${bits} out of range`);
  const steps = (1 << bits) - 1;
  const clamped = value < min ? min : value > max ? max : value;
  const t = max > min ? (clamped - min) / (max - min) : 0;
  return Math.round(t * steps);
}

export function quantDecode(code: number, min: number, max: number, bits: number): number {
  if (bits <= 0 || bits > MAX_QUANT_BITS) throw new Error(`quantDecode: bits=${bits} out of range`);
  const steps = (1 << bits) - 1;
  return min + (code / steps) * (max - min);
}

/** Maximum rounding error introduced by `quantEncode`/`quantDecode` for this (min,max,bits). */
export function quantStep(min: number, max: number, bits: number): number {
  const steps = (1 << bits) - 1;
  return (max - min) / steps;
}

/** Worst-case bit width of one record encoded with `fields` (arrays counted at `maxCount`). */
export function maxBits(fields: readonly FieldSchema[]): number {
  let total = 0;
  for (const f of fields) {
    switch (f.kind) {
      case 'bool':
        total += 1;
        break;
      case 'uint':
      case 'int':
      case 'quant':
        total += f.bits;
        break;
      case 'bytes':
        total += f.length * 8;
        break;
      case 'array':
        total += f.countBits + f.maxCount * maxBits(f.element);
        break;
    }
  }
  return total;
}
