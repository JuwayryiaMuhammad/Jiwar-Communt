import { DriverError, type DriverErrorKind } from '../vendors/vendor-call';
import type { IdReading, IdScanDriver } from './id-scan-driver';

/** What the fake reads when nothing was scripted: a sample card. */
export const SAMPLE_READING: IdReading = {
  documentType: 'national_id',
  number: '29001011234567',
  names: { en: 'Sample Holder', ar: 'حامل تجريبي' },
  birthDate: '1990-01-01',
  expiresOn: '2099-01-01',
};

/**
 * The fake ID-scan vendor (ADR 0068), for development and tests; refused
 * in production. It reads the sample card unless `script(reading)` set the
 * next answer; `failNext(kind)` fails the next read; `hold()` keeps the
 * next read waiting until `release()`. `calls` counts reads, never what
 * they carried.
 */
export class FakeIdScanDriver implements IdScanDriver {
  private scripted: IdReading[] = [];
  private failures: DriverErrorKind[] = [];
  private held: Promise<void> | null = null;
  private releaser: (() => void) | null = null;
  calls = 0;

  async read(
    _input: { tenantId: string; image: { bytes: Buffer; contentType: string } },
    signal: AbortSignal,
  ): Promise<IdReading> {
    this.calls++;
    const kind = this.failures.shift();
    if (kind) throw new DriverError(kind);
    const held = this.held;
    if (held) {
      this.held = null;
      await held;
    }
    if (signal.aborted) throw new DriverError('timeout');
    return this.scripted.shift() ?? SAMPLE_READING;
  }

  script(reading: IdReading): void {
    this.scripted.push(reading);
  }

  failNext(kind: DriverErrorKind = 'unavailable'): void {
    this.failures.push(kind);
  }

  /** The next read waits until `release()` (a race's middle). */
  hold(): void {
    this.held = new Promise<void>((r) => (this.releaser = r));
  }

  release(): void {
    this.releaser?.();
    this.releaser = null;
  }
}
