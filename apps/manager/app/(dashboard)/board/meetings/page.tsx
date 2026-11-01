'use client';

import { fieldError, formatDateTime, unwrap } from '@jiwar/api';
import { ErrorAlert, LoadMore, QueryState, useAction, useCursorList } from '@jiwar/api/react';
import { Button, Card, CardHeader, DataTable, Field, ForbiddenState, Input, PageHeader, Segmented, Select, StatusBadge, useToast } from '@jiwar/ui';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { api } from '@/lib/api';
import { boardWorkFetchers, boardWorkKeys, MEETING_KIND_TEXT, type Meeting, type MeetingStatus } from '@/lib/board-work';
import { usePermissions } from '@/lib/permissions';

/**
 * The board's meetings (ADR 0075): a sitting member's or the manager's
 * page. Scheduled for the board that sits; then held, with who was there,
 * or called off. Its agenda and action items are on the meeting's page.
 */
export default function BoardMeetingsPage() {
  const toast = useToast();
  const router = useRouter();
  const { ready, can } = usePermissions();
  const allowed = can('governance.board') || can('governance.manage');
  const [status, setStatus] = useState<MeetingStatus | ''>('scheduled');
  const list = useCursorList(boardWorkKeys.meetings(status), (c) => boardWorkFetchers.meetings(status, c), { enabled: allowed });
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
        toast.show('Scheduled. The other sitting members are told.');
        router.push(`/board/meetings/${m.id}`);
      },
    },
  );
  if (ready && !allowed)
    return (
      <>
        <PageHeader title="Board meetings" />
        <ForbiddenState />
      </>
    );
  return (
    <>
      <PageHeader
        title="Board meetings"
        description="Meetings of the board that sits: their agenda, who was there, the minutes and the action items. The owners read the minutes, never the meeting."
      />
      <Card>
        <CardHeader title="Schedule a meeting" />
        <div className="stack">
          <Field label="Title" error={fieldError(schedule.error, 'title')}>
            {(p) => <Input {...p} value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)} />}
          </Field>
          <Field label="Kind">
            {(p) => (
              <Select {...p} value={kind} onChange={(e) => setKind(e.target.value as 'regular' | 'extraordinary')}>
                <option value="regular">Regular</option>
                <option value="extraordinary">Extraordinary</option>
              </Select>
            )}
          </Field>
          <Field label="When" hint="Up to 30 days back, to record one after the fact" error={fieldError(schedule.error, 'scheduledAt')}>
            {(p) => <Input {...p} type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} />}
          </Field>
          <Field label="Where (optional)" error={fieldError(schedule.error, 'location')}>
            {(p) => <Input {...p} value={location} maxLength={200} onChange={(e) => setLocation(e.target.value)} />}
          </Field>
        </div>
        <ErrorAlert error={schedule.error} />
        <Button variant="primary" loading={schedule.isPending} disabled={!title.trim() || !when} onClick={() => schedule.mutate(undefined)}>
          Schedule
        </Button>
      </Card>
      <div className="toolbar">
        <Segmented<MeetingStatus | ''>
          label="Status"
          value={status}
          onChange={setStatus}
          options={[
            { value: 'scheduled', label: 'Scheduled' },
            { value: 'held', label: 'Held' },
            { value: 'cancelled', label: 'Called off' },
            { value: '', label: 'All' },
          ]}
        />
      </div>
      <Card flush>
        <QueryState query={list}>
          <DataTable<Meeting>
            rows={list.rows}
            rowKey={(m) => m.id}
            empty="No meetings here"
            columns={[
              { key: 'r', header: 'Meeting', cell: (m) => <Link href={`/board/meetings/${m.id}`}>{m.reference} · {m.title}</Link> },
              { key: 'k', header: 'Kind', cell: (m) => MEETING_KIND_TEXT[m.kind] ?? m.kind },
              { key: 'w', header: 'When', cell: (m) => formatDateTime(m.scheduledAt) },
              {
                key: 'q',
                header: 'Attendance',
                cell: (m) => (m.present === null ? '—' : `${m.present} of ${m.seated}${m.quorate ? '' : ' · no quorum'}`),
              },
              { key: 's', header: 'Status', cell: (m) => <StatusBadge status={m.status} /> },
            ]}
          />
          <LoadMore query={list} />
        </QueryState>
      </Card>
    </>
  );
}
