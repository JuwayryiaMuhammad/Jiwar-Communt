'use client';

import { LoadMore, QueryState, useCursorList } from '@jiwar/api/react';
import { useFormat, useLocale, useT } from '@jiwar/i18n';
import { Badge, Button, Card, DataTable, Field, ForbiddenState, PageHeader, Segmented, Select, StatusBadge, useCommonT, useLabel, useToast } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { HandlerPicker, ResponseBadges, usePersonName } from '@/components/management-requests/bits';
import { emptyKey, filtersFor, localName, VIEWS, type View } from '@/components/management-requests/logic';
import { NewRequestDialog } from '@/components/management-requests/new-request-dialog';
import { usePermissions } from '@/lib/permissions';
import {
  fetchers,
  keys,
  type ManagementRequest,
  type ManagementRequestFilters,
  type ManagementRequestStatus,
  type ManagementRequestType,
} from '@/lib/queries';
import ar from '@/messages/ar/services-mgmt-requests';
import en from '@/messages/en/services-mgmt-requests';

const STATUSES: ManagementRequestStatus[] = ['open', 'in_progress', 'answered', 'closed'];
const TYPES: ManagementRequestType[] = ['question', 'general', 'appointment'];

/**
 * The compound's requests to the management (ADR 0039), by last activity.
 * A view narrows who has them and what is late; the selects narrow the
 * rest. Every filter is applied by the API, so each page is full.
 */
export default function ManagementRequestsPage() {
  const t = useT(en, ar);
  const c = useCommonT();
  const fmt = useFormat();
  const label = useLabel();
  const { locale } = useLocale();
  const personName = usePersonName();
  const toast = useToast();
  const router = useRouter();
  const { can, ready } = usePermissions();
  const [view, setView] = useState<View>('open');
  const [status, setStatus] = useState<ManagementRequestStatus | ''>('');
  const [type, setType] = useState<ManagementRequestType | ''>('');
  const [topicId, setTopicId] = useState('');
  const [assignee, setAssignee] = useState('');
  const [creating, setCreating] = useState(false);
  const allowed = can('requests.handle');

  const filters = filtersFor(view, { status, type, topicId, assignee }) as ManagementRequestFilters;
  const topics = useQuery({ queryKey: keys.requestTopicOptions, queryFn: fetchers.requestTopicOptions, enabled: allowed });
  const list = useCursorList(keys.managementRequests(filters), (c) => fetchers.managementRequests(filters, c), {
    refetchInterval: 60_000,
    enabled: allowed,
  });

  if (ready && !allowed) return <ForbiddenState />;
  const ownsAssignee = view === 'mine' || view === 'unassigned';

  return (
    <>
      <PageHeader
        title={t('title')}
        description={t('description')}
      />
      <div className="toolbar">
        <Segmented<View>
          label={t('shown')}
          value={view}
          onChange={setView}
          options={VIEWS.map((v) => ({ value: v, label: t(`view.${v}`) }))}
        />
        <Field label={c('status')}>
          {(p) => (
            <Select {...p} value={status} onChange={(e) => setStatus(e.target.value as ManagementRequestStatus | '')}>
              <option value="">{t('anyStatus')}</option>
              {STATUSES.map((s) => (
                <option key={s} value={s}>
                  {label(s)}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label={t('topic')}>
          {(p) => (
            <Select {...p} value={topicId} onChange={(e) => setTopicId(e.target.value)}>
              <option value="">{t('anyTopic')}</option>
              {(topics.data?.data ?? []).map((topic) => (
                <option key={topic.id} value={topic.id}>
                  {localName(locale, topic)}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label={t('type')}>
          {(p) => (
            <Select {...p} value={type} onChange={(e) => setType(e.target.value as ManagementRequestType | '')}>
              <option value="">{t('anyType')}</option>
              {TYPES.map((type) => (
                <option key={type} value={type}>
                  {t(`type.${type}`)}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label={t('assignee')}>
          {(p) => (
            <HandlerPicker
              {...p}
              placeholder={t('anyone')}
              style={{ maxWidth: 220 }}
              value={ownsAssignee ? '' : assignee}
              disabled={ownsAssignee}
              onChange={(e) => setAssignee(e.target.value)}
            />
          )}
        </Field>
        <span className="spacer" />
        {can('residents.read', 'units.read') ? (
          <Button variant="primary" icon={<Plus aria-hidden />} onClick={() => setCreating(true)}>
            {t('newRequest')}
          </Button>
        ) : null}
      </div>
      <Card flush>
        <QueryState query={list}>
          <DataTable<ManagementRequest>
            rows={list.rows}
            rowKey={(r) => r.id}
            empty={t(emptyKey(view))}
            columns={[
              {
                key: 'number',
                header: t('col.request'),
                cell: (r) => (
                  <span className="stack stack--sm">
                    <span className="row">
                      <Link className="table__link t-mono" style={{ whiteSpace: 'nowrap' }} href={`/management-requests/${r.id}`}>
                        {r.number}
                      </Link>
                      {r.type !== 'general' ? <Badge plain>{t(`type.${r.type}`)}</Badge> : null}
                      {r.openedBy ? <Badge plain>{t('onBehalf')}</Badge> : null}
                    </span>
                    {r.preview ? (
                      <span className="t-secondary" style={{ maxWidth: 360, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {r.preview}
                      </span>
                    ) : null}
                  </span>
                ),
              },
              {
                key: 'author',
                header: t('col.resident'),
                cell: (r) => (
                  <span className="stack stack--sm">
                    {personName(r.author)}
                    {r.unit ? <span className="t-secondary">{t('unitCode', { code: r.unit.code })}</span> : null}
                  </span>
                ),
              },
              { key: 'topic', header: t('topic'), cell: (r) => localName(locale, r.topic) },
              { key: 'status', header: c('status'), cell: (r) => <StatusBadge status={r.status} /> },
              {
                key: 'assignee',
                header: t('assignee'),
                cell: (r) => (r.assignee ? personName(r.assignee) : <span className="t-secondary">{t('unassigned')}</span>),
              },
              { key: 'response', header: t('col.response'), cell: (r) => <ResponseBadges request={r} /> },
              {
                key: 'activity',
                header: t('col.activity'),
                cell: (r) => (
                  <span title={fmt.dateTime(r.lastActivityAt)} style={{ whiteSpace: 'nowrap' }}>
                    {fmt.relative(r.lastActivityAt)}
                  </span>
                ),
              },
            ]}
          />
          <LoadMore query={list} />
        </QueryState>
      </Card>
      <NewRequestDialog
        open={creating}
        onClose={() => setCreating(false)}
        onCreated={(request) => {
          setCreating(false);
          toast.show(t('opened', { number: request.number }));
          router.push(`/management-requests/${request.id}`);
        }}
      />
    </>
  );
}
