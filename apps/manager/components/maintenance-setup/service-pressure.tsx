'use client';

import { fieldError, unwrap } from '@jiwar/api';
import { ErrorAlert, QueryState, useAction } from '@jiwar/api/react';
import { useFormat, useT } from '@jiwar/i18n';
import { Badge, Button, Card, CardBody, CardHeader, Field, Input, useToast } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys } from '@/lib/queries';
import ar from '@/messages/ar/ms-analytics';
import en from '@/messages/en/ms-analytics';

/**
 * Service pressure (ADR 0079): how many open tickets one available
 * technician may carry before the dispatch and the managers are told. Told
 * once a rise, at most once an hour; empty turns the alert off.
 */
export function ServicePressureCard() {
  const t = useT(en, ar);
  const fmt = useFormat();
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
      onDone: () => toast.show(value.trim() === '' ? t('alertOff') : t('thresholdSaved')),
    },
  );
  return (
    <Card flush>
      <CardHeader title={t('pressure')} />
      <CardBody>
        <div className="stack">
          <p className="t-secondary">{t('pressureHint')}</p>
          {can('tickets.dispatch') ? (
            <QueryState query={state} rows={1}>
              {state.data ? (
                <div className="row" style={{ gap: 8, alignItems: 'center' }}>
                  <Badge tone={state.data.underPressure ? 'terracotta' : 'green'}>
                    {state.data.underPressure ? t('underPressure') : t('withinCapacity')}
                  </Badge>
                  <span className="t-secondary">
                    {t('counts', { open: state.data.open, available: state.data.available })}
                    {state.data.since ? t('since', { when: fmt.dateTime(state.data.since) }) : ''}
                  </span>
                </div>
              ) : null}
            </QueryState>
          ) : null}
          <Field label={t('threshold')} error={fieldError(save.error, 'openPerTechnician')}>
            {(f) => (
              <Input {...f} inputMode="numeric" style={{ maxWidth: 160 }} value={value} onChange={(e) => setValue(e.target.value)} />
            )}
          </Field>
          <span>
            <Button variant="primary" loading={save.isPending} onClick={() => save.mutate()}>
              {t('saveThreshold')}
            </Button>
          </span>
          <ErrorAlert error={save.error} />
        </div>
      </CardBody>
    </Card>
  );
}
