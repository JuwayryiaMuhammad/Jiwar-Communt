'use client';

import { formatDateTime, humanize } from '@jiwar/api';
import { LoadMore, QueryState, useCursorList } from '@jiwar/api/react';
import { Button, Card, DataTable, Field, ForbiddenState, PageHeader, Select, StatusBadge } from '@jiwar/ui';
import { Plus } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { TwoLanguages } from '@/components/community/bits';
import { EventDialog } from '@/components/community/event-dialog';
import { audienceText } from '@/components/community/logic';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys, type CommunityEvent, type EventFilters } from '@/lib/queries';

const STATUSES: CommunityEvent['status'][] = ['upcoming', 'ongoing', 'ended', 'cancelled'];

/** The compound's events (ADR 0040), the latest start first. */
export default function EventsPage() {
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
      <PageHeader title="Events" description="What the compound holds, and how many said they are coming. No payment is taken here." />
      <div className="toolbar">
        <Field label="Status">
          {(p) => (
            <Select {...p} value={status} onChange={(e) => setStatus(e.target.value as CommunityEvent['status'] | '')}>
              <option value="">Any status</option>
              {STATUSES.map((s) => (
                <option key={s} value={s}>
                  {humanize(s)}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <span className="spacer" />
        <Button variant="primary" icon={<Plus aria-hidden />} onClick={() => setCreating(true)}>
          New event
        </Button>
      </div>
      <Card flush>
        <QueryState query={list}>
          <DataTable<CommunityEvent>
            rows={list.rows}
            rowKey={(e) => e.id}
            empty="No event here"
            columns={[
              {
                key: 'title',
                header: 'Event',
                cell: (e) => (
                  <span className="stack stack--sm">
                    <Link className="table__link" href={`/events/${e.id}`}>
                      <TwoLanguages en={e.titleEn} ar={e.titleAr} strong />
                    </Link>
                    <span className="t-secondary">{e.place}</span>
                  </span>
                ),
              },
              { key: 'when', header: 'Starts', cell: (e) => <span style={{ whiteSpace: 'nowrap' }}>{formatDateTime(e.startsAt)}</span> },
              { key: 'status', header: 'Status', cell: (e) => <StatusBadge status={e.status} /> },
              {
                key: 'seats',
                header: 'Coming',
                cell: (e) => (e.capacity === null ? `${e.counts.seats}` : `${e.counts.seats} of ${e.capacity}`),
              },
              { key: 'audience', header: 'Audience', cell: (e) => audienceText(e.audience) },
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
