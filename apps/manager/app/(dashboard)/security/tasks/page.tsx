'use client';

import { REASON_CODES, unwrap } from '@jiwar/api';
import { ErrorAlert, LoadMore, QueryState, useAction, useCursorList } from '@jiwar/api/react';
import { useFormat, useLocale, useT } from '@jiwar/i18n';
import {
  Badge,
  Button,
  Card,
  DataTable,
  Dialog,
  ForbiddenState,
  PageHeader,
  ReasonCodeDialog,
  Segmented,
  StatusBadge,
  useCommonT,
  useLabel,
  useToast,
} from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { useState } from 'react';
import { personNameIn, postNameIn } from '@/components/security/logic';
import { NewTaskDialog } from '@/components/security/new-task-dialog';
import { api } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys, type GuardTask, type GuardTaskStatus } from '@/lib/queries';
import ar from '@/messages/ar/sec-tasks';
import en from '@/messages/en/sec-tasks';

const VIEWS = ['open', 'in_progress', 'done', 'cancelled', 'all'] as const;
type View = (typeof VIEWS)[number];

function TaskDetail({ id, onClose }: { id: string; onClose: () => void }) {
  const t = useT(en, ar);
  const c = useCommonT();
  const f = useFormat();
  const label = useLabel();
  const { locale } = useLocale();
  const toast = useToast();
  const task = useQuery({ queryKey: keys.guardTask(id), queryFn: () => fetchers.guardTask(id) });
  const [cancelling, setCancelling] = useState(false);
  const cancel = useAction(
    (reasonCode: string) =>
      unwrap(
        api.POST('/api/v1/staff/security/tasks/{id}/cancel', {
          params: { path: { id } },
          body: { reasonCode: reasonCode as (typeof REASON_CODES.guardTaskCancel)[number] },
        }),
      ),
    {
      invalidate: [keys.guardTasksAll],
      onDone: () => {
        toast.show(t('cancelled'));
        setCancelling(false);
      },
    },
  );
  const k = task.data;
  const live = k?.status === 'open' || k?.status === 'in_progress';
  return (
    <>
      <Dialog
        open={!cancelling}
        wide
        onClose={onClose}
        title={k ? (k.title ?? t('inspectUnit', { code: k.unit?.unitCode ?? '' })) : t('detailTitle')}
        footer={
          <>
            {live ? <Button onClick={() => setCancelling(true)}>{t('cancelTask')}</Button> : null}
            <Button onClick={onClose}>{c('close')}</Button>
          </>
        }
      >
        <QueryState query={task} rows={4}>
          {k ? (
            <dl className="dl">
              <dt>{c('status')}</dt>
              <dd>
                <StatusBadge status={k.status} />
                {k.outcome ? <span className="t-secondary"> · {label(k.outcome)}</span> : null}
                {k.cancelReason ? <span className="t-secondary"> · {label(k.cancelReason)}</span> : null}
              </dd>
              <dt>{t('forLabel')}</dt>
              <dd>{k.assignee ? personNameIn(k.assignee, locale) : postNameIn(k.post, locale)}</dd>
              {k.details ? (
                <>
                  <dt>{c('details')}</dt>
                  <dd>{k.details}</dd>
                </>
              ) : null}
              <dt>{t('takenBy')}</dt>
              <dd>{k.takenBy ? `${personNameIn(k.takenBy, locale)} · ${k.takenAt ? f.dateTime(k.takenAt) : ''}` : '—'}</dd>
              {k.resultNote ? (
                <>
                  <dt>{t('guardNote')}</dt>
                  <dd>{k.resultNote}</dd>
                </>
              ) : null}
              <dt>{t('givenBy')}</dt>
              <dd>
                {personNameIn(k.createdBy, locale)} · {f.dateTime(k.createdAt)}
              </dd>
              {k.photos.length ? (
                <>
                  <dt>{t('photos')}</dt>
                  <dd className="row">
                    {k.photos.map((p, i) => (
                      <a key={p.url} className="btn btn--secondary btn--sm" href={p.url} target="_blank" rel="noreferrer">
                        {t('photo', { n: f.number(i + 1) })}
                      </a>
                    ))}
                  </dd>
                </>
              ) : null}
            </dl>
          ) : null}
        </QueryState>
      </Dialog>
      <ReasonCodeDialog
        open={cancelling}
        onClose={() => setCancelling(false)}
        title={t('cancelTitle')}
        codes={REASON_CODES.guardTaskCancel}
        confirmLabel={t('cancelTask')}
        pending={cancel.isPending}
        error={<ErrorAlert error={cancel.error} />}
        onConfirm={(reasonCode) => cancel.mutate(reasonCode)}
      />
    </>
  );
}

/** Work for the guards (ADR 0050): closed-unit inspections and tasks of the management's words. */
export default function GuardTasksPage() {
  const t = useT(en, ar);
  const c = useCommonT();
  const f = useFormat();
  const { locale } = useLocale();
  const { ready, can } = usePermissions();
  const allowed = can('guard_tasks.manage');
  const [view, setView] = useState<View>('open');
  const [adding, setAdding] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const status: GuardTaskStatus | '' = view === 'all' ? '' : view;
  const list = useCursorList(keys.guardTasks({ status }), (cursor) => fetchers.guardTasks({ status }, cursor), { enabled: allowed });
  if (ready && !allowed)
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
        <Segmented<View>
          label={t('shown')}
          value={view}
          onChange={setView}
          options={[
            { value: 'open', label: t('view.open') },
            { value: 'in_progress', label: t('view.in_progress') },
            { value: 'done', label: t('view.done') },
            { value: 'cancelled', label: t('view.cancelled') },
            { value: 'all', label: c('all') },
          ]}
        />
        <Button variant="primary" icon={<Plus aria-hidden />} onClick={() => setAdding(true)}>
          {t('newTask')}
        </Button>
      </div>
      <Card flush>
        <QueryState query={list}>
          <DataTable<GuardTask>
            rows={list.rows}
            rowKey={(k) => k.id}
            empty={t('empty')}
            columns={[
              {
                key: 'task',
                header: t('col.task'),
                cell: (k) => (
                  <Button variant="text" className="table__link" onClick={() => setOpen(k.id)}>
                    {k.title ?? t('inspectUnit', { code: k.unit?.unitCode ?? '' })}
                  </Button>
                ),
              },
              { key: 'for', header: t('col.for'), cell: (k) => (k.assignee ? personNameIn(k.assignee, locale) : postNameIn(k.post, locale)) },
              {
                key: 'status',
                header: c('status'),
                cell: (k) => (
                  <span className="row">
                    <StatusBadge status={k.status} />
                    {k.carried ? <Badge tone="beige">{t('carried')}</Badge> : null}
                  </span>
                ),
              },
              { key: 'due', header: t('col.due'), cell: (k) => (k.dueAt ? f.dateTime(k.dueAt) : '—') },
              { key: 'when', header: t('col.given'), cell: (k) => <span title={f.dateTime(k.createdAt)}>{f.relative(k.createdAt)}</span> },
            ]}
          />
          <LoadMore query={list} />
        </QueryState>
      </Card>
      {adding ? <NewTaskDialog onClose={() => setAdding(false)} /> : null}
      {open ? <TaskDetail id={open} onClose={() => setOpen(null)} /> : null}
    </>
  );
}
