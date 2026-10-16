'use client';

import { fieldError, unwrap } from '@jiwar/api';
import { ErrorAlert, QueryState, useAction } from '@jiwar/api/react';
import { Button, Card, Checkbox, Field, ForbiddenState, Input, PageHeader, useToast } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { addDayOff, describeDays, toggleDay, validHours, WEEKDAYS } from '@/components/permits/logic';
import { api } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys, type PermitSettings } from '@/lib/queries';

/** The compound's work days, hours and days off for works and moves (ADR 0049). */
export default function PermitSettingsPage() {
  const toast = useToast();
  const { ready, can } = usePermissions();
  const allowed = can('permits.manage');
  const settings = useQuery({ queryKey: keys.permitSettings, queryFn: fetchers.permitSettings, enabled: allowed });
  const [form, setForm] = useState<PermitSettings | null>(null);
  const [newDay, setNewDay] = useState('');
  useEffect(() => {
    if (settings.data) setForm(settings.data);
  }, [settings.data]);
  const save = useAction(
    (body: PermitSettings) => unwrap(api.PATCH('/api/v1/staff/permit-settings', { body })),
    {
      invalidate: [keys.permitSettings],
      onDone: () => toast.show('Saved. The guard applies them from the next entry; permits already approved keep their own dates.'),
    },
  );
  if (ready && !allowed)
    return (
      <>
        <PageHeader title="Work hours" />
        <ForbiddenState />
      </>
    );
  const ok = form !== null && form.workDays.length > 0 && validHours(form.workHours.from, form.workHours.to);
  return (
    <>
      <PageHeader
        title="Work hours"
        description="When works and furniture moves may go on. Residents’ requests must fit them; the guard refuses entries outside them."
      />
      <QueryState query={settings}>
        {form ? (
          <Card>
            <form
              className="form"
              onSubmit={(e) => {
                e.preventDefault();
                if (ok) save.mutate(form);
              }}
            >
              <Field label={`Work days (${describeDays(form.workDays)})`} error={fieldError(save.error, 'workDays')}>
                {() => (
                  <div className="row" style={{ gap: 12, flexWrap: 'wrap' }}>
                    {WEEKDAYS.map((name, day) => (
                      <Checkbox
                        key={name}
                        label={name}
                        checked={form.workDays.includes(day)}
                        onChange={() => setForm({ ...form, workDays: toggleDay(form.workDays, day) })}
                      />
                    ))}
                  </div>
                )}
              </Field>
              <div className="row" style={{ gap: 12 }}>
                <Field label="From" error={fieldError(save.error, 'workHours')}>
                  {(p) => (
                    <Input
                      {...p}
                      type="time"
                      value={form.workHours.from}
                      onChange={(e) => setForm({ ...form, workHours: { ...form.workHours, from: e.target.value } })}
                    />
                  )}
                </Field>
                <Field label="To">
                  {(p) => (
                    <Input
                      {...p}
                      type="time"
                      value={form.workHours.to}
                      onChange={(e) => setForm({ ...form, workHours: { ...form.workHours, to: e.target.value } })}
                    />
                  )}
                </Field>
              </div>
              <Field label="Days off (feasts)" error={fieldError(save.error, 'daysOff')}>
                {(p) => (
                  <div className="stack stack--sm">
                    <div className="row" style={{ gap: 8 }}>
                      <Input {...p} type="date" value={newDay} onChange={(e) => setNewDay(e.target.value)} />
                      <Button
                        onClick={() => {
                          const next = addDayOff(form.daysOff, newDay);
                          if (next) {
                            setForm({ ...form, daysOff: next });
                            setNewDay('');
                          }
                        }}
                      >
                        Add
                      </Button>
                    </div>
                    {form.daysOff.map((d) => (
                      <span key={d} className="row" style={{ gap: 8 }}>
                        <span className="t-mono">{d}</span>
                        <Button variant="text" onClick={() => setForm({ ...form, daysOff: form.daysOff.filter((x) => x !== d) })}>
                          Remove
                        </Button>
                      </span>
                    ))}
                  </div>
                )}
              </Field>
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
