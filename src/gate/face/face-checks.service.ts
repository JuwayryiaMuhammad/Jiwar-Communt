import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { BlocklistEntry, GateFaceCheck } from '@prisma/client';
import { AuditService } from '../../core/audit/audit.service';
import { RequestContext } from '../../core/common/cls/request-context';
import { appError, ErrorCode, FieldErrorCode } from '../../core/common/errors';
import { newId } from '../../core/common/uuid';
import type { Env } from '../../core/config/env.schema';
import {
  TenantTx,
  type TenantTxClient,
} from '../../core/database/tenant-tx.service';
import { FilesService } from '../../core/files/files.service';
import { IdempotencyService } from '../../core/idempotency/idempotency.service';
import { RateLimitService } from '../../core/redis/rate-limit.service';
import { SweepRunner } from '../../core/sweep/sweep-runner';
import { BlocklistCore } from '../blocklist/blocklist-core';
import { BlocklistMatcher } from '../blocklist/blocklist-matcher';
import {
  BlocklistService,
  type BlocklistRecord,
} from '../blocklist/blocklist.service';
import { dbNow } from '../db-clock';
import { SafetyCore } from '../safety/safety-core';
import { GateSettingsService } from '../settings/gate-settings.service';
import { noOpenShift, ShiftsService } from '../shifts/shifts.service';
import {
  boundedCall,
  driverChoice,
  DriverError,
  vendorTimeout,
  vendorUnavailable,
} from '../vendors/vendor-call';
import { FACE_DRIVER, type FaceDriver } from './face-driver';

export const FACE_CHECK_RESOURCE = 'face_check';
export const FACE_PROBE_SWEEP = 'gate.face_probe_purge';
/** A probe that met nobody goes after a day; one that met someone after 30. */
const PROBE_DAYS = 1;
const MATCHED_PROBE_DAYS = 30;
const SWEEP_BATCH = 200;
const DAY_MS = 86_400_000;

export type FaceCheckOutcome =
  'pending' | 'no_match' | 'possible_match' | 'unavailable';

export interface FaceCheckRead {
  check: GateFaceCheck;
  outcome: FaceCheckOutcome;
  matches: BlocklistRecord[];
}

const notFound = () =>
  appError.notFound(ErrorCode.FACE_CHECK_NOT_FOUND, 'Face check not found');
const off = () =>
  appError.conflict(
    ErrorCode.FACE_CHECKS_OFF,
    'Face checks are off in this compound',
  );

/**
 * A face check at the gate (ADR 0068): advisory only. A guard on an open
 * shift at a gate, on their own rate limit, photographs someone; the face
 * vendor searches the compound's enrolled faces (the blocklist's live
 * entries with a photo) and names the templates it may be. A possible
 * match is recorded as met (`face`, noted) and the keepers are told, as an
 * ID lookup is; the guard sees the entries as an ID lookup shows them —
 * never the vendor's score. Nobody is refused by a face alone.
 *
 * Two transactions around the vendor, never one: the first takes the
 * account, then the shift (ADR 0056), claims the photo and writes the
 * check pending; the vendor is called; the second takes them again and
 * answers it. A shift that ended in between leaves it unanswered and
 * nothing met. A vendor that fails answers `unavailable`: the guard goes
 * on by hand. The probe goes after a day, or 30 after a possible match.
 */
@Injectable()
export class FaceChecksService implements OnModuleInit {
  private readonly perMinute: number;
  private readonly timeoutMs: number;
  private readonly isOff: boolean;

