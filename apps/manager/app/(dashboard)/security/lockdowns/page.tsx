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
  PageHeader,
  ReasonCodeDialog,
  Segmented,
  StatusBadge,
  Textarea,
  useToast,
} from '@jiwar/ui';
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
      <PageHeader title="Lockdown" description="A guard locks the gates from the app; it ends here. Exits stay open, and emergency vehicles pass." />
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
              { key: 'started', header: 'Started', cell: (l) => `${formatDateTime(l.startedAt)} · ${personName(l.startedBy)}` },
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
    </>
  );
}
