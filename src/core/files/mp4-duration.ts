/**
 * A recording's duration from its MP4 container (ADR 0056): the `mvhd`
 * box inside `moov`, read without the media itself. MP4, M4A and
 * QuickTime share the box layout (ISO/IEC 14496-12): a box is a 32-bit
 * size and a four-letter type, then its body; a size of 1 means a 64-bit
 * size follows, and 0 that the box runs to the end of the file.
 *
 * `moov` is at the start when the file was written for streaming ("fast
 * start"), and after the media (`mdat`) otherwise: the top-level boxes
 * are walked by their headers alone — a few bytes read at each box's
 * offset, the media skipped by its size — so a file whose `moov` is last
 * costs one more small read and then a read of its tail, never the media.
 *
 * The walk is bounded: so many top-level boxes, so many boxes inside
 * `moov`, a `moov` no larger than MP4_LIMITS.moovBytes, and every box
 * within its parent and the file. Anything else is refused with its reason;
 * a file with no movie header is refused as such.
 */

export const MP4_LIMITS = {
  /** Top-level boxes walked before giving up. */
  topBoxes: 64,
  /** Boxes inside `moov` walked before giving up. */
  moovBoxes: 256,
  /** The largest `moov` read: its sample tables grow with the length. */
  moovBytes: 8 * 1024 * 1024,
} as const;

/** Why a container was refused. */
export type Mp4Problem =
  /** A box's size is impossible: under its header, or past its parent or the file. */
  | 'box_out_of_bounds'
  /** More boxes than MP4_LIMITS allow. */
  | 'too_many_boxes'
  /** A `moov` larger than MP4_LIMITS.moovBytes. */
  | 'box_too_large'
  /** No `moov`, or no `mvhd` in it. */
  | 'no_movie_header'
  /** A movie header with no timescale, or a duration it cannot hold. */
  | 'bad_movie_header';

export class Mp4Refused extends Error {
  constructor(readonly problem: Mp4Problem) {
    super(`mp4: ${problem}`);
    this.name = 'Mp4Refused';
  }
}

/** Reads `length` bytes at `offset` (fewer only at the end of the file). */
export type RangeReader = (offset: number, length: number) => Promise<Buffer>;

/** The largest header: size, type and a 64-bit size. */
const HEADER_MAX = 16;

interface Box {
  type: string;
  /** Where its body starts, and where the box ends. */
  body: number;
  end: number;
}

/**
 * The box at `at` of a region ending at `limit`, from the first bytes of
 * it in `head` (at least 8, 16 for a 64-bit size). `toEof` lets a size of
 * 0 run to `limit`: top level only.
 */
function boxAt(head: Buffer, at: number, limit: number, toEof: boolean): Box {
  if (head.length < 8) throw new Mp4Refused('box_out_of_bounds');
  const size32 = head.readUInt32BE(0);
  const type = head.toString('latin1', 4, 8);
  let headerSize = 8;
  let size: number;
  if (size32 === 1) {
    if (head.length < 16) throw new Mp4Refused('box_out_of_bounds');
    const big = head.readBigUInt64BE(8);
    if (big > BigInt(Number.MAX_SAFE_INTEGER))
      throw new Mp4Refused('box_out_of_bounds');
    size = Number(big);
    headerSize = 16;
  } else if (size32 === 0) {
    if (!toEof) throw new Mp4Refused('box_out_of_bounds');
    size = limit - at;
  } else size = size32;
  if (size < headerSize || at + size > limit)
    throw new Mp4Refused('box_out_of_bounds');
  return { type, body: at + headerSize, end: at + size };
}

/** The duration in whole milliseconds, rounded down; throws Mp4Refused. */
export async function mp4DurationMs(
  fileSize: number,
  read: RangeReader,
): Promise<number> {
  let at = 0;
  for (let n = 0; at < fileSize; n++) {
    if (n >= MP4_LIMITS.topBoxes) throw new Mp4Refused('too_many_boxes');
    const box = boxAt(
      await read(at, Math.min(HEADER_MAX, fileSize - at)),
      at,
      fileSize,
      true,
    );
    if (box.type === 'moov') {
      if (box.end - at > MP4_LIMITS.moovBytes)
        throw new Mp4Refused('box_too_large');
      const moov = await read(box.body, box.end - box.body);
      if (moov.length !== box.end - box.body)
        throw new Mp4Refused('box_out_of_bounds');
      return fromMoov(moov);
    }
    at = box.end;
  }
  throw new Mp4Refused('no_movie_header');
}

/** The `mvhd` among `moov`'s children. */
function fromMoov(moov: Buffer): number {
  let at = 0;
  for (let n = 0; at < moov.length; n++) {
    if (n >= MP4_LIMITS.moovBoxes) throw new Mp4Refused('too_many_boxes');
    const box = boxAt(
      moov.subarray(at, at + HEADER_MAX),
      at,
      moov.length,
      false,
    );
    if (box.type === 'mvhd') return fromMvhd(moov.subarray(box.body, box.end));
    at = box.end;
  }
  throw new Mp4Refused('no_movie_header');
}

/**
 * Version 0: creation, modification (32 bits each), timescale, duration
 * (32 bits). Version 1: creation, modification (64 bits each), timescale
 * (32), duration (64). An unknown duration (all ones) is refused.
 */
function fromMvhd(b: Buffer): number {
  if (b.length < 4) throw new Mp4Refused('bad_movie_header');
  const version = b[0];
  let timescale: number;
  let duration: bigint;
  if (version === 0) {
    if (b.length < 20) throw new Mp4Refused('bad_movie_header');
    timescale = b.readUInt32BE(12);
    const d = b.readUInt32BE(16);
    if (d === 0xffffffff) throw new Mp4Refused('bad_movie_header');
    duration = BigInt(d);
  } else if (version === 1) {
    if (b.length < 32) throw new Mp4Refused('bad_movie_header');
    timescale = b.readUInt32BE(20);
    duration = b.readBigUInt64BE(24);
    if (duration === 0xffffffffffffffffn)
      throw new Mp4Refused('bad_movie_header');
  } else throw new Mp4Refused('bad_movie_header');
  if (timescale === 0) throw new Mp4Refused('bad_movie_header');
  const ms = (duration * 1000n) / BigInt(timescale);
  // Nothing recorded, or longer than the column holds (24 days).
  if (ms === 0n || ms > 2_147_483_647n)
    throw new Mp4Refused('bad_movie_header');
  return Number(ms);
}
