import { Injectable, type OnModuleInit } from '@nestjs/common';
import type {
  CommunityEvent,
  EventRsvp,
  EventRsvpResponse,
  Prisma,
} from '@prisma/client';
import { CommunityEngagementPort, type Audience } from '../../community';
import { AccountLifecycle } from '../../core/accounts/account-lifecycle';
import { ageOn, localToday } from '../../core/common/egyptian-national-id';
import { AuditService } from '../../core/audit/audit.service';
import { diffChanges } from '../../core/audit/diff';
import { RequestContext } from '../../core/common/cls/request-context';
import { keysetCursor, type Page } from '../../core/common/cursor';
import {
  appError,
  ErrorCode,
  FieldErrorCode,
  type FieldError,
} from '../../core/common/errors';
import { REASON_CODES, requireReasonCodeOnly } from '../../core/common/reasons';
import { newId } from '../../core/common/uuid';
import {
  TenantTx,
  type TenantTxClient,
} from '../../core/database/tenant-tx.service';
import { IdempotencyService } from '../../core/idempotency/idempotency.service';
import { TenantSettingsService } from '../../core/tenant-settings/tenant-settings.service';
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
} from '../../core/common/localized';
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
  /** For children of an age range (ADR 0054): fixed once written. */
  forChildren?: boolean;
  childAgeMin?: number;
  childAgeMax?: number;
}

/** The youngest and oldest a child of an event for children may be. */
export const CHILD_AGE = { min: 0, max: 17 } as const;

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
  /** Seats taken: those going, their guests, and the children registered. */
  seats: number;
  /** Children registered (an event for children, ADR 0054). */
  children: number;
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
  /**
   * The children of the reader's units registered for it (ADR 0054), by
   * first name; empty for the staff.
   */
  myChildren: { memberId: string; firstName: string | null }[];
}

