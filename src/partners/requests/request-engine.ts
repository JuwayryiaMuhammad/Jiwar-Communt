import { Injectable } from '@nestjs/common';
import type { PartnerRequest, Prisma } from '@prisma/client';
import { AuditService } from '../../core/audit/audit.service';
import { appError, ErrorCode } from '../../core/common/errors';
import { newId } from '../../core/common/uuid';
import type { TenantTxClient } from '../../core/database/tenant-tx.service';
import type { NotificationParams } from '../../core/notifications/kinds';
import { PartnerNotices } from '../notices/partner-notices';
import {
  decide,
  RESULT,
  type PartnerRequestStatus,
  type RequestAction,
  type Verdict,
} from './request-rules';

/** Who moves a request: the resident, the partner's desk, the relay, the system. */
export type RequestActor =
  | { kind: 'resident'; accountId: string }
  | { kind: 'partner_desk'; deskLinkId: string }
  | { kind: 'relay'; accountId: string }
  | { kind: 'system' };

/** What an action carries besides itself. */
export interface ActionInput {
  reasonCode?: string;
  window?: { startsAt: Date; endsAt: Date };
  staffCount?: number;
  /** False when the caller tells the requester itself (a suspension). */
  notify?: boolean;
}

export const requestNotFound = () =>
  appError.notFound(
    ErrorCode.PARTNER_REQUEST_NOT_FOUND,
    'Partner request not found',
  );

/** The history row of each action. */
const EVENT: Record<RequestAction, string> = {
  accept: 'accepted',
  decline: 'declined',
  propose: 'proposed',
  accept_proposal: 'proposal_accepted',
  decline_proposal: 'proposal_declined',
  resident_cancel: 'cancelled',
  partner_cancel: 'cancelled',
  system_cancel: 'cancelled',
  resident_done: 'done',
  partner_done: 'done',
  no_show: 'no_show',
  expire: 'expired',
  lapse: 'lapsed',
};

/** The audit entry of each action. */
const AUDIT = {
  accept: 'partner_request.accepted',
  decline: 'partner_request.declined',
  propose: 'partner_request.proposed',
  accept_proposal: 'partner_request.proposal_accepted',
  decline_proposal: 'partner_request.cancelled',
  resident_cancel: 'partner_request.cancelled',
  partner_cancel: 'partner_request.cancelled',
  system_cancel: 'partner_request.cancelled',
  resident_done: 'partner_request.done',
  partner_done: 'partner_request.done',
  no_show: 'partner_request.no_show',
  expire: 'partner_request.expired',
  lapse: 'partner_request.lapsed',
} as const satisfies Record<RequestAction, string>;

/** How an actor appears in the history and the audit's `via`. */
export const actorCode = (a: RequestActor) => a.kind;

const actorAccount = (a: RequestActor): string | null =>
  a.kind === 'resident' || a.kind === 'relay' ? a.accountId : null;

/** The refusal a verdict stands for. */
export function refusal(
  verdict: Exclude<Verdict, { ok: true }>,
  status: string,
) {
  switch (verdict.reason) {
    case 'status':
      return appError.conflict(
        ErrorCode.PARTNER_REQUEST_INVALID_TRANSITION,
        'The request’s status does not take this',
        { params: { status } },
      );
    case 'window_passed':
      return appError.conflict(
        ErrorCode.PARTNER_REQUEST_WINDOW_PASSED,
        'The request’s window has passed',
      );
    case 'too_early':
      return appError.conflict(
        ErrorCode.PARTNER_REQUEST_TOO_EARLY,
        'Too early for this',
      );
  }
}

/**
 * Moves partner requests (ADR 0060), whoever acts: one place that asks the
 * rules table, writes the row, its history, the audit entry and the
 * requester's notice, in the caller's transaction and under the request's
 * row lock (`lock`), taken after the accounts and the partner's row.
 */
@Injectable()
export class PartnerRequestEngine {
  /**
   * Hooks run after an action, in its transaction: the gate's service pass
   * (ADR 0060 §3) registers here, so the engine never reads the gate.
   */
  private readonly after: ((
    tx: TenantTxClient,
    before: PartnerRequest,
    after: PartnerRequest,
    action: RequestAction,
    actor: RequestActor,
    now: Date,
  ) => Promise<void>)[] = [];

  constructor(
    private readonly audit: AuditService,
    private readonly notices: PartnerNotices,
  ) {}

  onAfter(
    hook: (
      tx: TenantTxClient,
      before: PartnerRequest,
      after: PartnerRequest,
      action: RequestAction,
      actor: RequestActor,
      now: Date,
    ) => Promise<void>,
  ): void {
    this.after.push(hook);
  }

