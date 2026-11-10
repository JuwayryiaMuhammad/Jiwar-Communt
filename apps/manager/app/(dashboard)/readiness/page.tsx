'use client';

import { fieldError, unwrap } from '@jiwar/api';
import { ErrorAlert, LoadMore, QueryState, useAction, useCursorList } from '@jiwar/api/react';
import { useFormat, useT } from '@jiwar/i18n';
import { Button, Card, DataTable, Dialog, Field, ForbiddenState, Input, PageHeader, Select, useCommonT, useLabel, useToast } from '@jiwar/ui';
import Link from 'next/link';
import { useState } from 'react';
import { api } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys, type ReadinessProgram } from '@/lib/queries';
import ar from '@/messages/ar/ops-readiness';
import en from '@/messages/en/ops-readiness';

const KINDS = ['season', 'event', 'emergency'] as const;
const iso = (d: Date) => d.toISOString().slice(0, 10);

function NewProgramDialog({ onClose }: { onClose: () => void }) {
  const t = useT(en, ar);
  const c = useCommonT();
  const label = useLabel();
  const toast = useToast();
  const start = new Date(Date.now() + 30 * 24 * 3_600_000);
  const [f, setF] = useState({
    kind: 'season' as (typeof KINDS)[number],
    title: '',
    startsOn: iso(start),
    endsOn: iso(new Date(start.getTime() + 29 * 24 * 3_600_000)),
  });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const save = useAction(
    () => unwrap(api.POST('/api/v1/maintenance/readiness/programs', { body: { ...f, title: f.title.trim() } })),
    {
      invalidate: [keys.readinessAll],
      onDone: () => {
        toast.show(t('started'));
        onClose();
      },
    },
  );
  return (
    <Dialog
      open
      onClose={onClose}
      title={t('newProgramTitle')}
      description={t('newProgramDescription')}
      onSubmit={() => save.mutate()}
      footer={
        <>
          <Button onClick={onClose}>{c('cancel')}</Button>
          <Button type="submit" variant="primary" loading={save.isPending}>
            {t('start')}
          </Button>
        </>
      }
    >
      <div className="form">
        <ErrorAlert error={save.error} />
        <Field label={t('kind')} error={fieldError(save.error, 'kind')}>
          {(p) => (
            <Select {...p} value={f.kind} onChange={set('kind')}>
              {KINDS.map((k) => (
                <option key={k} value={k}>
                  {label(k)}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label={t('programTitle')} error={fieldError(save.error, 'title')}>
          {(p) => <Input {...p} value={f.title} onChange={set('title')} placeholder={t('titlePlaceholder')} />}
        </Field>
        <div className="form__row">
          <Field label={t('firstDay')} error={fieldError(save.error, 'startsOn')}>
            {(p) => <Input {...p} type="date" value={f.startsOn} onChange={set('startsOn')} />}
          </Field>
          <Field label={t('lastDay')} error={fieldError(save.error, 'endsOn')}>
            {(p) => <Input {...p} type="date" value={f.endsOn} onChange={set('endsOn')} />}
          </Field>
        </div>
      </div>
    </Dialog>
  );
}

/** Readiness programs (ADR 0067): seasons, events and emergencies, prepared item by item. */
export default function ReadinessPage() {
  const t = useT(en, ar);
  const fmt = useFormat();
  const label = useLabel();
  const { ready, can } = usePermissions();
  const [filters, setFilters] = useState<{ kind: ReadinessProgram['kind'] | ''; open: 'true' | 'false' | '' }>({
    kind: '',
    open: 'true',
  });
  const [creating, setCreating] = useState(false);
  const list = useCursorList(keys.readinessPrograms(filters), (c) => fetchers.readinessPrograms(filters, c), {
    enabled: can('readiness.manage'),
  });
  if (ready && !can('readiness.manage'))
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
        description={t('description')}
        actions={
          <Button variant="primary" onClick={() => setCreating(true)}>
            {t('newProgram')}
          </Button>
        }
      />
      <div className="row" style={{ gap: 8, marginBottom: 12 }}>
        <Select
          aria-label={t('kindFilter')}
          value={filters.kind}
          onChange={(e) => setFilters({ ...filters, kind: e.target.value as typeof filters.kind })}
        >
          <option value="">{t('everyKind')}</option>
          {KINDS.map((k) => (
            <option key={k} value={k}>
              {label(k)}
            </option>
          ))}
        </Select>
        <Select
          aria-label={t('openFilter')}
          value={filters.open}
          onChange={(e) => setFilters({ ...filters, open: e.target.value as typeof filters.open })}
        >
          <option value="true">{t('filter.open')}</option>
          <option value="false">{t('filter.closed')}</option>
          <option value="">{t('filter.all')}</option>
        </Select>
      </div>
      <Card flush>
        <QueryState query={list}>
          <DataTable<ReadinessProgram>
            rows={list.rows}
            rowKey={(p) => p.id}
            empty={t('empty')}
            columns={[
              { key: 't', header: t('col.program'), cell: (p) => <Link href={`/readiness/${p.id}`}>{p.title}</Link> },
              { key: 'k', header: t('col.kind'), cell: (p) => label(p.kind) },
              { key: 'd', header: t('col.days'), cell: (p) => t('days', { from: fmt.day(p.startsOn), to: fmt.day(p.endsOn) }) },
              {
                key: 'r',
                header: t('col.ready'),
                cell: (p) => (p.readiness.percent === null ? '—' : fmt.percent(p.readiness.percent / 100)),
              },
              { key: 'o', header: t('col.openItems'), cell: (p) => fmt.number(p.readiness.open) },
              { key: 'b', header: t('col.budget'), cell: (p) => fmt.money(p.readiness.budget) },
              { key: 's', header: t('col.status'), cell: (p) => (p.closedAt ? t('closed') : t('open')) },
            ]}
          />
          <LoadMore query={list} />
        </QueryState>
      </Card>
      {creating ? <NewProgramDialog onClose={() => setCreating(false)} /> : null}
    </>
  );
}
