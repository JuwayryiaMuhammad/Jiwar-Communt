/**
 * MP4 containers for the recordings' tests (ADR 0056), built box by box so
 * each fixture says what it is: a "fast start" file (`moov` before the
 * media), one with `moov` at the end, one cut short inside its `moov`, and
 * one whose media box claims a size it cannot have. The media bytes are
 * zeros; only the boxes matter. For the tests only (the unit spec beside
 * it and the media suite): `*.fixtures.ts` is kept out of the build.
 */

const u32 = (n: number) => {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n);
  return b;
};
const u64 = (n: bigint) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64BE(n);
  return b;
};

/** A box: its 32-bit size, its type, its body. */
export function box(type: string, ...body: Buffer[]): Buffer {
  const content = Buffer.concat(body);
  return Buffer.concat([
    u32(8 + content.length),
    Buffer.from(type, 'latin1'),
    content,
  ]);
}

export const ftyp = (brand = 'isom') =>
  box('ftyp', Buffer.from(brand, 'latin1'), u32(0), Buffer.from('isommp41'));

/** A movie header of `version`: `timescale` units a second, `duration` of them. */
export function mvhd(timescale: number, duration: number, version = 0) {
  const rest = Buffer.alloc(80); // rate, volume, matrix, next track id
  return version === 1
    ? box(
        'mvhd',
        Buffer.from([1, 0, 0, 0]),
        u64(0n),
        u64(0n),
        u32(timescale),
        u64(BigInt(duration)),
        rest,
      )
    : box(
        'mvhd',
        Buffer.from([0, 0, 0, 0]),
        u32(0),
        u32(0),
        u32(timescale),
        u32(duration),
        rest,
      );
}

/** A `moov` with something before its header, as recorders write it. */
export const moov = (header: Buffer) =>
  box(
    'moov',
    box('udta', Buffer.alloc(12)),
    header,
    box('trak', Buffer.alloc(32)),
  );

export const mdat = (bytes: number) => box('mdat', Buffer.alloc(bytes));

export interface Mp4Options {
  /** Its length, in seconds (a timescale of 1000). */
  seconds: number;
  /** The major brand: `qt  ` for QuickTime. */
  brand?: string;
  /** Bytes of media. */
  mediaBytes?: number;
  version?: 0 | 1;
}

/** `ftyp`, `moov`, `mdat`: written for streaming. */
export function fastStart(o: Mp4Options): Buffer {
  return Buffer.concat([
    ftyp(o.brand),
    moov(mvhd(1000, Math.round(o.seconds * 1000), o.version)),
    mdat(o.mediaBytes ?? 4096),
  ]);
}

/** `ftyp`, `mdat`, `moov`: as a phone writes it, the header last. */
export function moovAtEnd(o: Mp4Options): Buffer {
  return Buffer.concat([
    ftyp(o.brand),
    mdat(o.mediaBytes ?? 4096),
    moov(mvhd(1000, Math.round(o.seconds * 1000), o.version)),
  ]);
}

/** A moov-at-end file cut short in the middle of its `moov`. */
export function truncated(o: Mp4Options): Buffer {
  const whole = moovAtEnd(o);
  return whole.subarray(0, whole.length - 40);
}

/**
 * A moov-at-end file whose `mdat` claims to be larger than the file: the
 * walk must cross it to find the header.
 */
export function bogusBoxSize(o: Mp4Options): Buffer {
  const whole = moovAtEnd(o);
  const at = whole.indexOf(Buffer.from('mdat', 'latin1')) - 4;
  const copy = Buffer.from(whole);
  copy.writeUInt32BE(whole.length * 4, at);
  return copy;
}

/** A container with media and no movie header at all. */
export function noMovieHeader(o: { brand?: string } = {}): Buffer {
  return Buffer.concat([
    ftyp(o.brand),
    box('moov', box('trak', Buffer.alloc(32))),
    mdat(1024),
  ]);
}
