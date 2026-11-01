'use client';

import { fieldError, unwrap, type Schema } from '@jiwar/api';
import { ErrorAlert, QueryState, useAction } from '@jiwar/api/react';
import { Button, Card, DataTable, ForbiddenState, Input, PageHeader, useToast } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { inboxLabel } from '@/components/inbox/inbox-types';
import { api } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';

type Setting = Schema<'InboxSettingView'>;
const KEY = ['staff-inbox', 'settings'] as const;

/** How long each type may wait before it is overdue (ADR 0073). */
export default function InboxSettingsPage() {
  const toast = useToast();
  const { ready, can } = usePermissions();
  const allowed = can('settings.manage');
  const q = useQuery({
    queryKey: KEY,
    queryFn: () => unwrap(api.GET('/api/v1/staff/inbox/settings')),
    enabled: allowed,
  });
  const [draft, setDraft] = useState<Record<string, string>>({});
  useEffect(() => {
    if (q.data) setDraft(Object.fromEntries(q.data.data.map((s) => [s.type, String(s.dueHours)])));
  }, [q.data]);
  const rows = q.data?.data ?? [];
  const changed = rows.filter((s) => draft[s.type] !== undefined && draft[s.type] !== String(s.dueHours));
  const save = useAction(
    (reset?: Setting) =>
      unwrap(
        api.PATCH('/api/v1/staff/inbox/settings', {
          body: {
            items: reset
              ? [{ type: reset.type, dueHours: null }]
              : changed.map((s) => ({ type: s.type, dueHours: Number(draft[s.type]) })),
          },
        }),
      ),
    { invalidate: [KEY, ['staff-inbox']], onDone: () => toast.show('Saved. Items already overdue were told once.') },
  );
  if (ready && !allowed)
    return (
      <>
        <PageHeader title="Inbox due times" />
        <ForbiddenState />
      </>
    );
  const index = (type: string) => changed.findIndex((s) => s.type === type);
  return (
    <>
      <PageHeader
        title="Inbox due times"
        description="Hours from when something starts waiting until it is overdue. Past it, whoever decides that type is told once."
        actions={
          <Button variant="primary" disabled={!changed.length} loading={save.isPending} onClick={() => save.mutate(undefined)}>
            Save
          </Button>
        }
      />
      <Card flush>
        <QueryState query={q}>
          <DataTable<Setting>
            rows={rows}
            rowKey={(s) => s.type}
            columns={[
              { key: 't', header: 'What', cell: (s) => inboxLabel(s.type) },
              {
                key: 'h',
                header: 'Hours',
                cell: (s) => (
                  <>
                    <Input
                      aria-label={`Hours: ${inboxLabel(s.type)}`}
                      type="number"
                      min={1}
                      max={720}
                      value={draft[s.type] ?? ''}
                      onChange={(e) => setDraft((d) => ({ ...d, [s.type]: e.target.value }))}
                    />
                    <span className="t-error">{fieldError(save.error, `items.${index(s.type)}.dueHours`)}</span>
                  </>
                ),
              },
              {
                key: 'd',
                header: 'Default',
                cell: (s) =>
                  s.custom ? (
                    <Button size="sm" onClick={() => save.mutate(s)}>
                      Back to {s.defaultDueHours} h
                    </Button>
                  ) : (
                    `${s.defaultDueHours} h`
                  ),
              },
            ]}
          />
          <ErrorAlert error={save.error} />
        </QueryState>
      </Card>
    </>
  );
}
