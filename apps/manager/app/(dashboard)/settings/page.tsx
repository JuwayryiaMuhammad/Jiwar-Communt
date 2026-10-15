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
  officePhone: string;
  dutyPhone: string;
  visitorDirections: string;
  familyJoinRequiresApproval: boolean;
  maxHouseholdMembers: string;
  maxActiveVisitorPasses: string;
  gateRequestTimeoutSeconds: string;
  allowAlwaysAllow: boolean;
};

function toForm(s: Settings): Form {
  return {
    timezone: s.timezone,
    emergencyPhone: s.emergencyPhone ?? '',
    officePhone: s.officePhone ?? '',
    dutyPhone: s.dutyPhone ?? '',
    visitorDirections: s.visitorDirections ?? '',
    familyJoinRequiresApproval: s.familyJoinRequiresApproval,
    maxHouseholdMembers: String(s.maxHouseholdMembers),
    maxActiveVisitorPasses: String(s.maxActiveVisitorPasses),
    gateRequestTimeoutSeconds: String(s.gateRequestTimeoutSeconds),
    allowAlwaysAllow: s.allowAlwaysAllow,
  };
}

/** Only the fields that changed; empty text clears a nullable value. */
function diff(s: Settings, f: Form) {
  const out: Record<string, unknown> = {};
  if (f.timezone.trim() !== s.timezone) out.timezone = f.timezone.trim();
  for (const key of ['emergencyPhone', 'officePhone', 'dutyPhone'] as const) {
    if ((f[key].trim() || null) !== s[key]) out[key] = f[key].trim() || null;
  }
  if ((f.visitorDirections.trim() || null) !== s.visitorDirections) out.visitorDirections = f.visitorDirections.trim() || null;
  if (f.familyJoinRequiresApproval !== s.familyJoinRequiresApproval) out.familyJoinRequiresApproval = f.familyJoinRequiresApproval;
  if (f.allowAlwaysAllow !== s.allowAlwaysAllow) out.allowAlwaysAllow = f.allowAlwaysAllow;
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
                  <Field
                    label="Emergency phone"
                    hint="On the visitor page, the worker card and every unit's emergency contacts."
                    error={err('emergencyPhone')}
                  >
                    {(p) => <Input {...p} type="tel" value={form.emergencyPhone} onChange={(e) => set('emergencyPhone', e.target.value)} />}
                  </Field>
                  <Field
                    label="Community office phone"
                    hint="In every unit's emergency contacts."
                    error={err('officePhone')}
                  >
                    {(p) => <Input {...p} type="tel" value={form.officePhone} onChange={(e) => set('officePhone', e.target.value)} />}
                  </Field>
                  <Field
                    label="Duty manager phone"
                    hint="In every unit's emergency contacts, and what a household sees when the management answers an emergency."
                    error={err('dutyPhone')}
                  >
                    {(p) => <Input {...p} type="tel" value={form.dutyPhone} onChange={(e) => set('dutyPhone', e.target.value)} />}
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
                      hint="How long a household has to answer the gate before its gate instructions apply (30–1800)."
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
                    <Checkbox
                      label="Households may tell the gate to always let someone in"
                      checked={form.allowAlwaysAllow}
                      onChange={(e) => set('allowAlwaysAllow', e.target.checked)}
                    />
                    <p className="field__hint" style={{ margin: 0 }}>
                      When off, no new “always allow” instruction can be added, and the guard treats existing ones as
                      “call first”. The guard logs every entry either way.
                    </p>
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
