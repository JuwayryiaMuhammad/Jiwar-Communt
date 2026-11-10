'use client';

import { fieldError, unwrap, type Schema } from '@jiwar/api';
import { ErrorAlert, QueryState, useAction } from '@jiwar/api/react';
import { useT } from '@jiwar/i18n';
import { Button, Card, DataTable, ForbiddenState, Input, PageHeader, useCommonT, useToast } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useInboxText } from '@/components/inbox/use-inbox-text';
import { api } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';
import ar from '@/messages/ar/inbox';
import en from '@/messages/en/inbox';

type Setting = Schema<'InboxSettingView'>;
const KEY = ['staff-inbox', 'settings'] as const;

/** How long each type may wait before it is overdue (ADR 0073). */
export default function InboxSettingsPage() {
  const t = useT(en, ar);
  const c = useCommonT();
  const text = useInboxText();
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
    { invalidate: [KEY, ['staff-inbox']], onDone: () => toast.show(t('saved')) },
  );
  if (ready && !allowed)
    return (
      <>
        <PageHeader title={t('settingsTitle')} />
        <ForbiddenState />
      </>
    );
  const index = (type: string) => changed.findIndex((s) => s.type === type);
  return (
    <>
      <PageHeader
        title={t('settingsTitle')}
        description={t('settingsDescription')}
        actions={
          <Button variant="primary" disabled={!changed.length} loading={save.isPending} onClick={() => save.mutate(undefined)}>
            {c('save')}
          </Button>
        }
      />
      <Card flush>
        <QueryState query={q}>
          <DataTable<Setting>
            rows={rows}
            rowKey={(s) => s.type}
            columns={[
              { key: 't', header: t('what'), cell: (s) => text.type(s.type) },
              {
                key: 'h',
                header: t('hoursColumn'),
                cell: (s) => (
                  <>
                    <Input
                      aria-label={t('hoursOf', { what: text.type(s.type) })}
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
                header: t('defaultColumn'),
                cell: (s) =>
                  s.custom ? (
                    <Button size="sm" onClick={() => save.mutate(s)}>
                      {t('backTo', { hours: t('hours', { n: s.defaultDueHours }) })}
                    </Button>
                  ) : (
                    t('hours', { n: s.defaultDueHours })
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
