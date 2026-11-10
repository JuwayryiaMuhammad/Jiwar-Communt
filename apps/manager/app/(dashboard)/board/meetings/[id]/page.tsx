'use client';

import { fieldError, REASON_CODES, unwrap } from '@jiwar/api';
import { ErrorAlert, QueryState, useAction } from '@jiwar/api/react';
import { useFormat, useT } from '@jiwar/i18n';
import {
  Button,
  Card,
  CardHeader,
  Checkbox,
  DataTable,
  Dialog,
  Field,
  ForbiddenState,
  Input,
  PageHeader,
  ReasonCodeDialog,
  Select,
  StatusBadge,
  useCommonT,
  useLabel,
  useToast,
} from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { codeText } from '@/components/governance/logic';
import { api } from '@/lib/api';
import { boardWorkFetchers, boardWorkKeys, type MeetingAction } from '@/lib/board-work';
import { usePermissions } from '@/lib/permissions';
import ar from '@/messages/ar/gov-board-meetings';
import codesAr from '@/messages/ar/gov-codes';
import en from '@/messages/en/gov-board-meetings';
import codesEn from '@/messages/en/gov-codes';

type Seat = { id: string; fullName: string | null; role: string; endedAt: string | null };

/**
 * One board meeting (ADR 0075): its agenda while scheduled; held once with
 * who of the seats sitting was there, or called off; then its minutes (a
 * board publication of kind minutes) and its action items, each with an
 * owner and a due day. The open items of earlier meetings come last, to
 * follow up.
 */
