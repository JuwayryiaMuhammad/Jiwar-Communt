import { Injectable, type OnModuleInit } from '@nestjs/common';
import type {
  CommunityEvent,
  EventRsvp,
  EventRsvpResponse,
  Prisma,
} from '@prisma/client';
import { CommunityEngagementPort, type Audience } from '../../community';
import { AuditService } from '../../core/audit/audit.service';
import { diffChanges } from '../../core/audit/diff';
import { RequestContext } from '../../core/common/cls/request-context';
import { keysetCursor, type Page } from '../../core/common/cursor';
import { appError, ErrorCode, FieldErrorCode } from '../../core/common/errors';
import { REASON_CODES, requireReasonCodeOnly } from '../../core/common/reasons';
import { newId } from '../../core/common/uuid';
import {
  TenantTx,
  type TenantTxClient,
} from '../../core/database/tenant-tx.service';
import { IdempotencyService } from '../../core/idempotency/idempotency.service';
import { Notifier } from '../../core/notifications/notifier';
import { EngagementAccess } from '../access';
import {
  audienceColumns,
  audienceWhere,
  placesIn,
  sees,
} from '../audience/audience';
import { AudienceCheck } from '../audience/audience-check';
import {
  CommunityAttachments,
  type AttachmentRead,
} from '../content/attachments';
import {
  invalid,
  localized,
  namesText,
  type Localized,
} from '../content/localized';
import { dbNow } from '../db-clock';
import { EngagementSettingsService } from '../settings/engagement-settings.service';
import {
  eventStatus,
  eventStatusWhere,
  fits,
  seatsOf,
  type EventStatus,
} from './event-rules';

/** The CHECKs community_events_lengths and community_events_capacity. */
export const EVENT_TITLE_MAX = 150;
export const EVENT_DESCRIPTION_MAX = 5000;
export const EVENT_PLACE_MAX = 200;
export const EVENT_CAPACITY = { min: 1, max: 100_000 } as const;

export const EVENT_RESOURCE = 'community_event';

const TEXT = [
  { name: 'title', max: EVENT_TITLE_MAX },
  { name: 'description', max: EVENT_DESCRIPTION_MAX },
] as const;

interface EventText {
  titleEn?: string | null;
  descriptionEn?: string | null;
  titleAr?: string | null;
  descriptionAr?: string | null;
  capacity?: number | null;
  attachmentFileIds?: string[];
}

export interface NewEvent extends EventText {
  place: string;
  startsAt: Date;
  endsAt: Date;
  audience?: { buildings?: string[] | null; occupancy: Audience['occupancy'] };
}

export interface EventUpdate extends EventText {
  place?: string;
  startsAt?: Date;
  endsAt?: Date;
}

export interface RsvpInput {
  response: EventRsvpResponse;
  guests?: number;
  unitId?: string;
}

/** How an event is filling up. Counts only: never who. */
export interface EventCounts {
  /** Accounts that said they are going. */
  going: number;
  notGoing: number;
  /** Seats taken: those going and their guests. */
  seats: number;
  /** Seats left; null when the event has no limit. */
  remaining: number | null;
}

export interface EventRead {
  event: CommunityEvent;
  status: EventStatus;
  counts: EventCounts;
  /** Null in a list. */
  attachments: AttachmentRead[] | null;
  /** The reader's own answer; null for the staff or when they gave none. */
  mine: EventRsvp | null;
}

/** An answer as the staff's attendee list shows it. */
export interface AttendeeRead {
  rsvp: EventRsvp;
  fullName: string | null;
  unitCode: string | null;
}

const byStart = keysetCursor('startsAt', 'asc');
const byStartDesc = keysetCursor('startsAt');
const byAnswer = keysetCursor('createdAt', 'asc');

export const eventNotFound = () =>
  appError.notFound(ErrorCode.COMMUNITY_EVENT_NOT_FOUND, 'Event not found');

const wrongState = (status: EventStatus) =>
  appError.conflict(
    ErrorCode.COMMUNITY_EVENT_INVALID_STATE,
    'The event does not take this action now',
    { params: { status } },
  );

/**
 * What the audit trail records of an event: its dates, capacity and
 * audience by value; its words and its place as "changed" only.
 */
function audited(e: CommunityEvent) {
  return {
    startsAt: e.startsAt,
    endsAt: e.endsAt,
    capacity: e.capacity,
    audienceOccupancy: e.audienceOccupancy,
    audienceBuildings: e.audienceBuildings,
    attachments: e.attachmentIds.length,
    titleEn: e.titleEn,
    descriptionEn: e.descriptionEn,
    titleAr: e.titleAr,
    descriptionAr: e.descriptionAr,
    place: e.place,
  };
}

