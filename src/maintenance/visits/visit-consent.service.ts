import { Injectable, type OnModuleInit } from '@nestjs/common';
import type { Ticket, TicketVisit } from '@prisma/client';
import { CommunityMaintenancePort } from '../../community';
import { AccountLifecycle } from '../../core/accounts/account-lifecycle';
import { RequestContext } from '../../core/common/cls/request-context';
import { appError, ErrorCode, FieldErrorCode } from '../../core/common/errors';
import {
  TenantTx,
  type TenantTxClient,
} from '../../core/database/tenant-tx.service';
import { dbNow } from '../db-clock';
import { VisitAccess } from './visit-access';
import { VisitLog } from './visit-log';
import { assertVisit } from './visit-rules';
import { VisitsService } from './visits.service';

export type ReceiverInput = { accountId: string } | { engagementId: string };

const consentNotAllowed = () =>
  appError.forbidden(
    ErrorCode.VISIT_CONSENT_NOT_ALLOWED,
    'Only an adult who lives here allows entry while nobody is home',
  );

const receiverNotEligible = (field: 'accountId' | 'engagementId') =>
  appError.badRequest(ErrorCode.VALIDATION_FAILED, 'Not a receiver', {
    fields: [{ field, code: FieldErrorCode.RECEIVER_NOT_ELIGIBLE }],
  });

/**
 * Absence-entry consent and the receiver of a visit (ADR 0034).
 *
 * **Consent** is not confirmation: it says the technician may enter while
 * nobody is home, for this one visit. Any adult who lives in the unit
 * (`visitConsent`, an active account) grants it on a confirmed visit, and
 * any of them revokes it until the technician arrives. When someone other
 * than the primary grants it, the primary is told (the window only). It is
 * never carried over: a cancelled or rescheduled visit loses it, and so
 * does a visit whose granter no longer lives there.
 *
 * The **receiver** lets the technician in: an adult who lives in the unit,
 * or an active domestic worker of it. Cleared when they leave, are
 * deactivated, frozen or erased (a worker is checked live at every read).
 *
 * Locks: the people first (the caller's own account, a receiver's account,
 * `FOR SHARE`), then the ticket. A change of who lives where locks the
 * person's account row (`FOR NO KEY UPDATE`) before voiding, so a grant and
 * a departure are ordered one way or the other, never interleaved.
 */
@Injectable()
export class VisitConsentService implements OnModuleInit {
  constructor(
    private readonly tenantTx: TenantTx,
    private readonly ctx: RequestContext,
    private readonly access: VisitAccess,
    private readonly log: VisitLog,
    private readonly visits: VisitsService,
    private readonly community: CommunityMaintenancePort,
    private readonly lifecycle: AccountLifecycle,
  ) {}

  onModuleInit(): void {
    // The account row is already updated (locked) by the change itself.
    this.lifecycle.onDeactivated(async (tx, account) => {
      await this.forget(tx, account.id, () => Promise.resolve(false));
      return [];
    });
    this.lifecycle.onFrozen((tx, account) =>
      this.forget(tx, account.id, () => Promise.resolve(false)),
    );
    this.lifecycle.onErasing(async (tx, account) => {
      await this.forget(tx, account.id, () => Promise.resolve(false));
      return [];
    });
    // Where the person lives changed: the account row is not, so it is
    // locked here, ordering this against a grant in flight.
    this.lifecycle.onResidenceChanged(async (tx, account) => {
      await tx.$queryRaw`
        SELECT id FROM accounts WHERE id = ${account.id}::uuid FOR NO KEY UPDATE`;
      await this.forget(tx, account.id, (unitId) =>
        this.community.mayConsent(tx, account.id, unitId),
      );
    });
  }

  // --- consent ---------------------------------------------------------------

  grant(ticketId: string, visitId: string): Promise<void> {
    const me = this.ctx.accountId;
    return this.tenantTx.withTenantTx(async (tx) => {
      const { ticket, visit } = await this.consenter(tx, ticketId, visitId);
      assertVisit(visit, 'grantConsent');
      if (visit.absenceEntryApproved) return;
      const now = await dbNow(tx);
      await tx.ticketVisit.update({
        where: { id: visit.id },
        data: { absenceEntryApproved: true, consentById: me, consentAt: now },
      });
      await this.log.write(tx, visit, {
        kind: 'consent_granted',
        side: 'resident',
        actorId: me,
        at: now,
      });
      const primary = await this.community.primaryOf(tx, ticket.unitId!);
      if (primary && primary !== me)
        await this.visits.tell(
          tx,
          ticket,
          visit,
          'ticket.visit_consent_granted',
          [primary],
        );
    });
  }

  /** Any adult who lives there, until the technician arrives. */
  revoke(ticketId: string, visitId: string): Promise<void> {
    const me = this.ctx.accountId;
    return this.tenantTx.withTenantTx(async (tx) => {
      const { visit } = await this.consenter(tx, ticketId, visitId);
      assertVisit(visit, 'revokeConsent');
      if (!visit.absenceEntryApproved) return;
      const now = await dbNow(tx);
      await this.clearConsent(tx, visit);
      await this.log.write(tx, visit, {
        kind: 'consent_revoked',
        side: 'resident',
        actorId: me,
        at: now,
      });
    });
  }

