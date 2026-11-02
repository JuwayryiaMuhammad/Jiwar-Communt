'use client';

import { fieldError, formatDateTime, unwrap } from '@jiwar/api';
import { ErrorAlert, QueryState, useAction } from '@jiwar/api/react';
import { Badge, Button, Card, CardBody, CardHeader, Field, Input, useToast } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys } from '@/lib/queries';

/**
 * Service pressure (ADR 0079): how many open tickets one available
 * technician may carry before the dispatch and the managers are told. Told
 * once a rise, at most once an hour; empty turns the alert off.
 */
export function ServicePressureCard() {
  const toast = useToast();
  const { can } = usePermissions();
  const state = useQuery({
    queryKey: keys.servicePressure,
    queryFn: fetchers.servicePressure,
    enabled: can('tickets.dispatch'),
    retry: false,
  });
  const [value, setValue] = useState('');
  useEffect(() => setValue(state.data?.threshold?.toString() ?? ''), [state.data]);
  const save = useAction(
    () =>
      unwrap(
        api.PATCH('/api/v1/maintenance/service-pressure', {
          body: { openPerTechnician: value.trim() === '' ? null : Number(value) },
        }),
      ),
    {
      invalidate: [keys.servicePressure, keys.dashboardAll],
      onDone: () => toast.show(value.trim() === '' ? 'The service-pressure alert is off.' : 'The threshold is saved.'),
    },
  );
  return (
    <Card flush>
      <CardHeader title="Service pressure" />
      <CardBody>
        <div className="stack">
          <p className="t-secondary">
            When the open tickets (new, or in a technician’s hands) reach this many for each available technician, the
            maintenance supervisors and the managers are told: once a rise, and at most once an hour however often it comes
            and goes. Leave it empty for no alert.
          </p>
          {can('tickets.dispatch') ? (
            <QueryState query={state} rows={1}>
              {state.data ? (
                <div className="row" style={{ gap: 8, alignItems: 'center' }}>
                  <Badge tone={state.data.underPressure ? 'terracotta' : 'green'}>
                    {state.data.underPressure ? 'Under pressure' : 'Within capacity'}
                  </Badge>
                  <span className="t-secondary">
                    {state.data.open} open · {state.data.available} available
                    {state.data.since ? ` · since ${formatDateTime(state.data.since)}` : ''}
                  </span>
                </div>
              ) : null}
            </QueryState>
          ) : null}
          <Field label="Open tickets per available technician (1–100)" error={fieldError(save.error, 'openPerTechnician')}>
            {(f) => (
              <Input {...f} inputMode="numeric" style={{ maxWidth: 160 }} value={value} onChange={(e) => setValue(e.target.value)} />
            )}
          </Field>
          <span>
            <Button variant="primary" loading={save.isPending} onClick={() => save.mutate()}>
              Save threshold
            </Button>
          </span>
          <ErrorAlert error={save.error} />
        </div>
      </CardBody>
    </Card>
  );
}
