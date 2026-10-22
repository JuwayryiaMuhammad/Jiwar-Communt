import { Injectable } from '@nestjs/common';
import type { PartnerRequest } from '@prisma/client';
import { appError, ErrorCode } from '../../core/common/errors';
import { invalid } from '../../core/common/localized';
import { REASON_CODES, requireReasonCodeOnly } from '../../core/common/reasons';
import type { TenantTxClient } from '../../core/database/tenant-tx.service';
import { PartnersAccess } from '../access';
import { dbNow } from '../db-clock';
import { PartnersService } from '../setup/partners.service';
import { consentedRequests } from './consent-reads';
import {
  PartnerRequestEngine,
  requestNotFound,
  type RequestActor,
} from './request-engine';
import { RESULT, type RequestAction } from './request-rules';
import { windowErrors } from './requests.service';

/** What a partner may do, on its desk or through the relay. */
export type PartnerAction =
  'accept' | 'decline' | 'propose' | 'partner_done' | 'partner_cancel';

export interface PartnerActionInput {
  reasonCode?: string;
  staffCount?: number;
  windowStartsAt?: Date;
  windowEndsAt?: Date;
}

/**
 * The partner's moves on a request (ADR 0060), the same from its desk and
 * from the management's relay. Under, in order, the requester's account
 * (FOR SHARE), the partner's row (FOR SHARE) and the request's row (FOR
 * UPDATE). An action whose result the request already has changes nothing
 * and answers it again: a page pressed twice, or a phone call relayed
 * after the desk answered. A request whose requester withdrew the
 * category's consent takes none.
 */
@Injectable()
export class PartnerActions {
  constructor(
    private readonly access: PartnersAccess,
    private readonly partners: PartnersService,
    private readonly engine: PartnerRequestEngine,
  ) {}

  async act(
    tx: TenantTxClient,
    requestId: string,
    partnerId: string | null,
    action: PartnerAction,
    input: PartnerActionInput,
    actor: RequestActor,
  ): Promise<PartnerRequest> {
    const reasonCode =
      action === 'decline'
        ? requireReasonCodeOnly(
            input.reasonCode,
            REASON_CODES.partnerRequestDecline,
          )
        : action === 'partner_cancel'
          ? requireReasonCodeOnly(
              input.reasonCode,
              REASON_CODES.partnerRequestPartnerCancel,
            )
          : undefined;
    const found = await tx.partnerRequest.findUnique({
      where: { id: requestId },
    });
    // On a desk, another partner's request is not found.
    if (!found || (partnerId !== null && found.partnerId !== partnerId))
      throw requestNotFound();
    await this.access.lockAccount(tx, found.requesterId);
    await this.partners.lock(tx, found.partnerId, 'share');
    const request = await this.engine.lock(tx, requestId);
    if (request.status === RESULT[action as RequestAction]) return request;
    if (!(await consentedRequests(tx, [request])).has(request.id))
      throw appError.conflict(
        ErrorCode.PARTNER_REQUEST_CONSENT_WITHDRAWN,
        'The requester withdrew the category’s consent',
      );
    const now = await dbNow(tx);
    let window: { startsAt: Date; endsAt: Date } | undefined;
    if (action === 'propose') {
      window = { startsAt: input.windowStartsAt!, endsAt: input.windowEndsAt! };
      const errors = windowErrors(window.startsAt, window.endsAt, now, {
        start: 'windowStartsAt',
        end: 'windowEndsAt',
      });
      if (errors.length) throw invalid(errors);
    }
    return this.engine.apply(
      tx,
      request,
      action,
      actor,
      { reasonCode, window, staffCount: input.staffCount },
      now,
    );
  }
}
