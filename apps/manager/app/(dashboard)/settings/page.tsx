'use client';

import { unwrap } from '@jiwar/api';
import { ErrorAlert, fieldError, QueryState, useAction } from '@jiwar/api/react';
import { Button, Card, CardBody, CardHeader, Checkbox, Field, Input, PageHeader, Textarea, useToast } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { fetchers, keys, type Settings } from '@/lib/queries';

type Form = {
  timezone: string;
  emergencyPhone: string;
  visitorDirections: string;
  familyJoinRequiresApproval: boolean;
  maxHouseholdMembers: string;
  maxActiveVisitorPasses: string;
  gateRequestTimeoutSeconds: string;
};

function toForm(s: Settings): Form {
  return {
    timezone: s.timezone,
    emergencyPhone: s.emergencyPhone ?? '',
    visitorDirections: s.visitorDirections ?? '',
    familyJoinRequiresApproval: s.familyJoinRequiresApproval,
    maxHouseholdMembers: String(s.maxHouseholdMembers),
    maxActiveVisitorPasses: String(s.maxActiveVisitorPasses),
    gateRequestTimeoutSeconds: String(s.gateRequestTimeoutSeconds),
  };
}

/** Only the fields that changed; empty text clears a nullable value. */
function diff(s: Settings, f: Form) {
  const out: Record<string, unknown> = {};
  if (f.timezone.trim() !== s.timezone) out.timezone = f.timezone.trim();
  if ((f.emergencyPhone.trim() || null) !== s.emergencyPhone) out.emergencyPhone = f.emergencyPhone.trim() || null;
  if ((f.visitorDirections.trim() || null) !== s.visitorDirections) out.visitorDirections = f.visitorDirections.trim() || null;
  if (f.familyJoinRequiresApproval !== s.familyJoinRequiresApproval) out.familyJoinRequiresApproval = f.familyJoinRequiresApproval;
  for (const key of ['maxHouseholdMembers', 'maxActiveVisitorPasses', 'gateRequestTimeoutSeconds'] as const) {
    if (Number(f[key]) !== s[key]) out[key] = Number(f[key]);
  }
  return out;
}

export default function SettingsPage() {
  const toast = useToast();
  const settings = useQuery({ queryKey: keys.settings, queryFn: fetchers.settings });
  const [form, setForm] = useState<Form | null>(null);
  // Seed once: a background refetch (window focus) must not wipe unsaved edits.
  useEffect(() => {
    if (settings.data && form === null) setForm(toForm(settings.data));
  }, [settings.data, form]);

  const changes = settings.data && form ? diff(settings.data, form) : {};
  const dirty = Object.keys(changes).length > 0;

  const save = useAction(() => unwrap(api.PATCH('/api/v1/settings', { body: changes })), {
    invalidate: [keys.settings],
    onDone: (saved) => {
      setForm(toForm(saved));
      toast.show('Settings saved.');
    },
  });

  const set = <K extends keyof Form>(key: K, value: Form[K]) => form && setForm({ ...form, [key]: value });
  const err = (field: string) => fieldError(save.error, field);

  return (
    <>
      <PageHeader
        title="Settings"
        description="Compound-wide rules for households, visitors and the gate."
        actions={
          <>
            <Button disabled={!dirty} onClick={() => settings.data && setForm(toForm(settings.data))}>
              Discard
            </Button>
            <Button variant="primary" disabled={!dirty} loading={save.isPending} onClick={() => save.mutate(undefined)}>
              Save changes
            </Button>
          </>
        }
      />
      <QueryState query={settings}>
        {form ? (
          <form
            className="grid grid--2"
            style={{ alignItems: 'start' }}
            onSubmit={(e) => {
              e.preventDefault();
              if (dirty) save.mutate(undefined);
            }}
          >
            <Card flush>
              <CardHeader title="Compound" />
              <CardBody>
                <div className="form">
                  <Field label="Time zone" hint="IANA name, e.g. Africa/Cairo. Schedules and attendance use it." error={err('timezone')}>
                    {(p) => <Input {...p} value={form.timezone} onChange={(e) => set('timezone', e.target.value)} />}
                  </Field>
                  <Field label="Emergency phone" hint="On the visitor page and the worker card." error={err('emergencyPhone')}>
                    {(p) => <Input {...p} type="tel" value={form.emergencyPhone} onChange={(e) => set('emergencyPhone', e.target.value)} />}
                  </Field>
                  <Field label="Directions for visitors" hint="On the visitor's pass page." error={err('visitorDirections')}>
                    {(p) => (
                      <Textarea {...p} value={form.visitorDirections} onChange={(e) => set('visitorDirections', e.target.value)} />
                    )}
                  </Field>
                </div>
              </CardBody>
            </Card>
            <div className="stack">
              <Card flush>
                <CardHeader title="Households" />
                <CardBody>
                  <div className="form">
                    <Checkbox
                      label="New household members need a manager's approval"
                      checked={form.familyJoinRequiresApproval}
                      onChange={(e) => set('familyJoinRequiresApproval', e.target.checked)}
                    />
                    <Field label="Most members per household" error={err('maxHouseholdMembers')}>
                      {(p) => (
                        <Input
                          {...p}
                          type="number"
                          min={1}
                          value={form.maxHouseholdMembers}
                          onChange={(e) => set('maxHouseholdMembers', e.target.value)}
                        />
                      )}
                    </Field>
                  </div>
                </CardBody>
              </Card>
              <Card flush>
                <CardHeader title="Visitors and gate" />
                <CardBody>
                  <div className="form">
                    <Field label="Active visitor passes per unit" error={err('maxActiveVisitorPasses')}>
                      {(p) => (
                        <Input
                          {...p}
                          type="number"
                          min={1}
                          value={form.maxActiveVisitorPasses}
                          onChange={(e) => set('maxActiveVisitorPasses', e.target.value)}
                        />
                      )}
                    </Field>
                    <Field
                      label="Gate approval timeout (seconds)"
                      hint="How long a household has to answer the gate before its standing instruction applies (30–1800)."
                      error={err('gateRequestTimeoutSeconds')}
                    >
                      {(p) => (
                        <Input
                          {...p}
                          type="number"
                          min={30}
                          max={1800}
                          value={form.gateRequestTimeoutSeconds}
                          onChange={(e) => set('gateRequestTimeoutSeconds', e.target.value)}
                        />
                      )}
                    </Field>
                  </div>
                </CardBody>
              </Card>
              <ErrorAlert error={save.error} />
            </div>
          </form>
        ) : null}
      </QueryState>
    </>
  );
}
