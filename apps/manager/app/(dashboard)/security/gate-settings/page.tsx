'use client';

import { fieldError, unwrap } from '@jiwar/api';
import { ErrorAlert, QueryState, useAction } from '@jiwar/api/react';
import { Badge, Button, Card, CardBody, CardHeader, Checkbox, Field, ForbiddenState, Input, PageHeader, useToast } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { GATE_SETTINGS, settingsChanges, settingsErrors, settingsForm, type GateSettingsForm } from '@/components/security/exceptions-logic';
import { api } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys } from '@/lib/queries';

/**
 * Face checks (ADR 0068): advisory searches of a guard's photo against the
 * blocklist's faces. Turned on only with the management's word that a
 * visible notice is posted at the gate (a face template is sensitive data,
 * Law 151/2020); off, every template at the vendor is removed.
 */
function FaceChecks({ on }: { on: boolean }) {
  const toast = useToast();
  const [posted, setPosted] = useState(false);
  const save = useAction(
    () => unwrap(api.PATCH('/api/v1/staff/gate/settings', { body: on ? { faceChecks: false } : { faceChecks: true, faceChecksNoticePosted: true } })),
    {
      invalidate: [keys.gateSettings],
      onDone: () => {
        setPosted(false);
        toast.show(on ? 'Face checks are off: the vendor’s templates are being removed.' : 'Face checks are on: the blocklist’s faces are being enrolled.');
      },
    },
  );
  return (
    <Card>
      <CardHeader title="Face checks" actions={<Badge tone={on ? 'green' : 'beige'}>{on ? 'On' : 'Off'}</Badge>} />
      <CardBody>
        <div className="form">
          <p className="t-secondary">
            A guard’s photo of someone at the gate is searched against the faces of the live blocklist entries. A possible match is the guard’s to judge and
            the keepers’ to hear of: nobody is refused by a face alone, and the vendor’s score is never shown.
          </p>
          {on ? null : (
            <Checkbox
              label="A visible notice that faces are checked is posted at every gate"
              checked={posted}
              onChange={(e) => setPosted(e.target.checked)}
            />
          )}
          <ErrorAlert error={save.error} />
          <div>
            <Button variant={on ? 'danger' : 'primary'} loading={save.isPending} disabled={!on && !posted} onClick={() => save.mutate(undefined)}>
              {on ? 'Turn face checks off' : 'Turn face checks on'}
            </Button>
          </div>
        </div>
      </CardBody>
    </Card>
  );
}

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
      <PageHeader title="Gate settings" description="Field exceptions, visits, patrols, recordings, calls and face checks at the gate." />
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
        {settings.data ? <FaceChecks on={settings.data.faceChecks} /> : null}
      </QueryState>
    </>
  );
}
