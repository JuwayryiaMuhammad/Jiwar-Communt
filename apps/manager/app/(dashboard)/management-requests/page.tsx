'use client';

import { formatDateTime, humanize, relativeTime } from '@jiwar/api';
import { LoadMore, QueryState, useCursorList } from '@jiwar/api/react';
import { Badge, Button, Card, DataTable, Field, ForbiddenState, PageHeader, Segmented, Select, StatusBadge, useToast } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { HandlerPicker, personName, ResponseBadges, TYPE_TEXT } from '@/components/management-requests/bits';
import { emptyText, filtersFor, type View } from '@/components/management-requests/logic';
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

const STATUSES: ManagementRequestStatus[] = ['open', 'in_progress', 'answered', 'closed'];
const TYPES: ManagementRequestType[] = ['question', 'general', 'appointment'];

/**
 * The compound's requests to the management (ADR 0039), by last activity.
 * A view narrows who has them and what is late; the selects narrow the
 * rest. Every filter is applied by the API, so each page is full.
 */
export default function ManagementRequestsPage() {
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
        title="Management requests"
        description="What residents ask the management: questions, general matters and appointments. Each one is private to the resident who wrote it."
      />
      <div className="toolbar">
        <Segmented<View>
          label="Requests shown"
          value={view}
          onChange={setView}
          options={[
            { value: 'open', label: 'Open' },
            { value: 'mine', label: 'Assigned to me' },
            { value: 'unassigned', label: 'Unassigned' },
            { value: 'overdue', label: 'Overdue' },
            { value: 'escalated', label: 'Escalated' },
            { value: 'all', label: 'All' },
          ]}
        />
        <Field label="Status">
          {(p) => (
            <Select {...p} value={status} onChange={(e) => setStatus(e.target.value as ManagementRequestStatus | '')}>
              <option value="">Any status</option>
              {STATUSES.map((s) => (
                <option key={s} value={s}>
                  {humanize(s)}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Topic">
          {(p) => (
            <Select {...p} value={topicId} onChange={(e) => setTopicId(e.target.value)}>
              <option value="">Any topic</option>
              {(topics.data?.data ?? []).map((t) => (
                <option key={t.id} value={t.id}>
                  {t.nameEn}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Type">
          {(p) => (
            <Select {...p} value={type} onChange={(e) => setType(e.target.value as ManagementRequestType | '')}>
              <option value="">Any type</option>
              {TYPES.map((t) => (
                <option key={t} value={t}>
                  {TYPE_TEXT[t]}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Assignee">
          {(p) => (
            <HandlerPicker
              {...p}
              placeholder="Anyone"
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
            New request
          </Button>
        ) : null}
      </div>
      <Card flush>
        <QueryState query={list}>
          <DataTable<ManagementRequest>
            rows={list.rows}
            rowKey={(r) => r.id}
            empty={emptyText(view)}
            columns={[
              {
                key: 'number',
                header: 'Request',
                cell: (r) => (
                  <span className="stack stack--sm">
                    <span className="row">
                      <Link className="table__link t-mono" style={{ whiteSpace: 'nowrap' }} href={`/management-requests/${r.id}`}>
                        {r.number}
                      </Link>
                      {r.type !== 'general' ? <Badge plain>{TYPE_TEXT[r.type]}</Badge> : null}
                      {r.openedBy ? <Badge plain>On behalf</Badge> : null}
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
                header: 'Resident',
                cell: (r) => (
                  <span className="stack stack--sm">
                    {personName(r.author)}
                    {r.unit ? <span className="t-secondary">Unit {r.unit.code}</span> : null}
                  </span>
                ),
              },
              { key: 'topic', header: 'Topic', cell: (r) => r.topic.nameEn },
              { key: 'status', header: 'Status', cell: (r) => <StatusBadge status={r.status} /> },
              {
                key: 'assignee',
                header: 'Assignee',
                cell: (r) => (r.assignee ? personName(r.assignee) : <span className="t-secondary">Unassigned</span>),
              },
              { key: 'response', header: 'Response', cell: (r) => <ResponseBadges request={r} /> },
              {
                key: 'activity',
                header: 'Last activity',
                cell: (r) => (
                  <span title={formatDateTime(r.lastActivityAt)} style={{ whiteSpace: 'nowrap' }}>
                    {relativeTime(r.lastActivityAt)}
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
          toast.show(`Request ${request.number} is open.`);
          router.push(`/management-requests/${request.id}`);
        }}
      />
    </>
  );
}
