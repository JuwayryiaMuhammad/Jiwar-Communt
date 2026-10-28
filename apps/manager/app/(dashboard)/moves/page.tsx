'use client';

import { errorText, formatDate, formatDateTime, REASON_CODES, unwrap, type Schema } from '@jiwar/api';
import { ErrorAlert, QueryState, useAction } from '@jiwar/api/react';
import { Badge, Button, Card, DataTable, Dialog, PageHeader, ReasonCodeDialog, Segmented, useToast } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useState } from 'react';
import { api } from '@/lib/api';

type Move = Schema<'BoardMoveView'>;
type Step = Schema<'ChecklistStepView'>;
const VIEWS = ['planned', 'done', 'cancelled'] as const;
type View = (typeof VIEWS)[number];
const KEY = ['moves'] as const;

const STEP_LABELS: Record<string, string> = {
  guide_read: 'Read the moving guide',
  keys_received: 'Keys handed over',
  keys_returned: 'Keys returned',
  meters_read: 'Meters read',
  unit_inspected: 'Unit inspected',
  move_permit: 'Move permit approved',
  utilities_requested: 'Utilities asked for',
  clearance_issued: 'Clearance issued',
  deposits_settled: 'Deposits settled',
};

/**
 * Moving in and out (ADR 0063): the moves planned, nearest first. Each has
 * its checklist; the management ticks its own steps, confirms a move-in,
 * and a move-out is done at the occupancy's handover (its page).
 */
export default function MovesPage() {
  const [view, setView] = useState<View>('planned');
  const [open, setOpen] = useState<Move | null>(null);
  const list = useQuery({
    queryKey: [...KEY, view],
    queryFn: () => unwrap(api.GET('/api/v1/staff/moves', { params: { query: { status: view } } })),
    refetchInterval: 120_000,
  });
  return (
    <>
      <PageHeader
        title="Moves"
        description="Who moves in and out, when, and what is left on each checklist."
      />
      <Segmented<View>
        label="Show"
        value={view}
        onChange={setView}
        options={VIEWS.map((v) => ({ value: v, label: v.charAt(0).toUpperCase() + v.slice(1) }))}
      />
      <Card flush>
        <QueryState query={list}>
          <DataTable<Move>
            rows={list.data}
            rowKey={(m) => m.id}
            empty="No move here"
            emptyHint="A move-in is planned when someone starts living in a unit; a move-out when the primary gives notice."
            columns={[
              { key: 'ref', header: 'Move', cell: (m) => <span className="t-mono">{m.reference}</span> },
              {
                key: 'unit',
                header: 'Unit',
                cell: (m) => (
                  <Link className="table__link" href={`/units/${m.unitId}`}>
                    {m.unitCode}
                  </Link>
                ),
              },
              {
                key: 'dir',
                header: 'Way',
                cell: (m) => <Badge tone="beige">{m.direction === 'in' ? 'Moving in' : 'Moving out'}</Badge>,
              },
              { key: 'day', header: 'Planned', cell: (m) => formatDate(m.plannedOn) },
              {
                key: 'act',
                header: '',
                cell: (m) => (
                  <Button size="sm" onClick={() => setOpen(m)}>
                    Checklist
                  </Button>
                ),
              },
            ]}
          />
        </QueryState>
      </Card>
      {open ? <MoveDialog move={open} onClose={() => setOpen(null)} /> : null}
    </>
  );
}

function MoveDialog({ move, onClose }: { move: Move; onClose: () => void }) {
  const toast = useToast();
  const [cancelling, setCancelling] = useState(false);
  const detail = useQuery({
    queryKey: [...KEY, 'one', move.id],
    queryFn: () => unwrap(api.GET('/api/v1/staff/moves/{id}', { params: { path: { id: move.id } } })),
  });
  const tick = useAction(
    (step: string) =>
      unwrap(api.POST('/api/v1/staff/moves/{id}/steps', { params: { path: { id: move.id } }, body: { step } })),
    { invalidate: [KEY], onDone: () => toast.show('Ticked.') },
  );
  const done = useAction(
    () => unwrap(api.POST('/api/v1/staff/moves/{id}/done', { params: { path: { id: move.id } } })),
    {
      invalidate: [KEY],
      onDone: () => {
        toast.show('Moved in.');
        onClose();
      },
    },
  );
  const cancel = useAction(
    (reasonCode: string) =>
      unwrap(
        api.POST('/api/v1/staff/moves/{id}/cancel', { params: { path: { id: move.id } }, body: { reasonCode } }),
      ),
    {
      invalidate: [KEY],
      onDone: () => {
        toast.show('Cancelled.');
        onClose();
      },
    },
  );
  const planned = move.status === 'planned';
  return (
    <>
      <Dialog
        open
        wide
        onClose={onClose}
        title={`${move.direction === 'in' ? 'Moving in' : 'Moving out'}: ${move.unitCode}`}
        description={`${move.reference}, planned ${formatDate(move.plannedOn)}.${
          move.direction === 'out' ? ' Done at the handover, on the occupancy.' : ''
        }`}
        footer={
          planned ? (
            <>
              <Button onClick={() => setCancelling(true)}>Cancel the move</Button>
              {move.direction === 'in' ? (
                <Button variant="primary" loading={done.isPending} onClick={() => done.mutate(undefined)}>
                  Confirm the move-in
                </Button>
              ) : null}
            </>
          ) : null
        }
      >
        <ErrorAlert error={tick.error ?? done.error} />
        <QueryState query={detail}>
          <DataTable<Step>
            rows={detail.data?.checklist}
            rowKey={(s) => s.key}
            empty=""
            columns={[
              { key: 'step', header: 'Step', cell: (s) => STEP_LABELS[s.key] ?? s.key },
              {
                key: 'who',
                header: 'Whose',
                cell: (s) => (s.side === 'derived' ? 'Read from its record' : s.side === 'resident' ? 'The resident' : 'You'),
              },
              {
                key: 'state',
                header: '',
                cell: (s) =>
                  s.done ? (
                    <span>
                      <Badge tone="green">Done</Badge> {s.reference ?? (s.at ? formatDateTime(s.at) : '')}
                    </span>
                  ) : s.side === 'management' && planned ? (
                    <Button size="sm" loading={tick.isPending} onClick={() => tick.mutate(s.key)}>
                      Tick
                    </Button>
                  ) : (
                    <span className="t-secondary">Not yet</span>
                  ),
              },
            ]}
          />
        </QueryState>
      </Dialog>
      <ReasonCodeDialog
        open={cancelling}
        onClose={() => setCancelling(false)}
        title="Cancel the move"
        description="The resident sees the reason."
        codes={REASON_CODES.moveCancel}
        confirmLabel="Cancel the move"
        danger
        pending={cancel.isPending}
        error={cancel.error ? errorText(cancel.error) : undefined}
        onConfirm={(reasonCode) => cancel.mutate(reasonCode)}
      />
    </>
  );
}