const textOf = (e: CommunityEvent): Localized => ({
  titleEn: e.titleEn,
  descriptionEn: e.descriptionEn,
  titleAr: e.titleAr,
  descriptionAr: e.descriptionAr,
});

/**
 * Events (ADR 0040). The staff write, change and cancel them
 * (`community.publish`) and see who is coming; residents in the audience
 * see the event and how full it is, and say whether they are going, with
 * guests up to the compound's limit.
 *
 * Capacity counts every seat, guests included, and is decided under the
 * event's row lock: of two answers racing for the last seat, one gets it
 * and the other is told the event is full. A cancellation takes the same
 * lock, so nobody joins an event that is being cancelled.
 */
@Injectable()
export class EventsService implements OnModuleInit {
  constructor(
    private readonly tenantTx: TenantTx,
    private readonly ctx: RequestContext,
    private readonly access: EngagementAccess,
    private readonly community: CommunityEngagementPort,
    private readonly audiences: AudienceCheck,
    private readonly attachments: CommunityAttachments,
    private readonly settings: EngagementSettingsService,
    private readonly audit: AuditService,
    private readonly notifier: Notifier,
    private readonly idempotency: IdempotencyService,
  ) {}

  onModuleInit(): void {
    this.idempotency.renderer(EVENT_RESOURCE, (id) =>
      this.tenantTx.withTenantTx(async (tx) => {
        const e = await tx.communityEvent.findUniqueOrThrow({ where: { id } });
        return { id: e.id, createdAt: e.createdAt };
      }),
    );
  }

  // --------------------------------------------------------------------------
  // Writing (staff)
  // --------------------------------------------------------------------------

  /** An event is out as soon as it is written. */
  create(input: NewEvent): Promise<CommunityEvent> {
    const text = localized(input, TEXT);
    if (input.endsAt <= input.startsAt)
      throw invalid([
        { field: 'endsAt', code: FieldErrorCode.ENDS_BEFORE_START },
      ]);
    const fileIds = this.attachments.ids(
      input.attachmentFileIds,
      'attachmentFileIds',
    );
    const tenantId = this.ctx.tenantId;
    const me = this.ctx.accountId;
    return this.tenantTx.withTenantTx(async (tx) => {
      const id = newId();
      await this.idempotency.claim(tx, { type: EVENT_RESOURCE, id });
      await this.access.lockSelf(tx);
      const audience = await this.audiences.check(tx, input.audience);
      const now = await dbNow(tx);
      const created = await tx.communityEvent.create({
        data: {
          id,
          tenantId,
          titleEn: text.titleEn,
          descriptionEn: text.descriptionEn,
          titleAr: text.titleAr,
          descriptionAr: text.descriptionAr,
          place: input.place.trim(),
          startsAt: input.startsAt,
          endsAt: input.endsAt,
          capacity: input.capacity ?? null,
          ...audienceColumns(audience),
          createdById: me,
          createdAt: now,
        },
      });
      const attachmentIds: string[] = [];
      for (const [i, fileId] of fileIds.entries())
        attachmentIds.push(await this.attach(tx, created, fileId, i, now));
      const event = attachmentIds.length
        ? await tx.communityEvent.update({
            where: { id },
            data: { attachmentIds },
          })
        : created;
      await this.audit.record(tx, {
        action: 'community_event.created',
        targetId: id,
        changes: diffChanges(null, audited(event), 'community_event.created'),
      });
      return event;
    });
  }

