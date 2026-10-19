import {
  bogusBoxSize,
  box,
  fastStart,
  ftyp,
  mdat,
  moovAtEnd,
  mvhd,
  noMovieHeader,
  truncated,
} from './mp4-duration.fixtures';
import { MP4_LIMITS, mp4DurationMs, Mp4Refused } from './mp4-duration';

/** Reads from a buffer as the store would, recording each range asked. */
function reader(file: Buffer) {
  const reads: [number, number][] = [];
  return {
    reads,
    read: (offset: number, length: number) => {
      reads.push([offset, length]);
      return Promise.resolve(file.subarray(offset, offset + length));
    },
  };
}
const duration = (file: Buffer) =>
  mp4DurationMs(file.length, reader(file).read);
const refused = async (file: Buffer) => {
  try {
    await duration(file);
  } catch (e) {
    if (e instanceof Mp4Refused) return e.problem;
    throw e;
  }
  return 'read';
};

describe('mp4DurationMs (ADR 0056)', () => {
  it('fast start: the movie header before the media', async () => {
    expect(await duration(fastStart({ seconds: 42.5 }))).toBe(42_500);
  });

  it('moov at the end: the media skipped by its size, its tail read', async () => {
    const file = moovAtEnd({ seconds: 7, mediaBytes: 1_000_000 });
    const r = reader(file);
    expect(await mp4DurationMs(file.length, r.read)).toBe(7000);
    // Three headers, then the moov's body: never the media.
    expect(r.reads).toHaveLength(4);
    const read = r.reads.reduce((n, [, length]) => n + length, 0);
    expect(read).toBeLessThan(1000);
    const [lastOffset] = r.reads[r.reads.length - 1];
    expect(lastOffset).toBeGreaterThan(1_000_000);
  });

  it('version 1 headers, a QuickTime brand, a 64-bit box size', async () => {
    expect(await duration(fastStart({ seconds: 3, version: 1 }))).toBe(3000);
    expect(await duration(moovAtEnd({ seconds: 3, brand: 'qt  ' }))).toBe(3000);
    // An mdat with its size in 64 bits.
    const media = Buffer.alloc(100);
    const big = Buffer.concat([
      Buffer.from([0, 0, 0, 1]),
      Buffer.from('mdat'),
      (() => {
        const b = Buffer.alloc(8);
        b.writeBigUInt64BE(BigInt(16 + media.length));
        return b;
      })(),
      media,
    ]);
    const file = Buffer.concat([ftyp(), big, box('moov', mvhd(600, 1200))]);
    expect(await duration(file)).toBe(2000);
  });

  it('a media box running to the end: no movie header after it', async () => {
    const toEof = Buffer.concat([
      Buffer.from([0, 0, 0, 0]),
      Buffer.from('mdat'),
      Buffer.alloc(64),
    ]);
    expect(await refused(Buffer.concat([ftyp(), toEof]))).toBe(
      'no_movie_header',
    );
  });

  it('truncated inside its moov: refused, its box past the file', async () => {
    expect(await refused(truncated({ seconds: 5 }))).toBe('box_out_of_bounds');
  });

  it('a bogus box size: refused, nothing read past the file', async () => {
    const file = bogusBoxSize({ seconds: 5 });
    const r = reader(file);
    await expect(mp4DurationMs(file.length, r.read)).rejects.toThrow(
      Mp4Refused,
    );
    expect(await refused(file)).toBe('box_out_of_bounds');
    for (const [offset, length] of r.reads)
      expect(offset + length).toBeLessThanOrEqual(file.length);
    // A size under its own header.
    const tiny = Buffer.concat([
      ftyp(),
      Buffer.from([0, 0, 0, 4]),
      Buffer.from('free'),
    ]);
    expect(await refused(tiny)).toBe('box_out_of_bounds');
  });

  it('no movie header: refused as such', async () => {
    expect(await refused(noMovieHeader())).toBe('no_movie_header');
    expect(await refused(Buffer.concat([ftyp(), mdat(64)]))).toBe(
      'no_movie_header',
    );
  });

  it('a header without a timescale or a length, or with an unknown one: refused', async () => {
    const file = (header: Buffer) =>
      Buffer.concat([ftyp(), box('moov', header), mdat(16)]);
    expect(await refused(file(mvhd(0, 1000)))).toBe('bad_movie_header');
    expect(await refused(file(mvhd(1000, 0)))).toBe('bad_movie_header');
    expect(await refused(file(mvhd(1000, 0xffffffff)))).toBe(
      'bad_movie_header',
    );
    expect(await refused(file(box('mvhd', Buffer.from([0, 0, 0, 0]))))).toBe(
      'bad_movie_header',
    );
  });

  it('the walk is bounded: so many boxes, so large a moov', async () => {
    const many = Buffer.concat([
      ftyp(),
      ...Array.from({ length: MP4_LIMITS.topBoxes }, () => box('free')),
      box('moov', mvhd(1000, 1000)),
    ]);
    expect(await refused(many)).toBe('too_many_boxes');
    const crowded = box(
      'moov',
      ...Array.from({ length: MP4_LIMITS.moovBoxes }, () => box('free')),
      mvhd(1000, 1000),
    );
    expect(await refused(Buffer.concat([ftyp(), crowded]))).toBe(
      'too_many_boxes',
    );
    // A moov larger than the limit is refused before it is read.
    const huge = Buffer.concat([
      Buffer.from([0, 0x80, 0, 8]),
      Buffer.from('moov'),
    ]);
    const file = Buffer.concat([ftyp(), huge, Buffer.alloc(0x800000)]);
    const r = reader(file);
    await expect(mp4DurationMs(file.length, r.read)).rejects.toThrow(
      'box_too_large',
    );
    expect(r.reads.every(([, length]) => length <= 16)).toBe(true);
  });
});
