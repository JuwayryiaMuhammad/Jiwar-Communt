'use client';

import { LoadMore, QueryState, useCursorList } from '@jiwar/api/react';
import { useFormat, useT } from '@jiwar/i18n';
import { Button, Card, DataTable, Field, ForbiddenState, PageHeader, Select, StatusBadge, useLabel } from '@jiwar/ui';
import { Plus } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { TwoLanguages } from '@/components/community/bits';
import { EventDialog } from '@/components/community/event-dialog';
import { audienceText } from '@/components/community/logic';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys, type CommunityEvent, type EventFilters } from '@/lib/queries';
import communityAr from '@/messages/ar/community';
import ar from '@/messages/ar/community-events';
import communityEn from '@/messages/en/community';
import en from '@/messages/en/community-events';

const STATUSES: CommunityEvent['status'][] = ['upcoming', 'ongoing', 'ended', 'cancelled'];

/** The compound's events (ADR 0040), the latest start first. */
export default function EventsPage() {
  const t = useT(en, ar);
  const tc = useT(communityEn, communityAr);
  const fmt = useFormat();
  const label = useLabel();
  const router = useRouter();
  const { can, ready } = usePermissions();
  const [status, setStatus] = useState<CommunityEvent['status'] | ''>('');
  const [creating, setCreating] = useState(false);
  const allowed = can('community.publish');
  const filters: EventFilters = { status };
  const list = useCursorList(keys.communityEvents(filters), (c) => fetchers.communityEvents(filters, c), { enabled: allowed });

  if (ready && !allowed) return <ForbiddenState />;

  return (
    <>
      <PageHeader title={t('title')} description={t('description')} />
      <div className="toolbar">
        <Field label={t('status')}>
          {(p) => (
            <Select {...p} value={status} onChange={(e) => setStatus(e.target.value as CommunityEvent['status'] | '')}>
              <option value="">{t('anyStatus')}</option>
              {STATUSES.map((s) => (
                <option key={s} value={s}>
                  {label(s)}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <span className="spacer" />
        <Button variant="primary" icon={<Plus aria-hidden />} onClick={() => setCreating(true)}>
          {t('newEvent')}
        </Button>
      </div>
      <Card flush>
        <QueryState query={list}>
          <DataTable<CommunityEvent>
            rows={list.rows}
            rowKey={(e) => e.id}
            empty={t('empty')}
            columns={[
              {
                key: 'title',
                header: t('col.event'),
                cell: (e) => (
                  <span className="stack stack--sm">
                    <Link className="table__link" href={`/events/${e.id}`}>
                      <TwoLanguages en={e.titleEn} ar={e.titleAr} strong />
                    </Link>
                    <span className="t-secondary">{e.place}</span>
                  </span>
                ),
              },
              { key: 'when', header: t('col.starts'), cell: (e) => <span style={{ whiteSpace: 'nowrap' }}>{fmt.dateTime(e.startsAt)}</span> },
              { key: 'status', header: t('col.status'), cell: (e) => <StatusBadge status={e.status} /> },
              {
                key: 'seats',
                header: t('col.coming'),
                cell: (e) => (e.capacity === null ? fmt.number(e.counts.seats) : t('ofTotal', { part: e.counts.seats, whole: e.capacity })),
              },
              { key: 'audience', header: t('col.audience'), cell: (e) => audienceText(e.audience, tc, fmt) },
            ]}
          />
          <LoadMore query={list} />
        </QueryState>
      </Card>
      {creating ? (
        <EventDialog
          event={null}
          open
          onClose={() => setCreating(false)}
          onSaved={(id) => {
            setCreating(false);
            router.push(`/events/${id}`);
          }}
        />
      ) : null}
    </>
  );
}
