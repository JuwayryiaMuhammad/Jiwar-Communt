import { Injectable, type OnModuleInit } from '@nestjs/common';
import {
  Prisma,
  type ManagementAppointment,
  type ManagementRequest,
  type ManagementRequestEscalation,
  type ManagementRequestStatus,
  type ManagementRequestTopic,
  type ManagementRequestType,
} from '@prisma/client';
import { CommunityManagementPort, type RequestAuthor } from '../../community';
import { StaffRecipients } from '../../core/access/staff-recipients';
import { AuditService } from '../../core/audit/audit.service';
import { RequestContext } from '../../core/common/cls/request-context';
import { clampLimit, keysetCursor, type Page } from '../../core/common/cursor';
import {
  appError,
  AppException,
  ErrorCode,
  FieldErrorCode,
  type FieldError,
} from '../../core/common/errors';
import { REASON_CODES, requireReasonCodeOnly } from '../../core/common/reasons';
import { newId } from '../../core/common/uuid';
import type { TenantTxClient } from '../../core/database/tenant-tx.service';
import { TenantTx } from '../../core/database/tenant-tx.service';
import { IdempotencyService } from '../../core/idempotency/idempotency.service';
import {
  AppointmentsService,
  type AppointmentsQuery,
  type SlotChoice,
} from '../appointments/appointments.service';
import { dbNow } from '../db-clock';
import { MessagesService } from './messages.service';
import { RequestEscalation } from './escalation.service';
import { RequestAccess } from './request-access';
import { RequestProgress } from './request-progress';
import { assertCan, responseDueAt } from './request-rules';
import { RequestCreatedView } from './views/request.views';

export const REQUEST_RESOURCE = 'management_request';

export interface NewRequest {
  type: ManagementRequestType;
  topicId: string;
  /** One of the author's units, when the request is about one. */
  unitId?: string;
  /** What the request says: its first message. */
  body: string;
  /** The caller's own finalized files, attached to that message. */
  attachmentFileIds?: string[];
  /** The slot of an appointment request: required for one, refused otherwise. */
  appointment?: SlotChoice;
}

export interface NewRequestOnBehalf extends NewRequest {
  authorAccountId: string;
  reasonCode: string;
}

/** Someone a view names: never more than an id, a name and a status. */
export interface Person {
  id: string;
  fullName: string | null;
  status: string;
}

export type TopicRef = Pick<
  ManagementRequestTopic,
  'id' | 'key' | 'nameAr' | 'nameEn'
>;

/** A request with what its views name: the topic, the unit, the people. */
export interface RequestRead {
  request: ManagementRequest;
  topic: TopicRef;
  unitCode: string | null;
  people: Map<string, Person>;
  /** The database's clock at the read: what "overdue" is measured by. */
  now: Date;
}

/** One request with its appointment: the live one, else the last. */
export interface DetailRead extends RequestRead {
  appointment: ManagementAppointment | null;
}

/** One request as staff read it: with the history of its escalations. */
export interface StaffDetailRead extends DetailRead {
  escalations: ManagementRequestEscalation[];
}

/** A row of the staff's agenda: an appointment and its request. */
export interface AppointmentRead {
  appointment: ManagementAppointment;
  request: RequestRead;
}

/** A row of the staff inbox: the request and the start of what it says. */
export interface InboxRead extends RequestRead {
  /** The first 120 characters of the first message; null once erased. */
  preview: string | null;
}

export interface ResidentRequestsQuery {
  status?: ManagementRequestStatus;
  type?: ManagementRequestType;
  cursor?: string;
  limit?: number;
}

export interface StaffRequestsQuery extends ResidentRequestsQuery {
  topicId?: string;
  /** An account's id, `me`, or `none` for the unassigned queue. */
  assignee?: string;
  overdue?: boolean;
  escalated?: boolean;
}

export const PREVIEW_LENGTH = 120;

const PAGE = keysetCursor('lastActivityAt');
const TOPIC = {
  select: { id: true, key: true, nameAr: true, nameEn: true },
} as const;

