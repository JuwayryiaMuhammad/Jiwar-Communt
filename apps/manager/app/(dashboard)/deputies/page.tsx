'use client';

import { ErrorText, fieldError, unwrap, type Schema } from '@jiwar/api';
import { ErrorAlert, QueryState, useAction } from '@jiwar/api/react';
import { useFormat, useT } from '@jiwar/i18n';
import { Badge, Button, Card, Checkbox, DataTable, Field, Input, PageHeader, Select, useToast } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys } from '@/lib/queries';
import ar from '@/messages/ar/res-deputies';
import en from '@/messages/en/res-deputies';

type Deputy = Schema<'DeputyView'>;
const KEY = ['deputies'] as const;

/** Never delegated (ADR 0073); the API refuses them too. */
const delegable = (p: string) =>
  !p.startsWith('finance.') &&
  !p.startsWith('governance.') &&
  !['appeals.decide', 'roles.manage', 'deputies.manage'].includes(p);

/**
 * A deputy who decides in my place while I am away (ADR 0073): for at most
 * 30 days, with permissions of my own role. Meanwhile they hold them and I
 * do not; what they do is recorded as on my behalf.
 */
export default function DeputiesPage() {
  const t = useT(en, ar);
  const f = useFormat();
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
        toast.show(t('named'));
        setPicked(new Set());
      },
    },
  );
  const end = useAction(
    (d: Deputy) => unwrap(api.POST('/api/v1/staff/deputies/{id}/end', { params: { path: { id: d.id } } })),
    { invalidate: [KEY, keys.me], onDone: () => toast.show(t('ended')) },
  );
  const own = (me?.permissions ?? []).filter(delegable).sort();
  const candidates = (accounts.data?.data ?? []).filter(
    (a) => a.status === 'active' && (a.type === 'staff' || a.type === 'manager') && a.id !== me?.id,
  );
  const endReason = (reason: string | null | undefined) =>
    reason === 'ended' || reason === 'expired' || reason === 'account_left' ? t(`reason.${reason}`) : t('reason.other');

  return (
    <>
      <PageHeader title={t('title')} description={t('description')} />
      <Card flush>
        <QueryState query={mine}>
          <DataTable<Deputy>
            rows={mine.data?.data}
            rowKey={(d) => d.id}
            empty={t('none')}
            columns={[
              { key: 'side', header: t('col.side'), cell: (d) => (d.role === 'principal' ? t('away') : t('theDeputy')) },
              { key: 'perm', header: t('col.permissions'), cell: (d) => <span className="ltr">{d.permissions.join(', ')}</span> },
              { key: 'until', header: t('col.until'), cell: (d) => f.dateTime(d.endsAt) },
              {
                key: 'state',
                header: '',
                cell: (d) =>
                  d.live ? (
                    <span style={{ display: 'flex', gap: 8 }}>
                      <Badge tone="green">{t('inForce')}</Badge>
                      <Button size="sm" loading={end.isPending} onClick={() => end.mutate(d)}>
                        {t('endNow')}
                      </Button>
                    </span>
                  ) : (
                    endReason(d.endReason)
                  ),
              },
            ]}
          />
        </QueryState>
        <ErrorAlert error={end.error} />
      </Card>
      {can('deputies.manage') ? (
        <Card>
          <h2>{t('nameTitle')}</h2>
          <Field label={t('deputy')} error={fieldError(appoint.error, 'deputyAccountId')}>
            {(p) => (
              <Select {...p} value={deputyId} onChange={(e) => setDeputyId(e.target.value)}>
                <option value="">{t('chooseAccount')}</option>
                {candidates.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.fullName}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label={t('until')} hint={t('untilHint')} error={fieldError(appoint.error, 'endsAt')}>
            {(p) => <Input {...p} type="datetime-local" value={endsAt} onChange={(e) => setEndsAt(e.target.value)} />}
          </Field>
          <fieldset>
            <legend>{t('decides')}</legend>
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
          {appoint.error ? <span className="t-error"><ErrorText error={appoint.error} /></span> : null}
          <Button
            variant="primary"
            disabled={!deputyId || !picked.size || !endsAt}
            loading={appoint.isPending}
            onClick={() => appoint.mutate(undefined)}
          >
            {t('nameButton')}
          </Button>
        </Card>
      ) : null}
    </>
  );
}
