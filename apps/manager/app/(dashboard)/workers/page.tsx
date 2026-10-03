'use client';

import { formatDate, formatDateTime, humanize, REASON_CODES, relativeTime, shortId, unwrap } from '@jiwar/api';
import { ErrorAlert, LoadMore, QueryState, useAction, useCursorList } from '@jiwar/api/react';
import {
  Badge,
  Button,
  Card,
  ConfirmDialog,
  DataTable,
  Field,
  PageHeader,
  ReasonDialog,
  Segmented,
  Select,
  StatusBadge,
  useToast,
} from '@jiwar/ui';
import { Suspense, useState } from 'react';
import { AccessCodeDialog, EngagementReview } from '@/components/engagement-review';
import { api } from '@/lib/api';
import {
  fetchers,
  keys,
  type CardIncident,
  type ComplianceCase,
  type Engagement,
  type EngagementStatus,
} from '@/lib/queries';
import { useTab } from '@/lib/use-tab';
import type { Schema } from '@jiwar/api';

const TABS = ['review', 'all', 'compliance', 'incidents'] as const;
type Tab = (typeof TABS)[number];

function EngagementTable({
  rows,
  onOpen,
  actions,
  empty,
  emptyHint,
}: {
  rows: Engagement[] | undefined;
  onOpen: (e: Engagement) => void;
  actions?: (e: Engagement) => React.ReactNode;
  empty: string;
  emptyHint?: string;
}) {
  return (
    <DataTable<Engagement>
      rows={rows}
      rowKey={(e) => e.id}
      empty={empty}
      emptyHint={emptyHint}
      columns={[
        {
          key: 'name',
          header: 'Worker',
          cell: (e) => (
            <Button variant="text" className="table__link" onClick={() => onOpen(e)}>
              {e.workerName}
            </Button>
          ),
        },
        { key: 'capacity', header: 'Capacity', cell: (e) => humanize(e.capacity) },
        { key: 'unit', header: 'Unit', cell: (e) => e.unitCode },
        {
          key: 'doc',
          header: 'Document',
          cell: (e) => (
            <span className="row">
              {humanize(e.idDocumentType)}
              {e.idDocumentType === 'passport' && !e.birthDateVerified ? (
                <Badge tone="terracotta">Birth date to confirm</Badge>
              ) : null}
            </span>
          ),
        },
        { key: 'status', header: 'Status', cell: (e) => <StatusBadge status={e.status} /> },
        { key: 'when', header: 'Registered', cell: (e) => <span title={formatDateTime(e.createdAt)}>{relativeTime(e.createdAt)}</span> },
        ...(actions
          ? [
              {
                key: 'actions',
                header: <span className="visually-hidden">Actions</span>,
                className: 'table__actions',
                cell: actions,
              },
            ]
          : []),
      ]}
    />
  );
}

function ReviewQueue() {
  const [open, setOpen] = useState<string | null>(null);
  const list = useCursorList(keys.engagements('pending_review'), (c) => fetchers.engagements('pending_review', c));
  return (
    <Card flush>
      <QueryState query={list}>
        <EngagementTable
          rows={list.rows}
          onOpen={(e) => setOpen(e.id)}
          empty="No worker is waiting for review"
          emptyHint="Residents register domestic workers; each one needs a manager's approval before their code works."
          actions={(e) => (
            <Button size="sm" variant="primary" onClick={() => setOpen(e.id)}>
              Review
            </Button>
          )}
        />
        <LoadMore query={list} />
      </QueryState>
      <EngagementReview id={open} onClose={() => setOpen(null)} />
    </Card>
  );
}

type Pending = { kind: 'suspend' | 'end'; e: Engagement } | null;