  /** The request's row, locked FOR UPDATE; not found for an unknown id or another compound's. */
  async lock(tx: TenantTxClient, id: string): Promise<PartnerRequest> {
    const rows = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM partner_requests WHERE id = ${id}::uuid FOR UPDATE`;
    if (!rows.length) throw requestNotFound();
    return tx.partnerRequest.findUniqueOrThrow({ where: { id } });
  }

  /**
   * Applies `action` to the locked request at `now` (the database's clock,
   * read after the locks): refused with the rules' reason, or written with
   * its history row, audit entry and notice.
   */
  async apply(
    tx: TenantTxClient,
    request: PartnerRequest,
    action: RequestAction,
    actor: RequestActor,
    input: ActionInput,
    now: Date,
  ): Promise<PartnerRequest> {
    const verdict = decide(
      action,
      {
        status: request.status as PartnerRequestStatus,
        askedStartsAt: request.askedStartsAt,
        proposedStartsAt: request.proposedStartsAt,
        agreedStartsAt: request.agreedStartsAt,
        agreedEndsAt: request.agreedEndsAt,
      },
      now,
    );
    if (!verdict.ok) throw refusal(verdict, request.status);

    const to = RESULT[action];
    const data: Prisma.PartnerRequestUpdateInput = {
      status: to,
      lastActivityAt: now,
    };
    const clearProposal = {
      proposedStartsAt: null,
      proposedEndsAt: null,
    };
    let window: { startsAt: Date; endsAt: Date } | null = null;
    switch (action) {
      case 'accept':
        window = {
          startsAt: request.askedStartsAt,
          endsAt: request.askedEndsAt,
        };
        Object.assign(data, {
          agreedStartsAt: window.startsAt,
          agreedEndsAt: window.endsAt,
          staffCount: input.staffCount ?? 1,
          acceptedAt: now,
        });
        break;
      case 'accept_proposal':
        window = {
          startsAt: request.proposedStartsAt!,
          endsAt: request.proposedEndsAt!,
        };
        Object.assign(data, {
          ...clearProposal,
          agreedStartsAt: window.startsAt,
          agreedEndsAt: window.endsAt,
          staffCount: request.staffCount ?? 1,
          acceptedAt: now,
        });
        break;
      case 'propose':
        window = input.window!;
        Object.assign(data, {
          proposedStartsAt: window.startsAt,
          proposedEndsAt: window.endsAt,
          staffCount: input.staffCount ?? 1,
        });
        break;
      default: {
        // Every other action closes the request.
        const closedBy =
          action === 'resident_cancel' ||
          action === 'decline_proposal' ||
          action === 'resident_done' ||
          action === 'no_show'
            ? 'resident'
            : action === 'decline' ||
                action === 'partner_cancel' ||
                action === 'partner_done'
              ? 'partner'
              : 'system';
        Object.assign(data, {
          closedAt: now,
          closedBy,
          closeReason:
            action === 'decline_proposal'
              ? 'proposal_declined'
              : to === 'declined' || to === 'cancelled'
                ? (input.reasonCode ?? null)
                : null,
          ...(request.status === 'proposed'
            ? { ...clearProposal, staffCount: null }
            : {}),
        });
      }
    }
    const after = await tx.partnerRequest.update({
      where: { id: request.id },
      data,
    });
    const reasonCode = after.closeReason ?? null;
    await this.event(tx, request, EVENT[action], actor, now, {
      reasonCode,
      window,
    });
    await this.audit.record(tx, {
      action: AUDIT[action],
      targetId: request.id,
      metadata: {
        number: request.number,
        partnerId: request.partnerId,
        unitId: request.unitId,
        from: request.status,
        to,
        via: actorCode(actor),
        ...(actor.kind === 'partner_desk'
          ? { deskLinkId: actor.deskLinkId }
          : {}),
        ...(reasonCode ? { reasonCode } : {}),
        ...(window
          ? {
              startsAt: window.startsAt.toISOString(),
              endsAt: window.endsAt.toISOString(),
            }
          : {}),
        ...(after.staffCount !== null && window
          ? { staffCount: after.staffCount }
          : {}),
      },
    });
    if (input.notify !== false) await this.tell(tx, after, action, actor);
    for (const hook of this.after)
      await hook(tx, request, after, action, actor, now);
    return after;
  }

  /** A row of the request's history. */
  async event(
    tx: TenantTxClient,
    request: Pick<PartnerRequest, 'id' | 'tenantId'>,
    kind: string,
    actor: RequestActor,
    at: Date,
    extra: {
      reasonCode?: string | null;
      window?: { startsAt: Date; endsAt: Date } | null;
    } = {},
  ): Promise<void> {
    await tx.partnerRequestEvent.create({
      data: {
        id: newId(),
        tenantId: request.tenantId,
        requestId: request.id,
        kind,
        actor: actorCode(actor),
        actorAccountId: actorAccount(actor),
        reasonCode: extra.reasonCode ?? null,
        startsAt: extra.window?.startsAt ?? null,
        endsAt: extra.window?.endsAt ?? null,
        at,
      },
    });
  }

  /** What the requester is told of the partner's and the system's moves. */
  private async tell(
    tx: TenantTxClient,
    r: PartnerRequest,
    action: RequestAction,
    actor: RequestActor,
  ): Promise<void> {
    const to = [r.requesterId];
    const except = actorAccount(actor);
    const send = (
      kind: Parameters<PartnerNotices['send']>[2],
      params: NotificationParams = {},
    ) => this.notices.send(tx, to, kind, r.id, params, except);
    switch (action) {
      case 'accept':
        await send('partner_request.accepted');
        return;
      case 'decline':
        await send('partner_request.declined', { reason: r.closeReason! });
        return;
      case 'propose':
        await send('partner_request.proposed');
        return;
      case 'partner_cancel':
        await send('partner_request.cancelled', {
          side: 'partner',
          reason: r.closeReason!,
        });
        return;
      case 'partner_done':
        await send('partner_request.done');
        return;
      case 'expire':
        await send('partner_request.expired');
        return;
      default:
        // The resident's own moves tell nobody; a system cancel tells in
        // its own way (a suspension) or nobody (the requester left).
        return;
    }
  }
}
