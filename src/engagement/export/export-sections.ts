import { Injectable, type OnModuleInit } from '@nestjs/common';
import { TenantTx } from '../../core/database/tenant-tx.service';
import {
  ExportSections,
  type ExportEntry,
  type ExportSubject,
} from '../../core/exports/export-sections';
import { EventsService } from '../events/events.service';
import { PollsService } from '../polls/polls.service';
import { SuggestionsService } from '../suggestions/suggestions.service';
import { MySuggestionView } from '../suggestions/views/suggestion.views';

/**
 * The community life's section of a personal-data export (ADR 0036, 0040):
 *
 * - `community/suggestions.json`: every suggestion the account wrote, as
 *   its own detail shows it (`GET /suggestions/{id}`), with the staff's
 *   answers; the "we did" photos as a count, never a URL;
 * - `community/suggestion-supports.json`: the published suggestions it
 *   supports, by id;
 * - `community/event-answers.json`: its own answers to events;
 * - `community/poll-votes.json`: for each poll put to one of its units,
 *   whether that unit voted: yes or no, and nothing else. What a unit chose
 *   is not in an export because it is not anywhere.
 *
 * Nothing here is another person's: an event's attendee list, a
 * suggestion's author and another unit's vote are never read.
 */
@Injectable()
export class EngagementExportSections implements OnModuleInit {
  constructor(
    private readonly sections: ExportSections,
    private readonly tenantTx: TenantTx,
    private readonly suggestions: SuggestionsService,
    private readonly events: EventsService,
    private readonly polls: PollsService,
  ) {}

  onModuleInit(): void {
    this.sections.register('community', (s) => this.own(s));
  }

  private async *own(s: ExportSubject): AsyncIterable<ExportEntry> {
    const authored = await this.tenantTx.withTenantTx((tx) =>
      this.suggestions.authoredBy(tx, s.accountId),
    );
    yield {
      path: 'community/suggestions.json',
      json: authored.map((read) => {
        const view = MySuggestionView.from(read);
        return {
          ...view,
          done: view.done && {
            doneAt: view.done.doneAt,
            noteEn: view.done.noteEn,
            noteAr: view.done.noteAr,
            photoCount: view.done.photoCount,
          },
        };
      }),
    };

    const supported = await this.tenantTx.withTenantTx((tx) =>
      this.suggestions.supportedBy(tx, s.accountId),
    );
    yield {
      path: 'community/suggestion-supports.json',
      json: supported.map((suggestionId) => ({ suggestionId })),
    };

    const answers = await this.tenantTx.withTenantTx((tx) =>
      this.events.answersOf(tx, s.accountId),
    );
    yield {
      path: 'community/event-answers.json',
      json: answers.map(({ rsvp, event }) => ({
        eventId: event.id,
        titleEn: event.titleEn,
        titleAr: event.titleAr,
        startsAt: event.startsAt,
        unitId: rsvp.unitId,
        response: rsvp.response,
        guests: rsvp.guests,
        answeredAt: rsvp.updatedAt,
      })),
    };

    // The children it registered for events (ADR 0054), by first name.
    const children = await this.tenantTx.withTenantTx((tx) =>
      this.events.childRegistrationsOf(tx, s.accountId),
    );
    yield {
      path: 'community/event-children.json',
      json: children.map((c) => ({
        eventId: c.eventId,
        titleEn: c.event?.titleEn ?? null,
        titleAr: c.event?.titleAr ?? null,
        startsAt: c.event?.startsAt ?? null,
        memberId: c.memberId,
        firstName: c.firstName,
        registeredAt: c.registeredAt,
      })),
    };

    const votes = await this.tenantTx.withTenantTx((tx) =>
      this.polls.participationOf(tx, s.accountId),
    );
    yield {
      path: 'community/poll-votes.json',
      json: votes.map(({ poll, unitId, voted }) => ({
        pollId: poll.id,
        questionEn: poll.questionEn,
        questionAr: poll.questionAr,
        closesAt: poll.closesAt,
        unitId,
        voted,
      })),
    };
  }
}
