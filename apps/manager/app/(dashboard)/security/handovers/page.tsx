'use client';

import { unwrap } from '@jiwar/api';
import { ErrorAlert, fieldError, QueryState, useAction } from '@jiwar/api/react';
import { useFormat, useLocale, useT } from '@jiwar/i18n';
import { Button, Card, DataTable, Dialog, Field, ForbiddenState, Input, PageHeader, Segmented, StatusBadge, useCommonT, useToast } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { Suspense, useState } from 'react';
import { DateRange } from '@/components/date-range';
import { addDays, personNameIn, postNameIn, today } from '@/components/security/logic';
import { api } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys, type HandoverItem, type StaffHandover } from '@/lib/queries';
import { useTab } from '@/lib/use-tab';
import ar from '@/messages/ar/sec-handovers';
import en from '@/messages/en/sec-handovers';

const TABS = ['handovers', 'checklist'] as const;
type Tab = (typeof TABS)[number];

function ItemDialog({ item, onClose }: { item: HandoverItem | null; onClose: () => void }) {
  const t = useT(en, ar);
  const c = useCommonT();
  const toast = useToast();
  const [label, setLabel] = useState(item?.label ?? '');
  const [position, setPosition] = useState(String(item?.position ?? 0));
  const body = { label: label.trim(), position: Number(position) };
  const save = useAction(
    () =>
      item
        ? unwrap(api.PATCH('/api/v1/staff/security/handover-items/{id}', { params: { path: { id: item.id } }, body }))
        : unwrap(api.POST('/api/v1/staff/security/handover-items', { body })),
    {
      invalidate: [keys.handoverItems],
      onDone: () => {
        toast.show(item ? t('itemSaved') : t('itemAdded'));
        onClose();
      },
    },
  );
  return (
    <Dialog
      open
      onClose={onClose}
      title={item ? t('editItem') : t('newItem')}
      description={t('itemDescription')}
      onSubmit={() => save.mutate(undefined)}
      footer={
        <>
          <Button onClick={onClose}>{c('cancel')}</Button>
          <Button type="submit" variant="primary" loading={save.isPending} disabled={!label.trim()}>
            {item ? c('save') : t('addItem')}
          </Button>
        </>
      }
    >
      <div className="form">
        <Field label={t('item')} error={fieldError(save.error, 'label')}>
          {(p) => <Input {...p} autoFocus maxLength={120} value={label} onChange={(e) => setLabel(e.target.value)} />}
        </Field>
        <Field label={t('order')} hint={t('orderHint')} error={fieldError(save.error, 'position')}>
          {(p) => <Input {...p} type="number" min={0} max={1000} value={position} onChange={(e) => setPosition(e.target.value)} />}
        </Field>
        <ErrorAlert error={save.error} />
      </div>
    </Dialog>
  );
}

function Checklist() {
  const t = useT(en, ar);
  const c = useCommonT();
  const f = useFormat();
  const toast = useToast();
  const items = useQuery({ queryKey: keys.handoverItems, queryFn: fetchers.handoverItems });
  const [editing, setEditing] = useState<HandoverItem | 'new' | null>(null);
  const toggle = useAction(
    (i: HandoverItem) =>
      unwrap(api.PATCH('/api/v1/staff/security/handover-items/{id}', { params: { path: { id: i.id } }, body: { active: !i.active } })),
    { invalidate: [keys.handoverItems], onDone: (i) => toast.show(i.active ? t('askedAgain') : t('retired')) },
  );
  return (
    <div className="stack">
      <div className="row">
        <p className="t-secondary" style={{ flex: 1 }}>
          {t('checklistNote')}
        </p>
        <Button variant="primary" icon={<Plus aria-hidden />} onClick={() => setEditing('new')}>
          {t('newItemButton')}
        </Button>
      </div>
      <ErrorAlert error={toggle.error} />
      <Card flush>
        <QueryState query={items}>
          <DataTable<HandoverItem>
            rows={items.data?.data}
            rowKey={(i) => i.id}
            empty={t('emptyChecklist')}
            columns={[
              { key: 'label', header: t('item'), cell: (i) => <span className="table__primary">{i.label}</span> },
              { key: 'order', header: t('order'), cell: (i) => <span className="t-num">{f.number(i.position)}</span> },
              { key: 'status', header: c('status'), cell: (i) => <StatusBadge status={i.active ? 'active' : 'inactive'} /> },
              {
                key: 'actions',
                header: <span className="visually-hidden">{c('actions')}</span>,
                className: 'table__actions',
                cell: (i) => (
                  <span className="row" style={{ justifyContent: 'flex-end' }}>
                    <Button size="sm" onClick={() => setEditing(i)}>
                      {c('edit')}
                    </Button>
                    <Button size="sm" loading={toggle.isPending && toggle.variables?.id === i.id} onClick={() => toggle.mutate(i)}>
                      {i.active ? t('retire') : t('restore')}
                    </Button>
                  </span>
                ),
              },
            ]}
          />
        </QueryState>
      </Card>
      {editing ? <ItemDialog item={editing === 'new' ? null : editing} onClose={() => setEditing(null)} /> : null}
    </div>
  );
}