/** A field error of a nested object, named from the body's root. */
function nested(error: unknown, prefix: string): unknown {
  if (!(error instanceof AppException) || error.code !== 'VALIDATION_FAILED')
    return error;
  const body = error.getResponse() as { fields?: FieldError[] };
  return invalid(
    (body.fields ?? []).map((f) => ({ ...f, field: `${prefix}.${f.field}` })),
  );
}

const invalid = (fields: FieldError[]) =>
  appError.badRequest(ErrorCode.VALIDATION_FAILED, 'Invalid request', {
    fields,
  });

/**
 * Management requests (ADR 0039): opening one, by its author or by staff on
 * the author's behalf, reading them per audience, and assigning them. What
 * happens on a request afterwards lives in the messages, lifecycle and
 * appointment services; every one of them locks the request and asks
 * request-rules first.
 */
@Injectable()
export class RequestsService implements OnModuleInit {
  constructor(
    private readonly tenantTx: TenantTx,
    private readonly ctx: RequestContext,
    private readonly access: RequestAccess,
    private readonly messages: MessagesService,
    private readonly progress: RequestProgress,
    private readonly community: CommunityManagementPort,
    private readonly staff: StaffRecipients,
    private readonly audit: AuditService,
    private readonly idempotency: IdempotencyService,
    private readonly escalation: RequestEscalation,
    private readonly appointments: AppointmentsService,
  ) {}

  onModuleInit(): void {
    // A replay whose stored body was lost renders the request as created.
    this.idempotency.renderer(REQUEST_RESOURCE, async (id) =>
      RequestCreatedView.from(
        await this.tenantTx.withTenantTx((tx) =>
          tx.managementRequest.findUniqueOrThrow({ where: { id } }),
        ),
      ),
    );
  }

  /**
   * The author opens a request: any active resident or family account of
   * the compound, with or without a unit. A unit, when named, is one of
   * the author's.
   */
  create(input: NewRequest): Promise<ManagementRequest> {
    const me = this.ctx.accountId;
    this.assertSlot(input);
    return this.tenantTx.withTenantTx(async (tx) => {
      const id = newId();
      await this.idempotency.claim(tx, { type: REQUEST_RESOURCE, id });
      await this.access.lockSelf(tx);
      if (input.unitId && !(await this.community.hasUnit(tx, me, input.unitId)))
        throw appError.notFound(ErrorCode.UNIT_NOT_FOUND, 'Unit not found');
      const topic = await this.topic(tx, input.topicId);
      const request = await this.insert(tx, id, input, topic, {
        authorId: me,
        side: 'resident',
      });
      await this.audit.record(tx, {
        action: 'management_request.created',
        targetId: request.id,
        metadata: this.facts(request, topic),
      });
      return request;
    });
  }

  /**
   * Staff open a request for a resident who called, came in or wrote
   * (`requests.handle`, and `residents.read` because it names one). The
   * author is the resident, who sees it and is told; who opened it and why
   * are stored and audited. The reason is a code from a closed list.
   */
  createOnBehalf(input: NewRequestOnBehalf): Promise<ManagementRequest> {
    const me = this.ctx.accountId;
    const reasonCode = requireReasonCodeOnly(
      input.reasonCode,
      REASON_CODES.managementRequestOnBehalf,
    );
    this.assertSlot(input);
    return this.tenantTx.withTenantTx(async (tx) => {
      const id = newId();
      await this.idempotency.claim(tx, { type: REQUEST_RESOURCE, id });
      await this.access.lockSelf(tx);
      // The author's row too: an erasure of theirs waits for this commit.
      const active = await this.access.lockActive(tx, input.authorAccountId);
      const author = active
        ? await this.community.author(tx, input.authorAccountId)
        : null;
      if (!author)
        throw invalid([
          {
            field: 'authorAccountId',
            code: FieldErrorCode.AUTHOR_NOT_ELIGIBLE,
          },
        ]);
      if (
        input.unitId &&
        !(await this.community.hasUnit(tx, author.id, input.unitId))
      )
        throw appError.notFound(ErrorCode.UNIT_NOT_FOUND, 'Unit not found');
      const topic = await this.topic(tx, input.topicId);
      const request = await this.insert(tx, id, input, topic, {
        authorId: author.id,
        side: 'staff',
        openedById: me,
        onBehalfReason: reasonCode,
      });
      await this.audit.record(tx, {
        action: 'management_request.created_on_behalf',
        targetId: request.id,
        metadata: {
          ...this.facts(request, topic),
          reasonCode,
          authorId: author.id,
        },
      });
      return request;
    });
  }