  // --- the receiver ----------------------------------------------------------

  setReceiver(
    ticketId: string,
    visitId: string,
    input: ReceiverInput,
  ): Promise<void> {
    const me = this.ctx.accountId;
    const household = 'accountId' in input ? input.accountId : null;
    return this.tenantTx.withTenantTx(async (tx) => {
      const ticket = await this.access.forWrite(
        tx,
        ticketId,
        'resident',
        household ? [household] : [],
      );
      const visit = await this.access.visit(tx, ticket, visitId, 'resident');
      assertVisit(visit, 'setReceiver');
      const unitId = ticket.unitId!;
      if (household) {
        if (!(await this.community.mayConsent(tx, household, unitId)))
          throw receiverNotEligible('accountId');
      } else if (
        'engagementId' in input &&
        !(await this.community.activeWorker(tx, unitId, input.engagementId))
      )
        throw receiverNotEligible('engagementId');
      const now = await dbNow(tx);
      await tx.ticketVisit.update({
        where: { id: visit.id },
        data: household
          ? {
              receiverKind: 'household',
              receiverAccountId: household,
              receiverEngagementId: null,
            }
          : {
              receiverKind: 'worker',
              receiverAccountId: null,
              receiverEngagementId: (input as { engagementId: string })
                .engagementId,
            },
      });
      await this.log.write(tx, visit, {
        kind: 'receiver_set',
        side: 'resident',
        actorId: me,
        at: now,
      });
    });
  }

  clearReceiver(ticketId: string, visitId: string): Promise<void> {
    const me = this.ctx.accountId;
    return this.tenantTx.withTenantTx(async (tx) => {
      const ticket = await this.access.forWrite(tx, ticketId, 'resident');
      const visit = await this.access.visit(tx, ticket, visitId, 'resident');
      assertVisit(visit, 'setReceiver');
      if (!visit.receiverKind) return;
      const now = await dbNow(tx);
      await this.clearReceiverOf(tx, visit);
      await this.log.write(tx, visit, {
        kind: 'receiver_cleared',
        side: 'resident',
        actorId: me,
        at: now,
      });
    });
  }

  // --- helpers ---------------------------------------------------------------

  /** A visit for someone who may consent there; 403 for anyone else. */
  private async consenter(
    tx: TenantTxClient,
    ticketId: string,
    visitId: string,
  ): Promise<{ ticket: Ticket; visit: TicketVisit }> {
    const ticket = await this.access.forWrite(tx, ticketId, 'resident');
    const visit = await this.access.visit(tx, ticket, visitId, 'resident');
    if (
      !(await this.community.mayConsent(tx, this.ctx.accountId, ticket.unitId!))
    )
      throw consentNotAllowed();
    return { ticket, visit };
  }

  /**
   * The person no longer may (`stillMay` says, per unit): the consents they
   * granted on visits not yet arrived are void, and they no longer receive
   * a technician. Under each affected ticket's lock, in id order (the
   * caller holds the person's account row).
   */
  private async forget(
    tx: TenantTxClient,
    accountId: string,
    stillMay: (unitId: string) => Promise<boolean>,
  ): Promise<void> {
    const rows = await tx.$queryRaw<{ id: string }[]>`
      SELECT DISTINCT v.ticket_id AS id FROM ticket_visits v
       WHERE v.status = 'confirmed'
         AND (v.consent_by_account_id = ${accountId}::uuid
           OR v.receiver_account_id = ${accountId}::uuid)
       ORDER BY v.ticket_id`;
    for (const { id } of rows) {
      const [ticket] = await tx.$queryRaw<{ unit_id: string | null }[]>`
        SELECT unit_id FROM tickets WHERE id = ${id}::uuid FOR UPDATE`;
      if (!ticket?.unit_id || (await stillMay(ticket.unit_id))) continue;
      const visits = await tx.ticketVisit.findMany({
        where: {
          ticketId: id,
          status: 'confirmed',
          OR: [{ consentById: accountId }, { receiverAccountId: accountId }],
        },
      });
      const now = await dbNow(tx);
      for (const visit of visits) {
        if (visit.consentById === accountId) {
          await this.clearConsent(tx, visit);
          await this.log.write(tx, visit, {
            kind: 'consent_voided',
            side: 'system',
            actorId: null,
            reasonCode: 'granter_left',
            at: now,
          });
        }
        if (visit.receiverAccountId === accountId) {
          await this.clearReceiverOf(tx, visit);
          await this.log.write(tx, visit, {
            kind: 'receiver_cleared',
            side: 'system',
            actorId: null,
            at: now,
          });
        }
      }
    }
  }

  private async clearConsent(tx: TenantTxClient, visit: TicketVisit) {
    await tx.ticketVisit.update({
      where: { id: visit.id },
      data: { absenceEntryApproved: false, consentById: null, consentAt: null },
    });
  }

  private async clearReceiverOf(tx: TenantTxClient, visit: TicketVisit) {
    await tx.ticketVisit.update({
      where: { id: visit.id },
      data: {
        receiverKind: null,
        receiverAccountId: null,
        receiverEngagementId: null,
      },
    });
  }
}
