import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { GateFaceEnrollment } from '@prisma/client';
import { AuditService } from '../../core/audit/audit.service';
import { newId } from '../../core/common/uuid';
import type { Env } from '../../core/config/env.schema';
import type { TenantTxClient } from '../../core/database/tenant-tx.service';
import { FilesService } from '../../core/files/files.service';
import { SweepRunner } from '../../core/sweep/sweep-runner';
import { BlocklistService } from '../blocklist/blocklist.service';
import { dbNow } from '../db-clock';
import { GateSettingsService } from '../settings/gate-settings.service';
import {
  boundedCall,
  failureKind,
  vendorTimeout,
} from '../vendors/vendor-call';
import { FACE_DRIVER, type FaceDriver } from './face-driver';

export const FACE_ENROLLMENT_SWEEP = 'gate.face_enrollment';
const SWEEP_EVERY_MS = 60_000;
const BATCH = 20;
/** Backoff after a failure: a minute, doubling, at most an hour. */
const backoffMs = (attempts: number) =>
  Math.min(60_000 * 2 ** Math.max(0, attempts - 1), 3_600_000);

type Claimed =
  | {
      id: string;
      op: 'enroll';
      file: {
        id: string;
        tenantId: string;
        sizeBytes: number;
        contentType: string;
      };
    }
  | { id: string; op: 'remove' };

/**
 * The blocklist's faces at the face vendor (ADR 0068), as an outbox.
 *
 * What should be enrolled follows the blocklist and the compound's switch,
 * in their transactions (`sync`): a live person entry with a photo, while
 * face checks are on, has one live enrolment (pending, then enrolled); a
 * lifted, expired or purged entry, a cleared or replaced photo, or the
 * switch turned off moves it to `removing`. The entry's write holds the
 * blocklist lock and reads the settings FOR SHARE, so a switch waits for
 * it, or came first and is seen.
 *
 * The sweep makes the vendor calls, outside any transaction, on a lease
 * (`leased_until`): an enrolment is claimed, called and recorded with no
 * other call in flight for it. A lift while it enrols turns it `removing`,
 * and the removal runs next, by the enrolment's id — so even an enrolment
 * whose answer was lost to a timeout is removed: the vendor never keeps a
 * face we stopped wanting. A failure waits, doubling, up to an hour.
 */
@Injectable()
export class FaceEnrollments implements OnModuleInit {
  private readonly logger = new Logger(FaceEnrollments.name);
  private readonly timeoutMs: number;

  constructor(
    private readonly audit: AuditService,
    private readonly files: FilesService,
    private readonly sweep: SweepRunner,
    private readonly settings: GateSettingsService,
    private readonly blocklist: BlocklistService,
    @Inject(FACE_DRIVER) private readonly driver: FaceDriver,
    config: ConfigService<Env, true>,
  ) {
    this.timeoutMs = vendorTimeout(config);
  }

  onModuleInit(): void {
    this.blocklist.onEntryChanged((tx, entryId, photoChanged) =>
      this.sync(tx, entryId, photoChanged),
    );
    this.settings.onChanged(async (tx, before, after) => {
      if (before.faceChecks !== after.faceChecks)
        await this.syncAll(tx, after.faceChecks);
    });
    this.sweep.register(FACE_ENROLLMENT_SWEEP, () => this.run(), {
      intervalMs: SWEEP_EVERY_MS,
    });
  }

  /**
   * One entry, after a write to it in the caller's transaction (which holds
   * the blocklist lock): enrolled when it should be, removed when not. A
   * replaced photo removes the old template and enrols the new.
   */
  async sync(
    tx: TenantTxClient,
    entryId: string,
    photoChanged: boolean,
  ): Promise<void> {
    const { faceChecks } = await this.settings.read(tx, 'share');
    const entry = await tx.blocklistEntry.findUniqueOrThrow({
      where: { id: entryId },
    });
    const want =
      faceChecks &&
      entry.subject === 'person' &&
      entry.liftedAt === null &&
      entry.photoFileId !== null;
    const live = await tx.gateFaceEnrollment.findFirst({
      where: { entryId, status: { in: ['pending', 'enrolled'] } },
    });
    if (live && (!want || photoChanged)) await this.toRemoving(tx, live);
    if (want && (!live || photoChanged))
      await tx.gateFaceEnrollment.create({
        data: { id: newId(), tenantId: entry.tenantId, entryId },
      });
  }

  /** The switch, in its transaction: every face enrolled, or every one removed. */
  async syncAll(tx: TenantTxClient, on: boolean): Promise<void> {
    if (!on) {
      for (const live of await tx.gateFaceEnrollment.findMany({
        where: { status: { in: ['pending', 'enrolled'] } },
      }))
        await this.toRemoving(tx, live);
      return;
    }
    const now = await dbNow(tx);
    const entries = await tx.blocklistEntry.findMany({
      where: {
        subject: 'person',
        liftedAt: null,
        photoFileId: { not: null },
        OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
      },
      select: { id: true, tenantId: true },
    });
    const enrolled = new Set(
      (
        await tx.gateFaceEnrollment.findMany({
          where: {
            entryId: { in: entries.map((e) => e.id) },
            status: { in: ['pending', 'enrolled'] },
          },
          select: { entryId: true },
        })
      ).map((e) => e.entryId),
    );
    const missing = entries.filter((e) => !enrolled.has(e.id));
    if (missing.length)
      await tx.gateFaceEnrollment.createMany({
        data: missing.map((e) => ({
          id: newId(),
          tenantId: e.tenantId,
          entryId: e.id,
        })),
      });
  }

