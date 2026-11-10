'use client';

import { unwrap, type Schema } from '@jiwar/api';
import { ErrorAlert, QueryState, useAction } from '@jiwar/api/react';
import { useFormat, useT } from '@jiwar/i18n';
import { Badge, Button, Card, Checkbox, DataTable, PageHeader, Segmented, Select, useCommonT, useLabel, useToast } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useState } from 'react';
import { INBOX_TYPE } from '@/components/inbox/inbox-types';
import { useInboxText } from '@/components/inbox/use-inbox-text';
import { api } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';
import { useNow } from '@/lib/use-now';
import ar from '@/messages/ar/inbox';
import en from '@/messages/en/inbox';

type Item = Schema<'InboxItemView'>;
type InboxType = Item['type'];
const KEY = ['staff-inbox'] as const;

/**
 * Everything that waits for my decision (ADR 0073), oldest first, with how
 * long it has waited and when it is due. Each row opens its own page; the
 * ones whose approval takes no input may be approved together.
 */
export default function InboxPage() {
  const t = useT(en, ar);
  const c = useCommonT();
  const f = useFormat();
  const label = useLabel();
  const text = useInboxText();
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
        toast.show(failed ? t('approvedSome', { ok: res.data.length - failed, failed }) : t('approvedAll', { ok: res.data.length }));
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
        title={t('title')}
        description={
          count.data
            ? t('descriptionCount', { total: count.data.total, overdue: count.data.overdue })
            : t('descriptionEmpty')
        }
        actions={
          <>
            {can('settings.manage') ? (
              <Link className="btn" href="/inbox/settings">
                {t('dueTimes')}
              </Link>
            ) : null}
            <Button variant="primary" disabled={!chosen.length} loading={bulk.isPending} onClick={() => bulk.mutate(chosen)}>
              {t('approveSelected')}
            </Button>
          </>
        }
      />
      <div style={{ display: 'flex', gap: 12, marginBottom: 12 }}>
        <Select aria-label={c('type')} value={type} onChange={(e) => setType(e.target.value as InboxType | '')}>
          <option value="">{t('everyType')}</option>
          {(count.data?.types ?? []).map((x) => (
            <option key={x.type} value={x.type}>
              {text.type(x.type)} ({f.number(x.total)})
            </option>
          ))}
        </Select>
        <Segmented
          label={t('when')}
          value={when}
          onChange={setWhen}
          options={[
            { value: 'all', label: c('all') },
            { value: 'overdue', label: t('overdue') },
          ]}
        />
      </div>
      <ErrorAlert error={bulk.error} />
      <Card flush>
        <QueryState query={list}>
          <DataTable<Item>
            rows={rows}
            rowKey={key}
            empty={t('empty')}
            emptyHint={t('emptyHint')}
            columns={[
              {
                key: 'pick',
                header: '',
                cell: (i) =>
                  i.bulk ? (
                    <Checkbox
                      label=""
                      aria-label={t('selectItem', { what: text.type(i.type) })}
                      checked={picked.has(key(i))}
                      onChange={(e) => toggle(i, e.target.checked)}
                    />
                  ) : null,
              },
              {
                key: 'type',
                header: t('what'),
                cell: (i) => (
                  <Link className="table__link" href={INBOX_TYPE[i.type]?.href(i.id) ?? '/'}>
                    {text.type(i.type)}
                    {i.number ? ` ${i.number}` : ''}
                  </Link>
                ),
              },
              { key: 'kind', header: c('kind'), cell: (i) => (i.kind ? label(i.kind) : '—') },
              { key: 'age', header: t('waited'), cell: (i) => text.waited(i.requestedAt, now) },
              {
                key: 'due',
                header: t('due'),
                cell: (i) => (i.overdue ? <Badge tone="error">{t('overdue')}</Badge> : f.dateTime(i.dueAt)),
              },
              {
                key: 'who',
                header: t('decides'),
                cell: (i) =>
                  i.authority?.decider === 'board' ? (
                    <Badge tone="beige">{t('board', { limit: f.money(i.authority.limit) })}</Badge>
                  ) : (
                    t('you')
                  ),
              },
            ]}
          />
        </QueryState>
      </Card>
    </>
  );
}
