/**
 * Generic encode/decode over a `FieldSchema[]` table (see schema.ts). `encodeFields` and
 * `decodeFields` both switch on `field.kind` and walk the fields in the same order — the only
 * "generator" here is this shared iteration, which is what keeps the two directions from
 * drifting apart. Message-specific code (messages.ts) never hand-rolls a read or write of its
 * own; it only supplies a `fields` table.
 */
import { BitReader, BitWriter } from './bitio.js';
import { quantDecode, quantEncode, type FieldSchema, type InferFields } from './schema.js';

/** Generic record shape used internally while building/consuming a message object. */
type FieldRecord = Record<string, unknown>;

export function encodeFields(fields: readonly FieldSchema[], obj: FieldRecord, writer: BitWriter): void {
  for (const f of fields) {
    switch (f.kind) {
      case 'bool':
        writer.writeBool(Boolean(obj[f.name]));
        break;
      case 'uint':
        writer.writeBits(obj[f.name] as number, f.bits);
        break;
      case 'int':
        writer.writeInt(obj[f.name] as number, f.bits);
        break;
      case 'quant':
        writer.writeBits(quantEncode(obj[f.name] as number, f.min, f.max, f.bits), f.bits);
        break;
      case 'bytes': {
        const bytes = obj[f.name] as Uint8Array;
        if (bytes.length !== f.length) {
          throw new Error(`encodeFields: field "${f.name}" expected ${f.length} bytes, got ${bytes.length}`);
        }
        writer.writeBytesRaw(bytes);
        break;
      }
      case 'array': {
        const arr = obj[f.name] as FieldRecord[];
        const n = Math.min(arr.length, f.maxCount);
        writer.writeBits(n, f.countBits);
        for (let i = 0; i < n; i++) encodeFields(f.element, arr[i], writer);
        break;
      }
    }
  }
}

export function decodeFields(fields: readonly FieldSchema[], reader: BitReader): FieldRecord {
  const out: FieldRecord = {};
  for (const f of fields) {
    switch (f.kind) {
      case 'bool':
        out[f.name] = reader.readBool();
        break;
      case 'uint':
        out[f.name] = reader.readBits(f.bits);
        break;
      case 'int':
        out[f.name] = reader.readInt(f.bits);
        break;
      case 'quant':
        out[f.name] = quantDecode(reader.readBits(f.bits), f.min, f.max, f.bits);
        break;
      case 'bytes':
        out[f.name] = reader.readBytesRaw(f.length);
        break;
      case 'array': {
        const n = reader.readBits(f.countBits);
        const arr: FieldRecord[] = [];
        for (let i = 0; i < n; i++) arr.push(decodeFields(f.element, reader));
        out[f.name] = arr;
        break;
      }
    }
  }
  return out;
}

/** Encode a full message: 8-bit message id, then its fields. */
export function encodeMessage<F extends readonly FieldSchema[]>(
  id: number,
  fields: F,
  msg: InferFields<F>,
  writer: BitWriter,
): void {
  writer.writeBits(id, 8);
  encodeFields(fields, msg as FieldRecord, writer);
}

/** Decode a message body (the 8-bit id must already have been read and dispatched by the caller). */
export function decodeMessageBody<F extends readonly FieldSchema[]>(fields: F, reader: BitReader): InferFields<F> {
  return decodeFields(fields, reader) as InferFields<F>;
}

/** Peek the 8-bit message id without consuming anything else from a fresh reader. */
export function readMessageId(reader: BitReader): number {
  return reader.readBits(8);
}