  /**
   * Changes an event that has not started. The capacity never goes below
   * the seats already taken: nobody who was told they have a seat loses it.
   */
  update(id: string, input: EventUpdate): Promise<void> {
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.access.lockSelf(tx);
      const before = await this.locked(tx, id);
      const now = await dbNow(tx);
      const status = eventStatus(before, now);
      if (status !== 'upcoming') throw wrongState(status);

      const text = namesText(input, TEXT)
        ? localized(input, TEXT, textOf(before))
        : textOf(before);
      const startsAt = input.startsAt ?? before.startsAt;
      const endsAt = input.endsAt ?? before.endsAt;
      if (endsAt <= startsAt)
        throw invalid([
          { field: 'endsAt', code: FieldErrorCode.ENDS_BEFORE_START },
        ]);
      const capacity =
        input.capacity !== undefined ? input.capacity : before.capacity;
      if (capacity !== null) {
        const taken = (await this.counts(tx, [before])).get(id)!.seats;
        if (capacity < taken)
          throw invalid([
            {
              field: 'capacity',
              code: FieldErrorCode.INVALID_NUMBER,
              params: { min: taken, max: EVENT_CAPACITY.max },
            },
          ]);
      }
      const attachmentIds =
        input.attachmentFileIds === undefined
          ? before.attachmentIds
          : await this.attachmentSet(tx, before, input.attachmentFileIds, now);
      const after = await tx.communityEvent.update({
        where: { id },
        data: {
          titleEn: text.titleEn,
          descriptionEn: text.descriptionEn,
          titleAr: text.titleAr,
          descriptionAr: text.descriptionAr,
          place: input.place?.trim() ?? before.place,
          startsAt,
          endsAt,
          capacity,
          attachmentIds,
        },
      });
      const changes = diffChanges(
        audited(before),
        audited(after),
        'community_event.changed',
      );
      if (Object.keys(changes).length)
        await this.audit.record(tx, {
          action: 'community_event.changed',
          targetId: id,
          changes,
        });
    });
  }

  /**
   * Cancels an event that has not ended, with a reason code. Everyone who
   * said they are going is told; the answers stay as they were.
   */
  cancel(id: string, reasonCode: string | undefined): Promise<void> {
    const reason = requireReasonCodeOnly(
      reasonCode,
      REASON_CODES.communityEventCancel,
    );
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.access.lockSelf(tx);
      const before = await this.locked(tx, id);
      const now = await dbNow(tx);
      const status = eventStatus(before, now);
      if (status !== 'upcoming' && status !== 'ongoing')
        throw wrongState(status);
      await tx.communityEvent.update({
        where: { id },
        data: { cancelledAt: now, cancelReason: reason },
      });
      const going = await tx.eventRsvp.findMany({
        where: { eventId: id, response: 'going' },
        select: { accountId: true },
      });
      const active = await tx.account.findMany({
        where: { id: { in: going.map((g) => g.accountId) }, status: 'active' },
        select: { id: true },
      });
      await this.notifier.notify(
        tx,
        active.map((a) => a.id),
        { kind: 'community_event.cancelled', params: {}, targetId: id },
      );
      await this.audit.record(tx, {
        action: 'community_event.cancelled',
        targetId: id,
        metadata: {
          reasonCode: reason,
          fromStatus: status,
          told: active.length,
        },
      });
    });
  }

  // --------------------------------------------------------------------------
  // Answering (residents)
  // --------------------------------------------------------------------------

  /**
   * The caller's answer to an event that has not started: going, with
   * guests, or not going. One per account, changed in place.
   */
  rsvp(id: string, input: RsvpInput): Promise<void> {
    const me = this.ctx.accountId;
    const guests = input.guests ?? 0;
    if (input.response !== 'going' && guests > 0)
      throw invalid([
        { field: 'guests', code: FieldErrorCode.FIELD_NOT_ALLOWED },
      ]);
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.access.lockSelf(tx);
      // The event's lock: seats are counted and taken one answer at a time.
      await tx.$queryRaw`SELECT id FROM community_events WHERE id = ${id}::uuid FOR UPDATE`;
      const event = await tx.communityEvent.findUnique({ where: { id } });
      const places = await this.community.places(tx, me);
      if (!event || !sees(places, event)) throw eventNotFound();
      const now = await dbNow(tx);
      const status = eventStatus(event, now);
      if (status !== 'upcoming') throw wrongState(status);

      const mine = placesIn(places, event).map((p) => p.unitId);
      const unitId = input.unitId ?? (mine.length === 1 ? mine[0] : undefined);
      if (!unitId)
        throw invalid([
          { field: 'unitId', code: FieldErrorCode.FIELD_REQUIRED },
        ]);
      if (!mine.includes(unitId))
        throw invalid([
          { field: 'unitId', code: FieldErrorCode.INVALID_VALUE },
        ]);
      const { eventMaxGuests } = await this.settings.inTx(tx);
      if (guests > eventMaxGuests)
        throw invalid([
          {
            field: 'guests',
            code: FieldErrorCode.INVALID_NUMBER,
            params: { min: 0, max: eventMaxGuests },
          },
        ]);

      const answers = await tx.eventRsvp.findMany({
        where: { eventId: id, response: 'going' },
        select: { accountId: true, response: true, guests: true },
      });
      const others = answers
        .filter((a) => a.accountId !== me)
        .reduce((sum, a) => sum + seatsOf(a), 0);
      const wanted = seatsOf({ response: input.response, guests });
      if (!fits(event.capacity, others, wanted))
        throw appError.conflict(
          ErrorCode.COMMUNITY_EVENT_FULL,
          'The event has no room for this answer',
          { params: { remaining: Math.max(0, event.capacity! - others) } },
        );

      const before = await tx.eventRsvp.findUnique({
        where: {
          tenantId_eventId_accountId: {
            tenantId: event.tenantId,
            eventId: id,
            accountId: me,
          },
        },
      });
      if (
        before &&
        before.response === input.response &&
        before.guests === guests &&
        before.unitId === unitId
      )
        return;
      if (before)
        await tx.eventRsvp.update({
          where: { id: before.id },
          data: { response: input.response, guests, unitId },
        });
      else
        await tx.eventRsvp.create({
          data: {
            id: newId(),
            tenantId: event.tenantId,
            eventId: id,
            accountId: me,
            unitId,
            response: input.response,
            guests,
            createdAt: now,
          },
        });
      await this.audit.record(tx, {
        action: 'community_event.rsvp_changed',
        targetId: id,
        metadata: {
          response: input.response,
          guests,
          unitId,
          from: before?.response ?? 'none',
        },
      });
    });
  }

  // --------------------------------------------------------------------------
  // Reading
  // --------------------------------------------------------------------------

  /** Every event of the compound, the latest start first. */
  listForStaff(q: {
    status?: EventStatus;
    cursor?: string;
    limit: number;
  }): Promise<Page<EventRead>> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const now = await dbNow(tx);
      const rows = await tx.communityEvent.findMany({
        where: {
          AND: [
            q.status ? eventStatusWhere(q.status, now) : {},
            ...byStartDesc.after(q.cursor),
          ],
        },
        orderBy: byStartDesc.orderBy,
        take: q.limit + 1,
      });
      const page = byStartDesc.toPage(rows, q.limit);
      return { ...page, items: await this.reads(tx, page.items, now, null) };
    });
  }

  getForStaff(id: string): Promise<EventRead> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const event = await tx.communityEvent.findUnique({ where: { id } });
      if (!event) throw eventNotFound();
      return this.detail(tx, event, await dbNow(tx), null);
    });
  }

  /**
   * Who answered, in the order they did, by name, unit and guests: the
   * staff's list. Residents never get it.
   */
  attendees(
    id: string,
    q: { response?: EventRsvpResponse; cursor?: string; limit: number },
  ): Promise<Page<AttendeeRead>> {
    return this.tenantTx.withTenantTx(async (tx) => {
      const event = await tx.communityEvent.findUnique({
        where: { id },
        select: { id: true },
      });
      if (!event) throw eventNotFound();
      const rows = await tx.eventRsvp.findMany({
        where: {
          AND: [
            { eventId: id, response: q.response ?? 'going' },
            ...byAnswer.after(q.cursor),
          ],
        },
        orderBy: byAnswer.orderBy,
        take: q.limit + 1,
      });
      const page = byAnswer.toPage(rows, q.limit);
      const names = await this.community.names(
        tx,
        page.items.map((r) => r.accountId),
      );
      const codes = await this.community.unitCodes(
        tx,
        page.items.map((r) => r.unitId),
      );
      return {
        ...page,
        items: page.items.map((rsvp) => ({
          rsvp,
          fullName: names.get(rsvp.accountId) ?? null,
          unitCode: codes.get(rsvp.unitId) ?? null,
        })),
      };
    });
  }

  /**
   * The events put to the caller that are not over, the soonest first. A
   * cancelled one stays, marked, until it would have ended.
   */
  list(q: { cursor?: string; limit: number }): Promise<Page<EventRead>> {
    const me = this.ctx.accountId;
    return this.tenantTx.withTenantTx(async (tx) => {
      const now = await dbNow(tx);
      const places = await this.community.places(tx, me);
      const where: Prisma.CommunityEventWhereInput = {
        AND: [
          { endsAt: { gt: now } },
          audienceWhere(places),
          ...byStart.after(q.cursor),
        ],
      };
      const rows = await tx.communityEvent.findMany({
        where,
        orderBy: byStart.orderBy,
        take: q.limit + 1,
      });
      const page = byStart.toPage(rows, q.limit);
      return { ...page, items: await this.reads(tx, page.items, now, me) };
    });
  }

  /** One event put to the caller, past ones included. */
  one(id: string): Promise<EventRead> {
    const me = this.ctx.accountId;
    return this.tenantTx.withTenantTx(async (tx) => {
      const event = await tx.communityEvent.findUnique({ where: { id } });
      const places = await this.community.places(tx, me);
      if (!event || !sees(places, event)) throw eventNotFound();
      return this.detail(tx, event, await dbNow(tx), me);
    });
  }

  /**
   * The daily brief's events (ADR 0040): those put to the caller that fall
   * in `[from, to)`, are not over and not cancelled. Inside the brief's
   * transaction.
   */
  async forBrief(
    tx: TenantTxClient,
    accountId: string,
    now: Date,
    from: Date,
    to: Date,
  ): Promise<EventRead[]> {
    const places = await this.community.places(tx, accountId);
    const rows = await tx.communityEvent.findMany({
      where: {
        AND: [
          { cancelledAt: null, startsAt: { lt: to }, endsAt: { gt: now } },
          { endsAt: { gt: from } },
          audienceWhere(places),
        ],
      },
      orderBy: byStart.orderBy,
      take: 50,
    });
    return this.reads(tx, rows, now, accountId);
  }

  // --------------------------------------------------------------------------
  // Pieces
  // --------------------------------------------------------------------------

  private async locked(
    tx: TenantTxClient,
    id: string,
  ): Promise<CommunityEvent> {
    await tx.$queryRaw`SELECT id FROM community_events WHERE id = ${id}::uuid FOR UPDATE`;
    const event = await tx.communityEvent.findUnique({ where: { id } });
    if (!event) throw eventNotFound();
    return event;
  }

  private async attach(
    tx: TenantTxClient,
    event: Pick<CommunityEvent, 'id' | 'tenantId'>,
    fileId: string,
    index: number,
    now: Date,
  ): Promise<string> {
    const file = await this.attachments.take(
      tx,
      fileId,
      `attachmentFileIds.${index}`,
    );
    const row = await tx.eventAttachment.create({
      data: {
        id: newId(),
        tenantId: event.tenantId,
        eventId: event.id,
        fileId: file.id,
        uploadedById: this.ctx.accountId,
        createdAt: now,
      },
    });
    return row.id;
  }

  private async attachmentSet(
    tx: TenantTxClient,
    event: CommunityEvent,
    ids: readonly string[],
    now: Date,
  ): Promise<string[]> {
    const wanted = this.attachments.ids(ids, 'attachmentFileIds');
    const out: string[] = [];
    for (const [i, id] of wanted.entries())
      out.push(
        event.attachmentIds.includes(id)
          ? id
          : await this.attach(tx, event, id, i, now),
      );
    return out;
  }

  /** How each event is filling up, from its answers. */
  private async counts(
    tx: TenantTxClient,
    events: readonly Pick<CommunityEvent, 'id' | 'capacity'>[],
  ): Promise<Map<string, EventCounts>> {
    const groups = events.length
      ? await tx.eventRsvp.groupBy({
          by: ['eventId', 'response'],
          where: { eventId: { in: events.map((e) => e.id) } },
          _count: { _all: true },
          _sum: { guests: true },
        })
      : [];
    return new Map(
      events.map((e) => {
        const of = (response: EventRsvpResponse) =>
          groups.find((g) => g.eventId === e.id && g.response === response);
        const going = of('going')?._count._all ?? 0;
        const seats = going + (of('going')?._sum.guests ?? 0);
        return [
          e.id,
          {
            going,
            notGoing: of('not_going')?._count._all ?? 0,
            seats,
            remaining:
              e.capacity === null ? null : Math.max(0, e.capacity - seats),
          },
        ];
      }),
    );
  }

  private async reads(
    tx: TenantTxClient,
    rows: readonly CommunityEvent[],
    now: Date,
    reader: string | null,
  ): Promise<EventRead[]> {
    const counts = await this.counts(tx, rows);
    const mine =
      reader && rows.length
        ? await tx.eventRsvp.findMany({
            where: {
              accountId: reader,
              eventId: { in: rows.map((e) => e.id) },
            },
          })
        : [];
    return rows.map((event) => ({
      event,
      status: eventStatus(event, now),
      counts: counts.get(event.id)!,
      attachments: null,
      mine: mine.find((r) => r.eventId === event.id) ?? null,
    }));
  }

  private async detail(
    tx: TenantTxClient,
    event: CommunityEvent,
    now: Date,
    reader: string | null,
  ): Promise<EventRead> {
    const [read] = await this.reads(tx, [event], now, reader);
    const rows = event.attachmentIds.length
      ? await tx.eventAttachment.findMany({
          where: { id: { in: event.attachmentIds } },
          include: { file: { select: { contentType: true } } },
        })
      : [];
    const ordered = event.attachmentIds.flatMap(
      (id) => rows.find((r) => r.id === id) ?? [],
    );
    return { ...read, attachments: await this.attachments.read(tx, ordered) };
  }
}
