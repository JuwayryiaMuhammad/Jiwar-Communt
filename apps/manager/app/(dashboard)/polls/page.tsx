'use client';

import { LoadMore, QueryState, useCursorList } from '@jiwar/api/react';
import { useFormat, useT } from '@jiwar/i18n';
import { Badge, Button, Card, DataTable, Field, ForbiddenState, PageHeader, Select, StatusBadge, useLabel } from '@jiwar/ui';
import { Plus } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { TwoLanguages } from '@/components/community/bits';
import { audienceText } from '@/components/community/logic';
import { PollDialog } from '@/components/community/poll-dialog';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys, type Poll, type PollFilters } from '@/lib/queries';
import communityAr from '@/messages/ar/community';
import ar from '@/messages/ar/community-polls';
import communityEn from '@/messages/en/community';
import en from '@/messages/en/community-polls';

const STATUSES: Poll['status'][] = ['scheduled', 'open', 'closed', 'cancelled'];

/** The compound's consultative polls (ADR 0040), the newest first. */
export default function PollsPage() {
  const t = useT(en, ar);
  const tc = useT(communityEn, communityAr);
  const fmt = useFormat();
  const label = useLabel();
  const router = useRouter();
  const { can, ready } = usePermissions();
  const [status, setStatus] = useState<Poll['status'] | ''>('');
  const [creating, setCreating] = useState(false);
  const allowed = can('community.publish');
  const filters: PollFilters = { status };
  const list = useCursorList(keys.polls(filters), (c) => fetchers.polls(filters, c), { enabled: allowed, refetchInterval: 60_000 });

  if (ready && !allowed) return <ForbiddenState />;

  return (
    <>
      <PageHeader title={t('title')} description={t('description')} />
      <div className="toolbar">
        <Field label={t('status')}>
          {(p) => (
            <Select {...p} value={status} onChange={(e) => setStatus(e.target.value as Poll['status'] | '')}>
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
          {t('newPoll')}
        </Button>
      </div>
      <Card flush>
        <QueryState query={list}>
          <DataTable<Poll>
            rows={list.rows}
            rowKey={(p) => p.id}
            empty={t('empty')}
            columns={[
              {
                key: 'question',
                header: t('col.question'),
                cell: (p) => (
                  <span className="stack stack--sm">
                    <Link className="table__link" href={`/polls/${p.id}`}>
                      <TwoLanguages en={p.questionEn} ar={p.questionAr} strong />
                    </Link>
                    {p.multiple ? (
                      <span>
                        <Badge plain>{t('several')}</Badge>
                      </span>
                    ) : null}
                  </span>
                ),
              },
              { key: 'status', header: t('col.status'), cell: (p) => <StatusBadge status={p.status} /> },
              {
                key: 'turnout',
                header: t('col.turnout'),
                cell: (p) =>
                  p.turnout === null ? (
                    <span className="t-secondary">{p.resultsHidden === 'few_votes' ? t('fewerThanFive') : t('none')}</span>
                  ) : (
                    fmt.number(p.turnout)
                  ),
              },
              { key: 'closes', header: t('col.closes'), cell: (p) => <span style={{ whiteSpace: 'nowrap' }}>{fmt.dateTime(p.closesAt)}</span> },
              { key: 'audience', header: t('col.audience'), cell: (p) => audienceText(p.audience, tc, fmt) },
            ]}
          />
          <LoadMore query={list} />
        </QueryState>
      </Card>
      {creating ? (
        <PollDialog
          poll={null}
          open
          onClose={() => setCreating(false)}
          onSaved={(id) => {
            setCreating(false);
            router.push(`/polls/${id}`);
          }}
        />
      ) : null}
    </>
  );
}
