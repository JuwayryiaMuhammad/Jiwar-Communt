import { Injectable, type OnModuleInit } from '@nestjs/common';
import {
  Prisma,
  type MaintenanceSettings,
  type Ticket,
  type TicketAssignment,
  type TicketDispatchAttempt,
  type TicketAttachmentKind,
  type TicketFeedback,
  type TicketPriority,
  type TicketStatus,
  type TicketStatusHistory,
} from '@prisma/client';
import { CommunityMaintenancePort } from '../../community';
import { AuditService } from '../../core/audit/audit.service';
import { RequestContext } from '../../core/common/cls/request-context';
import { clampLimit, keysetCursor, type Page } from '../../core/common/cursor';
import {
  appError,
  ErrorCode,
  FieldErrorCode,
  type FieldError,
} from '../../core/common/errors';
import { newId } from '../../core/common/uuid';
import {
  TenantTx,
  type TenantTxClient,
} from '../../core/database/tenant-tx.service';
import type { PresignedRead } from '../../core/files/object-storage';
import { FilesService } from '../../core/files/files.service';
import { IdempotencyService } from '../../core/idempotency/idempotency.service';
import { categoryNotFound } from '../categories/categories.service';
import { DispatchEngine } from '../dispatch/dispatch-engine';
import { MaintenanceSettingsService } from '../settings/maintenance-settings.service';
import { ticketNotFound, TicketAccess, type Audience } from './ticket-access';
import { COMMON_AREA_LENGTH, DESCRIPTION_LENGTH } from './ticket-limits';
import { TicketLog } from './ticket-log';
import { TicketNotices } from './ticket-notices';
import { ticketNumber } from './ticket-rules';
import { TicketCreatedView } from './views/ticket.views';

export const TICKET_RESOURCE = 'ticket';

export interface NewTicket {
  unitId?: string;
  commonArea?: string;
  categoryId: string;
  priority?: TicketPriority;
  description: string;
  photoFileIds?: string[];
}

export interface Person {
  id: string;
  fullName: string | null;
  status: string;
}

export interface CategoryRef {
  id: string;
  key: string;
  nameAr: string;
  nameEn: string;
}

export interface PhotoRead {
  id: string;
  kind: TicketAttachmentKind;
  cycle: number;
  read: PresignedRead | null;
  createdAt: Date;
}

/** A ticket with what its views name: the category, the unit, the people. */
export interface TicketRead {
  ticket: Ticket;
  category: CategoryRef;
  unitCode: string | null;
  people: Map<string, Person>;
}

export interface TicketDetail extends TicketRead {
  photos: PhotoRead[];
  settings: Pick<MaintenanceSettings, 'autoCloseHours' | 'reopenDays'>;
  feedback: TicketFeedback[];
}

export interface HistoryRead<T> {
  rows: T[];
  people: Map<string, Person>;
}

export interface ResidentQuery {
  cursor?: string;
  limit?: number;
  status?: TicketStatus;
  unitId?: string;
}

export interface DispatchQuery extends ResidentQuery {
  priority?: TicketPriority;
  unassigned?: boolean;
  technicianId?: string;
  categoryId?: string;
}

const PAGE = keysetCursor('createdAt');
const CATEGORY = {
  select: { id: true, key: true, nameAr: true, nameEn: true },
} as const;

const invalid = (fields: FieldError[]) =>
  appError.badRequest(ErrorCode.VALIDATION_FAILED, 'Invalid ticket', {
    fields,
  });

/**
 * Tickets (ADR 0032): opening one, by the resident or by dispatch on their
 * behalf, and reading them per audience. The actions on a ticket live in
 * the dispatch, work and confirmation services; every one of them locks
 * the ticket and checks ticket-rules first.
 */
