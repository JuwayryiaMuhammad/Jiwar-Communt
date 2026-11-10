'use client';

import { REASON_CODES, unwrap } from '@jiwar/api';
import { ErrorAlert, LoadMore, QueryState, useAction, useCursorList } from '@jiwar/api/react';
import { useFormat, useLocale, useT } from '@jiwar/i18n';
import {
  Button,
  Card,
  CardBody,
  DataTable,
  ForbiddenState,
  PageHeader,
  ReasonCodeDialog,
  Segmented,
  Stat,
  StatusBadge,
  useLabel,
  useToast,
} from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { Attachments, Back, SectionHeader, TwoLanguages } from '@/components/community/bits';
import { EventDialog } from '@/components/community/event-dialog';
import { audienceText } from '@/components/community/logic';
import { api } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys, type Attendee } from '@/lib/queries';
import communityAr from '@/messages/ar/community';
import ar from '@/messages/ar/community-events';
import communityEn from '@/messages/en/community';
import en from '@/messages/en/community-events';

type Response = Attendee['response'];
const RESPONSES: Response[] = ['going', 'not_going'];

/** Who answered, by name, unit and guests: the staff's list. */
function Attendees({ id }: { id: string }) {
  const t = useT(en, ar);
  const fmt = useFormat();
  const [response, setResponse] = useState<Response>('going');
  const list = useCursorList(keys.attendees(id, response), (c) => fetchers.attendees(id, response, c));
  return (
    <Card flush>
      <SectionHeader
        title={t('answered')}
        description={t('answeredHint')}
        actions={
          <Segmented<Response>
            label={t('answersShown')}
            value={response}
            onChange={setResponse}
            options={RESPONSES.map((r) => ({ value: r, label: t(`response.${r}`) }))}
          />
        }
      />
      <QueryState query={list}>
        <DataTable<Attendee>
          rows={list.rows}
          rowKey={(a) => a.accountId}
          empty={response === 'going' ? t('emptyGoing') : t('emptyNotGoing')}
          columns={[
            { key: 'name', header: t('col.resident'), cell: (a) => a.fullName ?? <span className="t-secondary">{t('erased')}</span> },
            { key: 'unit', header: t('col.unit'), cell: (a) => a.unitCode ?? '' },
            { key: 'guests', header: t('col.guests'), cell: (a) => (a.response === 'going' ? fmt.number(a.guests) : '') },
            // ADR 0054: how many of the unit's children are registered, never who.
            { key: 'children', header: t('col.children'), cell: (a) => (a.children ? fmt.number(a.children) : '') },
            { key: 'when', header: t('col.answered'), cell: (a) => <span style={{ whiteSpace: 'nowrap' }}>{fmt.dateTime(a.answeredAt)}</span> },
          ]}
        />
        <LoadMore query={list} />
      </QueryState>
    </Card>
  );
}

export default function EventPage() {
  const t = useT(en, ar);
  const tc = useT(communityEn, communityAr);
  const fmt = useFormat();
  const label = useLabel();
  const { locale } = useLocale();
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
        toast.show(t('cancelled'));
        setDialog(null);
      },
    },
  );

  if (ready && !allowed) return <ForbiddenState />;
  const e = query.data;
  const heading = e ? ((locale === 'ar' ? (e.titleAr ?? e.titleEn) : (e.titleEn ?? e.titleAr)) ?? t('event')) : t('event');

  return (
    <>
      <PageHeader
        title={heading}
        back={<Back href="/events" label={t('title')} />}
        actions={
          e ? (
            <>
              {e.status === 'upcoming' ? <Button onClick={() => setDialog('edit')}>{t('edit')}</Button> : null}
              {e.status === 'upcoming' || e.status === 'ongoing' ? (
                <Button variant="danger" onClick={() => setDialog('cancel')}>
                  {t('cancelEvent')}
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
                    {e.cancelReason ? <span className="t-secondary">{t('cancelledBecause', { reason: label(e.cancelReason) })}</span> : null}
                  </span>
                  <TwoLanguages en={e.titleEn} ar={e.titleAr} strong />
                  <TwoLanguages en={e.descriptionEn} ar={e.descriptionAr} />
                  <Attachments items={e.attachments} />
                  <dl className="dl">
                    <dt>{t('when')}</dt>
                    <dd>{t('span', { from: fmt.dateTime(e.startsAt), to: fmt.dateTime(e.endsAt) })}</dd>
                    <dt>{t('where')}</dt>
                    <dd>{e.place}</dd>
                    <dt>{t('audience')}</dt>
                    <dd>{audienceText(e.audience, tc, fmt)}</dd>
                  </dl>
                </div>
              </CardBody>
            </Card>
            <div className="row" style={{ gap: 32, flexWrap: 'wrap' }}>
              <Stat
                label={t('seatsTaken')}
                value={e.capacity === null ? fmt.number(e.counts.seats) : t('ofTotal', { part: e.counts.seats, whole: e.capacity })}
                hint={e.counts.remaining === null ? t('noLimit') : t('left', { n: e.counts.remaining })}
              />
              <Stat label={t('going')} value={fmt.number(e.counts.going)} hint={t('goingHint')} />
              <Stat label={t('notGoing')} value={fmt.number(e.counts.notGoing)} />
              {e.forChildren ? (
                <Stat
                  label={t('children')}
                  value={fmt.number(e.counts.children)}
                  hint={t('childrenHint', { min: e.childAgeMin, max: e.childAgeMax })}
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
        title={t('cancelTitle')}
        description={t('cancelDescription')}
        codes={REASON_CODES.communityEventCancel}
        confirmLabel={t('cancelEvent')}
        danger
        pending={cancel.isPending}
        error={cancel.error ? <ErrorAlert error={cancel.error} /> : undefined}
        onConfirm={(reasonCode) => cancel.mutate(reasonCode)}
      />
    </>
  );
}
