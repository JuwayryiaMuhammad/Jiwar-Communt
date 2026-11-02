import { Injectable } from '@nestjs/common';
import { Prisma, type MaintenanceSettings, type Ticket } from '@prisma/client';
import { StaffRecipients } from '../../core/access/staff-recipients';
import { AuditService } from '../../core/audit/audit.service';
import { newId } from '../../core/common/uuid';
import type { TenantTxClient } from '../../core/database/tenant-tx.service';
import { Notifier } from '../../core/notifications/notifier';
import { TicketNotices } from '../tickets/ticket-notices';
import { residentReporter } from '../tickets/ticket-visibility';

/**
 * What a new ticket starts (ADR 0081), in the transaction that writes it,
 * after its row and its number: a community case, and a plan suggestion.
 *
 * Both run under the compound's ticket counter row, which `insert` locked
 * and holds until the commit: two tickets landing at the same time are
 * taken one after the other, and the second, reading after the first's
 * commit (READ COMMITTED), sees its ticket, its case and its suggestion.
 * So a case opens once, and a suggestion is made once; the partial unique
 * indexes back it. Lock order: the counter, then a case (a case's own
 * writers lock it alone, or after the counter).
 *
 * - **A case**: a resident's repair in a unit of a building. An open case
 *   of its category there takes it; else, once the building has
 *   `case_min_tickets` such tickets within `case_window_days` (none in a
 *   case, none sensitive, none cancelled), a case opens with all of them.
 *   The dispatch is told it opened; each reporter that their ticket joined.
 * - **A suggestion**: a repair (not a plan's own work order) on an asset of
 *   a common area, else in a unit. From `recurrence_min_tickets` of its
 *   category there within `recurrence_window_days` (none sensitive, none
 *   cancelled) on, unless one is open, or one was decided within the
 *   window: whoever keeps the plans is asked.
 */
@Injectable()
export class TicketLanding {
  constructor(
    private readonly audit: AuditService,
    private readonly notifier: Notifier,
    private readonly staff: StaffRecipients,
    private readonly notices: TicketNotices,
  ) {}

  async landed(
    tx: TenantTxClient,
    ticket: Ticket,
    categoryKey: string,
  ): Promise<void> {
    if (ticket.origin === 'plan' || ticket.kind !== 'repair') return;
    const settings = await tx.maintenanceSettings.findUnique({
      where: { tenantId: ticket.tenantId },
    });
    if (!settings) return;
    if (ticket.origin === 'resident' && ticket.unitId)
      await this.caseOf(tx, ticket, categoryKey, settings);
    await this.suggestion(tx, ticket, categoryKey, settings);
  }