@Injectable()
export class TicketsService implements OnModuleInit {
  constructor(
    private readonly tenantTx: TenantTx,
    private readonly ctx: RequestContext,
    private readonly access: TicketAccess,
    private readonly log: TicketLog,
    private readonly notices: TicketNotices,
    private readonly community: CommunityMaintenancePort,
    private readonly files: FilesService,
    private readonly audit: AuditService,
    private readonly idempotency: IdempotencyService,
    private readonly settings: MaintenanceSettingsService,
    private readonly engine: DispatchEngine,
  ) {}

  onModuleInit(): void {
    // A replay whose stored body was lost renders the ticket as created.
    this.idempotency.renderer(TICKET_RESOURCE, async (id) =>
      TicketCreatedView.from(
        await this.tenantTx.withTenantTx((tx) =>
          tx.ticket.findUniqueOrThrow({ where: { id } }),
        ),
      ),
    );
  }

  /**
   * A resident opens a ticket: `tickets` on the unit, or on any unit for a
   * common area. They are both its creator and its reporter.
   */
  async create(input: NewTicket): Promise<Ticket> {
    const me = this.ctx.accountId;
    const ticket = await this.tenantTx.withTenantTx(async (tx) => {
      const id = newId();
      await this.idempotency.claim(tx, { type: TICKET_RESOURCE, id });
      const where = this.location(input);
      if (where.unitId) {
        const place = await this.community.placeIn(tx, me, where.unitId);
        if (!place)
          throw appError.notFound(ErrorCode.UNIT_NOT_FOUND, 'Unit not found');
      }
      if (!(await this.access.mayOpen(tx, where.unitId, me)))
        throw appError.forbidden(
          ErrorCode.TICKETS_NOT_ALLOWED,
          'Tickets are not allowed here',
        );
      const category = await this.category(tx, input.categoryId, where);
      const photos = input.photoFileIds ?? [];
      const settings = await this.settings.inTx(tx);
      if (photos.length > settings.maxReportPhotos)
        throw photoLimit(settings.maxReportPhotos);
      const ticket = await this.insert(tx, id, input, where, category, me);
      for (const [i, fileId] of photos.entries())
        await this.attach(tx, ticket, fileId, 'report', `photoFileIds.${i}`);
      return ticket;
    });
    return this.dispatched(ticket);
  }

  /**
   * Dispatch opens a ticket for a resident who called or came by (ADR
   * 0032). The reporter must be someone who could have opened it: an
   * active resident or family account with `tickets` there. Audited, and
   * the reporter is told.
   */
  async createOnBehalf(
    input: Omit<NewTicket, 'photoFileIds'> & { reporterAccountId: string },
  ): Promise<Ticket> {
    const ticket = await this.tenantTx.withTenantTx(async (tx) => {
      const id = newId();
      await this.idempotency.claim(tx, { type: TICKET_RESOURCE, id });
      const where = this.location(input);
      if (where.unitId && !(await this.community.unit(tx, where.unitId)))
        throw appError.notFound(ErrorCode.UNIT_NOT_FOUND, 'Unit not found');
      const category = await this.category(tx, input.categoryId, where);
      const reporter = await tx.account.findUnique({
        where: { id: input.reporterAccountId },
        select: { id: true, type: true, status: true },
      });
      if (
        !reporter ||
        reporter.status !== 'active' ||
        (reporter.type !== 'resident' && reporter.type !== 'family') ||
        !(await this.access.mayOpen(tx, where.unitId, reporter.id))
      )
        throw invalid([
          {
            field: 'reporterAccountId',
            code: FieldErrorCode.REPORTER_NOT_ELIGIBLE,
          },
        ]);
      const ticket = await this.insert(
        tx,
        id,
        input,
        where,
        category,
        reporter.id,
      );
      await this.audit.record(tx, {
        action: 'ticket.created_on_behalf',
        targetId: ticket.id,
        metadata: {
          categoryKey: category.key,
          priority: ticket.priority,
          location: ticket.unitId ? 'unit' : 'common_area',
        },
      });
      await this.notices.send(
        tx,
        [reporter.id],
        'ticket.opened_on_behalf',
        ticket,
      );
      return ticket;
    });
    return this.dispatched(ticket);
  }

