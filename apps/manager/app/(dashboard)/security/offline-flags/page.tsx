'use client';

import { formatDateTime, REASON_CODES, relativeTime, unwrap } from '@jiwar/api';
import { ErrorAlert, LoadMore, QueryState, useAction, useCursorList } from '@jiwar/api/react';
import { Badge, Button, Card, ConfirmDialog, DataTable, Dialog, ForbiddenState, PageHeader, ReasonCodeDialog, Segmented, useToast } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { useSearchParams } from 'next/navigation';
import { useState } from 'react';
import { batchSummary, classTone, flagText, type FlagClass } from '@/components/security/offline-logic';
import { api } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';
import {
  fetchers,
  keys,
  type OfflineBatch,
  type OfflineBatchFilter,
  type OfflineFlag,
  type OfflineFlagClass,
  type OfflineFlagFilter,
} from '@/lib/queries';

type Tab = 'flags' | 'batches';

/** Reviewed once, with a code: what the management made of it. */
function Review({ f, onClose }: { f: OfflineFlag; onClose: () => void }) {
  const toast = useToast();
  const [idempotencyKey] = useState(() => crypto.randomUUID());
  const review = useAction(
    (reviewCode: (typeof REASON_CODES.offlineFlagReview)[number]) =>
      unwrap(
        api.POST('/api/v1/staff/gate/offline/flags/{id}/review', {
          params: { path: { id: f.id }, header: { 'Idempotency-Key': idempotencyKey } },
          body: { reviewCode },
        }),
      ),
    {
      invalidate: [keys.offlineAll],
      onDone: () => {
        toast.show('Reviewed.');
        onClose();
      },
    },
  );
  return (
    <ReasonCodeDialog
      open
      onClose={onClose}
      title="Review this flag"
      description={flagText(f)}
      codes={REASON_CODES.offlineFlagReview}
      confirmLabel="Review"
      pending={review.isPending}
      error={<ErrorAlert error={review.error} />}
      onConfirm={(reviewCode) => review.mutate(reviewCode as (typeof REASON_CODES.offlineFlagReview)[number])}
    />
  );
}

/** A revoked device's batch, decided once: accept records it as at its receipt; reject keeps it rejected. */
function Decide({ b, decision, onClose }: { b: OfflineBatch; decision: 'accept' | 'reject'; onClose: () => void }) {
  const toast = useToast();
  const [idempotencyKey] = useState(() => crypto.randomUUID());
  const decide = useAction(
    () =>
      unwrap(
        api.POST('/api/v1/staff/gate/offline/batches/{id}/review', {
          params: { path: { id: b.id }, header: { 'Idempotency-Key': idempotencyKey } },
          body: { decision },
        }),
      ),
    {
      invalidate: [keys.offlineAll],
      onDone: () => {
        toast.show(decision === 'accept' ? 'Accepted: each action was recorded as it happened, flagged where needed.' : 'Rejected: nothing of it was recorded.');
        onClose();
      },
    },
  );
  return (
    <ConfirmDialog
      open
      onClose={onClose}
      title={decision === 'accept' ? 'Accept what the revoked device recorded?' : 'Reject what the revoked device recorded?'}
      description={`${batchSummary(b.actions)}, uploaded ${formatDateTime(b.receivedAt)}. ${
        decision === 'accept'
          ? 'Each is recorded at its own time, as the gate would have, and flagged where the server knows better.'
          : 'Each stays rejected; nothing is recorded.'
      }`}
      confirmLabel={decision === 'accept' ? 'Accept' : 'Reject'}
      danger={decision === 'reject'}
      pending={decide.isPending}
      error={<ErrorAlert error={decide.error} />}
      onConfirm={() => decide.mutate()}
    />
  );
}

