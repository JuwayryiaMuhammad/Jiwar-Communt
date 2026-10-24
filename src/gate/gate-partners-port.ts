import { Injectable } from '@nestjs/common';
import type { TenantTxClient } from '../core/database/tenant-tx.service';
import {
  VisitorPassesService,
  type IssuedPass,
} from './visitors/visitor-passes.service';

/** The pass a partner's staff come in on, as the partners domain asks for it. */
export interface ServicePassInput {
  /** The requester: the pass is in their name, on their unit. */
  hostAccountId: string;
  unitId: string;
  validFrom: Date;
  validUntil: Date;
  /** How many of the partner's staff come: one entry each. */
  partySize: number;
  /** The partner's name: who the guard expects. */
  visitorName: string;
}

export type ServicePassResult =
  { passId: string } | { skipped: 'host_cannot_invite' | 'pass_limit' };

/** What a partner's desk shows of a service pass. */
export type ServicePass = Pick<
  IssuedPass,
  | 'id'
  | 'status'
  | 'validFrom'
  | 'validUntil'
  | 'code'
  | 'link'
  | 'qrPayload'
  | 'partySize'
>;

/**
 * What the gate does for the partners domain (ADR 0060), and nothing else:
 * an accepted request's one-time visitor pass for the partner's staff — the
 * same pass, code, QR and link as any other, read at the same gate (ADR
 * 0028, 0030, 0043): no new gate logic — and its cancellation when the
 * request ends before the visit. Every method takes the partners'
 * transaction.
 */
@Injectable()
export class GatePartnersPort {
  constructor(private readonly passes: VisitorPassesService) {}

  issueServicePass(
    tx: TenantTxClient,
    input: ServicePassInput,
  ): Promise<ServicePassResult> {
    return this.passes.createForService(tx, input.hostAccountId, input.unitId, {
      kind: 'one_time',
      partySize: input.partySize,
      validFrom: input.validFrom,
      validUntil: input.validUntil,
      visitorName: input.visitorName,
    });
  }

  /** The pass stops letting anyone in: the request was cancelled or closed. */
  async cancelServicePass(tx: TenantTxClient, passId: string): Promise<void> {
    await tx.$queryRaw`SELECT id FROM visitor_passes WHERE id = ${passId}::uuid FOR UPDATE`;
    await this.passes.close(tx, passId, 'service_cancelled');
  }

  /** The pass with its secrets while it is active; null for an unknown one. */
  async servicePass(
    tx: TenantTxClient,
    passId: string,
  ): Promise<ServicePass | null> {
    const pass = await this.passes.withLiveSecret(tx, passId);
    if (!pass) return null;
    return {
      id: pass.id,
      status: pass.status,
      validFrom: pass.validFrom,
      validUntil: pass.validUntil,
      code: pass.code,
      link: pass.link,
      qrPayload: pass.qrPayload,
      partySize: pass.partySize,
    };
  }
}
