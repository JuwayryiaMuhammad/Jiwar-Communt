'use client';

import { formatDateTime, humanize, REASON_CODES, unwrap } from '@jiwar/api';
import { ErrorAlert, LoadMore, QueryState, useAction, useCursorList } from '@jiwar/api/react';
import { Button, Card, CardBody, DataTable, ForbiddenState, PageHeader, ReasonCodeDialog, Segmented, Stat, StatusBadge, useToast } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { Attachments, Back, SectionHeader, TwoLanguages } from '@/components/community/bits';
import { EventDialog } from '@/components/community/event-dialog';
import { audienceText } from '@/components/community/logic';
import { api } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys, type Attendee } from '@/lib/queries';

type Response = Attendee['response'];

/** Who answered, by name, unit and guests: the staff's list. */
function Attendees({ id }: { id: string }) {
  const [response, setResponse] = useState<Response>('going');
  const list = useCursorList(keys.attendees(id, response), (c) => fetchers.attendees(id, response, c));
  return (
    <Card flush>
      <SectionHeader
        title="Who answered"
        description="Residents see the counts only, never this list."
        actions={
          <Segmented<Response>
            label="Answers shown"
            value={response}
            onChange={setResponse}
            options={[
              { value: 'going', label: 'Going' },
              { value: 'not_going', label: 'Not going' },
            ]}
          />
        }
      />
      <QueryState query={list}>
        <DataTable<Attendee>
          rows={list.rows}
          rowKey={(a) => a.accountId}
          empty={response === 'going' ? 'Nobody has said they are going yet' : 'Nobody has said they are not going'}
          columns={[
            { key: 'name', header: 'Resident', cell: (a) => a.fullName ?? <span className="t-secondary">Erased account</span> },
            { key: 'unit', header: 'Unit', cell: (a) => a.unitCode ?? '' },
            { key: 'guests', header: 'Guests', cell: (a) => (a.response === 'going' ? a.guests : '') },
            // ADR 0054: how many of the unit's children are registered, never who.
            { key: 'children', header: 'Children', cell: (a) => (a.children ? a.children : '') },
            { key: 'when', header: 'Answered', cell: (a) => <span style={{ whiteSpace: 'nowrap' }}>{formatDateTime(a.answeredAt)}</span> },
          ]}
        />
        <LoadMore query={list} />
      </QueryState>
    </Card>
  );
}

export default function EventPage() {
  const { id } = useParams<{ id: string }>();
  const toast = useToast();
  const { can, ready } = usePermissions();
  const allowed = can('community.publish');
  const query = useQuery({ queryKey: keys.communityEvent(id), queryFn: () => fetchers.communityEvent(id), enabled: allowed, refetchInterval: 60_000 });
  const [dialog, setDialog] = useState<'edit' | 'cancel' | null>(null);
  const cancel = useAction(
    (reasonCode: string) => unwrap(api.POST('/api/v1/community/events/{id}/cancel', { params: { path: { id } }, body: { reasonCode } })),
    {
      invalidate: [keys.communityEventsAll],
      onDone: () => {
        toast.show('The event is cancelled. Everyone who said they are going was told.');
        setDialog(null);
      },
    },
  );

  if (ready && !allowed) return <ForbiddenState />;
  const e = query.data;

  return (
    <>
      <PageHeader
        title={e ? (e.titleEn ?? e.titleAr ?? 'Event') : 'Event'}
        back={<Back href="/events" label="Events" />}
        actions={
          e ? (
            <>
              {e.status === 'upcoming' ? <Button onClick={() => setDialog('edit')}>Edit</Button> : null}
              {e.status === 'upcoming' || e.status === 'ongoing' ? (
                <Button variant="danger" onClick={() => setDialog('cancel')}>
                  Cancel the event
                </Button>
              ) : null}
            </>
          ) : null
        }
      />
      <QueryState query={query}>
        {e ? (
          <div className="stack">
            <Card>
              <CardBody>
                <div className="stack">
                  <span className="row" style={{ gap: 8 }}>
                    <StatusBadge status={e.status} />
                    {e.cancelReason ? <span className="t-secondary">Cancelled: {humanize(e.cancelReason)}</span> : null}
                  </span>
                  <TwoLanguages en={e.titleEn} ar={e.titleAr} strong />
                  <TwoLanguages en={e.descriptionEn} ar={e.descriptionAr} />
                  <Attachments items={e.attachments} />
                  <dl className="dl">
                    <dt>When</dt>
                    <dd>
                      {formatDateTime(e.startsAt)} to {formatDateTime(e.endsAt)}
                    </dd>
                    <dt>Where</dt>
                    <dd>{e.place}</dd>
                    <dt>Audience</dt>
                    <dd>{audienceText(e.audience)}</dd>
                  </dl>
                </div>
              </CardBody>
            </Card>
            <div className="row" style={{ gap: 32, flexWrap: 'wrap' }}>
              <Stat
                label="Seats taken"
                value={e.capacity === null ? e.counts.seats : `${e.counts.seats} of ${e.capacity}`}
                hint={e.counts.remaining === null ? 'No limit' : `${e.counts.remaining} left`}
              />
              <Stat label="Going" value={e.counts.going} hint="People, before their guests" />
              <Stat label="Not going" value={e.counts.notGoing} />
              {e.forChildren ? (
                <Stat
                  label="Children"
                  value={e.counts.children}
                  hint={`Registered by their households, aged ${e.childAgeMin}–${e.childAgeMax}`}
                />
              ) : null}
            </div>
            <Attendees id={e.id} />
          </div>
        ) : null}
      </QueryState>
      {e && dialog === 'edit' ? <EventDialog event={e} open onClose={() => setDialog(null)} onSaved={() => setDialog(null)} /> : null}
      <ReasonCodeDialog
        open={dialog === 'cancel'}
        onClose={() => setDialog(null)}
        title="Cancel this event?"
        description="Everyone who said they are going is notified. It stays listed as cancelled; it cannot be brought back."
        codes={REASON_CODES.communityEventCancel}
        confirmLabel="Cancel the event"
        danger
        pending={cancel.isPending}
        error={cancel.error ? <ErrorAlert error={cancel.error} /> : undefined}
        onConfirm={(reasonCode) => cancel.mutate(reasonCode)}
      />
    </>
  );
}
