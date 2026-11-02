import { Injectable, type OnModuleInit } from '@nestjs/common';
import {
  beforeCursor,
  UnitCorrespondence,
} from '../core/unit-correspondence/unit-correspondence';
import { letterNumber } from './letters/letter-rules';
import { requestNumber } from './requests/request-rules';

/**
 * The management's part of a unit's correspondence (ADR 0080): the
 * requests about the unit — the residents', and the conversations the
 * management started (`to_unit`) — and the official letters issued for its
 * people. Their topic's key or the letter's kind; never a word.
 */
@Injectable()
export class ManagementCorrespondence implements OnModuleInit {
  constructor(private readonly registry: UnitCorrespondence) {}

  onModuleInit(): void {
    this.registry.register({
      type: 'management_request',
      permission: 'requests.handle',
      page: async (tx, unitId, q) => {
        const rows = await tx.managementRequest.findMany({
          where: { AND: [{ unitId }, ...beforeCursor('createdAt', q.before)] },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          take: q.take,
          select: {
            id: true,
            number: true,
            status: true,
            outreach: true,
            createdAt: true,
            topic: { select: { key: true } },
          },
        });
        return rows.map((r) => ({
          type: 'management_request' as const,
          id: r.id,
          number: requestNumber(r.number),
          kind: r.topic.key,
          status: r.status,
          direction: r.outreach ? ('to_unit' as const) : ('from_unit' as const),
          at: r.createdAt,
        }));
      },
    });
    this.registry.register({
      type: 'official_letter',
      permission: 'letters.issue',
      page: async (tx, unitId, q) => {
        const rows = await tx.officialLetter.findMany({
          where: { AND: [{ unitId }, ...beforeCursor('issuedAt', q.before)] },
          orderBy: [{ issuedAt: 'desc' }, { id: 'desc' }],
          take: q.take,
          select: {
            id: true,
            number: true,
            kind: true,
            revokedAt: true,
            issuedAt: true,
          },
        });
        return rows.map((r) => ({
          type: 'official_letter' as const,
          id: r.id,
          number: letterNumber(r.number),
          kind: r.kind,
          status: r.revokedAt ? 'revoked' : 'valid',
          direction: 'to_unit' as const,
          at: r.issuedAt,
        }));
      },
    });
  }
}
