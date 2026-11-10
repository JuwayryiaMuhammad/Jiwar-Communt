'use client';

import { REASON_CODES, unwrap } from '@jiwar/api';
import { ErrorAlert, LoadMore, QueryState, useAction, useCursorList } from '@jiwar/api/react';
import { useFormat, useLocale, useT } from '@jiwar/i18n';
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
  useCommonT,
  useLabel,
  useToast,
} from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { personNameIn } from '@/components/security/logic';
import { lockdownScopeIn } from '@/components/security/ops-logic';
import { api } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys, type LockdownOverride, type LockdownState, type StaffLockdown } from '@/lib/queries';
import ar from '@/messages/ar/safety-lockdowns';
import en from '@/messages/en/safety-lockdowns';

type View = LockdownState | 'all';
const VIEWS = ['live', 'ended', 'all'] as const satisfies readonly View[];
/** The word the API takes as the typed confirmation, in either language. */
const CONFIRM_WORD = 'LOCKDOWN';

function EndLockdown({ lockdown, onClose }: { lockdown: StaffLockdown; onClose: () => void }) {
  const t = useT(en, ar);
  const { locale } = useLocale();
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
        toast.show(t('ended'));
        onClose();
      },
    },
  );
  return (
    <ReasonCodeDialog
      open
      onClose={onClose}
      title={t('endTitle', { scope: lockdownScopeIn(lockdown, locale) })}
      description={t('endDescription')}
      codes={REASON_CODES.gateLockdownEnd}
      confirmLabel={t('endConfirm')}
      danger
      pending={end.isPending}
      error={<ErrorAlert error={end.error} />}
      onConfirm={(reasonCode) => end.mutate(reasonCode)}
    >
      <Field label={t('note')} hint={t('noteHint')}>
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
  const t = useT(en, ar);
  const c = useCommonT();
  const label = useLabel();
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
            confirmation: CONFIRM_WORD,
          },
        }),
      ),
    {
      invalidate: [keys.lockdownsAll],
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
      title={t('startTitle')}
      onSubmit={() => typed === CONFIRM_WORD && start.mutate()}
      footer={
        <>
          <Button onClick={onClose}>{c('cancel')}</Button>
          <Button type="submit" variant="danger" loading={start.isPending} disabled={typed !== CONFIRM_WORD}>
            {t('startConfirm')}
          </Button>
        </>
      }
    >
      <div className="form">
        <ErrorAlert error={start.error} />
        <Field label={t('gates')}>
          {(p) => (
            <Select {...p} value={gateId} onChange={(e) => setGateId(e.target.value)}>
              <option value="">{t('everyGate')}</option>
              {(gates.data?.data ?? []).map((g) => (
                <option key={g.id} value={g.id}>
                  {g.name}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label={t('reason')}>
          {(p) => (
            <Select {...p} value={reasonCode} onChange={(e) => setReasonCode(e.target.value)}>
              {REASON_CODES.gateLockdownStart.map((r) => (
                <option key={r} value={r}>
                  {label(r)}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label={t('typeToConfirm', { word: CONFIRM_WORD })} hint={t('typeHint')}>
          {(p) => <Input {...p} dir="ltr" value={typed} onChange={(e) => setTyped(e.target.value)} />}
        </Field>
      </div>
    </Dialog>
  );
}

function LockdownDetail({ lockdown, onClose }: { lockdown: StaffLockdown; onClose: () => void }) {
  const t = useT(en, ar);
  const c = useCommonT();
  const fmt = useFormat();
  const label = useLabel();
  const { locale } = useLocale();
  const who = (ref: Parameters<typeof personNameIn>[0]) => personNameIn(ref, locale);
  return (
    <Dialog
      open
      wide
      onClose={onClose}
      title={t('detailTitle', { scope: lockdownScopeIn(lockdown, locale) })}
      footer={<Button onClick={onClose}>{c('close')}</Button>}
    >
      <div className="stack">
        <dl className="dl">
          <dt>{t('status')}</dt>
          <dd>
            <StatusBadge status={lockdown.endedAt ? 'ended' : 'live'} />
          </dd>
          <dt>{t('startedAt')}</dt>
          <dd>{t('byLine', { when: fmt.dateTime(lockdown.startedAt), reason: label(lockdown.reasonCode), who: who(lockdown.startedBy) })}</dd>
          {lockdown.endedAt ? (
            <>
              <dt>{t('endedAt')}</dt>
              <dd>{t('byLine', { when: fmt.dateTime(lockdown.endedAt), reason: label(lockdown.endReason), who: who(lockdown.endedBy) })}</dd>
            </>
          ) : null}
          {lockdown.endNote ? (
            <>
              <dt>{t('note')}</dt>
              <dd>{lockdown.endNote}</dd>
            </>
          ) : null}
        </dl>
        <Card flush>
          <CardHeader title={t('overrides')} />
          <DataTable<LockdownOverride>
            rows={lockdown.overrides}
            rowKey={(o) => o.id}
            empty={t('noOverride')}
            columns={[
              { key: 'when', header: t('col.when'), cell: (o) => fmt.dateTime(o.occurredAt) },
              { key: 'gate', header: t('col.gate'), cell: (o) => o.gate.name },
              { key: 'what', header: t('col.what'), cell: (o) => label(o.reasonCode) },
              { key: 'guard', header: t('col.guard'), cell: (o) => who(o.guard) },
              {
                key: 'link',
                header: t('col.for'),
                cell: (o) => (o.emergencyId ? t('for.emergency') : o.gateServiceRequestId ? t('for.lane') : '—'),
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
  const t = useT(en, ar);
  const fmt = useFormat();
  const label = useLabel();
  const { locale } = useLocale();
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
          can('lockdown.start') ? (
            <Button variant="danger" onClick={() => setStarting(true)}>
              {t('lockDown')}
            </Button>
          ) : null
        }
      />
      <div className="toolbar">
        <Segmented<View> label={t('shown')} value={view} onChange={setView} options={VIEWS.map((v) => ({ value: v, label: t(`view.${v}`) }))} />
      </div>
      <Card flush>
        <QueryState query={list}>
          <DataTable<StaffLockdown>
            rows={list.rows}
            rowKey={(l) => l.id}
            empty={view === 'live' ? t('emptyLive') : t('empty')}
            columns={[
              {
                key: 'scope',
                header: t('col.gates'),
                cell: (l) => (
                  <Button variant="text" className="table__link" onClick={() => setOpen(l)}>
                    {lockdownScopeIn(l, locale)}
                  </Button>
                ),
              },
              { key: 'status', header: t('col.status'), cell: (l) => <StatusBadge status={l.endedAt ? 'ended' : 'live'} /> },
              { key: 'reason', header: t('col.reason'), cell: (l) => label(l.reasonCode) },
              {
                key: 'started',
                header: t('col.started'),
                cell: (l) =>
                  [fmt.dateTime(l.startedAt), personNameIn(l.startedBy, locale), l.startedFrom === 'office' ? t('fromOffice') : null]
                    .filter(Boolean)
                    .join(' · '),
              },
              {
                key: 'ended',
                header: t('col.ended'),
                cell: (l) => (l.endedAt ? `${fmt.dateTime(l.endedAt)} · ${label(l.endReason)}` : '—'),
              },
              { key: 'overrides', header: t('col.overrides'), cell: (l) => <span className="t-num">{fmt.number(l.overrides.length)}</span> },
              {
                key: 'actions',
                header: '',
                className: 'table__actions',
                cell: (l) =>
                  l.endedAt ? null : (
                    <Button size="sm" variant="danger" onClick={() => setEnding(l)}>
                      {t('end')}
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
