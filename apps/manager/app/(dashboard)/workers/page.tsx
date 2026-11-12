'use client';

import { REASON_CODES, shortId, unwrap } from '@jiwar/api';
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
  useCommonT,
  useLabel,
  useToast,
} from '@jiwar/ui';
import { useFormat, useT } from '@jiwar/i18n';
import { Suspense, useState } from 'react';
import { AccessCodeDialog, EngagementReview } from '@/components/engagement-review';
import { wageText } from '@/components/workers/wage-text';
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
import ar from '@/messages/ar/workers';
import en from '@/messages/en/workers';
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
  const t = useT(en, ar);
  const c = useCommonT();
  const f = useFormat();
  const label = useLabel();
  return (
    <DataTable<Engagement>
      rows={rows}
      rowKey={(e) => e.id}
      empty={empty}
      emptyHint={emptyHint}
      columns={[
        {
          key: 'name',
          header: t('worker'),
          cell: (e) => (
            <Button variant="text" className="table__link" onClick={() => onOpen(e)}>
              {e.workerName}
            </Button>
          ),
        },
        { key: 'capacity', header: t('capacity'), cell: (e) => label(e.capacity) },
        { key: 'unit', header: c('unit'), cell: (e) => e.unitCode },
        {
          key: 'doc',
          header: t('document'),
          cell: (e) => (
            <span className="row">
              {label(e.idDocumentType)}
              {e.idDocumentType === 'passport' && !e.birthDateVerified ? (
                <Badge tone="terracotta">{t('birthToConfirm')}</Badge>
              ) : null}
            </span>
          ),
        },
        { key: 'wage', header: t('monthlyWage'), cell: (e) => <span className="t-num">{wageText(f, e.monthlyWage, e.currency)}</span> },
        { key: 'status', header: c('status'), cell: (e) => <StatusBadge status={e.status} /> },
        { key: 'when', header: t('registered'), cell: (e) => <span title={f.dateTime(e.createdAt)}>{f.relative(e.createdAt)}</span> },
        ...(actions
          ? [
              {
                key: 'actions',
                header: <span className="visually-hidden">{c('actions')}</span>,
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
  const t = useT(en, ar);
  const [open, setOpen] = useState<string | null>(null);
  const list = useCursorList(keys.engagements('pending_review'), (c) => fetchers.engagements('pending_review', c));
  return (
    <Card flush>
      <QueryState query={list}>
        <EngagementTable
          rows={list.rows}
          onOpen={(e) => setOpen(e.id)}
          empty={t('reviewEmpty')}
          emptyHint={t('reviewEmptyHint')}
          actions={(e) => (
            <Button size="sm" variant="primary" onClick={() => setOpen(e.id)}>
              {t('review')}
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
  const t = useT(en, ar);
  const c = useCommonT();
  const label = useLabel();
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
        toast.show(v.kind === 'suspend' ? t('suspendedToast', { name: v.e.workerName }) : t('endedToast', { name: v.e.workerName }));
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
        <Field label={c('status')}>
          {(p) => (
            <Select {...p} value={status} onChange={(e) => setStatus(e.target.value as EngagementStatus | '')}>
              <option value="">{t('allStatuses')}</option>
              {(['pending_review', 'active', 'suspended', 'ended', 'rejected'] as const).map((s) => (
                <option key={s} value={s}>
                  {label(s)}
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
            empty={t('allEmpty')}
            actions={(e) => (
              <span className="row" style={{ justifyContent: 'flex-end' }}>
                {e.status === 'active' ? (
                  <Button size="sm" onClick={() => setPending({ kind: 'suspend', e })}>
                    {t('suspend')}
                  </Button>
                ) : null}
                {e.status === 'suspended' ? (
                  <Button size="sm" loading={resume.isPending && resume.variables?.id === e.id} onClick={() => resume.mutate(e)}>
                    {t('resume')}
                  </Button>
                ) : null}
                {e.status === 'active' || e.status === 'suspended' ? (
                  <Button size="sm" onClick={() => setPending({ kind: 'end', e })}>
                    {t('end')}
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
        title={
          pending?.kind === 'suspend'
            ? t('suspendTitle', { name: pending.e.workerName })
            : t('endTitle', { name: pending?.e.workerName ?? '' })
        }
        description={
          pending?.kind === 'suspend'
            ? t('suspendDescription')
            : t('endDescription')
        }
        codes={pending?.kind === 'suspend' ? REASON_CODES.workerSuspend : REASON_CODES.workerEnd}
        confirmLabel={pending?.kind === 'suspend' ? t('suspend') : t('endConfirm')}
        danger
        pending={act.isPending}
        error={<ErrorAlert error={act.error} />}
        onConfirm={(reason) => pending && act.mutate({ ...pending, ...reason })}
      />
      <AccessCodeDialog
        code={issued}
        onClose={() => {
          setIssued(null);
          toast.show(t('resumed'));
        }}
      />
    </>
  );
}

function Compliance() {
  const t = useT(en, ar);
  const c = useCommonT();
  const f = useFormat();
  const label = useLabel();
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
        toast.show(t('caseClosed'));
        setClosing(null);
      },
    },
  );
  return (
    <>
      <div className="toolbar">
        <Segmented
          label={t('caseStatus')}
          value={status}
          onChange={setStatus}
          options={[
            { value: 'open', label: label('open') },
            { value: 'closed', label: label('closed') },
          ]}
        />
      </div>
      <Card flush>
        <QueryState query={list}>
          <DataTable<ComplianceCase>
            rows={list.rows}
            rowKey={(x) => x.id}
            empty={status === 'open' ? t('complianceOpenEmpty') : t('complianceClosedEmpty')}
            emptyHint={t('complianceHint')}
            columns={[
              { key: 'kind', header: t('case'), cell: (x) => <Badge tone="terracotta">{label(x.kind)}</Badge> },
              { key: 'worker', header: t('worker'), cell: (x) => <span className="t-mono ltr">{shortId(x.workerId)}</span> },
              { key: 'source', header: t('raisedBy'), cell: (x) => label(x.source) },
              { key: 'opened', header: t('opened'), cell: (x) => f.dateTime(x.openedAt) },
              { key: 'closed', header: t('closed'), cell: (x) => f.date(x.closedAt) },
              {
                key: 'actions',
                header: <span className="visually-hidden">{c('actions')}</span>,
                className: 'table__actions',
                cell: (x) =>
                  x.status === 'open' ? (
                    <Button size="sm" onClick={() => setClosing(x)}>
                      {t('closeCase')}
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
        title={t('closeCaseTitle')}
        codes={REASON_CODES.complianceClose}
        textLabel={t('note')}
        confirmLabel={t('closeCase')}
        pending={close.isPending}
        error={<ErrorAlert error={close.error} />}
        onConfirm={(reason) => closing && close.mutate({ c: closing, ...reason })}
      />
    </>
  );
}

function Incidents() {
  const t = useT(en, ar);
  const c = useCommonT();
  const f = useFormat();
  const label = useLabel();
  const toast = useToast();
  const [status, setStatus] = useState<'open' | 'closed'>('open');
  const [closing, setClosing] = useState<CardIncident | null>(null);
  const list = useCursorList(keys.incidents(status), (c) => fetchers.incidents(status, c));
  const close = useAction(
    (i: CardIncident) => unwrap(api.POST('/api/v1/card-incidents/{id}/close', { params: { path: { id: i.id } } })),
    {
      invalidate: [['card-incidents']],
      onDone: () => {
        toast.show(t('incidentClosed'));
        setClosing(null);
      },
    },
  );
  return (
    <>
      <div className="toolbar">
        <Segmented
          label={t('incidentStatus')}
          value={status}
          onChange={setStatus}
          options={[
            { value: 'open', label: label('open') },
            { value: 'closed', label: label('closed') },
          ]}
        />
      </div>
      <Card flush>
        <QueryState query={list}>
          <DataTable<CardIncident>
            rows={list.rows}
            rowKey={(i) => i.id}
            empty={status === 'open' ? t('incidentOpenEmpty') : t('incidentClosedEmpty')}
            emptyHint={t('incidentHint')}
            columns={[
              { key: 'type', header: t('incident'), cell: (i) => <Badge tone={i.type === 'confiscated' ? 'error' : 'terracotta'}>{label(i.type)}</Badge> },
              { key: 'worker', header: t('worker'), cell: (i) => <span className="t-mono ltr">{shortId(i.workerId)}</span> },
              { key: 'via', header: t('reportedBy'), cell: (i) => label(i.reportedVia) },
              { key: 'when', header: t('reported'), cell: (i) => f.dateTime(i.reportedAt) },
              {
                key: 'actions',
                header: <span className="visually-hidden">{c('actions')}</span>,
                className: 'table__actions',
                cell: (i) =>
                  i.status === 'open' ? (
                    <Button size="sm" onClick={() => setClosing(i)}>
                      {t('close')}
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
        title={t('closeIncidentTitle')}
        description={t('closeIncidentDescription')}
        confirmLabel={t('closeIncident')}
        pending={close.isPending}
        error={<ErrorAlert error={close.error} />}
        onConfirm={() => closing && close.mutate(closing)}
      />
    </>
  );
}

function WorkersView() {
  const t = useT(en, ar);
  const [tab, setTab] = useTab(TABS, 'review');
  return (
    <>
      <PageHeader
        title={t('title')}
        description={t('description')}
        actions={
          <Segmented<Tab>
            label={t('tabsLabel')}
            value={tab}
            onChange={setTab}
            options={[
              { value: 'review', label: t('tab.review') },
              { value: 'all', label: t('tab.all') },
              { value: 'compliance', label: t('tab.compliance') },
              { value: 'incidents', label: t('tab.incidents') },
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
