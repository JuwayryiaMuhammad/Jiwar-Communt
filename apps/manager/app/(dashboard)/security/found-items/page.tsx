'use client';

import { unwrap } from '@jiwar/api';
import { ErrorAlert, fieldError, LoadMore, QueryState, useAction, useCursorList } from '@jiwar/api/react';
import { useFormat, useLocale, useT } from '@jiwar/i18n';
import {
  Button,
  Card,
  DataTable,
  Dialog,
  Field,
  ForbiddenState,
  Input,
  PageHeader,
  Segmented,
  StatusBadge,
  Textarea,
  useCommonT,
  useToast,
} from '@jiwar/ui';
import Link from 'next/link';
import { Plus } from 'lucide-react';
import { useState } from 'react';
import { nameIn, personNameIn, postNameIn } from '@/components/security/logic';
import { api } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys, type FoundItem, type FoundItemStatus } from '@/lib/queries';
import ar from '@/messages/ar/sec-found-items';
import en from '@/messages/en/sec-found-items';

const VIEWS = ['at_gate', 'with_management', 'claimed', 'all'] as const;
type View = (typeof VIEWS)[number];

function RegisterDialog({ onClose }: { onClose: () => void }) {
  const t = useT(en, ar);
  const c = useCommonT();
  const toast = useToast();
  const [description, setDescription] = useState('');
  const [location, setLocation] = useState('');
  const [idempotencyKey] = useState(() => crypto.randomUUID());
  const save = useAction(
    () =>
      unwrap(
        api.POST('/api/v1/staff/security/found-items', {
          params: { header: { 'Idempotency-Key': idempotencyKey } },
          body: { description: description.trim(), ...(location.trim() ? { location: location.trim() } : {}) },
        }),
      ),
    {
      invalidate: [keys.foundItemsAll],
      onDone: () => {
        toast.show(t('registered'));
        onClose();
      },
    },
  );
  return (
    <Dialog
      open
      onClose={onClose}
      title={t('registerTitle')}
      description={t('registerDescription')}
      onSubmit={() => save.mutate(undefined)}
      footer={
        <>
          <Button onClick={onClose}>{c('cancel')}</Button>
          <Button type="submit" variant="primary" loading={save.isPending} disabled={!description.trim()}>
            {t('register')}
          </Button>
        </>
      }
    >
      <div className="form">
        <Field label={t('what')} error={fieldError(save.error, 'description')}>
          {(p) => <Textarea {...p} rows={3} maxLength={500} value={description} onChange={(e) => setDescription(e.target.value)} />}
        </Field>
        <Field label={t('whereFound')} error={fieldError(save.error, 'location')}>
          {(p) => <Input {...p} maxLength={120} value={location} onChange={(e) => setLocation(e.target.value)} />}
        </Field>
        <ErrorAlert error={save.error} />
      </div>
    </Dialog>
  );
}

function ClaimDialog({ item, onClose }: { item: FoundItem; onClose: () => void }) {
  const t = useT(en, ar);
  const c = useCommonT();
  const toast = useToast();
  const [unitCode, setUnitCode] = useState('');
  const [name, setName] = useState('');
  const [note, setNote] = useState('');
  const claim = useAction(
    () =>
      unwrap(
        api.POST('/api/v1/staff/security/found-items/{id}/claim', {
          params: { path: { id: item.id } },
          body: {
            ...(unitCode.trim() ? { unitCode: unitCode.trim() } : {}),
            ...(name.trim() ? { name: name.trim() } : {}),
            ...(note.trim() ? { note: note.trim() } : {}),
          },
        }),
      ),
    {
      invalidate: [keys.foundItemsAll],
      onDone: () => {
        toast.show(t('claimed'));
        onClose();
      },
    },
  );
  return (
    <Dialog
      open
      onClose={onClose}
      title={t('claimTitle')}
      description={t('claimDescription')}
      onSubmit={() => claim.mutate(undefined)}
      footer={
        <>
          <Button onClick={onClose}>{c('cancel')}</Button>
          <Button type="submit" variant="primary" loading={claim.isPending} disabled={!unitCode.trim() && !name.trim()}>
            {t('recordClaim')}
          </Button>
        </>
      }
    >
      <div className="form">
        <Field label={t('unitCode')} error={fieldError(claim.error, 'unitCode')}>
          {(p) => <Input {...p} maxLength={40} value={unitCode} onChange={(e) => setUnitCode(e.target.value)} />}
        </Field>
        <Field label={c('name')} error={fieldError(claim.error, 'name')}>
          {(p) => <Input {...p} maxLength={80} value={name} onChange={(e) => setName(e.target.value)} />}
        </Field>
        <Field label={c('note')} error={fieldError(claim.error, 'note')}>
          {(p) => <Input {...p} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} />}
        </Field>
        <ErrorAlert error={claim.error} />
      </div>
    </Dialog>
  );
}