function BatchDetail({ id, onClose, onDecide }: { id: string; onClose: () => void; onDecide: (b: OfflineBatch, d: 'accept' | 'reject') => void }) {
  const detail = useQuery({ queryKey: keys.offlineBatch(id), queryFn: () => fetchers.offlineBatch(id) });
  const b = detail.data;
  return (
    <Dialog
      open
      wide
      onClose={onClose}
      title="Uploaded batch"
      footer={
        <>
          {b?.pendingReview ? (
            <>
              <Button variant="danger" onClick={() => onDecide(b, 'reject')}>Reject</Button>
              <Button variant="primary" onClick={() => onDecide(b, 'accept')}>Accept</Button>
            </>
          ) : null}
          <Button onClick={onClose}>Done</Button>
        </>
      }
    >
      <QueryState query={detail} rows={6}>
        {b ? (
          <>
            <dl className="dl">
              <dt>Uploaded</dt>
              <dd>{b.uploadedBy.fullName ?? 'An erased account'} · {formatDateTime(b.receivedAt)}</dd>
              <dt>As</dt>
              <dd>{b.status === 'quarantined' ? 'From a revoked device: quarantined' : 'Accepted'}</dd>
              {b.reviewedAt ? (
                <>
                  <dt>Decided</dt>
                  <dd>{b.reviewDecision} · {b.reviewedBy?.fullName ?? '—'} · {formatDateTime(b.reviewedAt)}</dd>
                </>
              ) : null}
            </dl>
            <DataTable<OfflineBatch['actions'][number]>
              rows={b.actions}
              rowKey={(a) => a.clientId}
              empty="No action"
              columns={[
                { key: 'seq', header: 'No.', cell: (a) => a.seq.toString() },
                { key: 'type', header: 'What', cell: (a) => a.type.replace(/_/g, ' ') + (a.direction ? ` (${a.direction})` : '') },
                { key: 'when', header: 'When (device)', cell: (a) => formatDateTime(a.deviceTime) },
                { key: 'status', header: 'Now', cell: (a) => (a.reason ? `${a.status}: ${a.reason.replace(/_/g, ' ')}` : a.status) },
              ]}
            />
          </>
        ) : null}
      </QueryState>
    </Dialog>
  );
}

/**
 * Offline flags (ADR 0057): what the server knew better when a guard
 * device synced what it recorded without network — someone let in during
 * a lockdown, a banned plate, a once-only code used twice, a credential
 * revoked since — and the batches a revoked device uploaded, waiting to be
 * accepted or rejected. Codes and numbers only: open the entry's log for
 * the rest.
 */