  /**
   * After a creation committed: the dispatch engine tries the new ticket, in
   * a transaction of its own (ADR 0033). Not inside the creating one: that
   * holds the compound's ticket counter row until it commits, and waiting
   * for the dispatch lock while holding it would queue every creation behind
   * every decision. A failure, or a busy lock, costs nothing: the ticket is
   * in the queue and the sweep takes it. The ticket is read again, as the
   * engine may have assigned it.
   */
  private async dispatched(ticket: Ticket): Promise<Ticket> {
    if (!(await this.engine.dispatch([ticket.id], 'created'))) return ticket;
    return this.tenantTx.withTenantTx((tx) =>
      tx.ticket.findUniqueOrThrow({ where: { id: ticket.id } }),
    );
  }

  /** The resident's tickets: created, reported, or of a unit they are primary of. */
  listForResident(q: ResidentQuery): Promise<Page<TicketRead>> {
    const me = this.ctx.accountId;
    return this.tenantTx.withTenantTx(async (tx) => {
      const primaryOf = await this.community.primaryUnits(tx, me);
      return this.page(tx, q, {
        AND: [
          {
            OR: [
              { createdById: me },
              { reporterId: me },
              ...(primaryOf.length ? [{ unitId: { in: primaryOf } }] : []),
            ],
          },
          q.status ? { status: q.status } : {},
          q.unitId ? { unitId: q.unitId } : {},
        ],
      });
    });
  }

  /** The technician's own tickets: those assigned to them now. */
  listForTechnician(q: ResidentQuery): Promise<Page<TicketRead>> {
    return this.tenantTx.withTenantTx((tx) =>
      this.page(tx, q, {
        technicianId: this.ctx.accountId,
        ...(q.status ? { status: q.status } : {}),
      }),
    );
  }

  /** Every ticket of the compound; `unassigned` is the dispatch queue. */
  listForDispatch(q: DispatchQuery): Promise<Page<TicketRead>> {
    return this.tenantTx.withTenantTx((tx) =>
      this.page(tx, q, {
        AND: [
          q.status ? { status: q.status } : {},
          q.priority ? { priority: q.priority } : {},
          q.unassigned ? { technicianId: null } : {},
          q.technicianId ? { technicianId: q.technicianId } : {},
          q.unitId ? { unitId: q.unitId } : {},
          q.categoryId ? { categoryId: q.categoryId } : {},
        ],
      }),
    );
  }

