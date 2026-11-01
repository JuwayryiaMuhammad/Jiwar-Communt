import { Injectable, type OnModuleInit } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { BoardMatters } from '../../core/board-matters/board-matters';
import {
  CREDITED_SQL,
  DISPUTED_SQL,
  PAID_SQL,
  RESCHEDULED_SQL,
} from './balances';

/**
 * Finance's answer to governance's candidacy rule (ADR 0075): whether any
 * of an owner's units owes past its due date — an invoice with something
 * left to pay after its due day, not under an open dispute, not
 * rescheduled into instalments (its instalments count instead). By the
 * same fragments every balance is read with (balances.ts).
 */
@Injectable()
export class CandidacyDues implements OnModuleInit {
  constructor(private readonly matters: BoardMatters) {}

  onModuleInit(): void {
    this.matters.registerDues(async (tx, unitIds, today) => {
      if (!unitIds.length) return false;
      const rows = await tx.$queryRaw<{ owes: boolean }[]>(Prisma.sql`
        SELECT EXISTS (
          SELECT 1 FROM invoices i
           WHERE i.unit_id = ANY(${[...unitIds]}::uuid[])
             AND i.due_on < ${today}::date
             AND (i.total - ${CREDITED_SQL} - ${PAID_SQL}) > 0
             AND NOT ${DISPUTED_SQL}
             AND NOT ${RESCHEDULED_SQL}
        ) AS owes`);
      return rows[0]?.owes ?? false;
    });
  }
}
