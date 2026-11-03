'use client';

import { formatDateTime, humanize, REASON_CODES, unwrap } from '@jiwar/api';
import { ErrorAlert, LoadMore, QueryState, useAction, useCursorList } from '@jiwar/api/react';
import {
  Button,
  Card,
  CardHeader,
  DataTable,
  Dialog,
  Field,
  ForbiddenState,
  Input,
  PageHeader,
  ReasonCodeDialog,
  Segmented,
  Select,
  StatusBadge,
  Textarea,
  useToast,
} from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { personName } from '@/components/security/logic';
import { lockdownScope } from '@/components/security/ops-logic';
import { api } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys, type LockdownOverride, type LockdownState, type StaffLockdown } from '@/lib/queries';

type View = LockdownState | 'all';

function EndLockdown({ lockdown, onClose }: { lockdown: StaffLockdown; onClose: () => void }) {
  const toast = useToast();
  const [note, setNote] = useState('');
  const end = useAction(
    (reasonCode: string) =>
      unwrap(
        api.POST('/api/v1/staff/security/lockdowns/{id}/end', {
          params: { path: { id: lockdown.id } },
          body: { reasonCode, ...(note.trim() ? { note: note.trim() } : {}) },
        }),
      ),
    {
      invalidate: [keys.lockdownsAll],
      onDone: () => {
        toast.show('The lockdown ended. The guards and the residents are told.');
        onClose();
      },
    },
  );
  return (
    <ReasonCodeDialog
      open
      onClose={onClose}
      title={`End the lockdown: ${lockdownScope(lockdown)}?`}
      description="The gates let people in again. The guards on shift, the lockdown’s keepers and every resident are told."
      codes={REASON_CODES.gateLockdownEnd}
      confirmLabel="End the lockdown"
      danger
      pending={end.isPending}
      error={<ErrorAlert error={end.error} />}
      onConfirm={(reasonCode) => end.mutate(reasonCode)}
    >
      <Field label="Note" hint="Optional. The management’s own words: nobody else reads them.">
        {(p) => <Textarea {...p} rows={3} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} />}
      </Field>
    </ReasonCodeDialog>
  );
}

/**
 * The management locks the gates down from the office (ADR 0087): one gate
 * or all, a reason code, and the same typed confirmation a guard gives.
 */
