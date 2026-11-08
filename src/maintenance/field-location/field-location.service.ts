import { Injectable, type OnModuleInit } from '@nestjs/common';
import type { TechnicianLocation } from '@prisma/client';
import { AccountLifecycle } from '../../core/accounts/account-lifecycle';
import { AuditService } from '../../core/audit/audit.service';
import { RequestContext } from '../../core/common/cls/request-context';
import { appError, ErrorCode } from '../../core/common/errors';
import { newId } from '../../core/common/uuid';
import {
  TenantTx,
  type TenantTxClient,
} from '../../core/database/tenant-tx.service';
import { SweepRunner } from '../../core/sweep/sweep-runner';
import { dbNow } from '../db-clock';
import { ticketNumber } from '../tickets/ticket-rules';

export const LOCATION_PURGE_SWEEP = 'maintenance.location_purge';
/** A point is kept this long, then purged. */
export const LOCATION_KEEP_DAYS = 30;
const DAY = 86_400_000;
/** The technician's own points they read back at most. */
const OWN_MAX = 100;

/** The three moments a point is taken at, and no other. */
export const LOCATION_MOMENTS = ['en_route', 'arrived', 'started'] as const;
export type LocationMoment = (typeof LOCATION_MOMENTS)[number];

export interface FieldLocation {
  latitude: number;
  longitude: number;
  accuracyMeters?: number;
}

export interface LocationPoint {
  moment: LocationMoment;
  ticketId: string;
  ticketNumber: string | null;
  latitude: number;
  longitude: number;
  accuracyMeters: number | null;
  capturedAt: Date;
}

export interface OwnLocationRead {
  consent: { grantedAt: Date } | null;
  points: LocationPoint[];
}

export interface LastLocationRead {
  technicianId: string;
  consent: boolean;
  last: LocationPoint | null;
}

/**
 * A technician's last known location (ADR 0090): taken only with their
 * consent, and only at three moments of one of their tickets — on the way,
 * at the door, starting the work. Never continuous.
 *
 * - **Consent** is the technician's own, recorded, revocable and audited:
 *   one live at a time, under their consent lock. Revoking it, by
 *   themselves or the system when they leave, removes every point it took.
 * - **A point** comes with the step's own request, in its transaction:
 *   the live consent is read FOR SHARE, so a revocation either waits for
 *   the step (and removes its point) or ran first (and the step is refused
 *   with LOCATION_CONSENT_REQUIRED, nothing moving). Timed by the
 *   database's clock.
 * - **Kept 30 days**, then purged by `maintenance.location_purge`.
 * - **Read** by the field team and the dispatch, one technician at a time,
 *   audited (who looked, never where); never in a list, never in a
 *   resident's view, never in a notification.
 */
@Injectable()
export class FieldLocationService implements OnModuleInit {
  constructor(
    private readonly tenantTx: TenantTx,
    private readonly ctx: RequestContext,
    private readonly audit: AuditService,
    private readonly sweep: SweepRunner,
    private readonly lifecycle: AccountLifecycle,
  ) {}

  onModuleInit(): void {
    this.sweep.register(LOCATION_PURGE_SWEEP, (now) => this.purge(now));
    // Leaving ends the consent, and with it every point it took.
    this.lifecycle.onDeactivated(async (tx, account) => {
      await this.revokeIn(tx, account.id, 'system');
      return [];
    });
    this.lifecycle.onErasing(async (tx, account) => {
      await this.revokeIn(tx, account.id, 'system');
      return [];
    });
  }

  /** The technician's consent and their own points of the 30 days. */
  mine(): Promise<OwnLocationRead> {
    return this.tenantTx.withTenantTx((tx) =>
      this.ownIn(tx, this.ctx.accountId),
    );
  }

