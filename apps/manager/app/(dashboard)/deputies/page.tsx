'use client';

import { errorText, fieldError, formatDateTime, unwrap, type Schema } from '@jiwar/api';
import { ErrorAlert, QueryState, useAction } from '@jiwar/api/react';
import { Badge, Button, Card, Checkbox, DataTable, Field, Input, PageHeader, Select, useToast } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys } from '@/lib/queries';

type Deputy = Schema<'DeputyView'>;
const KEY = ['deputies'] as const;

/** Never delegated (ADR 0073); the API refuses them too. */
const delegable = (p: string) =>
  !p.startsWith('finance.') &&
  !p.startsWith('governance.') &&
  !['appeals.decide', 'roles.manage', 'deputies.manage'].includes(p);

const REASON: Record<string, string> = {
  ended: 'Ended early',
  expired: 'Its time ran out',
  account_left: 'One of you is no longer active',
};

/**
 * A deputy who decides in my place while I am away (ADR 0073): for at most
 * 30 days, with permissions of my own role. Meanwhile they hold them and I
 * do not; what they do is recorded as on my behalf.
 */
export default function DeputiesPage() {
  const toast = useToast();
  const { me, can } = usePermissions();
  const mine = useQuery({ queryKey: KEY, queryFn: () => unwrap(api.GET('/api/v1/staff/deputies')) });
  const accounts = useQuery({
    queryKey: keys.accounts,
    queryFn: () => fetchers.accounts(undefined, 100),
    enabled: can('deputies.manage'),
  });
  const [deputyId, setDeputyId] = useState('');
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [endsAt, setEndsAt] = useState('');
  const appoint = useAction(
    () =>
      unwrap(
        api.POST('/api/v1/staff/deputies', {
          body: {
            deputyAccountId: deputyId,
            permissions: [...picked].sort(),
            endsAt: new Date(endsAt).toISOString(),
          },
        }),
      ),
    {
      invalidate: [KEY, keys.me],
      onDone: () => {
        toast.show('Named. Your deputy is told.');
        setPicked(new Set());
      },
    },
  );
  const end = useAction(
    (d: Deputy) => unwrap(api.POST('/api/v1/staff/deputies/{id}/end', { params: { path: { id: d.id } } })),
    { invalidate: [KEY, keys.me], onDone: () => toast.show('Ended. The other side is told.') },
  );
  const own = (me?.permissions ?? []).filter(delegable).sort();
  const candidates = (accounts.data?.data ?? []).filter(
    (a) => a.status === 'active' && (a.type === 'staff' || a.type === 'manager') && a.id !== me?.id,
  );

  return (
    <>
      <PageHeader
        title="Deputy"
        description="Someone who decides in your place for up to 30 days. They hold what you give them and you do not, until it ends; what they do is recorded as on your behalf."
      />
      <Card flush>
        <QueryState query={mine}>
          <DataTable<Deputy>
            rows={mine.data?.data}
            rowKey={(d) => d.id}
            empty="No deputy"
            columns={[
              { key: 'side', header: 'You are', cell: (d) => (d.role === 'principal' ? 'Away' : 'The deputy') },
              { key: 'perm', header: 'Permissions', cell: (d) => d.permissions.join(', ') },
              { key: 'until', header: 'Until', cell: (d) => formatDateTime(d.endsAt) },
              {
                key: 'state',
                header: '',
                cell: (d) =>
                  d.live ? (
                    <span style={{ display: 'flex', gap: 8 }}>
                      <Badge tone="green">In force</Badge>
                      <Button size="sm" loading={end.isPending} onClick={() => end.mutate(d)}>
                        End now
                      </Button>
                    </span>
                  ) : (
                    (REASON[d.endReason ?? ''] ?? 'Ended')
                  ),
              },
            ]}
          />
        </QueryState>
        <ErrorAlert error={end.error} />
      </Card>
      {can('deputies.manage') ? (
        <Card>
          <h2>Name a deputy</h2>
          <Field label="Deputy" error={fieldError(appoint.error, 'deputyAccountId')}>
            {(p) => (
              <Select {...p} value={deputyId} onChange={(e) => setDeputyId(e.target.value)}>
                <option value="">Choose an account</option>
                {candidates.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.fullName}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="Until" hint="At most 30 days from now." error={fieldError(appoint.error, 'endsAt')}>
            {(p) => <Input {...p} type="datetime-local" value={endsAt} onChange={(e) => setEndsAt(e.target.value)} />}
          </Field>
          <fieldset>
            <legend>What they decide in your place</legend>
            {own.map((p) => (
              <Checkbox
                key={p}
                label={p}
                checked={picked.has(p)}
                onChange={(e) =>
                  setPicked((s) => {
                    const next = new Set(s);
                    if (e.target.checked) next.add(p);
                    else next.delete(p);
                    return next;
                  })
                }
              />
            ))}
          </fieldset>
          {appoint.error ? <span className="t-error">{errorText(appoint.error)}</span> : null}
          <Button
            variant="primary"
            disabled={!deputyId || !picked.size || !endsAt}
            loading={appoint.isPending}
            onClick={() => appoint.mutate(undefined)}
          >
            Name the deputy
          </Button>
        </Card>
      ) : null}
    </>
  );
}
