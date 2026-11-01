'use client';

import { formatDateTime, unwrap, type Schema } from '@jiwar/api';
import { ErrorAlert, QueryState, useAction } from '@jiwar/api/react';
import { Badge, Button, Card, Checkbox, DataTable, PageHeader, Segmented, Select, useToast } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useState } from 'react';
import { INBOX_TYPE, inboxLabel, waited } from '@/components/inbox/inbox-types';
import { api } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';
import { useNow } from '@/lib/use-now';

type Item = Schema<'InboxItemView'>;
type InboxType = Item['type'];
const KEY = ['staff-inbox'] as const;

/**
 * Everything that waits for my decision (ADR 0073), oldest first, with how
 * long it has waited and when it is due. Each row opens its own page; the
 * ones whose approval takes no input may be approved together.
 */
export default function InboxPage() {
  const toast = useToast();
  const { can } = usePermissions();
  const now = useNow(60_000);
  const [type, setType] = useState<InboxType | ''>('');
  const [when, setWhen] = useState<'all' | 'overdue'>('all');
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const count = useQuery({
    queryKey: [...KEY, 'count'],
    queryFn: () => unwrap(api.GET('/api/v1/staff/inbox/count')),
    refetchInterval: 60_000,
  });
  const list = useQuery({
    queryKey: [...KEY, type, when],
    queryFn: () =>
      unwrap(
        api.GET('/api/v1/staff/inbox', {
          params: { query: { limit: 100, ...(type ? { type } : {}), ...(when === 'overdue' ? { overdue: 'true' } : {}) } },
        }),
      ),
    refetchInterval: 60_000,
  });
  const key = (i: Item) => `${i.type}:${i.id}`;
  const bulk = useAction(
    (items: Item[]) =>
      unwrap(
        api.POST('/api/v1/staff/inbox/bulk-approve', {
          body: { items: items.map((i) => ({ type: i.type, id: i.id })) },
        }),
      ),
    {
      invalidate: [KEY],
      onDone: (res) => {
        const failed = res.data.filter((o) => o.outcome === 'failed').length;
        toast.show(failed ? `Approved ${res.data.length - failed}; ${failed} could not be.` : `Approved ${res.data.length}.`);
        setPicked(new Set());
      },
    },
  );
  const rows = list.data?.data ?? [];
  const chosen = rows.filter((i) => picked.has(key(i)));
  const toggle = (i: Item, on: boolean) =>
    setPicked((p) => {
      const next = new Set(p);
      if (on) next.add(key(i));
      else next.delete(key(i));
      return next;
    });

  return (
    <>
      <PageHeader
        title="Inbox"
        description={
          count.data
            ? `${count.data.total} waiting, ${count.data.overdue} past their due time. Each opens on its own page; due times are set in the inbox settings.`
            : 'What waits for your decision, across the compound.'
        }
        actions={
          <>
            {can('settings.manage') ? (
              <Link className="btn" href="/inbox/settings">
                Due times
              </Link>
            ) : null}
            <Button variant="primary" disabled={!chosen.length} loading={bulk.isPending} onClick={() => bulk.mutate(chosen)}>
              Approve selected
            </Button>
          </>
        }
      />
      <div style={{ display: 'flex', gap: 12, marginBottom: 12 }}>
        <Select aria-label="Type" value={type} onChange={(e) => setType(e.target.value as InboxType | '')}>
          <option value="">Every type</option>
          {(count.data?.types ?? []).map((t) => (
            <option key={t.type} value={t.type}>
              {inboxLabel(t.type)} ({t.total})
            </option>
          ))}
        </Select>
        <Segmented
          label="When"
          value={when}
          onChange={setWhen}
          options={[
            { value: 'all', label: 'All' },
            { value: 'overdue', label: 'Overdue' },
          ]}
        />
      </div>
      <ErrorAlert error={bulk.error} />
      <Card flush>
        <QueryState query={list}>
          <DataTable<Item>
            rows={rows}
            rowKey={key}
            empty="Nothing waits for you"
            emptyHint="Requests, permits, appeals and the rest appear here as they come in."
            columns={[
              {
                key: 'pick',
                header: '',
                cell: (i) =>
                  i.bulk ? (
                    <Checkbox
                      label=""
                      aria-label={`Select ${inboxLabel(i.type)}`}
                      checked={picked.has(key(i))}
                      onChange={(e) => toggle(i, e.target.checked)}
                    />
                  ) : null,
              },
              {
                key: 'type',
                header: 'What',
                cell: (i) => (
                  <Link className="table__link" href={INBOX_TYPE[i.type]?.href(i.id) ?? '/'}>
                    {inboxLabel(i.type)}
                    {i.number ? ` ${i.number}` : ''}
                  </Link>
                ),
              },
              { key: 'kind', header: 'Kind', cell: (i) => i.kind ?? '—' },
              { key: 'age', header: 'Waited', cell: (i) => waited(i.requestedAt, now) },
              {
                key: 'due',
                header: 'Due',
                cell: (i) => (i.overdue ? <Badge tone="error">Overdue</Badge> : formatDateTime(i.dueAt)),
              },
              {
                key: 'who',
                header: 'Decides',
                cell: (i) =>
                  i.authority?.decider === 'board' ? (
                    <Badge tone="beige">The board (above {i.authority.limit} EGP)</Badge>
                  ) : (
                    'You'
                  ),
              },
            ]}
          />
        </QueryState>
      </Card>
    </>
  );
}
