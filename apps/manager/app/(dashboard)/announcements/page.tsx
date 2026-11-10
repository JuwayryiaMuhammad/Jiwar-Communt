'use client';

import { LoadMore, QueryState, useCursorList } from '@jiwar/api/react';
import { useFormat, useT } from '@jiwar/i18n';
import { Badge, Button, Card, DataTable, Field, ForbiddenState, PageHeader, Segmented, Select, StatusBadge, useLabel } from '@jiwar/ui';
import { Plus } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { AnnouncementDialog } from '@/components/community/announcement-dialog';
import { TwoLanguages } from '@/components/community/bits';
import { audienceText } from '@/components/community/logic';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys, type Announcement, type AnnouncementFilters, type AnnouncementKind } from '@/lib/queries';
import communityAr from '@/messages/ar/community';
import ar from '@/messages/ar/community-announcements';
import communityEn from '@/messages/en/community';
import en from '@/messages/en/community-announcements';

const STATUSES: Announcement['status'][] = ['draft', 'scheduled', 'published', 'expired', 'ended', 'archived'];
const VIEWS = ['all', 'general', 'works'] as const;
type KindView = 'all' | AnnouncementKind;

/**
 * The compound's announcements, and its works and closures (ADR 0040):
 * drafts, scheduled, out and archived, the newest first.
 */
export default function AnnouncementsPage() {
  const t = useT(en, ar);
  const tc = useT(communityEn, communityAr);
  const fmt = useFormat();
  const label = useLabel();
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
      <PageHeader title={t('title')} description={t('description')} />
      <div className="toolbar">
        <Segmented<KindView>
          label={t('kindShown')}
          value={view}
          onChange={setView}
          options={VIEWS.map((v) => ({ value: v, label: t(`view.${v}`) }))}
        />
        <Field label={t('status')}>
          {(p) => (
            <Select {...p} value={status} onChange={(e) => setStatus(e.target.value as Announcement['status'] | '')}>
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
        <Button icon={<Plus aria-hidden />} onClick={() => setCreating('works')}>
          {t('newWorks')}
        </Button>
        <Button variant="primary" icon={<Plus aria-hidden />} onClick={() => setCreating('general')}>
          {t('newAnnouncement')}
        </Button>
      </div>
      <Card flush>
        <QueryState query={list}>
          <DataTable<Announcement>
            rows={list.rows}
            rowKey={(a) => a.id}
            empty={t('empty')}
            emptyHint={t('emptyHint')}
            columns={[
              {
                key: 'title',
                header: t('col.announcement'),
                cell: (a) => (
                  <span className="stack stack--sm">
                    <Link className="table__link" href={`/announcements/${a.id}`}>
                      <TwoLanguages en={a.titleEn} ar={a.titleAr} strong />
                    </Link>
                    <span className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
                      {a.kind === 'works' ? <Badge plain>{t('works')}</Badge> : null}
                      {a.priority === 'important' ? <Badge tone="terracotta">{t('important')}</Badge> : null}
                      {a.pinned ? <Badge tone="green">{t('pinned')}</Badge> : null}
                      {a.editedAt ? <Badge plain>{t('edited')}</Badge> : null}
                    </span>
                  </span>
                ),
              },
              { key: 'status', header: t('col.status'), cell: (a) => <StatusBadge status={a.status} /> },
              { key: 'audience', header: t('col.audience'), cell: (a) => audienceText(a.audience, tc, fmt) },
              {
                key: 'when',
                header: t('col.published'),
                cell: (a) =>
                  a.publishAt ? (
                    <span style={{ whiteSpace: 'nowrap' }}>{fmt.dateTime(a.publishAt)}</span>
                  ) : (
                    <span className="t-secondary">{t('notYet')}</span>
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
