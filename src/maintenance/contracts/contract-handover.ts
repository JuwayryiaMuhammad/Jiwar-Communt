import { Injectable, type OnModuleInit } from '@nestjs/common';
import { BoardMatters } from '../../core/board-matters/board-matters';

/** How far ahead a new board is shown the contracts that end (ADR 0075). */
export const HANDOVER_CONTRACT_DAYS = 90;

/**
 * The maintenance contracts' part of a new board's handover pack (ADR
 * 0075): those in force that end within 90 days, by code, kind and end
 * day, soonest first.
 */
@Injectable()
export class ContractHandover implements OnModuleInit {
  constructor(private readonly matters: BoardMatters) {}

  onModuleInit(): void {
    this.matters.registerHandover('contracts', async (tx, today) => {
      const rows = await tx.$queryRaw<
        { code: string; kind: string; ends_on: string }[]
      >`
        SELECT code, kind, ends_on::text AS ends_on FROM maintenance_contracts
         WHERE terminated_at IS NULL
           AND ends_on >= ${today}::date
           AND ends_on < ${today}::date + ${HANDOVER_CONTRACT_DAYS}::int
         ORDER BY ends_on, code`;
      return {
        withinDays: HANDOVER_CONTRACT_DAYS,
        ending: rows.map((r) => ({
          code: r.code,
          kind: r.kind,
          endsOn: r.ends_on,
        })),
      };
    });
  }
}