/** An answer as the staff's attendee list shows it. */
export interface AttendeeRead {
  rsvp: EventRsvp;
  fullName: string | null;
  unitCode: string | null;
  /** How many of the unit's children are registered: never who (ADR 0054). */
  children: number;
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
    forChildren: e.forChildren,
    childAgeMin: e.childAgeMin,
    childAgeMax: e.childAgeMax,
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
    private readonly lifecycle: AccountLifecycle,
    private readonly tenantSettings: TenantSettingsService,
  ) {}

  onModuleInit(): void {
    this.idempotency.renderer(EVENT_RESOURCE, (id) =>
      this.tenantTx.withTenantTx(async (tx) => {
        const e = await tx.communityEvent.findUniqueOrThrow({ where: { id } });
        return { id: e.id, createdAt: e.createdAt };
      }),
    );
    // Erasure (ADR 0023, 0040): the account's answers go, and the seats
    // they held with them. An answer in flight took a share lock on the
    // account's row first, so none is written after this.
    this.lifecycle.onErasing(async (tx, account) => {
      await tx.eventRsvp.deleteMany({ where: { accountId: account.id } });
      // The children it registered go too (ADR 0054), and their seats.
      await tx.eventChildRegistration.deleteMany({
        where: { registeredById: account.id },
      });
      return [];
    });
    // A child who leaves the household is no longer registered for what
    // has not started (ADR 0054): their seat is free again.
    this.lifecycle.onMinorLeaving(async (tx, minor) => {
      await tx.$executeRaw`
        DELETE FROM event_child_registrations r
         USING community_events e
         WHERE r.member_id = ${minor.memberId}::uuid
           AND e.id = r.event_id AND e.starts_at > clock_timestamp()`;
      return [];
    });
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
    const children = childRange(input);
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
          ...children,
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
      // And whoever registered a child for it (ADR 0054).
      const registrants = await tx.eventChildRegistration.findMany({
        where: { eventId: id },
        select: { registeredById: true },
      });
      const active = await tx.account.findMany({
        where: {
          id: {
            in: [
              ...new Set([
                ...going.map((g) => g.accountId),
                ...registrants.map((r) => r.registeredById),
              ]),
            ],
          },
          status: 'active',
        },
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
      const others =
        answers
          .filter((a) => a.accountId !== me)
          .reduce((sum, a) => sum + seatsOf(a), 0) +
        (await tx.eventChildRegistration.count({ where: { eventId: id } }));
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

  /**
   * Registers one of the unit's minors for an event for children (ADR
   * 0054): the unit's primary or a `household` delegate, before the start,
   * a child of the event's age on its local start day. A registration is a
   * seat, counted with the answers under the event's row lock. Registering
   * again is a no-op.
   */
  registerChild(
    id: string,
    memberId: string,
    input: { unitId?: string },
  ): Promise<void> {
    const me = this.ctx.accountId;
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.access.lockSelf(tx);
      const event = await this.lockedFor(tx, id, me);
      if (!event.forChildren)
        throw appError.conflict(
          ErrorCode.COMMUNITY_EVENT_NOT_FOR_CHILDREN,
          'The event is not for children',
        );
      const now = await dbNow(tx);
      const status = eventStatus(event, now);
      if (status !== 'upcoming') throw wrongState(status);
      const unitId = await this.unitFor(tx, event, me, input.unitId);
      await this.community.requireHousehold(tx, unitId);
      const minor = await this.community.minorOf(tx, unitId, memberId);
      if (!minor)
        throw appError.notFound(ErrorCode.CHILD_NOT_FOUND, 'Child not found');
      const { timezone } = await this.tenantSettings.inTx(tx, event.tenantId);
      const age = ageOn(minor.birthDate, localToday(timezone, event.startsAt));
      if (age < event.childAgeMin! || age > event.childAgeMax!)
        throw appError.conflict(
          ErrorCode.COMMUNITY_EVENT_AGE_MISMATCH,
          'The child is not of the age the event is for',
          { params: { min: event.childAgeMin!, max: event.childAgeMax! } },
        );
      const known = await tx.eventChildRegistration.findFirst({
        where: { eventId: id, memberId },
        select: { id: true },
      });
      if (known) return;
      const taken = (await this.counts(tx, [event])).get(id)!.seats;
      if (!fits(event.capacity, taken, 1))
        throw appError.conflict(
          ErrorCode.COMMUNITY_EVENT_FULL,
          'The event has no room for this child',
          { params: { remaining: Math.max(0, event.capacity! - taken) } },
        );
      await tx.eventChildRegistration.create({
        data: {
          id: newId(),
          tenantId: event.tenantId,
          eventId: id,
          unitId,
          memberId,
          registeredById: me,
          createdAt: now,
        },
      });
      await this.audit.record(tx, {
        action: 'community_event.child_registered',
        targetId: id,
        metadata: { unitId, memberId },
      });
    });
  }

  /** Takes a child's registration back before the start; none is a no-op. */
  unregisterChild(id: string, memberId: string): Promise<void> {
    const me = this.ctx.accountId;
    return this.tenantTx.withTenantTx(async (tx) => {
      await this.access.lockSelf(tx);
      const event = await this.lockedFor(tx, id, me);
      const registration = await tx.eventChildRegistration.findFirst({
        where: { eventId: id, memberId },
      });
      if (!registration) return;
      await this.community.requireHousehold(tx, registration.unitId);
      const status = eventStatus(event, await dbNow(tx));
      if (status !== 'upcoming') throw wrongState(status);
      await tx.eventChildRegistration.delete({
        where: { id: registration.id },
      });
      await this.audit.record(tx, {
        action: 'community_event.child_unregistered',
        targetId: id,
        metadata: { unitId: registration.unitId, memberId },
      });
    });
  }

  /**
   * The account's registrations of children, each with its event, for a
   * personal-data export (ADR 0054). Inside the export's transaction.
   */
  async childRegistrationsOf(
    tx: TenantTxClient,
    accountId: string,
  ): Promise<
    {
      eventId: string;
      event: CommunityEvent | null;
      memberId: string;
      firstName: string | null;
      registeredAt: Date;
    }[]
  > {
    const rows = await tx.eventChildRegistration.findMany({
      where: { registeredById: accountId },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    const events = new Map(
      (
        await tx.communityEvent.findMany({
          where: { id: { in: rows.map((r) => r.eventId) } },
        })
      ).map((e) => [e.id, e]),
    );
    const names = await this.community.memberFirstNames(
      tx,
      rows.map((r) => r.memberId),
    );
    return rows.map((r) => ({
      eventId: r.eventId,
      event: events.get(r.eventId) ?? null,
      memberId: r.memberId,
      firstName: names.get(r.memberId) ?? null,
      registeredAt: r.createdAt,
    }));
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
      const children = await tx.eventChildRegistration.groupBy({
        by: ['unitId'],
        where: { eventId: id, unitId: { in: page.items.map((r) => r.unitId) } },
        _count: { _all: true },
      });
      const childrenOfUnit = new Map(
        children.map((c) => [c.unitId, c._count._all]),
      );
      return {
        ...page,
        items: page.items.map((rsvp) => ({
          rsvp,
          fullName: names.get(rsvp.accountId) ?? null,
          unitCode: codes.get(rsvp.unitId) ?? null,
          children: childrenOfUnit.get(rsvp.unitId) ?? 0,
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

  /**
   * The account's own answers, each with the event it is to, for a
   * personal-data export. Inside the export's transaction.
   */
  async answersOf(
    tx: TenantTxClient,
    accountId: string,
  ): Promise<{ rsvp: EventRsvp; event: CommunityEvent }[]> {
    const rsvps = await tx.eventRsvp.findMany({
      where: { accountId },
      include: { event: true },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    return rsvps.map(({ event, ...rsvp }) => ({ rsvp, event }));
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
    const registered = new Map(
      (events.length
        ? await tx.eventChildRegistration.groupBy({
            by: ['eventId'],
            where: { eventId: { in: events.map((e) => e.id) } },
            _count: { _all: true },
          })
        : []
      ).map((g) => [g.eventId, g._count._all]),
    );
    return new Map(
      events.map((e) => {
        const of = (response: EventRsvpResponse) =>
          groups.find((g) => g.eventId === e.id && g.response === response);
        const going = of('going')?._count._all ?? 0;
        const children = registered.get(e.id) ?? 0;
        const seats = going + (of('going')?._sum.guests ?? 0) + children;
        return [
          e.id,
          {
            going,
            notGoing: of('not_going')?._count._all ?? 0,
            seats,
            children,
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
    const myChildren = await this.childrenOf(tx, rows, reader);
    return rows.map((event) => ({
      event,
      status: eventStatus(event, now),
      counts: counts.get(event.id)!,
      attachments: null,
      mine: mine.find((r) => r.eventId === event.id) ?? null,
      myChildren: myChildren.get(event.id) ?? [],
    }));
  }

  /** The event FOR UPDATE, put to the caller, or 404. */
  private async lockedFor(
    tx: TenantTxClient,
    id: string,
    me: string,
  ): Promise<CommunityEvent> {
    await tx.$queryRaw`SELECT id FROM community_events WHERE id = ${id}::uuid FOR UPDATE`;
    const event = await tx.communityEvent.findUnique({ where: { id } });
    const places = await this.community.places(tx, me);
    if (!event || !sees(places, event)) throw eventNotFound();
    return event;
  }

  /** The caller's unit in the event's audience: given, or the only one. */
  private async unitFor(
    tx: TenantTxClient,
    event: CommunityEvent,
    me: string,
    given: string | undefined,
  ): Promise<string> {
    const places = await this.community.places(tx, me);
    const mine = placesIn(places, event).map((p) => p.unitId);
    const unitId = given ?? (mine.length === 1 ? mine[0] : undefined);
    if (!unitId)
      throw invalid([{ field: 'unitId', code: FieldErrorCode.FIELD_REQUIRED }]);
    if (!mine.includes(unitId))
      throw invalid([{ field: 'unitId', code: FieldErrorCode.INVALID_VALUE }]);
    return unitId;
  }

  /** The reader's units' children registered for each event, by first name. */
  private async childrenOf(
    tx: TenantTxClient,
    rows: readonly CommunityEvent[],
    reader: string | null,
  ): Promise<Map<string, { memberId: string; firstName: string | null }[]>> {
    const out = new Map<
      string,
      { memberId: string; firstName: string | null }[]
    >();
    const forChildren = rows.filter((e) => e.forChildren);
    if (!reader || !forChildren.length) return out;
    const units = [
      ...new Set(
        (await this.community.places(tx, reader)).map((p) => p.unitId),
      ),
    ];
    if (!units.length) return out;
    const registrations = await tx.eventChildRegistration.findMany({
      where: {
        eventId: { in: forChildren.map((e) => e.id) },
        unitId: { in: units },
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    const names = await this.community.memberFirstNames(
      tx,
      registrations.map((r) => r.memberId),
    );
    for (const r of registrations)
      out.set(r.eventId, [
        ...(out.get(r.eventId) ?? []),
        { memberId: r.memberId, firstName: names.get(r.memberId) ?? null },
      ]);
    return out;
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

/**
 * An event for children takes an age range, 0 to 17 and in order; any other
 * event takes none (community_events_children). Fixed once written.
 */
function childRange(input: NewEvent): {
  forChildren: boolean;
  childAgeMin: number | null;
  childAgeMax: number | null;
} {
  const fields: FieldError[] = [];
  if (!input.forChildren) {
    for (const field of ['childAgeMin', 'childAgeMax'] as const)
      if (input[field] !== undefined)
        fields.push({ field, code: FieldErrorCode.FIELD_NOT_ALLOWED });
    if (fields.length) throw invalid(fields);
    return { forChildren: false, childAgeMin: null, childAgeMax: null };
  }
  for (const field of ['childAgeMin', 'childAgeMax'] as const) {
    const v = input[field];
    if (v === undefined)
      fields.push({ field, code: FieldErrorCode.FIELD_REQUIRED });
    else if (!Number.isInteger(v) || v < CHILD_AGE.min || v > CHILD_AGE.max)
      fields.push({
        field,
        code: FieldErrorCode.INVALID_NUMBER,
        params: { min: CHILD_AGE.min, max: CHILD_AGE.max },
      });
  }
  if (!fields.length && input.childAgeMax! < input.childAgeMin!)
    fields.push({
      field: 'childAgeMax',
      code: FieldErrorCode.INVALID_NUMBER,
      params: { min: input.childAgeMin!, max: CHILD_AGE.max },
    });
  if (fields.length) throw invalid(fields);
  return {
    forChildren: true,
    childAgeMin: input.childAgeMin!,
    childAgeMax: input.childAgeMax!,
  };
}
