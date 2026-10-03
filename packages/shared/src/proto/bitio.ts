/**
 * Bit-level reader/writer over a caller-owned `Uint8Array`. Neither class allocates: `BitWriter`
 * writes into the buffer it is constructed with (or `reset()` onto), and `finish()` returns a
 * zero-copy `subarray` view of the written prefix. This is what lets `apps/sim`'s broadcast path
 * reuse one scratch buffer per connection across ticks instead of allocating a fresh one per
 * message — see docs/ARCHITECTURE.md's "zero allocation in the steady-state tick".
 *
 * Bit order is MSB-first within each byte. `readBits`/`writeBits` build values via
 * multiply/divide-by-2 (not `<<`/`>>>`) so that 32-bit fields (tick counters, timestamps) never
 * run into JS's 32-bit *signed* bitwise semantics — `writeBits` tolerates `>>> i` for the write
 * side (safe for i in [0,31]), but accumulating 32 bits on read via `<<` can produce a negative
 * intermediate; multiply/add keeps every intermediate a non-negative integer, exactly
 * representable in a float64 up to 2^53.
 */

const MAX_BITS = 32;

export class BitWriter {
  private buf: Uint8Array;
  private bitPos = 0;

  constructor(buffer: Uint8Array) {
    this.buf = buffer;
  }

  /** Point this writer at a new (or the same) backing buffer and rewind to bit 0. */
  reset(buffer?: Uint8Array): void {
    if (buffer) this.buf = buffer;
    this.bitPos = 0;
  }

  get bitLength(): number {
    return this.bitPos;
  }

  /** Bytes actually touched so far (ceil(bitPos/8)) — what `finish()` returns a view of. */
  get byteLength(): number {
    return (this.bitPos + 7) >>> 3;
  }

  /** Remaining capacity in bits given the backing buffer's length. */
  get bitsFree(): number {
    return this.buf.length * 8 - this.bitPos;
  }

  writeBool(v: boolean): void {
    this.writeBits(v ? 1 : 0, 1);
  }

  /** Write the low `bits` bits of `value` (treated as unsigned), MSB-first. `bits` in [0,32]. */
  writeBits(value: number, bits: number): void {
    if (bits <= 0) return;
    if (bits > MAX_BITS) throw new Error(`writeBits: bits=${bits} exceeds ${MAX_BITS}`);
    if (this.bitsFree < bits) throw new Error('BitWriter: buffer overflow');
    for (let i = bits - 1; i >= 0; i--) {
      const bit = (value >>> i) & 1;
      const byteIndex = this.bitPos >>> 3;
      const bitIndex = 7 - (this.bitPos & 7);
      if (bit) this.buf[byteIndex] |= 1 << bitIndex;
      else this.buf[byteIndex] &= ~(1 << bitIndex);
      this.bitPos++;
    }
  }

  /**
   * Two's-complement signed write within `bits` bits. Uses `2 ** bits` (not `1 << bits`) for the
   * mask: JS's `<<` is a *signed* 32-bit shift, so `1 << 31` overflows to a negative Int32 and
   * silently corrupts the mask for exactly `bits === 31` — `**` has no such width limit.
   */
  writeInt(value: number, bits: number): void {
    const mod = 2 ** bits;
    const u = ((value % mod) + mod) % mod; // value mod 2^bits, forced non-negative
    this.writeBits(u, bits);
  }

  writeBytesRaw(bytes: Uint8Array): void {
    for (let i = 0; i < bytes.length; i++) this.writeBits(bytes[i], 8);
  }

  /** Zero-copy view of the bytes written so far. Valid only until the next `reset()`/write. */
  finish(): Uint8Array {
    return this.buf.subarray(0, this.byteLength);
  }
}

export class BitReader {
  private buf: Uint8Array;
  private bitPos: number;
  private bitEnd: number;

  constructor(buffer: Uint8Array, byteOffset = 0, byteLength = buffer.length - byteOffset) {
    this.buf = buffer;
    this.bitPos = byteOffset * 8;
    this.bitEnd = (byteOffset + byteLength) * 8;
  }

  get bitsRemaining(): number {
    return this.bitEnd - this.bitPos;
  }

  readBool(): boolean {
    return this.readBits(1) !== 0;
  }

  /** Read `bits` bits (unsigned), MSB-first. `bits` in [0,32]. */
  readBits(bits: number): number {
    if (bits <= 0) return 0;
    if (bits > MAX_BITS) throw new Error(`readBits: bits=${bits} exceeds ${MAX_BITS}`);
    if (this.bitsRemaining < bits) throw new Error('BitReader: buffer underflow');
    let result = 0;
    for (let i = 0; i < bits; i++) {
      const byteIndex = this.bitPos >>> 3;
      const bitIndex = 7 - (this.bitPos & 7);
      const bit = (this.buf[byteIndex] >>> bitIndex) & 1;
      result = result * 2 + bit;
      this.bitPos++;
    }
    return result;
  }

  /**
   * Sign-extend a `bits`-wide two's-complement field back to a normal JS number. Uses `2 **`
   * (not `1 <<`/`<<`) for the same overflow reason as `writeInt` above.
   */
  readInt(bits: number): number {
    const u = this.readBits(bits);
    const signBit = 2 ** (bits - 1);
    return u >= signBit ? u - 2 ** bits : u;
  }

  readBytesRaw(length: number): Uint8Array {
    const out = new Uint8Array(length);
    for (let i = 0; i < length; i++) out[i] = this.readBits(8);
    return out;
  }
}