function HandoverDetail({ h, onClose }: { h: StaffHandover; onClose: () => void }) {
  const t = useT(en, ar);
  const c = useCommonT();
  const f = useFormat();
  const { locale } = useLocale();
  return (
    <Dialog
      open
      wide
      onClose={onClose}
      title={t('detailTitle', { post: postNameIn(h.post, locale) })}
      description={f.dateTime(h.createdAt)}
      footer={<Button onClick={onClose}>{c('close')}</Button>}
    >
      <dl className="dl">
        <dt>{t('by')}</dt>
        <dd>{personNameIn(h.guard, locale)}</dd>
        <dt>{c('kind')}</dt>
        <dd>{h.kind === 'system' ? t('systemEnded') : t('handedOver')}</dd>
        <dt>{t('checklist')}</dt>
        <dd>{h.checklist.length ? h.checklist.map((x) => x.label).join(' · ') : '—'}</dd>
        <dt>{c('notes')}</dt>
        <dd>{h.notes ?? '—'}</dd>
        <dt>{t('tasksCarried')}</dt>
        <dd>{f.number(h.carriedTaskIds.length)}</dd>
        <dt>{t('acknowledged')}</dt>
        <dd>{h.acknowledgedAt ? `${personNameIn(h.acknowledgedBy, locale)} · ${f.dateTime(h.acknowledgedAt)}` : t('notYet')}</dd>
      </dl>
    </Dialog>
  );
}

function Handovers() {
  const t = useT(en, ar);
  const c = useCommonT();
  const f = useFormat();
  const { locale } = useLocale();
  const [range, setRange] = useState({ from: addDays(today(), -6), to: today() });
  const [state, setState] = useState<'pending' | 'acknowledged' | ''>('');
  const [open, setOpen] = useState<StaffHandover | null>(null);
  const filters = { ...range, state };
  const list = useQuery({ queryKey: keys.handovers(filters), queryFn: () => fetchers.handovers(filters) });
  return (
    <div className="stack">
      <div className="toolbar">
        <DateRange from={range.from} to={range.to} onChange={(r) => setRange(r)} />
        <Segmented<'pending' | 'acknowledged' | ''>
          label={t('shown')}
          value={state}
          onChange={setState}
          options={[
            { value: '', label: c('all') },
            { value: 'pending', label: t('waiting') },
            { value: 'acknowledged', label: t('acknowledged') },
          ]}
        />
      </div>
      <Card flush>
        <QueryState query={list}>
          <DataTable<StaffHandover>
            rows={list.data?.data}
            rowKey={(h) => h.id}
            empty={t('emptyHandovers')}
            columns={[
              {
                key: 'when',
                header: t('col.when'),
                cell: (h) => (
                  <Button variant="text" className="table__link" onClick={() => setOpen(h)}>
                    {f.dateTime(h.createdAt)}
                  </Button>
                ),
              },
              { key: 'post', header: t('col.post'), cell: (h) => postNameIn(h.post, locale) },
              { key: 'guard', header: t('col.by'), cell: (h) => personNameIn(h.guard, locale) },
              { key: 'kind', header: t('col.kind'), cell: (h) => <StatusBadge status={h.kind === 'system' ? 'closed' : 'done'} /> },
              {
                key: 'ack',
                header: t('acknowledged'),
                cell: (h) => (h.acknowledgedAt ? personNameIn(h.acknowledgedBy, locale) : t('waiting')),
              },
            ]}
          />
        </QueryState>
      </Card>
      {open ? <HandoverDetail h={open} onClose={() => setOpen(null)} /> : null}
    </div>
  );
}

function HandoversView() {
  const t = useT(en, ar);
  const { ready, can } = usePermissions();
  const [tab, setTab] = useTab(TABS, 'handovers');
  if (ready && !can('guard_roster.manage'))
    return (
      <>
        <PageHeader title={t('title')} />
        <ForbiddenState />
      </>
    );
  return (
    <>
      <PageHeader title={t('title')} description={t('description')} />
      <div className="toolbar">
        <Segmented<Tab>
          label={t('title')}
          value={tab}
          onChange={setTab}
          options={[
            { value: 'handovers', label: t('tab.handovers') },
            { value: 'checklist', label: t('tab.checklist') },
          ]}
        />
      </div>
      {tab === 'handovers' ? <Handovers /> : <Checklist />}
    </>
  );
}

export default function HandoversPage() {
  return (
    <Suspense>
      <HandoversView />
    </Suspense>
  );
}