  /** The sweep: claim, call the vendor outside any transaction, record. */
  run(): Promise<number> {
    return this.sweep.forEachTenantCall<Claimed, string | null>(
      (tx) => this.claim(tx),
      (tenantId, one) => this.call(tenantId, one),
      async (tx, _tenantId, one, result) => {
        if (!result.ok && failureKind(result.error) === 'unavailable')
          this.logger.warn(
            `face vendor failed (${result.error instanceof Error ? result.error.name : 'Error'})`,
          );
        return this.record(tx, one, result);
      },
    );
  }

  private async claim(tx: TenantTxClient): Promise<Claimed[]> {
    const now = await dbNow(tx);
    const rows = await tx.$queryRaw<GateFaceEnrollmentRow[]>`
      SELECT id, entry_id AS "entryId", status
        FROM gate_face_enrollments
       WHERE status IN ('pending', 'removing') AND next_attempt_at <= ${now}
         AND (leased_until IS NULL OR leased_until < ${now})
       ORDER BY next_attempt_at, id LIMIT ${BATCH}
       FOR UPDATE SKIP LOCKED`;
    const leasedUntil = new Date(now.getTime() + 2 * this.timeoutMs + 5_000);
    const out: Claimed[] = [];
    for (const row of rows) {
      if (row.status === 'removing') {
        out.push({ id: row.id, op: 'remove' });
      } else {
        const entry = await tx.blocklistEntry.findUniqueOrThrow({
          where: { id: row.entryId },
          select: { photoFileId: true },
        });
        const file = entry.photoFileId
          ? await tx.storedFile.findFirst({
              where: { id: entry.photoFileId, deletedAt: null },
              select: {
                id: true,
                tenantId: true,
                sizeBytes: true,
                contentType: true,
              },
            })
          : null;
        if (!file) {
          // Its photo went with no sync yet: nothing to enrol.
          await this.toRemoving(tx, row, now);
          continue;
        }
        out.push({ id: row.id, op: 'enroll', file });
      }
      await tx.gateFaceEnrollment.update({
        where: { id: row.id },
        data: { leasedUntil },
      });
    }
    return out;
  }

  /** The vendor call: a template's reference for an enrolment, null for a removal. */
  private async call(tenantId: string, one: Claimed): Promise<string | null> {
    if (one.op === 'remove') {
      await boundedCall(this.timeoutMs, (signal) =>
        this.driver.remove({ tenantId, enrollmentId: one.id }, signal),
      );
      return null;
    }
    const bytes = await this.files.contents(one.file);
    if (!bytes) throw new Error('the photo’s object is gone');
    const { templateRef } = await boundedCall(this.timeoutMs, (signal) =>
      this.driver.enroll(
        {
          tenantId,
          enrollmentId: one.id,
          image: { bytes, contentType: one.file.contentType },
        },
        signal,
      ),
    );
    return templateRef;
  }

  private async record(
    tx: TenantTxClient,
    one: Claimed,
    result: { ok: true; value: string | null } | { ok: false; error: unknown },
  ): Promise<number> {
    await tx.$queryRaw`
      SELECT id FROM gate_face_enrollments WHERE id = ${one.id}::uuid FOR UPDATE`;
    const row = await tx.gateFaceEnrollment.findUniqueOrThrow({
      where: { id: one.id },
    });
    const now = await dbNow(tx);
    if (!result.ok) {
      const attempts = row.attempts + 1;
      await tx.gateFaceEnrollment.update({
        where: { id: row.id },
        data: {
          leasedUntil: null,
          attempts,
          lastError: failureKind(result.error),
          nextAttemptAt: new Date(now.getTime() + backoffMs(attempts)),
        },
      });
      return 0;
    }
    if (one.op === 'remove') {
      await this.removed(tx, row.id, now);
      return 1;
    }
    const templateRef = result.value!;
    if (row.status === 'pending') {
      await tx.gateFaceEnrollment.update({
        where: { id: row.id },
        data: {
          status: 'enrolled',
          templateRef,
          enrolledAt: now,
          leasedUntil: null,
          attempts: 0,
          lastError: null,
        },
      });
      await this.audit.record(tx, {
        action: 'face_enrollment.enrolled',
        targetId: row.id,
        metadata: { entryId: row.entryId },
      });
    } else {
      // Lifted, cleared or switched off while it enrolled: the removal,
      // due now, takes the template the vendor just made.
      await tx.gateFaceEnrollment.update({
        where: { id: row.id },
        data: { templateRef, leasedUntil: null, nextAttemptAt: now },
      });
    }
    return 1;
  }

  private async toRemoving(
    tx: TenantTxClient,
    row: Pick<GateFaceEnrollment, 'id'>,
    at?: Date,
  ): Promise<void> {
    const now = at ?? (await dbNow(tx));
    await tx.gateFaceEnrollment.update({
      where: { id: row.id },
      data: {
        status: 'removing',
        removingAt: now,
        nextAttemptAt: now,
        attempts: 0,
        lastError: null,
      },
    });
  }

  private async removed(
    tx: TenantTxClient,
    id: string,
    now: Date,
  ): Promise<void> {
    const row = await tx.gateFaceEnrollment.update({
      where: { id },
      data: {
        status: 'removed',
        templateRef: null,
        removedAt: now,
        leasedUntil: null,
      },
    });
    await this.audit.record(tx, {
      action: 'face_enrollment.removed',
      targetId: id,
      metadata: { entryId: row.entryId, enrolled: row.enrolledAt !== null },
    });
  }
}

interface GateFaceEnrollmentRow {
  id: string;
  entryId: string;
  status: string;
}
