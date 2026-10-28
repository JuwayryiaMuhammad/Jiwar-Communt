'use client';

import { formatDateTime, humanize, REASON_CODES, relativeTime, unwrap } from '@jiwar/api';
import { ErrorAlert, LoadMore, QueryState, useAction, useCursorList } from '@jiwar/api/react';
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
  useToast,
} from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { useState } from 'react';
import { personName, postName } from '@/components/security/logic';
import { NewTaskDialog } from '@/components/security/new-task-dialog';
import { api } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys, type GuardTask, type GuardTaskStatus } from '@/lib/queries';

const VIEWS = ['open', 'in_progress', 'done', 'cancelled', 'all'] as const;
type View = (typeof VIEWS)[number];


function TaskDetail({ id, onClose }: { id: string; onClose: () => void }) {
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
        toast.show('Task cancelled.');
        setCancelling(false);
      },
    },
  );
  const t = task.data;
  const live = t?.status === 'open' || t?.status === 'in_progress';
  return (
    <>
      <Dialog
        open={!cancelling}
        wide
        onClose={onClose}
        title={t ? (t.title ?? `Inspect unit ${t.unit?.unitCode ?? ''}`) : 'Task'}
        footer={
          <>
            {live ? <Button onClick={() => setCancelling(true)}>Cancel task</Button> : null}
            <Button onClick={onClose}>Done</Button>
          </>
        }
      >
        <QueryState query={task} rows={4}>
          {t ? (
            <dl className="dl">
              <dt>Status</dt>
              <dd>
                <StatusBadge status={t.status} />
                {t.outcome ? <span className="t-secondary"> · {humanize(t.outcome)}</span> : null}
                {t.cancelReason ? <span className="t-secondary"> · {humanize(t.cancelReason)}</span> : null}
              </dd>
              <dt>For</dt>
              <dd>{t.assignee ? personName(t.assignee) : postName(t.post)}</dd>
              {t.details ? (
                <>
                  <dt>Details</dt>
                  <dd>{t.details}</dd>
                </>
              ) : null}
              <dt>Taken by</dt>
              <dd>{t.takenBy ? `${personName(t.takenBy)} · ${t.takenAt ? formatDateTime(t.takenAt) : ''}` : '—'}</dd>
              {t.resultNote ? (
                <>
                  <dt>Guard’s note</dt>
                  <dd>{t.resultNote}</dd>
                </>
              ) : null}
              <dt>Given by</dt>
              <dd>
                {personName(t.createdBy)} · {formatDateTime(t.createdAt)}
              </dd>
              {t.photos.length ? (
                <>
                  <dt>Photos</dt>
                  <dd className="row">
                    {t.photos.map((p, i) => (
                      <a key={p.url} className="btn btn--secondary btn--sm" href={p.url} target="_blank" rel="noreferrer">
                        Photo {i + 1}
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
        title="Cancel this task?"
        codes={REASON_CODES.guardTaskCancel}
        confirmLabel="Cancel task"
        pending={cancel.isPending}
        error={<ErrorAlert error={cancel.error} />}
        onConfirm={(reasonCode) => cancel.mutate(reasonCode)}
      />
    </>
  );
}

/** Work for the guards (ADR 0050): closed-unit inspections and tasks of the management's words. */
export default function GuardTasksPage() {
  const { ready, can } = usePermissions();
  const allowed = can('guard_tasks.manage');
  const [view, setView] = useState<View>('open');
  const [adding, setAdding] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const status: GuardTaskStatus | '' = view === 'all' ? '' : view;
  const list = useCursorList(keys.guardTasks({ status }), (c) => fetchers.guardTasks({ status }, c), { enabled: allowed });
  if (ready && !allowed)
    return (
      <>
        <PageHeader title="Guard tasks" />
        <ForbiddenState />
      </>
    );
  return (
    <>
      <PageHeader title="Guard tasks" description="A task left open at a shift’s end moves to the shift’s post for the next guard." />
      <div className="toolbar">
        <Segmented<View>
          label="Tasks shown"
          value={view}
          onChange={setView}
          options={[
            { value: 'open', label: 'Open' },
            { value: 'in_progress', label: 'In progress' },
            { value: 'done', label: 'Done' },
            { value: 'cancelled', label: 'Cancelled' },
            { value: 'all', label: 'All' },
          ]}
        />
        <Button variant="primary" icon={<Plus aria-hidden />} onClick={() => setAdding(true)}>
          New task
        </Button>
      </div>
      <Card flush>
        <QueryState query={list}>
          <DataTable<GuardTask>
            rows={list.rows}
            rowKey={(t) => t.id}
            empty="No task"
            columns={[
              {
                key: 'task',
                header: 'Task',
                cell: (t) => (
                  <Button variant="text" className="table__link" onClick={() => setOpen(t.id)}>
                    {t.title ?? `Inspect unit ${t.unit?.unitCode ?? ''}`}
                  </Button>
                ),
              },
              { key: 'for', header: 'For', cell: (t) => (t.assignee ? personName(t.assignee) : postName(t.post)) },
              {
                key: 'status',
                header: 'Status',
                cell: (t) => (
                  <span className="row">
                    <StatusBadge status={t.status} />
                    {t.carried ? <Badge tone="beige">Carried</Badge> : null}
                  </span>
                ),
              },
              { key: 'due', header: 'Due', cell: (t) => (t.dueAt ? formatDateTime(t.dueAt) : '—') },
              { key: 'when', header: 'Given', cell: (t) => <span title={formatDateTime(t.createdAt)}>{relativeTime(t.createdAt)}</span> },
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