  constructor(
    private readonly tenantTx: TenantTx,
    private readonly ctx: RequestContext,
    private readonly audit: AuditService,
    private readonly idempotency: IdempotencyService,
    private readonly files: FilesService,
    private readonly rateLimit: RateLimitService,
    private readonly sweep: SweepRunner,
    private readonly shifts: ShiftsService,
    private readonly safety: SafetyCore,
    private readonly settings: GateSettingsService,
    private readonly core: BlocklistCore,
    private readonly matcher: BlocklistMatcher,
    private readonly blocklist: BlocklistService,
    @Inject(FACE_DRIVER) private readonly driver: FaceDriver,
    config: ConfigService<Env, true>,
  ) {
    this.perMinute = config.get('GATE_VERIFY_RATE_LIMIT_PER_MINUTE', {
      infer: true,
    });
    this.timeoutMs = vendorTimeout(config);
    this.isOff = driverChoice(config, 'face') === 'off';
  }

  onModuleInit(): void {
    this.idempotency.renderer(FACE_CHECK_RESOURCE, (id) =>
      this.tenantTx.withTenantTx(async (tx) =>
        this.read(
          tx,
          await tx.gateFaceCheck.findUniqueOrThrow({ where: { id } }),
        ),
      ),
    );
    this.sweep.register(FACE_PROBE_SWEEP, (now) => this.purgeProbes(now));
  }

  async check(photoFileId: string): Promise<FaceCheckRead> {
    if (this.isOff) throw vendorUnavailable('face', true);
    // The shift first: a guard off duty learns nothing about anyone.
    await this.tenantTx.withTenantTx(async (tx) => {
      await this.shifts.requireOpen(tx);
      if (!(await this.settings.read(tx)).faceChecks) throw off();
    });
    await this.rateLimit.consume(
      `gate-face:account:${this.ctx.accountId}`,
      this.perMinute,
      60,
    );
    const pending = await this.tenantTx.withTenantTx(async (tx) => {
      await this.safety.lockSelf(tx);
      const shift = await this.shifts.requireOpenLocked(tx);
      if (!(await this.settings.read(tx, 'share')).faceChecks) throw off();
      const id = newId();
      await this.idempotency.claim(tx, { type: FACE_CHECK_RESOURCE, id });
      const file = await this.files.claim(tx, photoFileId, 'gate_face_probe');
      if (!file)
        throw appError.badRequest(
          ErrorCode.VALIDATION_FAILED,
          'Not a face probe of yours',
          {
            fields: [
              { field: 'photoFileId', code: FieldErrorCode.FILE_NOT_AVAILABLE },
            ],
          },
        );
      await this.files.attach(tx, file);
      await tx.gateFaceCheck.create({
        data: {
          id,
          tenantId: this.ctx.txTenantId,
          shiftId: shift.id,
          gateId: shift.gateId,
          guardAccountId: this.ctx.accountId,
          probeFileId: file.id,
        },
      });
      return { id, shiftId: shift.id, file };
    });

    // The vendor, outside any transaction.
    let templateRefs: string[] | null = null;
    try {
      const bytes = await this.files.contents(pending.file);
      if (bytes)
        ({ templateRefs } = await boundedCall(this.timeoutMs, (signal) =>
          this.driver.search(
            {
              tenantId: this.ctx.tenantId,
              image: { bytes, contentType: pending.file.contentType },
            },
            signal,
          ),
        ));
    } catch (e) {
      if (!(e instanceof DriverError)) throw e;
    }

    return this.tenantTx.withTenantTx(async (tx) => {
      await this.safety.lockSelf(tx);
      const shift = await this.shifts.requireOpenLocked(tx);
      await tx.$queryRaw`
        SELECT id FROM gate_face_checks WHERE id = ${pending.id}::uuid FOR UPDATE`;
      const row = await tx.gateFaceCheck.findUniqueOrThrow({
        where: { id: pending.id },
      });
      // The shift it was made on, still open; else nothing is met.
      if (shift.id !== row.shiftId) throw noOpenShift();
      if (row.outcome) return this.read(tx, row);
      const now = await dbNow(tx);
      const met = templateRefs ? await this.met(tx, templateRefs, now) : [];
      const outcome =
        templateRefs === null
          ? 'unavailable'
          : met.length
            ? 'possible_match'
            : 'no_match';
      if (met.length)
        await this.matcher.record(
          tx,
          {
            entries: met,
            kind: met.some((e) => e.kind === 'ban') ? 'ban' : 'watch',
            entry: met.find((e) => e.kind === 'ban') ?? met[0],
          },
          {
            source: 'face',
            outcome: 'noted',
            subject: { type: 'face_check', id: row.id },
            gateId: row.gateId,
            shiftId: row.shiftId,
          },
        );
      const answered = await tx.gateFaceCheck.update({
        where: { id: row.id },
        data: { outcome, matches: met.length, checkedAt: now },
      });
      await this.audit.record(tx, {
        action: 'face_check.made',
        targetId: row.id,
        metadata: {
          shiftId: row.shiftId,
          outcome,
          entryIds: met.map((e) => e.id),
        },
      });
      return this.read(tx, answered);
    });
  }

