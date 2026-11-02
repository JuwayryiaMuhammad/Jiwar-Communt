import { Injectable } from '@nestjs/common';
import { Prisma, type MaintenanceCase, type Ticket } from '@prisma/client';
import { AuditService } from '../../core/audit/audit.service';
import { RequestContext } from '../../core/common/cls/request-context';
import { clampLimit, keysetCursor, type Page } from '../../core/common/cursor';
import { appError, ErrorCode } from '../../core/common/errors';
import { REASON_CODES, requireReasonCodeOnly } from '../../core/common/reasons';
import {
  TenantTx,
  type TenantTxClient,
} from '../../core/database/tenant-tx.service';
import { dbNow } from '../db-clock';
import { SensitiveTickets } from '../tickets/sensitive-tickets';
import { TicketAccess } from '../tickets/ticket-access';
import { TicketNotices } from '../tickets/ticket-notices';
import { residentReporter } from '../tickets/ticket-visibility';

export const CASE_STATUSES = ['open', 'resolved', 'dismissed'] as const;
export type CaseStatus = (typeof CASE_STATUSES)[number];

export interface CaseRead {
  row: MaintenanceCase;
  categoryKey: string;
  /** The building's name while it exists (ADR 0072). */
  buildingName: string | null;
  /** Its tickets the reader may see. */
  ticketCount: number;
  workOrder: { id: string; number: number; status: string } | null;
}

export interface CaseTicket {
  id: string;
  number: number;
  status: string;
  unitCode: string | null;
  createdAt: Date;
  linkedAt: Date;
}

export interface CaseDetail extends CaseRead {
  tickets: CaseTicket[];
}

const PAGE = keysetCursor('openedAt', 'desc');

export const caseNotFound = () =>
  appError.notFound(ErrorCode.MAINTENANCE_CASE_NOT_FOUND, 'Case not found');

export const caseClosed = (status: string) =>
  appError.conflict(ErrorCode.MAINTENANCE_CASE_CLOSED, 'This case is closed', {
    params: { status },
  });

/**
 * Community cases (ADR 0081), for the dispatch (`tickets.dispatch`). A case
 * opens itself when a ticket lands (`TicketLanding`); here it is read, given
 * its one work order (`WorkOrdersService`, `caseId`), and closed once under
 * its row lock, the caller's account shared-locked first: resolved (each
 * resident reporter of its tickets told) or dismissed, with a reason code.
 * Its tickets keep their own course: a case closes none of them. A sensitive
 * ticket of a case shows, and counts, only for `tickets.sensitive`.
 */
@Injectable()
export class CasesService {
  constructor(
    private readonly tenantTx: TenantTx,
    private readonly ctx: RequestContext,
    private readonly access: TicketAccess,
    private readonly sensitive: SensitiveTickets,
    private readonly notices: TicketNotices,
    private readonly audit: AuditService,
  ) {}

  async list(q: {
    status?: CaseStatus;
    buildingId?: string;
    cursor?: string;
    limit?: number;
  }): Promise<Page<CaseRead>> {
    const limit = clampLimit(q.limit);
    const hide = await this.sensitive.sql('t');
    return this.tenantTx.withTenantTx(async (tx) => {
      const rows = await tx.maintenanceCase.findMany({
        where: {
          AND: [
            q.status ? { status: q.status } : {},
            q.buildingId ? { buildingId: q.buildingId } : {},
            ...PAGE.after(q.cursor),
          ],
        },
        orderBy: PAGE.orderBy,
        take: limit + 1,
      });
      const page = PAGE.toPage(rows, limit);
      return {
        items: await this.reads(tx, page.items, hide),
        nextCursor: page.nextCursor,
      };
    });
  }

  async get(id: string): Promise<CaseDetail> {
    const hide = await this.sensitive.sql('t');
    return this.tenantTx.withTenantTx(async (tx) => {
      const row = await tx.maintenanceCase.findUnique({ where: { id } });
      if (!row) throw caseNotFound();
      const [read] = await this.reads(tx, [row], hide);
      const tickets = await tx.$queryRaw<
        (CaseTicket & { sensitive: boolean })[]
      >`
        SELECT t.id, t.number, t.status::text AS status, u.code AS "unitCode",
               t.created_at AS "createdAt", l.linked_at AS "linkedAt", t.sensitive
          FROM maintenance_case_tickets l
          JOIN tickets t ON t.id = l.ticket_id
          LEFT JOIN units u ON u.id = t.unit_id
         WHERE l.case_id = ${id}::uuid
           ${hide.length ? Prisma.sql`AND ${Prisma.join(hide, ' AND ')}` : Prisma.empty}
         ORDER BY l.linked_at, t.created_at, t.id`;
      await this.sensitive.logReads(tx, tickets, 'list');
      return {
        ...read,
        tickets: tickets.map((t) => ({
          id: t.id,
          number: t.number,
          status: t.status,
          unitCode: t.unitCode,
          createdAt: t.createdAt,
          linkedAt: t.linkedAt,
        })),
      };
    });
  }

