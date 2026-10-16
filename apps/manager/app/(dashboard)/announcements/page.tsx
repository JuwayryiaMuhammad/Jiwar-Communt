'use client';

import { formatDateTime, humanize } from '@jiwar/api';
import { LoadMore, QueryState, useCursorList } from '@jiwar/api/react';
import { Badge, Button, Card, DataTable, Field, ForbiddenState, PageHeader, Segmented, Select, StatusBadge } from '@jiwar/ui';
import { Plus } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { AnnouncementDialog } from '@/components/community/announcement-dialog';
import { TwoLanguages } from '@/components/community/bits';
import { audienceText } from '@/components/community/logic';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys, type Announcement, type AnnouncementFilters, type AnnouncementKind } from '@/lib/queries';

const STATUSES: Announcement['status'][] = ['draft', 'scheduled', 'published', 'expired', 'ended', 'archived'];
type KindView = 'all' | AnnouncementKind;

/**
 * The compound's announcements, and its works and closures (ADR 0040):
 * drafts, scheduled, out and archived, the newest first.
 */
export default function AnnouncementsPage() {
  const router = useRouter();
  const { can, ready } = usePermissions();
  const [view, setView] = useState<KindView>('all');
  const [status, setStatus] = useState<Announcement['status'] | ''>('');
  const [creating, setCreating] = useState<Exclude<AnnouncementKind, 'board'> | null>(null);
  const allowed = can('community.publish');
  const filters: AnnouncementFilters = { status, kind: view === 'all' ? '' : view };
  const list = useCursorList(keys.announcements(filters), (c) => fetchers.announcements(filters, c), { enabled: allowed });

  if (ready && !allowed) return <ForbiddenState />;

  return (
    <>
      <PageHeader
        title="Announcements"
        description="What the management tells residents, and works and closures. Each is read by whoever is in its audience on the day they open it."
      />
      <div className="toolbar">
        <Segmented<KindView>
          label="Kind shown"
          value={view}
          onChange={setView}
          options={[
            { value: 'all', label: 'All' },
            { value: 'general', label: 'Announcements' },
            { value: 'works', label: 'Works and closures' },
          ]}
        />
        <Field label="Status">
          {(p) => (
            <Select {...p} value={status} onChange={(e) => setStatus(e.target.value as Announcement['status'] | '')}>
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
        <Button icon={<Plus aria-hidden />} onClick={() => setCreating('works')}>
          New works or closure
        </Button>
        <Button variant="primary" icon={<Plus aria-hidden />} onClick={() => setCreating('general')}>
          New announcement
        </Button>
      </div>
      <Card flush>
        <QueryState query={list}>
          <DataTable<Announcement>
            rows={list.rows}
            rowKey={(a) => a.id}
            empty="No announcement here"
            emptyHint="A new one is saved as a draft; nobody sees it until it is published."
            columns={[
              {
                key: 'title',
                header: 'Announcement',
                cell: (a) => (
                  <span className="stack stack--sm">
                    <Link className="table__link" href={`/announcements/${a.id}`}>
                      <TwoLanguages en={a.titleEn} ar={a.titleAr} strong />
                    </Link>
                    <span className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
                      {a.kind === 'works' ? <Badge plain>Works and closures</Badge> : null}
                      {a.priority === 'important' ? <Badge tone="terracotta">Important</Badge> : null}
                      {a.pinned ? <Badge tone="green">Pinned</Badge> : null}
                      {a.editedAt ? <Badge plain>Edited</Badge> : null}
                    </span>
                  </span>
                ),
              },
              { key: 'status', header: 'Status', cell: (a) => <StatusBadge status={a.status} /> },
              { key: 'audience', header: 'Audience', cell: (a) => audienceText(a.audience) },
              {
                key: 'when',
                header: 'Published',
                cell: (a) =>
                  a.publishAt ? (
                    <span style={{ whiteSpace: 'nowrap' }}>{formatDateTime(a.publishAt)}</span>
                  ) : (
                    <span className="t-secondary">Not yet</span>
                  ),
              },
            ]}
          />
          <LoadMore query={list} />
        </QueryState>
      </Card>
      {creating ? (
        <AnnouncementDialog
          key={creating}
          announcement={null}
          kind={creating}
          open
          onClose={() => setCreating(null)}
          onSaved={(id) => {
            setCreating(null);
            router.push(`/announcements/${id}`);
          }}
        />
      ) : null}
    </>
  );
}
