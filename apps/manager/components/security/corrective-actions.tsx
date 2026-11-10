'use client';

import { fieldError, REASON_CODES, unwrap } from '@jiwar/api';
import { ErrorAlert, QueryState, useAction } from '@jiwar/api/react';
import { useFormat, useLocale, useT } from '@jiwar/i18n';
import { Button, Card, CardHeader, DataTable, Field, Input, ReasonCodeDialog, Select, Textarea, useCommonT, useLabel, useToast } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { personNameIn } from '@/components/security/logic';
import { api } from '@/lib/api';
import { fetchers, keys, type IncidentAction } from '@/lib/queries';
import ar from '@/messages/ar/sec-corrective-actions';
import en from '@/messages/en/sec-corrective-actions';

/**
 * An incident's corrective actions (ADR 0087): what must be done, by whom
 * and by when. The incident does not close while one is open.
 */
export function CorrectiveActions({ incidentId, closed }: { incidentId: string; closed: boolean }) {
  const t = useT(en, ar);
  const c = useCommonT();
  const f = useFormat();
  const label = useLabel();
  const { locale } = useLocale();
  const toast = useToast();
  const actions = useQuery({ queryKey: keys.incidentActions(incidentId), queryFn: () => fetchers.incidentActions(incidentId) });
  const accounts = useQuery({ queryKey: [...keys.accounts, 'owners'], queryFn: () => fetchers.accounts(undefined, 100) });
  const owners = (accounts.data?.data ?? []).filter(
    (a) => !a.erased && a.status === 'active' && (a.type === 'staff' || a.type === 'manager'),
  );
  const [form, setForm] = useState({ description: '', ownerId: '', dueOn: '' });
  const [cancelling, setCancelling] = useState<IncidentAction | null>(null);
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value });
  const refresh = [keys.incidentActions(incidentId), keys.securityIncidentsAll];
  const add = useAction(
    () =>
      unwrap(
        api.POST('/api/v1/staff/security/incidents/{id}/actions', {
          params: { path: { id: incidentId } },
          body: { description: form.description.trim(), ownerId: form.ownerId, dueOn: form.dueOn },
        }),
      ),
    {
      invalidate: refresh,
      onDone: () => {
        toast.show(t('added'));
        setForm({ description: '', ownerId: '', dueOn: '' });
      },
    },
  );
  const done = useAction(
    (actionId: string) =>
      unwrap(api.POST('/api/v1/staff/security/incident-actions/{actionId}/done', { params: { path: { actionId } }, body: {} })),
    { invalidate: refresh, onDone: () => toast.show(t('markedDone')) },
  );
  const cancel = useAction(
    ({ actionId, reasonCode }: { actionId: string; reasonCode: string }) =>
      unwrap(
        api.POST('/api/v1/staff/security/incident-actions/{actionId}/cancel', {
          params: { path: { actionId } },
          body: { reasonCode },
        }),
      ),
    {
      invalidate: refresh,
      onDone: () => {
        toast.show(t('calledOff'));
        setCancelling(null);
      },
    },
  );
  return (
    <Card flush>
      <CardHeader title={t('title')} />
      <QueryState query={actions}>
        <DataTable<IncidentAction>
          rows={actions.data?.data ?? []}
          rowKey={(a) => a.id}
          empty={t('empty')}
          columns={[
            { key: 'd', header: t('col.action'), cell: (a) => a.description ?? <span className="t-secondary">{t('erased')}</span> },
            { key: 'o', header: t('col.owner'), cell: (a) => personNameIn(a.owner, locale) },
            {
              key: 'due',
              header: t('col.due'),
              cell: (a) => (a.overdue ? t('dueOverdue', { date: f.day(a.dueOn) }) : f.day(a.dueOn)),
            },
            {
              key: 's',
              header: t('col.state'),
              cell: (a) => (a.cancelReason ? `${label(a.state)} · ${label(a.cancelReason)}` : label(a.state)),
            },
            {
              key: 'x',
              header: <span className="visually-hidden">{c('actions')}</span>,
              className: 'table__actions',
              cell: (a) =>
                a.state === 'open' ? (
                  <span className="row" style={{ gap: 6 }}>
                    <Button size="sm" loading={done.isPending} onClick={() => done.mutate(a.id)}>
                      {t('done')}
                    </Button>
                    <Button size="sm" onClick={() => setCancelling(a)}>
                      {t('callOff')}
                    </Button>
                  </span>
                ) : null,
            },
          ]}
        />
      </QueryState>
      {closed ? null : (
        <form
          className="form"
          onSubmit={(e) => {
            e.preventDefault();
            if (form.description.trim() && form.ownerId && form.dueOn) add.mutate(undefined);
          }}
        >
          <ErrorAlert error={add.error ?? done.error} />
          <Field label={t('whatMustBeDone')} error={fieldError(add.error, 'description')}>
            {(p) => <Textarea {...p} rows={2} maxLength={1000} value={form.description} onChange={set('description')} />}
          </Field>
          <div className="form__row">
            <Field label={t('owner')} error={fieldError(add.error, 'ownerId')}>
              {(p) => (
                <Select {...p} value={form.ownerId} onChange={set('ownerId')}>
                  <option value="">{t('choose')}</option>
                  {owners.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.fullName}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <Field label={t('due')} error={fieldError(add.error, 'dueOn')}>
              {(p) => <Input {...p} type="date" value={form.dueOn} onChange={set('dueOn')} />}
            </Field>
          </div>
          <div>
            <Button type="submit" loading={add.isPending} disabled={!form.description.trim() || !form.ownerId || !form.dueOn}>
              {t('addAction')}
            </Button>
          </div>
        </form>
      )}
      <ReasonCodeDialog
        open={cancelling !== null}
        onClose={() => setCancelling(null)}
        title={t('callOffTitle')}
        codes={REASON_CODES.incidentActionCancel}
        confirmLabel={t('callOff')}
        danger
        pending={cancel.isPending}
        error={<ErrorAlert error={cancel.error} />}
        onConfirm={(code) => cancelling && cancel.mutate({ actionId: cancelling.id, reasonCode: code })}
      />
    </Card>
  );
}