export default function OfflineFlagsPage() {
  const { ready, can } = usePermissions();
  const allowed = can('gate_devices.manage');
  const params = useSearchParams();
  const [tab, setTab] = useState<Tab>(params.get('batch') ? 'batches' : 'flags');
  const [status, setStatus] = useState<OfflineFlagFilter>('open');
  const [klass, setKlass] = useState<OfflineFlagClass | 'any'>('any');
  const [batchStatus, setBatchStatus] = useState<OfflineBatchFilter>('pending');
  const [reviewing, setReviewing] = useState<OfflineFlag | null>(null);
  const [batch, setBatch] = useState<string | null>(params.get('batch'));
  const [deciding, setDeciding] = useState<{ b: OfflineBatch; decision: 'accept' | 'reject' } | null>(null);
  const device = params.get('device') ?? undefined;
  const flags = useCursorList(
    keys.offlineFlags(status, klass, device),
    (c) => fetchers.offlineFlags(status, klass === 'any' ? undefined : klass, device, c),
    {
      enabled: allowed && tab === 'flags',
      refetchInterval: 60_000,
    },
  );
  const batches = useCursorList(keys.offlineBatches(batchStatus), (c) => fetchers.offlineBatches(batchStatus, c), {
    enabled: allowed && tab === 'batches',
  });

  if (ready && !allowed)
    return (
      <>
        <PageHeader title="Offline flags" />
        <ForbiddenState />
      </>
    );

  return (
    <>
      <PageHeader
        title="Offline flags"
        description="What the server knew better when a gate device synced what it recorded offline, and what a revoked device uploaded."
      />
      <div className="toolbar">
        <Segmented<Tab>
          label="Show"
          value={tab}
          onChange={setTab}
          options={[
            { value: 'flags', label: 'Flags' },
            { value: 'batches', label: 'Uploaded batches' },
          ]}
        />
        {tab === 'flags' ? (
          <>
            <Segmented<OfflineFlagFilter>
              label="Flags shown"
              value={status}
              onChange={setStatus}
              options={[
                { value: 'open', label: 'To look at' },
                { value: 'reviewed', label: 'Reviewed' },
                { value: 'cleared', label: 'Cleared' },
                { value: 'all', label: 'All' },
              ]}
            />
            <Segmented<OfflineFlagClass | 'any'>
              label="Kind"
              value={klass}
              onChange={setKlass}
              options={[
                { value: 'any', label: 'Any' },
                { value: 'security', label: 'Security' },
                { value: 'manager', label: 'Management' },
                { value: 'info', label: 'For the record' },
              ]}
            />
          </>
        ) : (
          <Segmented<OfflineBatchFilter>
            label="Batches shown"
            value={batchStatus}
            onChange={setBatchStatus}
            options={[
              { value: 'pending', label: 'Quarantined, to decide' },
              { value: 'reviewed', label: 'Decided' },
              { value: 'all', label: 'All' },
            ]}
          />
        )}
      </div>
      {tab === 'flags' ? (
        <Card flush>
          <QueryState query={flags}>
            <DataTable<OfflineFlag>
              rows={flags.rows}
              rowKey={(f) => f.id}
              empty={status === 'open' ? 'Nothing to look at' : 'No flag'}
              columns={[
                {
                  key: 'what',
                  header: 'What',
                  cell: (f) => (
                    <span className="row">
                      <Badge tone={classTone(f.class as FlagClass)}>{f.class}</Badge>
                      {flagText(f)}
                    </span>
                  ),
                },
                { key: 'when', header: 'When (device)', cell: (f) => (f.occurredAt ? formatDateTime(f.occurredAt) : '—') },
                { key: 'synced', header: 'Synced', cell: (f) => <span title={formatDateTime(f.createdAt)}>{relativeTime(f.createdAt)}</span> },
                {
                  key: 'batch',
                  header: '',
                  cell: (f) => (
                    <span className="row">
                      <Button size="sm" variant="text" onClick={() => setBatch(f.batchId)}>Batch</Button>
                      {f.status === 'open' ? (
                        <Button size="sm" variant="primary" onClick={() => setReviewing(f)}>Review</Button>
                      ) : (
                        <Badge tone="beige">{f.status}</Badge>
                      )}
                    </span>
                  ),
                },
              ]}
            />
            <LoadMore query={flags} />
          </QueryState>
        </Card>
      ) : (
        <Card flush>
          <QueryState query={batches}>
            <DataTable<OfflineBatch>
              rows={batches.rows}
              rowKey={(b) => b.id}
              empty={batchStatus === 'pending' ? 'Nothing waits for a decision' : 'No batch'}
              columns={[
                {
                  key: 'what',
                  header: 'What',
                  cell: (b) => (
                    <Button variant="text" className="table__link" onClick={() => setBatch(b.id)}>
                      {b.actionCount} action{b.actionCount === 1 ? '' : 's'}
                    </Button>
                  ),
                },
                { key: 'as', header: 'As', cell: (b) => (b.pendingReview ? <Badge tone="error">Quarantined</Badge> : b.reviewDecision ?? 'Accepted') },
                { key: 'by', header: 'Uploaded by', cell: (b) => b.uploadedBy.fullName ?? 'An erased account' },
                { key: 'when', header: 'Received', cell: (b) => <span title={formatDateTime(b.receivedAt)}>{relativeTime(b.receivedAt)}</span> },
                {
                  key: 'decide',
                  header: '',
                  cell: (b) =>
                    b.pendingReview ? (
                      <span className="row">
                        <Button size="sm" variant="primary" onClick={() => setDeciding({ b, decision: 'accept' })}>Accept</Button>
                        <Button size="sm" variant="danger" onClick={() => setDeciding({ b, decision: 'reject' })}>Reject</Button>
                      </span>
                    ) : null,
                },
              ]}
            />
            <LoadMore query={batches} />
          </QueryState>
        </Card>
      )}
      {reviewing ? <Review f={reviewing} onClose={() => setReviewing(null)} /> : null}
      {batch ? <BatchDetail id={batch} onClose={() => setBatch(null)} onDecide={(b, decision) => setDeciding({ b, decision })} /> : null}
      {deciding ? <Decide b={deciding.b} decision={deciding.decision} onClose={() => setDeciding(null)} /> : null}
    </>
  );
}