function AllEngagements() {
  const toast = useToast();
  const [status, setStatus] = useState<EngagementStatus | ''>('active');
  const [open, setOpen] = useState<string | null>(null);
  const [pending, setPending] = useState<Pending>(null);
  const [issued, setIssued] = useState<Schema<'AccessCodeView'> | null>(null);
  const list = useCursorList(keys.engagements(status || undefined), (c) => fetchers.engagements(status || undefined, c));

  const act = useAction(
    (v: { kind: 'suspend' | 'end'; e: Engagement; reasonCode: string; reason: string }) =>
      unwrap(
        api.POST(v.kind === 'suspend' ? '/api/v1/worker-engagements/{id}/suspend' : '/api/v1/worker-engagements/{id}/end', {
          params: { path: { id: v.e.id } },
          body: { reasonCode: v.reasonCode, reason: v.reason },
        }),
      ),
    {
      invalidate: [keys.engagementsAll],
      onDone: (_, v) => {
        toast.show(v.kind === 'suspend' ? `${v.e.workerName} is suspended; their code stops working.` : `${v.e.workerName}'s engagement ended.`);
        setPending(null);
      },
    },
  );
  const resume = useAction(
    (e: Engagement) => unwrap(api.POST('/api/v1/worker-engagements/{id}/resume', { params: { path: { id: e.id } } })),
    { invalidate: [keys.engagementsAll], onDone: (code) => setIssued(code) },
  );

  return (
    <>
      <div className="toolbar">
        <Field label="Status">
          {(p) => (
            <Select {...p} value={status} onChange={(e) => setStatus(e.target.value as EngagementStatus | '')}>
              <option value="">All statuses</option>
              {(['pending_review', 'active', 'suspended', 'ended', 'rejected'] as const).map((s) => (
                <option key={s} value={s}>
                  {humanize(s)}
                </option>
              ))}
            </Select>
          )}
        </Field>
      </div>
      <ErrorAlert error={resume.error} />
      <Card flush>
        <QueryState query={list}>
          <EngagementTable
            rows={list.rows}
            onOpen={(e) => setOpen(e.id)}
            empty="No worker with this status"
            actions={(e) => (
              <span className="row" style={{ justifyContent: 'flex-end' }}>
                {e.status === 'active' ? (
                  <Button size="sm" onClick={() => setPending({ kind: 'suspend', e })}>
                    Suspend
                  </Button>
                ) : null}
                {e.status === 'suspended' ? (
                  <Button size="sm" loading={resume.isPending && resume.variables?.id === e.id} onClick={() => resume.mutate(e)}>
                    Resume
                  </Button>
                ) : null}
                {e.status === 'active' || e.status === 'suspended' ? (
                  <Button size="sm" onClick={() => setPending({ kind: 'end', e })}>
                    End
                  </Button>
                ) : null}
              </span>
            )}
          />
          <LoadMore query={list} />
        </QueryState>
      </Card>
      <EngagementReview id={open} onClose={() => setOpen(null)} />
      <ReasonDialog
        open={pending !== null}
        onClose={() => {
          setPending(null);
          act.reset();
        }}
        title={pending?.kind === 'suspend' ? `Suspend ${pending.e.workerName}?` : `End ${pending?.e.workerName ?? ''}'s engagement?`}
        description={
          pending?.kind === 'suspend'
            ? 'Their code stops working until a manager resumes it. The worker and the unit are told.'
            : 'The code stops working for good. A new engagement needs a new registration.'
        }
        codes={pending?.kind === 'suspend' ? REASON_CODES.workerSuspend : REASON_CODES.workerEnd}
        confirmLabel={pending?.kind === 'suspend' ? 'Suspend' : 'End engagement'}
        danger
        pending={act.isPending}
        error={<ErrorAlert error={act.error} />}
        onConfirm={(reason) => pending && act.mutate({ ...pending, ...reason })}
      />
      <AccessCodeDialog
        code={issued}
        onClose={() => {
          setIssued(null);
          toast.show('Worker resumed.');
        }}
      />
    </>
  );
}

function Compliance() {
  const toast = useToast();
  const [status, setStatus] = useState<'open' | 'closed'>('open');
  const [closing, setClosing] = useState<ComplianceCase | null>(null);
  const list = useCursorList(keys.compliance(status), (c) => fetchers.compliance(status, c));
  const close = useAction(
    (v: { c: ComplianceCase; reasonCode: string; reason: string }) =>
      unwrap(
        api.POST('/api/v1/compliance-cases/{id}/close', {
          params: { path: { id: v.c.id } },
          body: { reasonCode: v.reasonCode, reason: v.reason },
        }),
      ),
    {
      invalidate: [['compliance-cases'], keys.engagementsAll],
      onDone: () => {
        toast.show('Case closed.');
        setClosing(null);
      },
    },
  );
  return (
    <>
      <div className="toolbar">
        <Segmented
          label="Case status"
          value={status}
          onChange={setStatus}
          options={[
            { value: 'open', label: 'Open' },
            { value: 'closed', label: 'Closed' },
          ]}
        />
      </div>
      <Card flush>
        <QueryState query={list}>
          <DataTable<ComplianceCase>
            rows={list.rows}
            rowKey={(c) => c.id}
            empty={status === 'open' ? 'No open compliance case' : 'No closed case'}
            emptyHint="A case opens when a worker may be under 18: at review, after a birth date correction, or from a report."
            columns={[
              { key: 'kind', header: 'Case', cell: (c) => <Badge tone="terracotta">{humanize(c.kind)}</Badge> },
              { key: 'worker', header: 'Worker', cell: (c) => <span className="t-mono">{shortId(c.workerId)}</span> },
              { key: 'source', header: 'Raised by', cell: (c) => humanize(c.source) },
              { key: 'opened', header: 'Opened', cell: (c) => formatDateTime(c.openedAt) },
              { key: 'closed', header: 'Closed', cell: (c) => formatDate(c.closedAt) },
              {
                key: 'actions',
                header: <span className="visually-hidden">Actions</span>,
                className: 'table__actions',
                cell: (c) =>
                  c.status === 'open' ? (
                    <Button size="sm" onClick={() => setClosing(c)}>
                      Close case
                    </Button>
                  ) : null,
              },
            ]}
          />
          <LoadMore query={list} />
        </QueryState>
      </Card>
      <ReasonDialog
        open={closing !== null}
        onClose={() => {
          setClosing(null);
          close.reset();
        }}
        title="Close this compliance case?"
        codes={REASON_CODES.complianceClose}
        textLabel="Note"
        confirmLabel="Close case"
        pending={close.isPending}
        error={<ErrorAlert error={close.error} />}
        onConfirm={(reason) => closing && close.mutate({ c: closing, ...reason })}
      />
    </>
  );
}

