import { Injectable } from '@nestjs/common';
import { AuditService } from '../../core/audit/audit.service';
import { RequestContext } from '../../core/common/cls/request-context';
import { appError, ErrorCode, type FieldError } from '../../core/common/errors';
import { newId } from '../../core/common/uuid';
import {
  TenantTx,
  type TenantTxClient,
} from '../../core/database/tenant-tx.service';
import { IdempotencyService } from '../../core/idempotency/idempotency.service';
import { dbNow } from '../db-clock';
import { PermitCore } from './permit-core';
import {
  isOpen,
  PERMIT_RESOURCE,
  permitNotFound,
  PermitRecords,
  viewStatus,
  type PermitRecord,
} from './permit-records';
import { checkGuests, type NewGuest } from './permit-requests.service';
import { invalid, PermitsService } from './permits.service';
import { BlocklistMatcher } from '../blocklist/blocklist-matcher';

export const permitGuestNotFound = () =>
  appError.notFound(ErrorCode.PERMIT_GUEST_NOT_FOUND, 'Guest not found');

/**
 * An event's guest list, the host's side (ADR 0049). The host or the unit's
 * primary adds guests until the event starts, never past its guest limit
 * (20 when approved at once, else the size the management was asked for:
 * a bigger event is a new request), and takes guests off while it is open.
 * Under the event's row lock, so two additions never pass the limit.
 */
@Injectable()
export class PermitGuestsService {
  constructor(
    private readonly tenantTx: TenantTx,
    private readonly ctx: RequestContext,
    private readonly audit: AuditService,
    private readonly idempotency: IdempotencyService,
    private readonly core: PermitCore,
    private readonly records: PermitRecords,
    private readonly permits: PermitsService,
    private readonly matcher: BlocklistMatcher,
  ) {}

  add(permitId: string, guests: NewGuest[]): Promise<PermitRecord> {
    const fields: FieldError[] = [];
    const tidy = checkGuests(guests, 'guests', fields);
    if (fields.length) throw invalid(fields);
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.core.lockSelf(tx);
      const p = await this.openEvent(tx, permitId);
      const now = await dbNow(tx);
      if (p.startsAt.getTime() <= now.getTime())
        throw appError.conflict(
          ErrorCode.PERMIT_STARTED,
          'The event has started: its list is fixed',
        );
      const count = await tx.permitGuest.count({
        where: { permitId, removedAt: null },
      });
      if (count + tidy.length > p.guestLimit!)
        throw appError.conflict(
          ErrorCode.PERMIT_LIMIT_REACHED,
          'The event holds as many guests as it may',
          { params: { scope: 'guests', max: p.guestLimit! } },
        );
      await this.idempotency.claim(tx, { type: PERMIT_RESOURCE, id: p.id });
      const rows = tidy.map((g) => ({
        id: newId(),
        tenantId: this.ctx.txTenantId,
        permitId,
        fullName: g.fullName,
        vehiclePlate: g.vehiclePlate,
        addedById: this.ctx.accountId,
      }));
      await tx.permitGuest.createMany({ data: rows });
      // Their cars' plates on the blocklist (ADR 0053): noted, never refused.
      for (const g of rows)
        await this.matcher.noteRecorded(
          tx,
          'event_guest',
          { type: 'event_guest', id: g.id },
          g.vehiclePlate,
        );
      await this.audit.record(tx, {
        action: 'unit_permit.guests_changed',
        targetId: permitId,
        metadata: {
          added: tidy.length,
          removed: 0,
          guests: count + tidy.length,
        },
      });
      return this.records.load(tx, p);
    });
  }

  remove(permitId: string, guestId: string): Promise<PermitRecord> {
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.core.lockSelf(tx);
      const p = await this.openEvent(tx, permitId);
      const rows = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM permit_guests
         WHERE id = ${guestId}::uuid AND permit_id = ${permitId}::uuid
           FOR UPDATE`;
      if (!rows.length) throw permitGuestNotFound();
      const guest = await tx.permitGuest.findUniqueOrThrow({
        where: { id: guestId },
      });
      if (!guest.removedAt) {
        await tx.permitGuest.update({
          where: { id: guestId },
          data: { removedAt: await dbNow(tx) },
        });
        await this.audit.record(tx, {
          action: 'unit_permit.guests_changed',
          targetId: permitId,
          metadata: {
            added: 0,
            removed: 1,
            guests: await tx.permitGuest.count({
              where: { permitId, removedAt: null },
            }),
          },
        });
      }
      return this.records.load(tx, p);
    });
  }

  /** An event the caller manages, locked, still open. */
  private async openEvent(tx: TenantTxClient, permitId: string) {
    await this.permits.visible(
      tx,
      await tx.unitPermit.findUnique({ where: { id: permitId } }),
    );
    const p = await this.records.lock(tx, permitId);
    if (p.kind !== 'event') throw permitNotFound();
    const now = await dbNow(tx);
    if (!isOpen(p, now))
      throw appError.conflict(
        ErrorCode.PERMIT_NOT_ACTIVE,
        'This permit is over',
        {
          params: { status: viewStatus(p, now) },
        },
      );
    return p;
  }
}