  /** The guard's own check, as they made it. */
  get(id: string): Promise<FaceCheckRead> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const row = await tx.gateFaceCheck.findUnique({ where: { id } });
      if (!row || row.guardAccountId !== this.ctx.accountId) throw notFound();
      return this.read(tx, row);
    });
  }

  /**
   * Once an hour: the probes past their time — a day, or 30 days after a
   * possible match — deleted, and the check keeps its answer.
   */
  purgeProbes(now: Date): Promise<number> {
    return this.sweep.forEachTenant(async (tx) => {
      const due = await tx.gateFaceCheck.findMany({
        where: {
          probeFileId: { not: null },
          OR: [
            {
              outcome: { not: 'possible_match' },
              createdAt: { lte: new Date(now.getTime() - PROBE_DAYS * DAY_MS) },
            },
            // Unanswered (the shift ended between): a day, as no match.
            {
              outcome: null,
              createdAt: { lte: new Date(now.getTime() - PROBE_DAYS * DAY_MS) },
            },
            {
              outcome: 'possible_match',
              createdAt: {
                lte: new Date(now.getTime() - MATCHED_PROBE_DAYS * DAY_MS),
              },
            },
          ],
        },
        select: { id: true, probeFileId: true },
        orderBy: { createdAt: 'asc' },
        take: SWEEP_BATCH,
      });
      const at = await dbNow(tx);
      for (const c of due) {
        await tx.gateFaceCheck.update({
          where: { id: c.id },
          data: { probeFileId: null, probeDeletedAt: at },
        });
        await this.files.markDeleted(
          tx,
          { id: c.probeFileId!, purpose: 'gate_face_probe' },
          'retention',
        );
      }
      return due.length;
    });
  }

  /** The live entries behind the vendor's candidates, under the blocklist's shared lock. */
  private async met(
    tx: TenantTxClient,
    templateRefs: string[],
    now: Date,
  ): Promise<BlocklistEntry[]> {
    if (!templateRefs.length) return [];
    const enrolled = await tx.gateFaceEnrollment.findMany({
      where: { status: 'enrolled', templateRef: { in: templateRefs } },
      select: { entryId: true },
    });
    if (!enrolled.length) return [];
    await this.core.lockRead(tx);
    return tx.blocklistEntry.findMany({
      where: {
        AND: [
          this.core.active(now),
          { id: { in: [...new Set(enrolled.map((e) => e.entryId))] } },
        ],
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
  }

  private async read(
    tx: TenantTxClient,
    check: GateFaceCheck,
  ): Promise<FaceCheckRead> {
    const ids = (
      await tx.blocklistMatch.findMany({
        where: { subjectType: 'face_check', subjectId: check.id },
        select: { entryId: true },
      })
    ).map((m) => m.entryId);
    const entries = ids.length
      ? await tx.blocklistEntry.findMany({
          where: { id: { in: ids } },
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        })
      : [];
    return {
      check,
      outcome: (check.outcome as FaceCheckOutcome | null) ?? 'pending',
      matches: await this.blocklist.records(tx, entries, await dbNow(tx)),
    };
  }
}