function StartLockdown({ onClose }: { onClose: () => void }) {
  const toast = useToast();
  const gates = useQuery({ queryKey: keys.gates, queryFn: () => fetchers.gates() });
  const [gateId, setGateId] = useState('');
  const [reasonCode, setReasonCode] = useState<string>(REASON_CODES.gateLockdownStart[0]);
  const [typed, setTyped] = useState('');
  const start = useAction(
    () =>
      unwrap(
        api.POST('/api/v1/staff/security/lockdowns', {
          body: {
            scope: gateId ? 'gate' : 'all',
            ...(gateId ? { gateId } : {}),
            reasonCode,
            confirmation: 'LOCKDOWN',
          },
        }),
      ),
    {
      invalidate: [keys.lockdownsAll],
      onDone: () => {
        toast.show('The gates are locked down. The guards on shift and the residents are told.');
        onClose();
      },
    },
  );
  return (
    <Dialog
      open
      onClose={onClose}
      title="Lock the gates down"
      onSubmit={() => typed === 'LOCKDOWN' && start.mutate()}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="danger" loading={start.isPending} disabled={typed !== 'LOCKDOWN'}>
            Lock down now
          </Button>
        </>
      }
    >
      <div className="form">
        <ErrorAlert error={start.error} />
        <Field label="Gates">
          {(p) => (
            <Select {...p} value={gateId} onChange={(e) => setGateId(e.target.value)}>
              <option value="">Every gate</option>
              {(gates.data?.data ?? []).map((g) => (
                <option key={g.id} value={g.id}>
                  {g.name}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Reason">
          {(p) => (
            <Select {...p} value={reasonCode} onChange={(e) => setReasonCode(e.target.value)}>
              {REASON_CODES.gateLockdownStart.map((r) => (
                <option key={r} value={r}>
                  {humanize(r)}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Type LOCKDOWN to confirm" hint="It starts at once: only residents come in until it ends.">
          {(p) => <Input {...p} value={typed} onChange={(e) => setTyped(e.target.value)} />}
        </Field>
      </div>
    </Dialog>
  );
}

function LockdownDetail({ lockdown, onClose }: { lockdown: StaffLockdown; onClose: () => void }) {
  return (
    <Dialog open wide onClose={onClose} title={`Lockdown · ${lockdownScope(lockdown)}`} footer={<Button onClick={onClose}>Close</Button>}>
      <div className="stack">
        <dl className="dl">
          <dt>Status</dt>
          <dd>
            <StatusBadge status={lockdown.endedAt ? 'ended' : 'live'} />
          </dd>
          <dt>Started</dt>
          <dd>
            {formatDateTime(lockdown.startedAt)} · {humanize(lockdown.reasonCode)} · by {personName(lockdown.startedBy)}
          </dd>
          {lockdown.endedAt ? (
            <>
              <dt>Ended</dt>
              <dd>
                {formatDateTime(lockdown.endedAt)} · {humanize(lockdown.endReason)} · by {personName(lockdown.endedBy)}
              </dd>
            </>
          ) : null}
          {lockdown.endNote ? (
            <>
              <dt>Note</dt>
              <dd>{lockdown.endNote}</dd>
            </>
          ) : null}
        </dl>
        <Card flush>
          <CardHeader title="Overrides" />
          <DataTable<LockdownOverride>
            rows={lockdown.overrides}
            rowKey={(o) => o.id}
            empty="No emergency vehicle was let through"
            columns={[
              { key: 'when', header: 'When', cell: (o) => formatDateTime(o.occurredAt) },
              { key: 'gate', header: 'Gate', cell: (o) => o.gate.name },
              { key: 'what', header: 'What came through', cell: (o) => humanize(o.reasonCode) },
              { key: 'guard', header: 'Guard', cell: (o) => personName(o.guard) },
              {
                key: 'link',
                header: 'For',
                cell: (o) => (o.emergencyId ? 'An emergency' : o.gateServiceRequestId ? 'A lane request' : '—'),
              },
            ]}
          />
        </Card>
      </div>
    </Dialog>
  );
}

/**
 * The lockdowns (ADR 0053): a guard starts one at the gate; the management
 * (`lockdown.end`) ends it here, and reads the history with the emergency
 * vehicles let through.
 */
export default function LockdownsPage() {
  const { ready, can } = usePermissions();
  const allowed = can('lockdown.end');
  const [view, setView] = useState<View>('live');
  const [starting, setStarting] = useState(false);
  const [open, setOpen] = useState<StaffLockdown | null>(null);
  const [ending, setEnding] = useState<StaffLockdown | null>(null);
  const state = view === 'all' ? '' : view;
  const list = useCursorList(keys.lockdowns(state), (c) => fetchers.lockdowns(state, c), { enabled: allowed });
  if (ready && !allowed)
    return (
      <>
        <PageHeader title="Lockdown" />
        <ForbiddenState />
      </>
    );
  return (
    <>
      <PageHeader
        title="Lockdown"
        description="A guard locks the gates from the app, or the management from here; it ends here. Exits stay open, and emergency vehicles pass."
        actions={
          can('lockdown.start') ? (
            <Button variant="danger" onClick={() => setStarting(true)}>
              Lock down
            </Button>
          ) : null
        }
      />
      <div className="toolbar">
        <Segmented<View>
          label="Lockdowns shown"
          value={view}
          onChange={setView}
          options={[
            { value: 'live', label: 'In force' },
            { value: 'ended', label: 'Ended' },
            { value: 'all', label: 'All' },
          ]}
        />
      </div>
      <Card flush>
        <QueryState query={list}>
          <DataTable<StaffLockdown>
            rows={list.rows}
            rowKey={(l) => l.id}
            empty={view === 'live' ? 'No lockdown is in force' : 'No lockdown'}
            columns={[
              {
                key: 'scope',
                header: 'Gates',
                cell: (l) => (
                  <Button variant="text" className="table__link" onClick={() => setOpen(l)}>
                    {lockdownScope(l)}
                  </Button>
                ),
              },
              { key: 'status', header: 'Status', cell: (l) => <StatusBadge status={l.endedAt ? 'ended' : 'live'} /> },
              { key: 'reason', header: 'Reason', cell: (l) => humanize(l.reasonCode) },
              {
                key: 'started',
                header: 'Started',
                cell: (l) =>
                  `${formatDateTime(l.startedAt)} · ${personName(l.startedBy)}${l.startedFrom === 'office' ? ' · from the office' : ''}`,
              },
              { key: 'ended', header: 'Ended', cell: (l) => (l.endedAt ? `${formatDateTime(l.endedAt)} · ${humanize(l.endReason)}` : '—') },
              { key: 'overrides', header: 'Overrides', cell: (l) => <span className="t-num">{l.overrides.length}</span> },
              {
                key: 'actions',
                header: '',
                className: 'table__actions',
                cell: (l) =>
                  l.endedAt ? null : (
                    <Button size="sm" variant="danger" onClick={() => setEnding(l)}>
                      End
                    </Button>
                  ),
              },
            ]}
          />
          <LoadMore query={list} />
        </QueryState>
      </Card>
      {open ? <LockdownDetail lockdown={open} onClose={() => setOpen(null)} /> : null}
      {ending ? <EndLockdown lockdown={ending} onClose={() => setEnding(null)} /> : null}
      {starting ? <StartLockdown onClose={() => setStarting(false)} /> : null}
    </>
  );
}