/**
 * The gate's lost-and-found register (ADR 0050): what security found or
 * was handed. The residents' board is the neighbours' lost and found.
 */
export default function FoundItemsPage() {
  const t = useT(en, ar);
  const c = useCommonT();
  const f = useFormat();
  const { locale } = useLocale();
  const toast = useToast();
  const { ready, can } = usePermissions();
  const allowed = can('found_items.manage');
  const [view, setView] = useState<View>('at_gate');
  const [registering, setRegistering] = useState(false);
  const [claiming, setClaiming] = useState<FoundItem | null>(null);
  const status: FoundItemStatus | '' = view === 'all' ? '' : view;
  const list = useCursorList(keys.foundItems(status), (c) => fetchers.foundItems(status, c), { enabled: allowed });
  const receive = useAction(
    (i: FoundItem) => unwrap(api.POST('/api/v1/staff/security/found-items/{id}/receive', { params: { path: { id: i.id } } })),
    { invalidate: [keys.foundItemsAll], onDone: () => toast.show(t('received')) },
  );
  if (ready && !allowed)
    return (
      <>
        <PageHeader title={t('title')} />
        <ForbiddenState />
      </>
    );
  return (
    <>
      <PageHeader
        title={t('title')}
        description={
          <>
            {t('descriptionBefore')}
            {can('neighbours.handle') ? <Link href="/lost-found">{t('board')}</Link> : t('board')}
            {'.'}
          </>
        }
      />
      <div className="toolbar">
        <Segmented<View>
          label={t('shown')}
          value={view}
          onChange={setView}
          options={[
            { value: 'at_gate', label: t('view.at_gate') },
            { value: 'with_management', label: t('view.with_management') },
            { value: 'claimed', label: t('view.claimed') },
            { value: 'all', label: c('all') },
          ]}
        />
        <Button variant="primary" icon={<Plus aria-hidden />} onClick={() => setRegistering(true)}>
          {t('register')}
        </Button>
      </div>
      <ErrorAlert error={receive.error} />
      <Card flush>
        <QueryState query={list}>
          <DataTable<FoundItem>
            rows={list.rows}
            rowKey={(i) => i.id}
            empty={t('empty')}
            columns={[
              { key: 'what', header: t('col.what'), cell: (i) => <span className="table__primary">{i.description}</span> },
              {
                key: 'where',
                header: t('col.where'),
                cell: (i) => [i.place ? nameIn(i.place, locale) : null, i.location].filter(Boolean).join(' · ') || '—',
              },
              { key: 'found', header: t('col.found'), cell: (i) => <span title={f.dateTime(i.foundAt)}>{f.relative(i.foundAt)}</span> },
              {
                key: 'by',
                header: t('col.by'),
                cell: (i) => `${personNameIn(i.registeredBy, locale)}${i.registeredAt ? ` · ${postNameIn(i.registeredAt, locale)}` : ''}`,
              },
              {
                key: 'status',
                header: c('status'),
                cell: (i) => (
                  <span className="row">
                    <StatusBadge status={i.status} />
                    {i.claim ? <span className="t-secondary">{[i.claim.unitCode, i.claim.name].filter(Boolean).join(' · ')}</span> : null}
                  </span>
                ),
              },
              {
                key: 'actions',
                header: <span className="visually-hidden">{c('actions')}</span>,
                className: 'table__actions',
                cell: (i) =>
                  i.status === 'claimed' ? null : (
                    <span className="row" style={{ justifyContent: 'flex-end' }}>
                      {i.status === 'at_gate' ? (
                        <Button size="sm" loading={receive.isPending && receive.variables?.id === i.id} onClick={() => receive.mutate(i)}>
                          {t('receivedButton')}
                        </Button>
                      ) : null}
                      <Button size="sm" onClick={() => setClaiming(i)}>
                        {t('claimedButton')}
                      </Button>
                    </span>
                  ),
              },
            ]}
          />
          <LoadMore query={list} />
        </QueryState>
      </Card>
      {registering ? <RegisterDialog onClose={() => setRegistering(false)} /> : null}
      {claiming ? <ClaimDialog item={claiming} onClose={() => setClaiming(null)} /> : null}
    </>
  );
}
