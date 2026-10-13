import { Injectable } from '@nestjs/common';
import { PermissionsService } from '../../core/access/permissions.service';
import { RequestContext } from '../../core/common/cls/request-context';
import {
  addDays,
  localDate,
  zonedInstant,
} from '../../core/common/slots/day-slots';
import { TenantTx } from '../../core/database/tenant-tx.service';
import { TenantSettingsService } from '../../core/tenant-settings/tenant-settings.service';
import { GateStatusPort, type GateStatus } from '../../gate';
import { ResidentTicketSummary, type TicketSummary } from '../../maintenance';
import { ResidentRequestSummary, type RequestSummary } from '../../management';
import {
  AnnouncementsService,
  type AnnouncementRead,
} from '../announcements/announcements.service';
import { dbNow } from '../db-clock';
import { EventsService, type EventRead } from '../events/events.service';
import { PollsService, type PollRead } from '../polls/polls.service';

const HOUR = 3_600_000;
/** An announcement is "new" for this long after it comes out, until opened. */
export const NEW_ANNOUNCEMENT_DAYS = 7;
/** A poll is in the brief when it closes within this long. */
export const POLL_CLOSING_HOURS = 48;

export interface DailyBrief {
  /** The compound's local day the brief is of, `YYYY-MM-DD`. */
  date: string;
  timeZone: string;
  works: AnnouncementRead[];
  events: EventRead[];
  pinned: AnnouncementRead[];
  fresh: AnnouncementRead[];
  polls: { read: PollRead; pendingUnitIds: string[] }[];
  /** Null when the caller's role does not open tickets. */
  tickets: TicketSummary | null;
  /** Null when the caller's role does not write to the management. */
  requests: RequestSummary | null;
  gates: GateStatus[];
}

/**
 * The daily brief (ADR 0040): what the caller should know today, computed
 * when asked and stored nowhere. One transaction, one clock.
 *
 * - works and closures under way now;
 * - the events of today (the compound's local day) that are not over;
 * - announcements: what is pinned, and what came out in the last seven
 *   days that the caller has not opened;
 * - open polls closing within 48 hours in which the caller casts the vote
 *   of a unit that has not voted;
 * - the caller's unfinished tickets and open requests to the management:
 *   a count and the latest one's status, each read through its own
 *   domain's port and only when the caller's role uses that feature;
 * - the gates and whether each is in service.
 *
 * Everything the engagement domain owns is read by its own rules (the
 * audience, at this moment); everything else through the other domains'
 * public ports.
 */
@Injectable()
export class DailyBriefService {
  constructor(
    private readonly tenantTx: TenantTx,
    private readonly ctx: RequestContext,
    private readonly permissions: PermissionsService,
    private readonly tenantSettings: TenantSettingsService,
    private readonly announcements: AnnouncementsService,
    private readonly events: EventsService,
    private readonly polls: PollsService,
    private readonly tickets: ResidentTicketSummary,
    private readonly requests: ResidentRequestSummary,
    private readonly gates: GateStatusPort,
  ) {}

  async get(): Promise<DailyBrief> {
    const me = this.ctx.accountId;
    const tenantId = this.ctx.tenantId;
    const mayReport = await this.permissions.has('tickets.create');
    const mayAsk = await this.permissions.has('requests.create');
    return this.tenantTx.withTenantTx(async (tx) => {
      const now = await dbNow(tx);
      const { timezone } = await this.tenantSettings.inTx(tx, tenantId);
      const date = localDate(now, timezone);
      // Midnight to midnight on the compound's clock; a day whose midnight
      // does not exist there (a daylight-saving gap) starts now.
      const from = zonedInstant(date, 0, timezone) ?? now;
      const to =
        zonedInstant(addDays(date, 1), 0, timezone) ??
        new Date(from.getTime() + 24 * HOUR);
      const news = await this.announcements.forBrief(
        tx,
        me,
        now,
        new Date(now.getTime() - NEW_ANNOUNCEMENT_DAYS * 24 * HOUR),
      );
      return {
        date,
        timeZone: timezone,
        works: news.works,
        events: await this.events.forBrief(tx, me, now, from, to),
        pinned: news.pinned,
        fresh: news.fresh,
        polls: await this.polls.forBrief(
          tx,
          me,
          now,
          new Date(now.getTime() + POLL_CLOSING_HOURS * HOUR),
        ),
        tickets: mayReport ? await this.tickets.of(tx, me) : null,
        requests: mayAsk ? await this.requests.of(tx, me) : null,
        gates: await this.gates.statuses(tx),
      };
    });
  }
}
