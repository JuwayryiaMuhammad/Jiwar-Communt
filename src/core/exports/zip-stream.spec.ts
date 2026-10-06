import { Readable } from 'node:stream';
import { unzipSync } from 'fflate';
import { ExportTooLargeError, ZipStream } from './zip-stream';

async function collect(z: ZipStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  z.output.on('data', (c: Buffer) => chunks.push(c));
  await new Promise((resolve) => z.output.on('end', resolve));
  return Buffer.concat(chunks);
}

describe('ZipStream', () => {
  it('writes JSON and streamed files into a valid zip', async () => {
    const z = new ZipStream(10 * 1024 * 1024);
    const done = collect(z);
    await z.addJson('account.json', { id: 'a', name: 'نور' });
    const big = Buffer.alloc(300_000, 7);
    await z.addStream(
      'files/photo.png',
      Readable.from([big.subarray(0, 100_000), big.subarray(100_000)]),
    );
    await z.end();
    const files = unzipSync(new Uint8Array(await done));
    expect(Object.keys(files).sort()).toEqual([
      'account.json',
      'files/photo.png',
    ]);
    expect(
      JSON.parse(Buffer.from(files['account.json']).toString('utf8')),
    ).toEqual({
      id: 'a',
      name: 'نور',
    });
    expect(Buffer.from(files['files/photo.png']).equals(big)).toBe(true);
  });

  it('waits for a slow reader instead of buffering the archive', async () => {
    const z = new ZipStream(50 * 1024 * 1024);
    // Nobody reads yet: the writer must stop at the stream's high-water mark.
    let finished = false;
    const writing = z
      .addStream('big.bin', Readable.from([Buffer.alloc(4 * 1024 * 1024, 1)]))
      .then(() => (finished = true));
    await new Promise((r) => setTimeout(r, 50));
    expect(finished).toBe(false);
    expect(z.output.readableLength).toBeLessThan(5 * 1024 * 1024);
    const done = collect(z);
    await writing;
    await z.end();
    expect((await done).length).toBeGreaterThan(4 * 1024 * 1024);
  });

  it('stops at its size limit', async () => {
    const z = new ZipStream(1024);
    void collect(z);
    await expect(
      z.addStream('big.bin', Readable.from([Buffer.alloc(10_000, 1)])),
    ).rejects.toBeInstanceOf(ExportTooLargeError);
  });
});