  /** An appointment request names its slot; no other request has one. */
  private assertSlot(input: NewRequest): void {
    if ((input.type === 'appointment') === (input.appointment !== undefined))
      return;
    throw invalid([
      {
        field: 'appointment',
        code:
          input.type === 'appointment'
            ? FieldErrorCode.FIELD_REQUIRED
            : FieldErrorCode.FIELD_NOT_ALLOWED,
      },
    ]);
  }

  /** What the audit trail says of a new request: codes, never its words. */
  private facts(request: ManagementRequest, topic: TopicRef) {
    return {
      requestNumber: request.number,
      type: request.type,
      topicKey: topic.key,
      withUnit: request.unitId !== null,
    };
  }

  /** An active topic of the compound, or a field error on `topicId`. */
  private async topic(
    tx: TenantTxClient,
    topicId: string,
  ): Promise<ManagementRequestTopic> {
    const topic = await tx.managementRequestTopic.findFirst({
      where: { id: topicId, active: true },
    });
    if (!topic)
      throw invalid([
        { field: 'topicId', code: FieldErrorCode.TOPIC_NOT_AVAILABLE },
      ]);
    return topic;
  }

  /**
   * The row and its first message. The number comes from the compound's
   * counter under its row lock: creations are serialized until the commit,
   * and a rollback returns the number (as tickets do, ADR 0032). The cycle
   * starts now, by the database's clock, and is due after the topic's
   * target.
   */
  private async insert(
    tx: TenantTxClient,
    id: string,
    input: NewRequest,
    topic: ManagementRequestTopic,
    by: {
      authorId: string;
      side: 'resident' | 'staff';
      openedById?: string;
      onBehalfReason?: string;
    },
  ): Promise<ManagementRequest> {
    const body = this.messages.body(input.body);
    const fileIds = this.messages.fileIds(input.attachmentFileIds);
    const tenantId = this.ctx.tenantId;
    const [{ number }] = await tx.$queryRaw<{ number: number }[]>`
      INSERT INTO management_request_counters (tenant_id, last_number)
      VALUES (${tenantId}::uuid, 1)
      ON CONFLICT (tenant_id)
        DO UPDATE SET last_number = management_request_counters.last_number + 1
      RETURNING last_number AS number`;
    const now = await dbNow(tx);
    const request = await tx.managementRequest.create({
      data: {
        id,
        tenantId,
        number,
        type: input.type,
        topicId: topic.id,
        authorId: by.authorId,
        openedById: by.openedById,
        onBehalfReason: by.onBehalfReason,
        unitId: input.unitId,
        cycleStartedAt: now,
        responseDueAt: responseDueAt(now, topic.targetResponseHours),
        lastActivityAt: now,
        createdAt: now,
      },
    });
    // Written by whoever typed it: the author, or the staff member who
    // took it down. Not a response: the clock keeps running.
    const message = await this.messages.write(
      tx,
      request,
      { side: by.side, body },
      now,
    );
    await this.messages.attach(tx, message, fileIds, 'attachmentFileIds');
    if (!input.appointment) return request;
    try {
      await this.appointments.bookAtCreation(
        tx,
        request,
        input.appointment,
        by.side,
        now,
      );
    } catch (error) {
      throw nested(error, 'appointment');
    }
    // A slot staff book for the resident is their response to the request.
    return by.side === 'staff'
      ? this.progress.responded(tx, request, 'appointment', now)
      : request;
  }

  // --------------------------------------------------------------------------
  // Reading
  // --------------------------------------------------------------------------

