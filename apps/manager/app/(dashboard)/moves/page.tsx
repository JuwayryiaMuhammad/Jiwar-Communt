'use client';

import { ErrorText, REASON_CODES, unwrap, type Schema } from '@jiwar/api';
import { ErrorAlert, QueryState, useAction } from '@jiwar/api/react';
import { useFormat, useT } from '@jiwar/i18n';
import { Badge, Button, Card, DataTable, Dialog, PageHeader, ReasonCodeDialog, Segmented, useToast } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useState } from 'react';
import { api } from '@/lib/api';
import ar from '@/messages/ar/res-moves';
import en from '@/messages/en/res-moves';

type Move = Schema<'BoardMoveView'>;
type Step = Schema<'ChecklistStepView'>;
const VIEWS = ['planned', 'done', 'cancelled'] as const;
type View = (typeof VIEWS)[number];
const KEY = ['moves'] as const;

/**
 * Moving in and out (ADR 0063): the moves planned, nearest first. Each has
 * its checklist; the management ticks its own steps, confirms a move-in,
 * and a move-out is done at the occupancy's handover (its page).
 */
export default function MovesPage() {
  const t = useT(en, ar);
  const f = useFormat();
  const [view, setView] = useState<View>('planned');
  const [open, setOpen] = useState<Move | null>(null);
  const list = useQuery({
    queryKey: [...KEY, view],
    queryFn: () => unwrap(api.GET('/api/v1/staff/moves', { params: { query: { status: view } } })),
    refetchInterval: 120_000,
  });
  return (
    <>
      <PageHeader title={t('title')} description={t('description')} />
      <Segmented<View>
        label={t('show')}
        value={view}
        onChange={setView}
        options={VIEWS.map((v) => ({ value: v, label: t(`view.${v}`) }))}
      />
      <Card flush>
        <QueryState query={list}>
          <DataTable<Move>
            rows={list.data}
            rowKey={(m) => m.id}
            empty={t('none')}
            emptyHint={t('noneHint')}
            columns={[
              { key: 'ref', header: t('col.move'), cell: (m) => <span className="t-mono ltr">{m.reference}</span> },
              {
                key: 'unit',
                header: t('col.unit'),
                cell: (m) => (
                  <Link className="table__link" href={`/units/${m.unitId}`}>
                    <span className="ltr">{m.unitCode}</span>
                  </Link>
                ),
              },
              {
                key: 'dir',
                header: t('col.way'),
                cell: (m) => <Badge tone="beige">{m.direction === 'in' ? t('movingIn') : t('movingOut')}</Badge>,
              },
              { key: 'day', header: t('col.planned'), cell: (m) => f.day(m.plannedOn) },
              {
                // ADR 0083: what the unit owes the compound now.
                key: 'owed',
                header: t('col.owed'),
                cell: (m) =>
                  Number(m.owed) > 0 ? <Badge tone="terracotta">{f.money(m.owed)}</Badge> : <span className="t-secondary">{t('nothing')}</span>,
              },
              {
                key: 'act',
                header: '',
                cell: (m) => (
                  <Button size="sm" onClick={() => setOpen(m)}>
                    {t('checklist')}
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

const STEPS = ['guide_read', 'keys_received', 'keys_returned', 'meters_read', 'unit_inspected', 'move_permit', 'utilities_requested', 'clearance_issued', 'deposits_settled'] as const;
const isStep = (key: string): key is (typeof STEPS)[number] => (STEPS as readonly string[]).includes(key);

function MoveDialog({ move, onClose }: { move: Move; onClose: () => void }) {
  const t = useT(en, ar);
  const f = useFormat();
  const toast = useToast();
  const [cancelling, setCancelling] = useState(false);
  const detail = useQuery({
    queryKey: [...KEY, 'one', move.id],
    queryFn: () => unwrap(api.GET('/api/v1/staff/moves/{id}', { params: { path: { id: move.id } } })),
  });
  const tick = useAction(
    (step: string) =>
      unwrap(api.POST('/api/v1/staff/moves/{id}/steps', { params: { path: { id: move.id } }, body: { step } })),
    { invalidate: [KEY], onDone: () => toast.show(t('ticked')) },
  );
  const done = useAction(
    () => unwrap(api.POST('/api/v1/staff/moves/{id}/done', { params: { path: { id: move.id } } })),
    {
      invalidate: [KEY],
      onDone: () => {
        toast.show(t('movedIn'));
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
        toast.show(t('cancelled'));
        onClose();
      },
    },
  );
  const planned = move.status === 'planned';
  const day = f.day(move.plannedOn);
  return (
    <>
      <Dialog
        open
        wide
        onClose={onClose}
        title={t('dialogTitle', { direction: move.direction, unit: move.unitCode })}
        description={
          move.direction === 'out'
            ? t('dialogDescriptionOut', { reference: move.reference, day })
            : t('dialogDescription', { reference: move.reference, day })
        }
        footer={
          planned ? (
            <>
              <Button onClick={() => setCancelling(true)}>{t('cancelMove')}</Button>
              {move.direction === 'in' ? (
                <Button variant="primary" loading={done.isPending} onClick={() => done.mutate(undefined)}>
                  {t('confirmIn')}
                </Button>
              ) : null}
            </>
          ) : null
        }
      >
        <ErrorAlert error={tick.error ?? done.error} />
        {detail.data && Number(detail.data.owed) > 0 ? (
          <p className="t-secondary">{t('owes', { amount: f.money(detail.data.owed) })}</p>
        ) : null}
        <QueryState query={detail}>
          <DataTable<Step>
            rows={detail.data?.checklist}
            rowKey={(s) => s.key}
            empty=""
            columns={[
              { key: 'step', header: t('col.step'), cell: (s) => (isStep(s.key) ? t(`step.${s.key}`) : s.key) },
              {
                key: 'who',
                header: t('col.whose'),
                cell: (s) =>
                  s.side === 'derived' ? t('side.derived') : s.side === 'resident' ? t('side.resident') : t('side.management'),
              },
              {
                key: 'state',
                header: '',
                cell: (s) =>
                  s.done ? (
                    <span>
                      <Badge tone="green">{t('done')}</Badge> {s.reference ?? (s.at ? f.dateTime(s.at) : '')}
                    </span>
                  ) : s.side === 'management' && planned ? (
                    <Button size="sm" loading={tick.isPending} onClick={() => tick.mutate(s.key)}>
                      {t('tick')}
                    </Button>
                  ) : (
                    <span className="t-secondary">{t('notYet')}</span>
                  ),
              },
            ]}
          />
        </QueryState>
      </Dialog>
      <ReasonCodeDialog
        open={cancelling}
        onClose={() => setCancelling(false)}
        title={t('cancelMove')}
        description={t('cancelDescription')}
        codes={REASON_CODES.moveCancel}
        confirmLabel={t('cancelMove')}
        danger
        pending={cancel.isPending}
        error={cancel.error ? <ErrorText error={cancel.error} /> : undefined}
        onConfirm={(reasonCode) => cancel.mutate(reasonCode)}
      />
    </>
  );
}
