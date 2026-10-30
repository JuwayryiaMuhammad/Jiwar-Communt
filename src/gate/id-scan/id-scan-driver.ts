import { DriverError } from '../vendors/vendor-call';

/** What the vendor read off a document. Never stored by us. */
export interface IdReading {
  documentType: 'national_id' | 'passport' | 'driving_licence' | 'other';
  /** The document's number as printed; null when it could not be read. */
  number: string | null;
  /** The holder's name, as printed, in each script the document has. */
  names: { en: string | null; ar: string | null };
  /** `YYYY-MM-DD`, as printed. */
  birthDate: string | null;
  expiresOn: string | null;
}

/**
 * The ID-scan vendor (ADR 0068): it reads a document's image and answers
 * what it says. Our code holds every rule — the number's shape, the
 * national ID's own check, expiry, the blocklist. The driver only talks to
 * the vendor and fails with DriverError.
 */
export interface IdScanDriver {
  read(
    input: { tenantId: string; image: { bytes: Buffer; contentType: string } },
    signal: AbortSignal,
  ): Promise<IdReading>;
}

export const ID_SCAN_DRIVER = Symbol('ID_SCAN_DRIVER');

/** `off`: every read is unavailable (503 reason off). */
export class OffIdScanDriver implements IdScanDriver {
  read(): Promise<IdReading> {
    return Promise.reject(new DriverError('off'));
  }
}