  private async caseOf(
    tx: TenantTxClient,
    ticket: Ticket,
    categoryKey: string,
    settings: MaintenanceSettings,
  ): Promise<void> {
    const [unit] = await tx.$queryRaw<{ building_id: string | null }[]>`
      SELECT building_id FROM units WHERE id = ${ticket.unitId}::uuid`;
    const buildingId = unit?.building_id;
    if (!buildingId) return;
    const [open] = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM maintenance_cases
       WHERE category_id = ${ticket.categoryId}::uuid
         AND building_id = ${buildingId}::uuid AND status = 'open'
         FOR UPDATE`;
    if (open) {
      await this.link(tx, open.id, [ticket.id]);
      await this.notices.send(
        tx,
        [residentReporter(ticket)],
        'ticket.case_linked',
        ticket,
      );
      return;
    }
    const rows = await tx.$queryRaw<
      { id: string; number: number; unit_id: string; reporter: string }[]
    >`
      SELECT t.id, t.number, t.unit_id, t.reporter_account_id AS reporter
        FROM tickets t JOIN units u ON u.id = t.unit_id
       WHERE u.building_id = ${buildingId}::uuid
         AND t.category_id = ${ticket.categoryId}::uuid
         AND t.origin = 'resident' AND t.kind = 'repair'
         AND t.status <> 'cancelled' AND NOT t.sensitive
         AND t.created_at > clock_timestamp() - make_interval(days => ${settings.caseWindowDays})
         AND NOT EXISTS (SELECT 1 FROM maintenance_case_tickets l WHERE l.ticket_id = t.id)
       ORDER BY t.created_at, t.id`;
    if (rows.length < settings.caseMinTickets) return;
    const id = newId();
    await tx.$executeRaw`
      INSERT INTO maintenance_cases (id, tenant_id, category_id, building_id, status, opened_at)
      VALUES (${id}::uuid, ${ticket.tenantId}::uuid, ${ticket.categoryId}::uuid,
              ${buildingId}::uuid, 'open', date_trunc('milliseconds', clock_timestamp()))`;
    await this.link(
      tx,
      id,
      rows.map((r) => r.id),
    );
    await this.audit.record(tx, {
      action: 'maintenance_case.opened',
      targetId: id,
      metadata: {
        categoryKey,
        buildingId,
        ticketCount: rows.length,
        by: 'threshold',
        ticketId: ticket.id,
      },
    });
    const dispatch = (await this.staff.holding(tx, 'tickets.dispatch')).map(
      (r) => r.id,
    );
    await this.notifier.notify(tx, dispatch, {
      kind: 'maintenance_case.opened',
      params: { categoryKey, ticketCount: rows.length },
      targetId: id,
    });
    for (const r of rows)
      await this.notices.send(tx, [r.reporter], 'ticket.case_linked', {
        id: r.id,
        number: r.number,
        unitId: r.unit_id,
      });
  }

  /** The tickets join the case: by themselves (no one links them). */
  private async link(
    tx: TenantTxClient,
    caseId: string,
    ticketIds: readonly string[],
  ): Promise<void> {
    await tx.$executeRaw`
      INSERT INTO maintenance_case_tickets (tenant_id, ticket_id, case_id, linked_at)
      SELECT t.tenant_id, t.id, ${caseId}::uuid, date_trunc('milliseconds', clock_timestamp())
        FROM tickets t
       WHERE t.id IN (${Prisma.join(ticketIds.map((i) => Prisma.sql`${i}::uuid`))})
      ON CONFLICT (tenant_id, ticket_id) DO NOTHING`;
  }

  private async suggestion(
    tx: TenantTxClient,
    ticket: Ticket,
    categoryKey: string,
    settings: MaintenanceSettings,
  ): Promise<void> {
    let assetId: string | null = null;
    let unitId: string | null = ticket.unitId;
    if (ticket.assetId) {
      const asset = await tx.asset.findUnique({
        where: { id: ticket.assetId },
        select: { unitId: true },
      });
      // An asset in a unit takes no plan (ADR 0064): its unit is the place.
      if (asset && asset.unitId === null) assetId = ticket.assetId;
      else unitId = asset?.unitId ?? ticket.unitId;
    }
    const place = assetId ?? unitId;
    if (!place) return;
    const where = assetId
      ? Prisma.sql`t.asset_id = ${assetId}::uuid`
      : Prisma.sql`t.unit_id = ${unitId}::uuid`;
    const [found] = await tx.$queryRaw<
      { n: bigint; first_at: Date | null; last_at: Date | null }[]
    >`
      SELECT count(*) AS n, min(t.created_at) AS first_at, max(t.created_at) AS last_at
        FROM tickets t
       WHERE ${where}
         AND t.category_id = ${ticket.categoryId}::uuid
         AND t.origin <> 'plan' AND t.kind = 'repair'
         AND t.status <> 'cancelled' AND NOT t.sensitive
         AND t.created_at > clock_timestamp() - make_interval(days => ${settings.recurrenceWindowDays})`;
    const count = Number(found?.n ?? 0);
    if (count < settings.recurrenceMinTickets) return;
    const [taken] = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM maintenance_plan_suggestions
       WHERE category_id = ${ticket.categoryId}::uuid
         AND COALESCE(asset_id, unit_id) = ${place}::uuid
         AND (status = 'open'
              OR decided_at > clock_timestamp() - make_interval(days => ${settings.recurrenceWindowDays}))
       LIMIT 1`;
    if (taken) return;
    const id = newId();
    await tx.$executeRaw`
      INSERT INTO maintenance_plan_suggestions
        (id, tenant_id, asset_id, unit_id, category_id, ticket_count, window_days,
         first_ticket_at, last_ticket_at, status, created_at)
      VALUES (${id}::uuid, ${ticket.tenantId}::uuid, ${assetId}::uuid,
              ${assetId ? null : unitId}::uuid, ${ticket.categoryId}::uuid, ${count},
              ${settings.recurrenceWindowDays}, ${found.first_at}, ${found.last_at}, 'open',
              date_trunc('milliseconds', clock_timestamp()))`;
    const keepers = (await this.staff.holding(tx, 'assets.manage')).map(
      (r) => r.id,
    );
    await this.notifier.notify(tx, keepers, {
      kind: 'maintenance.plan_suggested',
      params: { categoryKey, ticketCount: count },
      targetId: id,
    });
  }
}
