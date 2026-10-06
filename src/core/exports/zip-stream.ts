import { once } from 'node:events';
import { PassThrough, type Readable } from 'node:stream';
import { Zip, ZipDeflate, ZipPassThrough } from 'fflate';

/** The archive passed its size limit while it was being written. */
export class ExportTooLargeError extends Error {
  constructor() {
    super('The export is larger than its limit');
    this.name = 'ExportTooLargeError';
  }
}

/**
 * A zip written as a stream (ADR 0036): entries are added one after the
 * other and their bytes flow out of `output` as they are produced, with
 * backpressure, so neither an entry nor the archive is ever held whole.
 * JSON is deflated; files (already compressed images and PDFs) are stored.
 */
export class ZipStream {
  readonly output = new PassThrough();
  private readonly zip: Zip;
  private written = 0;

  constructor(private readonly maxBytes: number) {
    this.zip = new Zip((err, data, final) => {
      if (err) {
        this.output.destroy(err);
        return;
      }
      this.written += data.length;
      this.output.write(data);
      if (final) this.output.end();
    });
  }

  /** Bytes of archive produced so far. */
  get bytes(): number {
    return this.written;
  }

  async addJson(path: string, value: unknown): Promise<void> {
    const entry = new ZipDeflate(path, { level: 6 });
    this.zip.add(entry);
    entry.push(
      Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8'),
      true,
    );
    await this.flush();
  }

  async addStream(path: string, source: Readable): Promise<void> {
    const entry = new ZipPassThrough(path);
    this.zip.add(entry);
    for await (const chunk of source) {
      entry.push(chunk as Buffer);
      await this.flush();
    }
    entry.push(new Uint8Array(0), true);
    await this.flush();
  }

  async end(): Promise<void> {
    this.zip.end();
    await this.flush();
  }

  /** Waits while the reader is behind; stops at the size limit. */
  private async flush(): Promise<void> {
    if (this.written > this.maxBytes) throw new ExportTooLargeError();
    if (this.output.writableNeedDrain) await once(this.output, 'drain');
  }
}
