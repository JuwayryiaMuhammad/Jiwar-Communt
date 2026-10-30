import { DriverError } from '../vendors/vendor-call';

/** An image the vendor reads: never stored by us beyond its file. */
export interface FaceImage {
  bytes: Buffer;
  contentType: string;
}

/**
 * The face vendor (ADR 0068): it keeps a gallery of templates for one
 * compound and searches a probe against it. Our code holds every rule —
 * who is enrolled, when, and what a candidate means; the driver only
 * talks to the vendor. Each call takes an abort signal (the caller's
 * timeout) and fails with DriverError.
 */
export interface FaceDriver {
  /**
   * Enrols a face; idempotent by `enrollmentId` (a retry after a lost
   * answer returns the same template). Answers the vendor's opaque
   * reference to it.
   */
  enroll(
    input: { tenantId: string; enrollmentId: string; image: FaceImage },
    signal: AbortSignal,
  ): Promise<{ templateRef: string }>;
  /**
   * Removes what an enrolment left, by its id (the vendor's external id),
   * whether or not its answer ever reached us: an enrolment that timed out
   * may have landed. Removing what the vendor does not hold is done.
   */
  remove(
    input: { tenantId: string; enrollmentId: string },
    signal: AbortSignal,
  ): Promise<void>;
  /**
   * The compound's templates the probe may be, above the vendor's own
   * threshold — never a score.
   */
  search(
    input: { tenantId: string; image: FaceImage },
    signal: AbortSignal,
  ): Promise<{ templateRefs: string[] }>;
}

export const FACE_DRIVER = Symbol('FACE_DRIVER');

/** `off`: every call is unavailable (503 reason off for a request). */
export class OffFaceDriver implements FaceDriver {
  enroll(): Promise<{ templateRef: string }> {
    return Promise.reject(new DriverError('off'));
  }
  remove(): Promise<void> {
    return Promise.reject(new DriverError('off'));
  }
  search(): Promise<{ templateRefs: string[] }> {
    return Promise.reject(new DriverError('off'));
  }
}
