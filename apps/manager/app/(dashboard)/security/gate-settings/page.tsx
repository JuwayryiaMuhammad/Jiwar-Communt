'use client';

import { fieldError, unwrap } from '@jiwar/api';
import { ErrorAlert, QueryState, useAction } from '@jiwar/api/react';
import { Button, Card, Field, ForbiddenState, Input, PageHeader, useToast } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { GATE_SETTINGS, settingsChanges, settingsErrors, settingsForm, type GateSettingsForm } from '@/components/security/exceptions-logic';
import { api } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys } from '@/lib/queries';

/**
 * The gate's settings (ADR 0056), `gate.manage`: how long a field
 * exception waits and lets in, a visit's expected length (empty: no
 * overstay alert), how long a patrol may be out of its area, and the
 * recordings a patrol note or an incident takes. Only what changed is
 * sent; what was decided under the old values keeps them.
 */
export default function GateSettingsPage() {
  const toast = useToast();
  const { ready, can } = usePermissions();
  const allowed = can('gate.manage');
  const settings = useQuery({ queryKey: keys.gateSettings, queryFn: fetchers.gateSettings, enabled: allowed });
  const [form, setForm] = useState<GateSettingsForm | null>(null);
  useEffect(() => {
    if (settings.data) setForm(settingsForm(settings.data));
  }, [settings.data]);
  const save = useAction((body: ReturnType<typeof settingsChanges>) => unwrap(api.PATCH('/api/v1/staff/gate/settings', { body })), {
    invalidate: [keys.gateSettings],
    onDone: () => toast.show('Saved. What was asked before keeps its own times.'),
  });

  if (ready && !allowed)
    return (
      <>
        <PageHeader title="Gate settings" />
        <ForbiddenState />
      </>
    );

  const wrong = form ? settingsErrors(form) : [];
  const changes = form && settings.data ? settingsChanges(settings.data, form) : {};
  const ok = form !== null && wrong.length === 0 && Object.keys(changes).length > 0;
  return (
    <>
      <PageHeader title="Gate settings" description="Field exceptions, visits, patrols and recordings at the gate." />
      <QueryState query={settings}>
        {form ? (
          <Card>
            <form
              className="form"
              onSubmit={(ev) => {
                ev.preventDefault();
                if (ok) save.mutate(changes);
              }}
            >
              {GATE_SETTINGS.map((s) => (
                <Field
                  key={s.name}
                  label={`${s.label} (${s.min}–${s.max}${'nullable' in s ? '; empty: off' : ''})`}
                  error={fieldError(save.error, s.name) ?? (wrong.includes(s.name) ? `A whole number from ${s.min} to ${s.max}.` : undefined)}
                >
                  {(p) => (
                    <Input
                      {...p}
                      inputMode="numeric"
                      value={form[s.name]}
                      onChange={(ev) => setForm({ ...form, [s.name]: ev.target.value })}
                    />
                  )}
                </Field>
              ))}
              <ErrorAlert error={save.error} />
              <div>
                <Button type="submit" variant="primary" loading={save.isPending} disabled={!ok}>
                  Save
                </Button>
              </div>
            </form>
          </Card>
        ) : null}
      </QueryState>
    </>
  );
}