  resolve(id: string, reasonCode?: string): Promise<CaseDetail> {
    const code = requireReasonCodeOnly(
      reasonCode,
      REASON_CODES.maintenanceCaseResolve,
    );
    return this.close(id, 'resolved', code);
  }

  dismiss(id: string, reasonCode?: string): Promise<CaseDetail> {
    const code = requireReasonCodeOnly(
      reasonCode,
      REASON_CODES.maintenanceCaseDismiss,
    );
    return this.close(id, 'dismissed', code);
  }

  private async close(
    id: string,
    status: 'resolved' | 'dismissed',
    code: string,
  ): Promise<CaseDetail> {
    await this.tenantTx.withTenantTx(async (tx) => {
      await this.access.lockSelf(tx);
      await lockOpenCase(tx, id);
      await tx.maintenanceCase.update({
        where: { id },
        data: {
          status,
          closedAt: await dbNow(tx),
          closedById: this.ctx.accountId,
          reasonCode: code,
        },
      });
      const tickets = await tx.$queryRaw<
        Pick<Ticket, 'id' | 'number' | 'unitId' | 'origin' | 'reporterId'>[]
      >`
        SELECT t.id, t.number, t.unit_id AS "unitId", t.origin,
               t.reporter_account_id AS "reporterId"
          FROM maintenance_case_tickets l JOIN tickets t ON t.id = l.ticket_id
         WHERE l.case_id = ${id}::uuid
         ORDER BY l.linked_at, t.id`;
      await this.audit.record(tx, {
        action:
          status === 'resolved'
            ? 'maintenance_case.resolved'
            : 'maintenance_case.dismissed',
        targetId: id,
        metadata: { reasonCode: code, ticketCount: tickets.length },
      });
      if (status === 'resolved')
        for (const t of tickets)
          await this.notices.send(
            tx,
            [residentReporter(t)],
            'ticket.case_resolved',
            t,
          );
    });
    return this.get(id);
  }

  private async reads(
    tx: TenantTxClient,
    rows: MaintenanceCase[],
    hide: Prisma.Sql[],
  ): Promise<CaseRead[]> {
    if (!rows.length) return [];
    const ids = rows.map((r) => r.id);
    const counts = new Map(
      (
        await tx.$queryRaw<{ case_id: string; n: bigint }[]>`
          SELECT l.case_id, count(*) AS n
            FROM maintenance_case_tickets l JOIN tickets t ON t.id = l.ticket_id
           WHERE l.case_id IN (${Prisma.join(ids.map((i) => Prisma.sql`${i}::uuid`))})
             ${hide.length ? Prisma.sql`AND ${Prisma.join(hide, ' AND ')}` : Prisma.empty}
           GROUP BY l.case_id`
      ).map((r) => [r.case_id, Number(r.n)]),
    );
    const categories = new Map(
      (
        await tx.ticketCategory.findMany({
          where: { id: { in: [...new Set(rows.map((r) => r.categoryId))] } },
          select: { id: true, key: true },
        })
      ).map((c) => [c.id, c.key]),
    );
    const buildings = new Map(
      (
        await tx.building.findMany({
          where: { id: { in: [...new Set(rows.map((r) => r.buildingId))] } },
          select: { id: true, name: true },
        })
      ).map((b) => [b.id, b.name]),
    );
    const orders = new Map(
      (
        await tx.ticket.findMany({
          where: {
            id: {
              in: rows.flatMap((r) =>
                r.workOrderTicketId ? [r.workOrderTicketId] : [],
              ),
            },
          },
          select: { id: true, number: true, status: true },
        })
      ).map((t) => [t.id, t]),
    );
    return rows.map((row) => ({
      row,
      categoryKey: categories.get(row.categoryId)!,
      buildingName: buildings.get(row.buildingId) ?? null,
      ticketCount: counts.get(row.id) ?? 0,
      workOrder: row.workOrderTicketId
        ? (orders.get(row.workOrderTicketId) ?? null)
        : null,
    }));
  }
}

/**
 * The case under its row lock, open, or the matching refusal. Lock order:
 * the ticket counter (when the caller holds it), then the case.
 */
export async function lockOpenCase(
  tx: TenantTxClient,
  id: string,
): Promise<MaintenanceCase> {
  await tx.$queryRaw`SELECT id FROM maintenance_cases WHERE id = ${id}::uuid FOR UPDATE`;
  const row = await tx.maintenanceCase.findUnique({ where: { id } });
  if (!row) throw caseNotFound();
  if (row.status !== 'open') throw caseClosed(row.status);
  return row;
}
