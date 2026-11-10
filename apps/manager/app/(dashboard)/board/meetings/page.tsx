'use client';

import { fieldError, unwrap } from '@jiwar/api';
import { ErrorAlert, LoadMore, QueryState, useAction, useCursorList } from '@jiwar/api/react';
import { useFormat, useT } from '@jiwar/i18n';
import {
  Button,
  Card,
  CardHeader,
  DataTable,
  Field,
  ForbiddenState,
  Input,
  PageHeader,
  Segmented,
  Select,
  StatusBadge,
  useCommonT,
  useToast,
} from '@jiwar/ui';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { codeText } from '@/components/governance/logic';
import { api } from '@/lib/api';
import { boardWorkFetchers, boardWorkKeys, type Meeting, type MeetingStatus } from '@/lib/board-work';
import { usePermissions } from '@/lib/permissions';
import ar from '@/messages/ar/gov-board-meetings';
import codesAr from '@/messages/ar/gov-codes';
import en from '@/messages/en/gov-board-meetings';
import codesEn from '@/messages/en/gov-codes';

const VIEWS = ['scheduled', 'held', 'cancelled'] as const satisfies readonly MeetingStatus[];

/**
 * The board's meetings (ADR 0075): a sitting member's or the manager's
 * page. Scheduled for the board that sits; then held, with who was there,
 * or called off. Its agenda and action items are on the meeting's page.
 */
export default function BoardMeetingsPage() {
  const t = useT(en, ar);
  const g = useT(codesEn, codesAr);
  const c = useCommonT();
  const fmt = useFormat();
  const toast = useToast();
  const router = useRouter();
  const { ready, can } = usePermissions();
  const allowed = can('governance.board') || can('governance.manage');
  const [status, setStatus] = useState<MeetingStatus | ''>('scheduled');
  const list = useCursorList(boardWorkKeys.meetings(status), (cursor) => boardWorkFetchers.meetings(status, cursor), { enabled: allowed });
  const [title, setTitle] = useState('');
  const [kind, setKind] = useState<'regular' | 'extraordinary'>('regular');
  const [when, setWhen] = useState('');
  const [location, setLocation] = useState('');
  const schedule = useAction(
    () =>
      unwrap(
        api.POST('/api/v1/board/meetings', {
          body: {
            kind,
            title: title.trim(),
            scheduledAt: new Date(when).toISOString(),
            ...(location.trim() ? { location: location.trim() } : {}),
          },
        }),
      ),
    {
      invalidate: [boardWorkKeys.meetings(status)],
      onDone: (m) => {
        toast.show(t('scheduled'));
        router.push(`/board/meetings/${m.id}`);
      },
    },
  );
  if (ready && !allowed)
    return (
      <>
        <PageHeader title={t('title')} />
        <ForbiddenState />
      </>
    );
  return (
    <>
      <PageHeader title={t('title')} description={t('description')} />
      <Card>
        <CardHeader title={t('scheduleTitle')} />
        <div className="stack">
          <Field label={t('field.title')} error={fieldError(schedule.error, 'title')}>
            {(p) => <Input {...p} value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)} />}
          </Field>
          <Field label={t('kind')}>
            {(p) => (
              <Select {...p} value={kind} onChange={(e) => setKind(e.target.value as 'regular' | 'extraordinary')}>
                <option value="regular">{g('meetingKind.regular')}</option>
                <option value="extraordinary">{g('meetingKind.extraordinary')}</option>
              </Select>
            )}
          </Field>
          <Field label={t('when')} hint={t('whenHint')} error={fieldError(schedule.error, 'scheduledAt')}>
            {(p) => <Input {...p} type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} />}
          </Field>
          <Field label={t('where')} error={fieldError(schedule.error, 'location')}>
            {(p) => <Input {...p} value={location} maxLength={200} onChange={(e) => setLocation(e.target.value)} />}
          </Field>
        </div>
        <ErrorAlert error={schedule.error} />
        <Button variant="primary" loading={schedule.isPending} disabled={!title.trim() || !when} onClick={() => schedule.mutate(undefined)}>
          {t('schedule')}
        </Button>
      </Card>
      <div className="toolbar">
        <Segmented<MeetingStatus | ''>
          label={c('status')}
          value={status}
          onChange={setStatus}
          options={[...VIEWS.map((v) => ({ value: v, label: t(`view.${v}`) })), { value: '' as const, label: t('view.all') }]}
        />
      </div>
      <Card flush>
        <QueryState query={list}>
          <DataTable<Meeting>
            rows={list.rows}
            rowKey={(m) => m.id}
            empty={t('empty')}
            columns={[
              {
                key: 'r',
                header: t('col.meeting'),
                cell: (m) => (
                  <Link href={`/board/meetings/${m.id}`}>
                    {m.reference} · {m.title}
                  </Link>
                ),
              },
              { key: 'k', header: t('kind'), cell: (m) => codeText(g, 'meetingKind', m.kind) },
              { key: 'w', header: t('when'), cell: (m) => fmt.dateTime(m.scheduledAt) },
              {
                key: 'q',
                header: t('col.attendance'),
                cell: (m) =>
                  m.present === null
                    ? '—'
                    : t(m.quorate ? 'attendance' : 'attendanceNoQuorum', { present: m.present, seated: m.seated }),
              },
              { key: 's', header: c('status'), cell: (m) => <StatusBadge status={m.status} /> },
            ]}
          />
          <LoadMore query={list} />
        </QueryState>
      </Card>
    </>
  );
}