  /**
   * The caller's own requests, the most recently active first. Activity
   * moves a request up, so a request that changes between two pages may be
   * seen twice or not at all: a list to look at, never to count with.
   */
  listMine(q: ResidentRequestsQuery): Promise<Page<RequestRead>> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const where: Prisma.ManagementRequestWhereInput = {
        authorId: this.ctx.accountId,
        ...(q.status ? { status: q.status } : {}),
        ...(q.type ? { type: q.type } : {}),
      };
      const now = await dbNow(tx);
      const page = await this.rows(tx, where, q);
      return { ...page, items: await this.withNames(tx, page.items, now) };
    });
  }

  /** The compound's requests, for the staff inbox. */
  listForStaff(q: StaffRequestsQuery): Promise<Page<InboxRead>> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const now = await dbNow(tx);
      const assignee =
        q.assignee === undefined
          ? {}
          : q.assignee === 'none'
            ? { assigneeId: null }
            : {
                assigneeId:
                  q.assignee === 'me' ? this.ctx.accountId : q.assignee,
              };
      const where: Prisma.ManagementRequestWhereInput = {
        AND: [
          q.status ? { status: q.status } : {},
          q.type ? { type: q.type } : {},
          q.topicId ? { topicId: q.topicId } : {},
          assignee,
          // request-rules.isOverdue, as a query.
          q.overdue
            ? {
                status: { in: ['open', 'in_progress'] },
                firstResponseAt: null,
                responseDueAt: { lte: now },
              }
            : {},
          q.escalated ? { escalatedAt: { not: null } } : {},
        ],
      };
      const page = await this.rows(tx, where, q);
      const reads = await this.withNames(tx, page.items, now);
      const previews = await this.previews(
        tx,
        page.items.map((r) => r.id),
      );
      return {
        ...page,
        items: reads.map((r) => ({
          ...r,
          preview: previews.get(r.request.id) ?? null,
        })),
      };
    });
  }

  /** One of the caller's own requests. */
  detail(id: string): Promise<DetailRead> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const request = await this.access.load(tx, id, 'resident');
      const [read] = await this.withNames(tx, [request], await dbNow(tx));
      return { ...read, appointment: await this.appointments.current(tx, id) };
    });
  }

  /** One request of the compound, with what only staff read of it. */
  detailForStaff(id: string): Promise<StaffDetailRead> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const request = await this.access.load(tx, id, 'staff');
      const [read] = await this.withNames(tx, [request], await dbNow(tx));
      return {
        ...read,
        appointment: await this.appointments.current(tx, id),
        escalations: await this.escalation.list(tx, id),
      };
    });
  }

  /** The compound's appointments with their requests, soonest first. */
  async appointmentsForStaff(
    q: AppointmentsQuery,
  ): Promise<Page<AppointmentRead>> {
    const page = await this.appointments.listForStaff(q);
    return this.tenantTx.withTenantTx(async (tx) => {
      const requests = await tx.managementRequest.findMany({
        where: { id: { in: page.items.map((a) => a.requestId) } },
      });
      const reads = new Map(
        (await this.withNames(tx, requests, await dbNow(tx))).map((r) => [
          r.request.id,
          r,
        ]),
      );
      return {
        ...page,
        items: page.items.map((appointment) => ({
          appointment,
          request: reads.get(appointment.requestId)!,
        })),
      };
    });
  }

  private async rows(
    tx: TenantTxClient,
    where: Prisma.ManagementRequestWhereInput,
    q: { cursor?: string; limit?: number },
  ): Promise<Page<ManagementRequest>> {
    const limit = clampLimit(q.limit);
    const rows = await tx.managementRequest.findMany({
      where: { AND: [where, ...PAGE.after(q.cursor)] },
      orderBy: PAGE.orderBy,
      take: limit + 1,
    });
    return PAGE.toPage(rows, limit);
  }

  /** The topic, unit code and people of each request, in three reads. */
  private async withNames(
    tx: TenantTxClient,
    requests: ManagementRequest[],
    now: Date,
  ): Promise<RequestRead[]> {
    if (!requests.length) return [];
    const topics = new Map(
      (
        await tx.managementRequestTopic.findMany({
          where: { id: { in: [...new Set(requests.map((r) => r.topicId))] } },
          ...TOPIC,
        })
      ).map((t) => [t.id, t]),
    );
    const units = await this.community.unitCodes(
      tx,
      requests.flatMap((r) => (r.unitId ? [r.unitId] : [])),
    );
    const people = await this.people(
      tx,
      requests.flatMap((r) => [r.authorId, r.openedById, r.assigneeId]),
    );
    return requests.map((request) => ({
      request,
      topic: topics.get(request.topicId)!,
      unitCode: request.unitId ? (units.get(request.unitId) ?? null) : null,
      people,
      now,
    }));
  }

  /** Accounts by id: a name and a status, nothing else. */
  async people(
    tx: TenantTxClient,
    ids: readonly (string | null | undefined)[],
  ): Promise<Map<string, Person>> {
    const wanted = [...new Set(ids.filter((i): i is string => !!i))];
    if (!wanted.length) return new Map();
    const rows = await tx.account.findMany({
      where: { id: { in: wanted } },
      select: { id: true, fullName: true, status: true },
    });
    return new Map(rows.map((r) => [r.id, r]));
  }

  /**
   * The start of each request's first message, for the staff inbox alone:
   * no resident route, no audit row and no notification carries it. Null
   * once the message was erased.
   */
  private async previews(
    tx: TenantTxClient,
    ids: string[],
  ): Promise<Map<string, string | null>> {
    if (!ids.length) return new Map();
    const rows = await tx.$queryRaw<{ id: string; preview: string | null }[]>`
      SELECT DISTINCT ON (m.request_id)
             m.request_id AS id, left(m.body, ${PREVIEW_LENGTH}) AS preview
        FROM management_request_messages m
       WHERE m.request_id IN (${Prisma.join(ids.map((i) => Prisma.sql`${i}::uuid`))})
       ORDER BY m.request_id, m.created_at, m.id`;
    return new Map(rows.map((r) => [r.id, r.preview]));
  }

  // --------------------------------------------------------------------------
  // Staff: whom a request may be opened for, and who may be given one
  // --------------------------------------------------------------------------

  /** The unit's people a request may be opened for (`residents.read`). */
  authorsOf(unitId: string): Promise<RequestAuthor[]> {
    return this.tenantTx.withTenantTx(async (tx) => {
      if (!(await this.community.unit(tx, unitId)))
        throw appError.notFound(ErrorCode.UNIT_NOT_FOUND, 'Unit not found');
      return this.community.authorsOf(tx, unitId);
    });
  }

  /** The active accounts that hold `requests.handle` now, by name. */
  assignees(): Promise<Person[]> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const holders = await this.staff.holding(tx, 'requests.handle');
      const people = await this.people(
        tx,
        holders.map((h) => h.id),
      );
      return [...people.values()].sort(
        (a, b) =>
          (a.fullName ?? '').localeCompare(b.fullName ?? '') ||
          a.id.localeCompare(b.id),
      );
    });
  }

  /**
   * Gives the request to one handler, or back to the unassigned queue
   * (null). The assignee is an active account holding `requests.handle`
   * now, checked under its row lock. Audited both ways; the same assignee
   * again changes nothing and records nothing.
   */
  assign(id: string, assigneeId: string | null): Promise<void> {
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.access.lockSelf(tx);
      if (assigneeId && assigneeId !== this.ctx.accountId) {
        if (!(await this.access.lockActive(tx, assigneeId)))
          throw this.notEligible();
      }
      const request = await this.access.load(tx, id, 'staff', { lock: true });
      assertCan(request, 'assign');
      if (assigneeId) {
        const holders = await this.staff.holding(tx, 'requests.handle');
        if (!holders.some((h) => h.id === assigneeId)) throw this.notEligible();
      }
      if (request.assigneeId === assigneeId) return;
      await tx.managementRequest.update({
        where: { id },
        data: { assigneeId },
      });
      await this.audit.record(tx, {
        action: assigneeId
          ? 'management_request.assigned'
          : 'management_request.unassigned',
        targetId: id,
        changes: {
          assigneeId: { from: request.assigneeId, to: assigneeId },
        },
        metadata: { requestNumber: request.number },
      });
    });
  }

  private notEligible() {
    return invalid([
      { field: 'assigneeId', code: FieldErrorCode.ASSIGNEE_NOT_ELIGIBLE },
    ]);
  }
}
