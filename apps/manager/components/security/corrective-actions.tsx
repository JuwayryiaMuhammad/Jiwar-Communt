'use client';

import { fieldError, formatDate, humanize, REASON_CODES, unwrap } from '@jiwar/api';
import { ErrorAlert, QueryState, useAction } from '@jiwar/api/react';
import { Button, Card, CardHeader, DataTable, Field, Input, ReasonCodeDialog, Select, Textarea, useToast } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { personName } from '@/components/security/logic';
import { api } from '@/lib/api';
import { fetchers, keys, type IncidentAction } from '@/lib/queries';

/**
 * An incident's corrective actions (ADR 0087): what must be done, by whom
 * and by when. The incident does not close while one is open.
 */
export function CorrectiveActions({ incidentId, closed }: { incidentId: string; closed: boolean }) {
  const toast = useToast();
  const actions = useQuery({ queryKey: keys.incidentActions(incidentId), queryFn: () => fetchers.incidentActions(incidentId) });
  const accounts = useQuery({ queryKey: [...keys.accounts, 'owners'], queryFn: () => fetchers.accounts(undefined, 100) });
  const owners = (accounts.data?.data ?? []).filter(
    (a) => !a.erased && a.status === 'active' && (a.type === 'staff' || a.type === 'manager'),
  );
  const [f, setF] = useState({ description: '', ownerId: '', dueOn: '' });
  const [cancelling, setCancelling] = useState<IncidentAction | null>(null);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const refresh = [keys.incidentActions(incidentId), keys.securityIncidentsAll];
  const add = useAction(
    () =>
      unwrap(
        api.POST('/api/v1/staff/security/incidents/{id}/actions', {
          params: { path: { id: incidentId } },
          body: { description: f.description.trim(), ownerId: f.ownerId, dueOn: f.dueOn },
        }),
      ),
    {
      invalidate: refresh,
      onDone: () => {
        toast.show('Action added; its owner is told.');
        setF({ description: '', ownerId: '', dueOn: '' });
      },
    },
  );
  const done = useAction(
    (actionId: string) =>
      unwrap(api.POST('/api/v1/staff/security/incident-actions/{actionId}/done', { params: { path: { actionId } }, body: {} })),
    { invalidate: refresh, onDone: () => toast.show('Marked done.') },
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
        toast.show('Called off.');
        setCancelling(null);
      },
    },
  );
  return (
    <Card flush>
      <CardHeader title="Corrective actions" />
      <QueryState query={actions}>
        <DataTable<IncidentAction>
          rows={actions.data?.data ?? []}
          rowKey={(a) => a.id}
          empty="No corrective action"
          columns={[
            { key: 'd', header: 'Action', cell: (a) => a.description ?? <span className="t-secondary">Erased</span> },
            { key: 'o', header: 'Owner', cell: (a) => personName(a.owner) },
            { key: 'due', header: 'Due', cell: (a) => `${formatDate(a.dueOn)}${a.overdue ? ' · overdue' : ''}` },
            {
              key: 's',
              header: 'State',
              cell: (a) => (a.cancelReason ? `${humanize(a.state)} · ${humanize(a.cancelReason)}` : humanize(a.state)),
            },
            {
              key: 'x',
              header: <span className="visually-hidden">Actions</span>,
              className: 'table__actions',
              cell: (a) =>
                a.state === 'open' ? (
                  <span className="row" style={{ gap: 6 }}>
                    <Button size="sm" loading={done.isPending} onClick={() => done.mutate(a.id)}>
                      Done
                    </Button>
                    <Button size="sm" onClick={() => setCancelling(a)}>
                      Call off
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
            if (f.description.trim() && f.ownerId && f.dueOn) add.mutate(undefined);
          }}
        >
          <ErrorAlert error={add.error ?? done.error} />
          <Field label="What must be done" error={fieldError(add.error, 'description')}>
            {(p) => <Textarea {...p} rows={2} maxLength={1000} value={f.description} onChange={set('description')} />}
          </Field>
          <div className="form__row">
            <Field label="Owner" error={fieldError(add.error, 'ownerId')}>
              {(p) => (
                <Select {...p} value={f.ownerId} onChange={set('ownerId')}>
                  <option value="">Choose…</option>
                  {owners.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.fullName}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <Field label="Due" error={fieldError(add.error, 'dueOn')}>
              {(p) => <Input {...p} type="date" value={f.dueOn} onChange={set('dueOn')} />}
            </Field>
          </div>
          <div>
            <Button type="submit" loading={add.isPending} disabled={!f.description.trim() || !f.ownerId || !f.dueOn}>
              Add action
            </Button>
          </div>
        </form>
      )}
      <ReasonCodeDialog
        open={cancelling !== null}
        onClose={() => setCancelling(null)}
        title="Call the action off"
        codes={REASON_CODES.incidentActionCancel}
        confirmLabel="Call off"
        danger
        pending={cancel.isPending}
        error={<ErrorAlert error={cancel.error} />}
        onConfirm={(c) => cancelling && cancel.mutate({ actionId: cancelling.id, reasonCode: c })}
      />
    </Card>
  );
}