function Incidents() {
  const toast = useToast();
  const [status, setStatus] = useState<'open' | 'closed'>('open');
  const [closing, setClosing] = useState<CardIncident | null>(null);
  const list = useCursorList(keys.incidents(status), (c) => fetchers.incidents(status, c));
  const close = useAction(
    (i: CardIncident) => unwrap(api.POST('/api/v1/card-incidents/{id}/close', { params: { path: { id: i.id } } })),
    {
      invalidate: [['card-incidents']],
      onDone: () => {
        toast.show('Incident closed.');
        setClosing(null);
      },
    },
  );
  return (
    <>
      <div className="toolbar">
        <Segmented
          label="Incident status"
          value={status}
          onChange={setStatus}
          options={[
            { value: 'open', label: 'Open' },
            { value: 'closed', label: 'Closed' },
          ]}
        />
      </div>
      <Card flush>
        <QueryState query={list}>
          <DataTable<CardIncident>
            rows={list.rows}
            rowKey={(i) => i.id}
            empty={status === 'open' ? 'No open card incident' : 'No closed incident'}
            emptyHint="Lost or confiscated worker cards, reported by residents or management."
            columns={[
              { key: 'type', header: 'Incident', cell: (i) => <Badge tone={i.type === 'confiscated' ? 'error' : 'terracotta'}>{humanize(i.type)}</Badge> },
              { key: 'worker', header: 'Worker', cell: (i) => <span className="t-mono">{shortId(i.workerId)}</span> },
              { key: 'via', header: 'Reported by', cell: (i) => humanize(i.reportedVia) },
              { key: 'when', header: 'Reported', cell: (i) => formatDateTime(i.reportedAt) },
              {
                key: 'actions',
                header: <span className="visually-hidden">Actions</span>,
                className: 'table__actions',
                cell: (i) =>
                  i.status === 'open' ? (
                    <Button size="sm" onClick={() => setClosing(i)}>
                      Close
                    </Button>
                  ) : null,
              },
            ]}
          />
          <LoadMore query={list} />
        </QueryState>
      </Card>
      <ConfirmDialog
        open={closing !== null}
        onClose={() => {
          setClosing(null);
          close.reset();
        }}
        title="Close this incident?"
        description="Do this once the card is recovered or replaced."
        confirmLabel="Close incident"
        pending={close.isPending}
        error={<ErrorAlert error={close.error} />}
        onConfirm={() => closing && close.mutate(closing)}
      />
    </>
  );
}

function WorkersView() {
  const [tab, setTab] = useTab(TABS, 'review');
  return (
    <>
      <PageHeader
        title="Workers"
        description="Domestic workers registered by residents: review, suspend, and follow up on cases."
        actions={
          <Segmented<Tab>
            label="Workers"
            value={tab}
            onChange={setTab}
            options={[
              { value: 'review', label: 'To review' },
              { value: 'all', label: 'Engagements' },
              { value: 'compliance', label: 'Compliance' },
              { value: 'incidents', label: 'Card incidents' },
            ]}
          />
        }
      />
      {tab === 'review' ? <ReviewQueue /> : tab === 'all' ? <AllEngagements /> : tab === 'compliance' ? <Compliance /> : <Incidents />}
    </>
  );
}

export default function WorkersPage() {
  return (
    <Suspense>
      <WorkersView />
    </Suspense>
  );
}
