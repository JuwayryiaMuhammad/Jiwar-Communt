import { Injectable, type OnModuleInit } from '@nestjs/common';
import type { EmergencyType } from '@prisma/client';
import { RequestContext } from '../../core/common/cls/request-context';
import { appError, ErrorCode } from '../../core/common/errors';
import { REASON_CODES, requireReasonCodeOnly } from '../../core/common/reasons';
import {
  TenantTx,
  type TenantTxClient,
} from '../../core/database/tenant-tx.service';
import { IdempotencyService } from '../../core/idempotency/idempotency.service';
import { MaintenanceGatePort, type TechnicianTicket } from '../../maintenance';
import { SafetyCore } from '../safety/safety-core';
import {
  emergencyNotFound,
  EmergencyRecords,
  OPEN_EMERGENCY,
  type EmergencyRecord,
} from './emergency-records';
import { SosCore } from './sos-core';
import { StaffEmergencyView } from './views/staff-emergency.views';

/** A technician's SOS, replayed as the responders' view. */
export const TECHNICIAN_SOS_RESOURCE = 'technician_sos';

export const ticketNotFound = () =>
  appError.notFound(ErrorCode.TICKET_NOT_FOUND, 'Ticket not found');

/**
 * A technician's SOS (ADR 0067): an emergency from the ticket in their
 * hands — with no shift — through the staff's SOS core (SosCore), so it is
 * told and escalated exactly as a guard's. One open per ticket, decided
 * under the ticket's emergency lock (a repeat answers 200 with the open
 * one), with a partial unique index behind it. The technician who raised it
 * never accepts it, and does not cancel it: they ask for it to be called
 * off, which is recorded and told while it stays open until a responder or
 * the management resolves it — someone under duress can be made to cancel.
 */
@Injectable()
export class TechnicianSosService implements OnModuleInit {
  constructor(
    private readonly tenantTx: TenantTx,
    private readonly ctx: RequestContext,
    private readonly idempotency: IdempotencyService,
    private readonly core: SafetyCore,
    private readonly records: EmergencyRecords,
    private readonly sos: SosCore,
    private readonly tickets: MaintenanceGatePort,
  ) {}

  onModuleInit(): void {
    this.idempotency.renderer(TECHNICIAN_SOS_RESOURCE, (id) =>
      this.tenantTx.withTenantTx(async (tx) =>
        StaffEmergencyView.from(
          await this.records.load(
            tx,
            await tx.emergency.findUniqueOrThrow({ where: { id } }),
          ),
          this.ctx.accountId,
        ),
      ),
    );
  }

  raise(
    ticketId: string,
    type: EmergencyType,
  ): Promise<{ record: EmergencyRecord; created: boolean }> {
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.core.lockSelf(tx);
      await this.requireOwn(tx, ticketId);
      await this.core.lockUnit(tx, 'emergency-ticket', ticketId);
      return this.sos.raiseLocked(
        tx,
        { kind: 'ticket', ticketId },
        type,
        TECHNICIAN_SOS_RESOURCE,
      );
    });
  }

  /** The open SOS the caller raised from the ticket: asked to be called off; it stays open. */
  requestCancel(
    ticketId: string,
    reasonCode?: string,
  ): Promise<EmergencyRecord> {
    const reason =
      reasonCode === undefined
        ? null
        : requireReasonCodeOnly(reasonCode, REASON_CODES.emergencyCancel);
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.core.lockSelf(tx);
      await this.core.lockUnit(tx, 'emergency-ticket', ticketId);
      const open = await tx.emergency.findFirst({
        where: {
          originTicketId: ticketId,
          reportedById: this.ctx.accountId,
          status: { in: OPEN_EMERGENCY },
        },
        select: { id: true },
      });
      if (!open) throw emergencyNotFound();
      const e = await this.records.lock(tx, open.id, 'update');
      return this.sos.requestCancelLocked(tx, e, reason);
    });
  }

  private async requireOwn(
    tx: TenantTxClient,
    ticketId: string,
  ): Promise<TechnicianTicket> {
    const ticket = await this.tickets.ownTicket(
      tx,
      ticketId,
      this.ctx.accountId,
    );
    if (!ticket) throw ticketNotFound();
    return ticket;
  }
}
