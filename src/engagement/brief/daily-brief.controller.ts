import { Controller, Get } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiProperty } from '@nestjs/swagger';
import { RequirePermissions } from '../../core/access/require-permissions.decorator';
import { ApiArea, NoStore } from '../../core/common/http/decorators';
import { REASON_CODES } from '../../core/common/reasons';
import { AnnouncementListItemView } from '../announcements/views/announcement.views';
import { EventListItemView } from '../events/views/event.views';
import type { PollRead } from '../polls/polls.service';
import { DailyBriefService, type DailyBrief } from './daily-brief.service';

/** A poll that is about to close and still waits for the caller's vote. */
export class BriefPollView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Written by the staff.',
  })
  questionEn: string | null;
  @ApiProperty({ type: String, nullable: true })
  questionAr: string | null;
  @ApiProperty({ type: String, format: 'date-time' })
  closesAt: Date;
  @ApiProperty({
    type: [String],
    format: 'uuid',
    description:
      'The units whose vote the caller casts and that have not voted.',
  })
  pendingUnitIds: string[];

  static from(p: { read: PollRead; pendingUnitIds: string[] }): BriefPollView {
    return {
      id: p.read.poll.id,
      questionEn: p.read.poll.questionEn,
      questionAr: p.read.poll.questionAr,
      closesAt: p.read.poll.closesAt,
      pendingUnitIds: p.pendingUnitIds,
    };
  }
}

export class BriefLatestView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ type: String, example: 'MT-000123' })
  number: string;
  @ApiProperty({
    type: String,
    description:
      'The item’s own status: a TicketStatus for a ticket, a ManagementRequestStatus for a request.',
  })
  status: string;
}

/** The caller's open items of one kind: how many, and where the latest stands. */
export class BriefSummaryView {
  @ApiProperty({ type: Number, description: 'Not finished, or not closed.' })
  open: number;
  @ApiProperty({
    type: BriefLatestView,
    nullable: true,
    description: 'The open one that moved last. Null: none is open.',
  })
  latest: BriefLatestView | null;
}

export class BriefGateView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ type: String, description: 'Written by the compound.' })
  name: string;
  @ApiProperty({ type: Boolean, description: 'In service now.' })
  open: boolean;
}

/** A utility outage told to the caller (ADR 0069): the kind and the instants. */
export class BriefOutageView {
  @ApiProperty({ type: String, format: 'uuid' })
  id: string;
  @ApiProperty({ enum: REASON_CODES.outageKind, enumName: 'OutageKind' })
  kind: string;
  @ApiProperty({ type: String, format: 'date-time' })
  startsAt: Date;
  @ApiProperty({ type: String, format: 'date-time' })
  endsAt: Date;
}

export class BriefAnnouncementsView {
  @ApiProperty({ type: [AnnouncementListItemView], description: 'Pinned now.' })
  pinned: AnnouncementListItemView[];
  @ApiProperty({
    type: [AnnouncementListItemView],
    description:
      'Out in the last seven days and not opened by the caller, pinned ones aside.',
  })
  new: AnnouncementListItemView[];
}

/** What the caller should know today. Computed when asked; stored nowhere. */
export class DailyBriefView {
  @ApiProperty({
    type: String,
    format: 'date',
    description: 'The compound’s local day the brief is of.',
  })
  date: string;
  @ApiProperty({ type: String, example: 'Africa/Cairo' })
  timeZone: string;
  @ApiProperty({
    type: [AnnouncementListItemView],
    description: 'Works and closures under way now.',
  })
  works: AnnouncementListItemView[];
  @ApiProperty({
    type: [EventListItemView],
    description: 'Today’s events that are not over, the soonest first.',
  })
  events: EventListItemView[];
  @ApiProperty({ type: BriefAnnouncementsView })
  announcements: BriefAnnouncementsView;
  @ApiProperty({
    type: [BriefPollView],
    description:
      'Open polls closing within 48 hours in which the caller casts the vote of a unit that has not voted.',
  })
  polls: BriefPollView[];
  @ApiProperty({
    type: BriefSummaryView,
    nullable: true,
    description:
      'The caller’s maintenance tickets. Null when their role does not open tickets.',
  })
  tickets: BriefSummaryView | null;
  @ApiProperty({
    type: BriefSummaryView,
    nullable: true,
    description:
      'The caller’s requests to the management. Null when their role does not write to it.',
  })
  requests: BriefSummaryView | null;
  @ApiProperty({ type: [BriefGateView] })
  gates: BriefGateView[];
  @ApiProperty({
    type: [BriefOutageView],
    description:
      'Utility outages told to the caller, under way or starting within 48 hours, the soonest first.',
  })
  outages: BriefOutageView[];

  static from(b: DailyBrief): DailyBriefView {
    return {
      date: b.date,
      timeZone: b.timeZone,
      works: b.works.map((a) => AnnouncementListItemView.from(a)),
      events: b.events.map((e) => EventListItemView.from(e)),
      announcements: {
        pinned: b.pinned.map((a) => AnnouncementListItemView.from(a)),
        new: b.fresh.map((a) => AnnouncementListItemView.from(a)),
      },
      polls: b.polls.map((p) => BriefPollView.from(p)),
      tickets: b.tickets,
      requests: b.requests,
      gates: b.gates.map((g) => ({ id: g.id, name: g.name, open: g.open })),
      outages: b.outages.map((o) => ({
        id: o.id,
        kind: o.kind,
        startsAt: o.startsAt,
        endsAt: o.endsAt,
      })),
    };
  }
}

/** The caller's daily brief (ADR 0040, `community.read`). */
@ApiArea('community')
@RequirePermissions('community.read')
@Controller('me/daily-brief')
export class DailyBriefController {
  constructor(private readonly brief: DailyBriefService) {}

  @Get()
  @NoStore()
  @ApiOperation({ summary: 'Get my daily brief' })
  @ApiOkResponse({ type: DailyBriefView })
  async get(): Promise<DailyBriefView> {
    return DailyBriefView.from(await this.brief.get());
  }
}