  /** Given once; given again answers the same. */
  grant(): Promise<OwnLocationRead> {
    const me = this.ctx.accountId;
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.lockConsent(tx, me);
      const live = await tx.technicianLocationConsent.findFirst({
        where: { accountId: me, revokedAt: null },
      });
      if (!live) {
        await tx.technicianLocationConsent.create({
          data: {
            id: newId(),
            tenantId: this.ctx.txTenantId,
            accountId: me,
            grantedAt: await dbNow(tx),
          },
        });
        await this.audit.record(tx, {
          action: 'technician_location.consent_granted',
          targetId: me,
        });
      }
      return this.ownIn(tx, me);
    });
  }

  /** Revoked by themselves: their points go with it. None live: nothing. */
  revoke(): Promise<OwnLocationRead> {
    const me = this.ctx.accountId;
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.revokeIn(tx, me, 'self');
      return this.ownIn(tx, me);
    });
  }

  /**
   * A point at one of the technician's steps on a ticket, in the step's
   * transaction (the ticket already locked): refused without a live
   * consent, so nothing of the step stays.
   */
  async capture(
    tx: TenantTxClient,
    ticketId: string,
    moment: LocationMoment,
    at: FieldLocation,
  ): Promise<void> {
    const me = this.ctx.accountId;
    const [consent] = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM technician_location_consents
       WHERE account_id = ${me}::uuid AND revoked_at IS NULL
       FOR SHARE`;
    if (!consent)
      throw appError.conflict(
        ErrorCode.LOCATION_CONSENT_REQUIRED,
        'Consent to your location first, or send the step without it',
      );
    await tx.technicianLocation.create({
      data: {
        id: newId(),
        tenantId: this.ctx.txTenantId,
        accountId: me,
        consentId: consent.id,
        ticketId,
        moment,
        latitude: at.latitude,
        longitude: at.longitude,
        accuracyM: at.accuracyMeters ?? null,
        capturedAt: await dbNow(tx),
      },
    });
  }

  /**
   * A technician's last known location, for the field team or the
   * dispatch: the latest point of the 30 days, or none. Audited.
   */
  last(technicianId: string): Promise<LastLocationRead> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const technician = await tx.account.findFirst({
        where: { id: technicianId, type: 'staff' },
        select: { id: true },
      });
      if (!technician)
        throw appError.notFound(
          ErrorCode.TECHNICIAN_NOT_FOUND,
          'Technician not found',
        );
      const consent = await tx.technicianLocationConsent.count({
        where: { accountId: technicianId, revokedAt: null },
      });
      const now = await dbNow(tx);
      const [row] = await tx.technicianLocation.findMany({
        where: {
          accountId: technicianId,
          capturedAt: { gte: this.keptFrom(now) },
        },
        orderBy: [{ capturedAt: 'desc' }, { id: 'desc' }],
        take: 1,
      });
      await this.audit.record(tx, {
        action: 'technician_location.read',
        targetId: technicianId,
        metadata: row ? { found: true, moment: row.moment } : { found: false },
      });
      return {
        technicianId,
        consent: consent > 0,
        last: row ? (await this.points(tx, [row]))[0] : null,
      };
    });
  }

  /** Points older than 30 days, purged in every compound. */
  purge(now: Date): Promise<number> {
    const before = this.keptFrom(now);
    return this.sweep.forEachTenant(async (tx) => {
      const { count } = await tx.technicianLocation.deleteMany({
        where: { capturedAt: { lt: before } },
      });
      return count;
    });
  }

  // --------------------------------------------------------------------------

  private keptFrom(now: Date): Date {
    return new Date(now.getTime() - LOCATION_KEEP_DAYS * DAY);
  }

  private async lockConsent(tx: TenantTxClient, accountId: string) {
    await tx.$executeRaw`
      SELECT pg_advisory_xact_lock(hashtext(${`location-consent:${this.ctx.txTenantId}:${accountId}`}))`;
  }

  /**
   * The live consent ended, by the technician or the system, and every
   * point of theirs removed with it; audited with how many went.
   */
  private async revokeIn(
    tx: TenantTxClient,
    accountId: string,
    by: 'self' | 'system',
  ): Promise<void> {
    await this.lockConsent(tx, accountId);
    const [live] = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM technician_location_consents
       WHERE account_id = ${accountId}::uuid AND revoked_at IS NULL
       FOR UPDATE`;
    if (!live) return;
    await tx.technicianLocationConsent.update({
      where: { id: live.id },
      data: { revokedAt: await dbNow(tx), revokedBy: by },
    });
    const { count } = await tx.technicianLocation.deleteMany({
      where: { accountId },
    });
    await this.audit.record(tx, {
      action: 'technician_location.consent_revoked',
      targetId: accountId,
      metadata: { by, removed: count },
    });
  }

  private async ownIn(
    tx: TenantTxClient,
    accountId: string,
  ): Promise<OwnLocationRead> {
    const consent = await tx.technicianLocationConsent.findFirst({
      where: { accountId, revokedAt: null },
      select: { grantedAt: true },
    });
    const rows = await tx.technicianLocation.findMany({
      where: {
        accountId,
        capturedAt: { gte: this.keptFrom(await dbNow(tx)) },
      },
      orderBy: [{ capturedAt: 'desc' }, { id: 'desc' }],
      take: OWN_MAX,
    });
    return { consent, points: await this.points(tx, rows) };
  }

  private async points(
    tx: TenantTxClient,
    rows: readonly TechnicianLocation[],
  ): Promise<LocationPoint[]> {
    const tickets = new Map(
      (rows.length
        ? await tx.ticket.findMany({
            where: { id: { in: [...new Set(rows.map((r) => r.ticketId))] } },
            select: { id: true, number: true },
          })
        : []
      ).map((t) => [t.id, ticketNumber(t.number)]),
    );
    return rows.map((r) => ({
      moment: r.moment as LocationMoment,
      ticketId: r.ticketId,
      ticketNumber: tickets.get(r.ticketId) ?? null,
      latitude: r.latitude.toNumber(),
      longitude: r.longitude.toNumber(),
      accuracyMeters: r.accuracyM,
      capturedAt: r.capturedAt,
    }));
  }
}
