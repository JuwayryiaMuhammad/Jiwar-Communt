import { createHash } from 'node:crypto';
import { DriverError, type DriverErrorKind } from '../vendors/vendor-call';
import type { FaceDriver, FaceImage } from './face-driver';

type Call =
  | { op: 'enroll'; tenantId: string; enrollmentId: string }
  | { op: 'remove'; tenantId: string; enrollmentId: string }
  | { op: 'search'; tenantId: string };

/**
 * The fake face vendor (ADR 0068), for development and tests; refused in
 * production. Deterministic: a template's reference is derived from the
 * enrolment's id, and a probe matches the templates whose image has the
 * same bytes — so a test enrols a photo and probes with the same photo.
 * `failNext(kind)` fails the next call, `hold()` keeps the next call
 * waiting until `release()`, and `calls` records what was asked (never an
 * image).
 */
export class FakeFaceDriver implements FaceDriver {
  /** templateRef → [tenant, the image's hash]. */
  private readonly gallery = new Map<string, [string, string]>();
  private failures: DriverErrorKind[] = [];
  private held: Promise<void> | null = null;
  private releaser: (() => void) | null = null;
  readonly calls: Call[] = [];

  async enroll(
    input: { tenantId: string; enrollmentId: string; image: FaceImage },
    signal: AbortSignal,
  ): Promise<{ templateRef: string }> {
    this.calls.push({
      op: 'enroll',
      tenantId: input.tenantId,
      enrollmentId: input.enrollmentId,
    });
    await this.gate(signal);
    const templateRef = `fake-tpl-${input.enrollmentId}`;
    this.gallery.set(templateRef, [input.tenantId, hash(input.image)]);
    return { templateRef };
  }

  async remove(
    input: { tenantId: string; enrollmentId: string },
    signal: AbortSignal,
  ): Promise<void> {
    this.calls.push({ op: 'remove', ...input });
    await this.gate(signal);
    this.gallery.delete(`fake-tpl-${input.enrollmentId}`);
  }

  async search(
    input: { tenantId: string; image: FaceImage },
    signal: AbortSignal,
  ): Promise<{ templateRefs: string[] }> {
    this.calls.push({ op: 'search', tenantId: input.tenantId });
    await this.gate(signal);
    const probe = hash(input.image);
    return {
      templateRefs: [...this.gallery]
        .filter(([, [t, h]]) => t === input.tenantId && h === probe)
        .map(([ref]) => ref),
    };
  }

  /** The templates the vendor holds for a compound (tests: none after erasure). */
  templates(tenantId: string): string[] {
    return [...this.gallery]
      .filter(([, [t]]) => t === tenantId)
      .map(([ref]) => ref);
  }

  failNext(kind: DriverErrorKind = 'unavailable'): void {
    this.failures.push(kind);
  }

  /** The next call waits until `release()` (a race's middle). */
  hold(): void {
    this.held = new Promise<void>((r) => (this.releaser = r));
  }

  release(): void {
    this.releaser?.();
    this.releaser = null;
  }

  reset(): void {
    this.gallery.clear();
    this.failures = [];
    this.release();
    this.held = null;
    this.calls.length = 0;
  }

  private async gate(signal: AbortSignal): Promise<void> {
    const kind = this.failures.shift();
    if (kind) throw new DriverError(kind);
    const held = this.held;
    if (held) {
      this.held = null;
      await held;
    }
    if (signal.aborted) throw new DriverError('timeout');
  }
}

const hash = (image: FaceImage) =>
  createHash('sha256').update(image.bytes).digest('hex');
