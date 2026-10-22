import { Injectable } from '@nestjs/common';
import type { TenantTxClient } from '../core/database/tenant-tx.service';
import { requestNumber } from './requests/request-rules';
import { RequestsService } from './requests/requests.service';

/** The management request a complaint against a partner is. */
export interface OpenedRequest {
  id: string;
  number: string;
}

/**
 * What management does for the partners domain (ADR 0060), and nothing
 * else: a complaint against a partner is a management request on the
 * system topic `partner_service` — its conversation, response target,
 * escalation, close and rating are management's (ADR 0039). Every method
 * takes the partners' transaction.
 */
@Injectable()
export class ManagementPartnersPort {
  constructor(private readonly requests: RequestsService) {}

  /** Opens it as the author, the complaint's words its first message. */
  async openComplaint(
    tx: TenantTxClient,
    input: { authorId: string; unitId: string | null; body: string },
  ): Promise<OpenedRequest> {
    const request = await this.requests.openOnTopic(tx, {
      ...input,
      topicKey: 'partner_service',
    });
    return { id: request.id, number: requestNumber(request.number) };
  }

  /** The request's number, as shown (`MR-000123`), by id. */
  async numbers(
    tx: TenantTxClient,
    ids: readonly string[],
  ): Promise<Map<string, string>> {
    if (!ids.length) return new Map();
    const rows = await tx.managementRequest.findMany({
      where: { id: { in: [...new Set(ids)] } },
      select: { id: true, number: true },
    });
    return new Map(rows.map((r) => [r.id, requestNumber(r.number)]));
  }
}