  /** A ticket as `audience` may see it, with its photos (presigned). */
  detail(id: string, audience: Audience): Promise<TicketDetail> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const ticket = await this.access.load(tx, id, audience);
      const [read] = await this.reads(tx, [ticket]);
      const attachments = await tx.ticketAttachment.findMany({
        where: { ticketId: id },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      });
      const settings = await this.settings.inTx(tx);
      const feedback =
        audience === 'dispatch'
          ? await tx.ticketFeedback.findMany({
              where: { ticketId: id },
              orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
            })
          : [];
      const photos: PhotoRead[] = [];
      for (const a of attachments)
        photos.push({
          id: a.id,
          kind: a.kind,
          cycle: a.cycle,
          read: await this.files.readUrl(tx, a.fileId),
          createdAt: a.createdAt,
        });
      await this.addPeople(
        tx,
        read.people,
        feedback.map((f) => f.authorId),
      );
      return { ...read, photos, settings, feedback };
    });
  }

  /** Dispatch: the status history, oldest first (a ticket has a handful). */
  statusHistory(id: string): Promise<HistoryRead<TicketStatusHistory>> {
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.access.load(tx, id, 'dispatch');
      const rows = await tx.ticketStatusHistory.findMany({
        where: { ticketId: id },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      });
      const people = new Map<string, Person>();
      await this.addPeople(
        tx,
        people,
        rows.map((r) => r.actorId),
      );
      return { rows, people };
    });
  }

  /** Dispatch: the assignment trail, oldest first. */
  assignments(id: string): Promise<HistoryRead<TicketAssignment>> {
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.access.load(tx, id, 'dispatch');
      const rows = await tx.ticketAssignment.findMany({
        where: { ticketId: id },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      });
      const people = new Map<string, Person>();
      await this.addPeople(
        tx,
        people,
        rows.flatMap((r) => [r.fromId, r.toId, r.assignedById]),
      );
      return { rows, people };
    });
  }

  /** Dispatch: why the engine did what it did, oldest first (ADR 0033). */
  dispatchAttempts(id: string): Promise<HistoryRead<TicketDispatchAttempt>> {
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.access.load(tx, id, 'dispatch');
      const rows = await tx.ticketDispatchAttempt.findMany({
        where: { ticketId: id },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      });
      const people = new Map<string, Person>();
      await this.addPeople(
        tx,
        people,
        rows.map((r) => r.technicianId),
      );
      return { rows, people };
    });
  }

  /** Who a ticket names, keyed by id (an erased one renders as erased). */
  async addPeople(
    tx: TenantTxClient,
    people: Map<string, Person>,
    ids: readonly (string | null)[],
  ): Promise<void> {
    const missing = [
      ...new Set(ids.filter((i): i is string => !!i && !people.has(i))),
    ];
    if (!missing.length) return;
    const rows = await tx.account.findMany({
      where: { id: { in: missing } },
      select: { id: true, fullName: true, status: true },
    });
    for (const r of rows) people.set(r.id, r);
  }

  /** The category, unit code and people of each ticket, in two reads. */
  async reads(tx: TenantTxClient, tickets: Ticket[]): Promise<TicketRead[]> {
    const categories = await tx.ticketCategory.findMany({
      where: { id: { in: [...new Set(tickets.map((t) => t.categoryId))] } },
      ...CATEGORY,
    });
    const codes = await this.community.unitCodes(
      tx,
      tickets.flatMap((t) => (t.unitId ? [t.unitId] : [])),
    );
    const people = new Map<string, Person>();
    await this.addPeople(
      tx,
      people,
      tickets.flatMap((t) => [t.reporterId, t.createdById, t.technicianId]),
    );
    const byId = new Map(categories.map((c) => [c.id, c]));
    return tickets.map((ticket) => ({
      ticket,
      category: byId.get(ticket.categoryId)!,
      unitCode: ticket.unitId ? (codes.get(ticket.unitId) ?? null) : null,
      people,
    }));
  }

  private async page(
    tx: TenantTxClient,
    q: { cursor?: string; limit?: number },
    where: Prisma.TicketWhereInput,
  ): Promise<Page<TicketRead>> {
    const limit = clampLimit(q.limit);
    const rows = await tx.ticket.findMany({
      where: { AND: [where, ...PAGE.after(q.cursor)] },
      orderBy: PAGE.orderBy,
      take: limit + 1,
    });
    const page = PAGE.toPage(rows, limit);
    return {
      items: await this.reads(tx, page.items),
      nextCursor: page.nextCursor,
    };
  }

  /** A unit or a common area, never both, never neither. */
  private location(input: Pick<NewTicket, 'unitId' | 'commonArea'>): {
    unitId: string | null;
    commonArea: string | null;
  } {
    const area = input.commonArea?.trim();
    if (input.unitId && input.commonArea !== undefined)
      throw invalid([
        { field: 'commonArea', code: FieldErrorCode.FIELD_NOT_ALLOWED },
      ]);
    if (!input.unitId && input.commonArea === undefined)
      throw invalid([{ field: 'unitId', code: FieldErrorCode.FIELD_REQUIRED }]);
    if (input.commonArea !== undefined && !area)
      throw invalid([
        {
          field: 'commonArea',
          code: FieldErrorCode.INVALID_LENGTH,
          params: { ...COMMON_AREA_LENGTH },
        },
      ]);
    return { unitId: input.unitId ?? null, commonArea: area ?? null };
  }

  /** An active category, one that allows a common area when it is one. */
  private async category(
    tx: TenantTxClient,
    id: string,
    where: { commonArea: string | null },
  ): Promise<CategoryRef & { defaultPriority: TicketPriority }> {
    const category = await tx.ticketCategory.findFirst({
      where: { id, active: true },
    });
    if (!category) throw categoryNotFound();
    if (where.commonArea !== null && !category.commonAreaAllowed)
      throw invalid([
        {
          field: 'categoryId',
          code: FieldErrorCode.CATEGORY_NOT_FOR_COMMON_AREA,
        },
      ]);
    return category;
  }

  /**
   * The row, its number (the compound's counter, locked by its upsert until
   * this transaction ends: a rollback gives the number back) and its first
   * history row. An emergency tells every dispatcher at once, critically.
   */
  private async insert(
    tx: TenantTxClient,
    id: string,
    input: Pick<NewTicket, 'priority' | 'description'>,
    where: { unitId: string | null; commonArea: string | null },
    category: CategoryRef & { defaultPriority: TicketPriority },
    reporterId: string,
  ): Promise<Ticket> {
    const description = input.description.trim();
    if (!description)
      throw invalid([
        {
          field: 'description',
          code: FieldErrorCode.INVALID_LENGTH,
          params: { ...DESCRIPTION_LENGTH },
        },
      ]);
    const tenantId = this.ctx.tenantId;
    const [{ number }] = await tx.$queryRaw<{ number: number }[]>`
      INSERT INTO ticket_counters (tenant_id, last_number)
      VALUES (${tenantId}::uuid, 1)
      ON CONFLICT (tenant_id)
        DO UPDATE SET last_number = ticket_counters.last_number + 1
      RETURNING last_number AS number`;
    const ticket = await tx.ticket.create({
      data: {
        id,
        tenantId,
        number,
        unitId: where.unitId,
        commonArea: where.commonArea,
        categoryId: category.id,
        createdById: this.ctx.accountId,
        reporterId,
        priority: input.priority ?? category.defaultPriority,
        description,
      },
    });
    await this.log.status(tx, ticket, {
      from: null,
      to: 'new',
      actorId: this.ctx.accountId,
      cycle: 1,
    });
    if (ticket.priority === 'emergency')
      await this.notices.send(
        tx,
        await this.notices.dispatchers(tx),
        'ticket.emergency',
        ticket,
        { categoryKey: category.key },
        this.ctx.accountId,
      );
    return ticket;
  }

  /**
   * Moves one of the caller's finalized ticket photos to the ticket: it no
   * longer has an owner, so the uploader's erasure leaves it (ADR 0029).
   * Anything else is FILE_NOT_AVAILABLE on `field`.
   */
  async attach(
    tx: TenantTxClient,
    ticket: Pick<Ticket, 'id' | 'tenantId' | 'cycle'>,
    fileId: string,
    kind: TicketAttachmentKind,
    field: string,
  ) {
    const file = await this.files.claim(tx, fileId, 'ticket_photo');
    if (!file)
      throw invalid([{ field, code: FieldErrorCode.FILE_NOT_AVAILABLE }]);
    await this.files.attach(tx, file);
    return tx.ticketAttachment.create({
      data: {
        id: newId(),
        tenantId: ticket.tenantId,
        ticketId: ticket.id,
        fileId: file.id,
        kind,
        uploadedById: this.ctx.accountId,
        cycle: ticket.cycle,
      },
    });
  }
}

export const photoLimit = (max: number) =>
  appError.conflict(
    ErrorCode.TICKET_PHOTO_LIMIT_REACHED,
    'No more photos of this kind',
    { params: { max } },
  );

export { ticketNotFound, ticketNumber };