export default function BoardMeetingPage() {
  const t = useT(en, ar);
  const g = useT(codesEn, codesAr);
  const c = useCommonT();
  const fmt = useFormat();
  const label = useLabel();
  const { id } = useParams<{ id: string }>();
  const toast = useToast();
  const { ready, can } = usePermissions();
  const manager = can('governance.manage');
  const allowed = can('governance.board') || manager;
  const key = boardWorkKeys.meeting(id);
  const q = useQuery({ queryKey: key, queryFn: () => boardWorkFetchers.meeting(id), enabled: allowed });
  // The seats sitting now: the manager's view, or a member's own.
  const seats = useQuery({
    queryKey: ['governance', 'board', 'seats', manager],
    queryFn: async () => {
      const res = manager
        ? await unwrap(api.GET('/api/v1/staff/governance/board'))
        : await unwrap(api.GET('/api/v1/governance/board'));
      return ((res.board?.members ?? []) as Seat[]).filter((s) => !s.endedAt);
    },
    enabled: allowed,
  });
  const [holding, setHolding] = useState(false);
  const [present, setPresent] = useState<string[]>([]);
  const [cancelling, setCancelling] = useState(false);
  const [minutesId, setMinutesId] = useState('');
  const [action, setAction] = useState({ title: '', ownerAccountId: '', dueOn: '' });
  const [closing, setClosing] = useState<MeetingAction | null>(null);

  const hold = useAction(
    () => unwrap(api.POST('/api/v1/board/meetings/{id}/hold', { params: { path: { id } }, body: { presentMemberIds: present } })),
    { invalidate: [key], onDone: () => (setHolding(false), toast.show(t('heldToast'))) },
  );
  const cancel = useAction(
    (reasonCode: string) => unwrap(api.POST('/api/v1/board/meetings/{id}/cancel', { params: { path: { id } }, body: { reasonCode } })),
    { invalidate: [key], onDone: () => (setCancelling(false), toast.show(t('calledOffToast'))) },
  );
  const minutes = useAction(
    () =>
      unwrap(api.POST('/api/v1/board/meetings/{id}/minutes', { params: { path: { id } }, body: { publicationId: minutesId.trim() } })),
    { invalidate: [key], onDone: () => toast.show(t('minutesLinked')) },
  );
  const add = useAction(
    () =>
      unwrap(
        api.POST('/api/v1/board/meetings/{id}/actions', {
          params: { path: { id } },
          body: { title: action.title.trim(), ownerAccountId: action.ownerAccountId, dueOn: action.dueOn },
        }),
      ),
    {
      invalidate: [key],
      onDone: () => (setAction({ title: '', ownerAccountId: '', dueOn: '' }), toast.show(t('actionAdded'))),
    },
  );
  const done = useAction(
    (a: MeetingAction) => unwrap(api.POST('/api/v1/board/meeting-actions/{id}/done', { params: { path: { id: a.id } }, body: {} })),
    { invalidate: [key], onDone: () => toast.show(t('markedDone')) },
  );
  const dropAction = useAction(
    (reasonCode: string) =>
      unwrap(api.POST('/api/v1/board/meeting-actions/{id}/cancel', { params: { path: { id: closing!.id } }, body: { reasonCode } })),
    { invalidate: [key], onDone: () => (setClosing(null), toast.show(t('actionCancelled'))) },
  );

  if (ready && !allowed)
    return (
      <>
        <PageHeader title={t('meeting')} />
        <ForbiddenState />
      </>
    );
  const m = q.data;
  const actionColumns = [
    { key: 't', header: t('col.action'), cell: (a: MeetingAction) => a.title },
    { key: 'o', header: t('col.owner'), cell: (a: MeetingAction) => a.ownerName ?? '—' },
    {
      key: 'd',
      header: t('col.due'),
      cell: (a: MeetingAction) => (a.overdue ? t('dueLate', { day: fmt.day(a.dueOn) }) : fmt.day(a.dueOn)),
    },
    { key: 's', header: c('status'), cell: (a: MeetingAction) => <StatusBadge status={a.status} /> },
    {
      key: 'x',
      header: '',
      cell: (a: MeetingAction) =>
        a.status === 'open' ? (
          <span className="toolbar">
            <Button size="sm" loading={done.isPending} onClick={() => done.mutate(a)}>
              {t('done')}
            </Button>
            <Button size="sm" variant="text" onClick={() => setClosing(a)}>
              {c('cancel')}
            </Button>
          </span>
        ) : null,
    },
  ];
  return (
    <>
      <PageHeader
        title={m ? `${m.reference} · ${m.title}` : t('meeting')}
        description={
          m
            ? [codeText(g, 'meetingKind', m.kind), fmt.dateTime(m.scheduledAt), ...(m.location ? [m.location] : [])].join(' · ')
            : undefined
        }
        actions={
          m?.status === 'scheduled' ? (
            <>
              <Button variant="primary" onClick={() => setHolding(true)}>
                {t('recordHeld')}
              </Button>
              <Button variant="text" onClick={() => setCancelling(true)}>
                {t('callOff')}
              </Button>
            </>
          ) : undefined
        }
      />
      <QueryState query={q}>
        {m ? (
          <>
            <Card>
              <CardHeader title={c('status')} />
              <p>
                <StatusBadge status={m.status} />{' '}
                {m.status === 'held' ? t(m.quorate ? 'held' : 'heldNoQuorum', { present: m.present, seated: m.seated }) : null}
                {m.cancelReason ? ` · ${label(m.cancelReason)}` : null}
              </p>
            </Card>
            <Card flush>
              <CardHeader title={t('agenda')} />
              <DataTable
                rows={m.agenda}
                rowKey={(i) => String(i.position)}
                empty={t('noAgenda')}
                columns={[
                  { key: 'p', header: '#', cell: (i) => i.position },
                  { key: 'k', header: t('kind'), cell: (i) => codeText(g, 'agendaKind', i.kind) },
                  { key: 't', header: t('col.item'), cell: (i) => i.reference ?? i.title ?? '—' },
                  { key: 's', header: t('col.now'), cell: (i) => (i.subjectStatus ? <StatusBadge status={i.subjectStatus} /> : '—') },
                ]}
              />
            </Card>
            {m.status === 'held' ? (
              <>
                <Card flush>
                  <CardHeader title={t('whoWasThere')} />
                  <DataTable
                    rows={m.attendance}
                    rowKey={(a) => a.memberId}
                    columns={[
                      { key: 'n', header: t('col.member'), cell: (a) => a.fullName ?? '—' },
                      { key: 'r', header: t('col.role'), cell: (a) => codeText(g, 'role', a.role) },
                      { key: 'p', header: t('col.present'), cell: (a) => (a.present ? c('yes') : c('no')) },
                    ]}
                  />
                </Card>
                <Card>
                  <CardHeader title={t('minutes')} />
                  {m.minutesPublicationId ? (
                    <p>{t('minutesLinkedTo', { id: m.minutesPublicationId })}</p>
                  ) : (
                    <div className="stack">
                      <p className="t-secondary">{t('minutesHint')}</p>
                      <Field label={t('publicationId')} error={fieldError(minutes.error, 'publicationId')}>
                        {(p) => <Input {...p} value={minutesId} onChange={(e) => setMinutesId(e.target.value)} />}
                      </Field>
                      <ErrorAlert error={minutes.error} />
                      <Button loading={minutes.isPending} disabled={!minutesId.trim()} onClick={() => minutes.mutate(undefined)}>
                        {t('linkMinutes')}
                      </Button>
                    </div>
                  )}
                </Card>
                <Card flush>
                  <CardHeader title={t('actions')} />
                  <DataTable<MeetingAction> rows={m.actions} rowKey={(a) => a.id} empty={t('noneYet')} columns={actionColumns} />
                  <div className="stack">
                    <Field label={t('col.action')} error={fieldError(add.error, 'title')}>
                      {(p) => <Input {...p} maxLength={300} value={action.title} onChange={(e) => setAction({ ...action, title: e.target.value })} />}
                    </Field>
                    <Field label={t('col.owner')} hint={t('ownerHint')} error={fieldError(add.error, 'ownerAccountId')}>
                      {(p) => (
                        <Select {...p} value={action.ownerAccountId} onChange={(e) => setAction({ ...action, ownerAccountId: e.target.value })}>
                          <option value="">{t('choose')}</option>
                          {m.attendance.map((a) => (
                            <option key={a.memberId} value={a.accountId}>
                              {a.fullName ?? codeText(g, 'role', a.role)}
                            </option>
                          ))}
                        </Select>
                      )}
                    </Field>
                    <Field label={t('col.due')} error={fieldError(add.error, 'dueOn')}>
                      {(p) => <Input {...p} type="date" value={action.dueOn} onChange={(e) => setAction({ ...action, dueOn: e.target.value })} />}
                    </Field>
                    <ErrorAlert error={add.error} />
                    <Button
                      loading={add.isPending}
                      disabled={!action.title.trim() || !action.ownerAccountId || !action.dueOn}
                      onClick={() => add.mutate(undefined)}
                    >
                      {t('addAction')}
                    </Button>
                  </div>
                </Card>
              </>
            ) : null}
            <Card flush>
              <CardHeader title={t('followUp')} />
              <DataTable<MeetingAction> rows={m.followUp} rowKey={(a) => a.id} empty={t('nothingOpen')} columns={actionColumns} />
            </Card>
          </>
        ) : null}
      </QueryState>
      <Dialog
        open={holding}
        onClose={() => setHolding(false)}
        title={t('holdTitle')}
        footer={
          <Button variant="primary" loading={hold.isPending} onClick={() => hold.mutate(undefined)}>
            {t('record')}
          </Button>
        }
      >
        <p className="t-secondary">{t('holdHint')}</p>
        {(seats.data ?? []).map((s) => (
          <Checkbox
            key={s.id}
            label={t('seat', { name: s.fullName ?? '—', role: codeText(g, 'role', s.role) })}
            checked={present.includes(s.id)}
            onChange={(e) => setPresent((p) => (e.target.checked ? [...p, s.id] : p.filter((x) => x !== s.id)))}
          />
        ))}
        <ErrorAlert error={hold.error} />
      </Dialog>
      <ReasonCodeDialog
        open={cancelling}
        onClose={() => setCancelling(false)}
        title={t('callOffTitle')}
        codes={REASON_CODES.boardMeetingCancel}
        confirmLabel={t('callOff')}
        danger
        pending={cancel.isPending}
        error={<ErrorAlert error={cancel.error} />}
        onConfirm={(code) => cancel.mutate(code)}
      />
      <ReasonCodeDialog
        open={closing !== null}
        onClose={() => setClosing(null)}
        title={t('cancelActionTitle')}
        codes={REASON_CODES.boardActionCancel}
        confirmLabel={t('cancelIt')}
        danger
        pending={dropAction.isPending}
        error={<ErrorAlert error={dropAction.error} />}
        onConfirm={(code) => dropAction.mutate(code)}
      />
    </>
  );
}
