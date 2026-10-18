import { ApiProperty } from '@nestjs/swagger';
import {
  EventRsvpResponse,
  type CommunityEvent,
  type EventRsvp,
} from '@prisma/client';
import { AudienceView } from '../../audience/audience';
import { CommunityAttachmentView } from '../../content/attachment.view';
import { EVENT_STATUSES, type EventStatus } from '../event-rules';
import type { AttendeeRead, EventCounts, EventRead } from '../events.service';

export class EventCreatedView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: Date;

  /** No text: the stored replay of a create holds none. */
  static from(e: Pick<CommunityEvent, 'id' | 'createdAt'>): EventCreatedView {
    return { id: e.id, createdAt: e.createdAt };
  }
}

/** How an event is filling up. Counts only: never who. */
export class EventCountsView {
  @ApiProperty({
    type: Number,
    description: 'Accounts that said they are going.',
  })
  going: number;
  @ApiProperty({ type: Number })
  notGoing: number;
  @ApiProperty({
    type: Number,
    description:
      'Seats taken: those going, their guests and the children registered.',
  })
  seats: number;
  @ApiProperty({
    type: Number,
    description: 'Children registered (an event for children). Never who.',
  })
  children: number;
  @ApiProperty({
    type: Number,
    nullable: true,
    description: 'Seats left. Null: the event has no limit.',
  })
  remaining: number | null;

  static from(c: EventCounts): EventCountsView {
    return {
      going: c.going,
      notGoing: c.notGoing,
      seats: c.seats,
      children: c.children,
      remaining: c.remaining,
    };
  }
}

/** The caller's own answer. */
export class MyRsvpView {
  @ApiProperty({ enum: EventRsvpResponse, enumName: 'EventRsvpResponse' })
  response: EventRsvpResponse;
  @ApiProperty({ type: Number })
  guests: number;
  @ApiProperty({ type: String, format: 'uuid' })
  unitId: string;

  static from(r: EventRsvp | null): MyRsvpView | null {
    return r
      ? { response: r.response, guests: r.guests, unitId: r.unitId }
      : null;
  }
}

class EventBaseView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({
    enum: EVENT_STATUSES,
    description: 'From its dates, now. `cancelled` stays so.',
  })
  status: EventStatus;
  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'Written by the staff. A language is whole or absent; at least one is there.',
  })
  titleEn: string | null;
  @ApiProperty({ type: String, nullable: true })
  descriptionEn: string | null;
  @ApiProperty({ type: String, nullable: true })
  titleAr: string | null;
  @ApiProperty({ type: String, nullable: true })
  descriptionAr: string | null;
  @ApiProperty({ type: String, description: 'Where, in the staff’s words.' })
  place: string;
  @ApiProperty({ type: String, format: 'date-time' })
  startsAt: Date;
  @ApiProperty({ type: String, format: 'date-time' })
  endsAt: Date;
  @ApiProperty({
    type: Number,
    nullable: true,
    description: 'Seats in all, guests included. Null: no limit.',
  })
  capacity: number | null;
  @ApiProperty({ type: EventCountsView })
  counts: EventCountsView;
  @ApiProperty({
    type: Boolean,
    description: 'For children (ADR 0054): the household registers its minors.',
  })
  forChildren: boolean;
  @ApiProperty({ type: Number, nullable: true })
  childAgeMin: number | null;
  @ApiProperty({ type: Number, nullable: true })
  childAgeMax: number | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  cancelledAt: Date | null;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'From the closed list `communityEventCancel`.',
  })
  cancelReason: string | null;
  @ApiProperty({ type: Number, description: 'Files it shows.' })
  attachmentCount: number;

  static base(r: EventRead): EventBaseView {
    const e = r.event;
    return {
      id: e.id,
      status: r.status,
      titleEn: e.titleEn,
      descriptionEn: e.descriptionEn,
      titleAr: e.titleAr,
      descriptionAr: e.descriptionAr,
      place: e.place,
      startsAt: e.startsAt,
      endsAt: e.endsAt,
      capacity: e.capacity,
      counts: EventCountsView.from(r.counts),
      forChildren: e.forChildren,
      childAgeMin: e.childAgeMin,
      childAgeMax: e.childAgeMax,
      cancelledAt: e.cancelledAt,
      cancelReason: e.cancelReason,
      attachmentCount: e.attachmentIds.length,
    };
  }
}

/** A child of mine registered for an event (ADR 0054). */
export class MyChildView {
  @ApiProperty({ type: String, format: 'uuid' })
  memberId: string;
  @ApiProperty({ type: String, nullable: true, example: 'Omar' })
  firstName: string | null;
}

/** An event as a resident sees it: how full it is, and their own answer. */
export class EventListItemView extends EventBaseView {
  @ApiProperty({
    type: MyRsvpView,
    nullable: true,
    description: 'Null: the caller has not answered.',
  })
  myRsvp: MyRsvpView | null;
  @ApiProperty({
    type: [MyChildView],
    description: "My units' children registered for it.",
  })
  myChildren: MyChildView[];

  static from(r: EventRead): EventListItemView {
    return {
      ...EventBaseView.base(r),
      myRsvp: MyRsvpView.from(r.mine),
      myChildren: r.myChildren,
    };
  }
}

export class EventView extends EventListItemView {
  @ApiProperty({ type: [CommunityAttachmentView] })
  attachments: CommunityAttachmentView[];

  static from(r: EventRead): EventView {
    return {
      ...EventListItemView.from(r),
      attachments: (r.attachments ?? []).map((a) =>
        CommunityAttachmentView.from(a),
      ),
    };
  }
}

/** An event as the staff see it. */
export class StaffEventListItemView extends EventBaseView {
  @ApiProperty({ type: AudienceView })
  audience: AudienceView;
  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: Date;

  static from(r: EventRead): StaffEventListItemView {
    return {
      ...EventBaseView.base(r),
      audience: AudienceView.from(r.event),
      createdAt: r.event.createdAt,
    };
  }
}

export class StaffEventView extends StaffEventListItemView {
  @ApiProperty({ type: [CommunityAttachmentView] })
  attachments: CommunityAttachmentView[];

  static from(r: EventRead): StaffEventView {
    return {
      ...StaffEventListItemView.from(r),
      attachments: (r.attachments ?? []).map((a) =>
        CommunityAttachmentView.from(a),
      ),
    };
  }
}

/** One answer in the staff's attendee list. */
export class AttendeeView {
  @ApiProperty({ type: String, format: 'uuid' })
  accountId: string;
  @ApiProperty({ type: String, nullable: true })
  fullName: string | null;
  @ApiProperty({ type: String, format: 'uuid' })
  unitId: string;
  @ApiProperty({ type: String, nullable: true })
  unitCode: string | null;
  @ApiProperty({ enum: EventRsvpResponse, enumName: 'EventRsvpResponse' })
  response: EventRsvpResponse;
  @ApiProperty({ type: Number })
  guests: number;
  @ApiProperty({
    type: Number,
    description: "The unit's children registered (ADR 0054): never who.",
  })
  children: number;
  @ApiProperty({ type: String, format: 'date-time' })
  answeredAt: Date;

  static from(a: AttendeeRead): AttendeeView {
    return {
      accountId: a.rsvp.accountId,
      fullName: a.fullName,
      unitId: a.rsvp.unitId,
      unitCode: a.unitCode,
      response: a.rsvp.response,
      guests: a.rsvp.guests,
      children: a.children,
      answeredAt: a.rsvp.updatedAt,
    };
  }
}
