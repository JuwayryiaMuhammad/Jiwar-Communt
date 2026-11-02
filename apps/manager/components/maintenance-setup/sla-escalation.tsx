'use client';

import { fieldError, unwrap } from '@jiwar/api';
import { ErrorAlert, useAction } from '@jiwar/api/react';
import { Button, Card, CardBody, CardHeader, Field, Input, useToast } from '@jiwar/ui';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { keys, type SlaSettings } from '@/lib/queries';

const PRIORITIES = ['normal', 'urgent', 'emergency'] as const;
type Shares = Record<(typeof PRIORITIES)[number], string>;

const shares = (s?: SlaSettings): Shares => ({
  normal: s?.atRiskPercent.normal?.toString() ?? '',
  urgent: s?.atRiskPercent.urgent?.toString() ?? '',
  emergency: s?.atRiskPercent.emergency?.toString() ?? '',
});

/**
 * The SLA's escalation levels (ADR 0076): at this share of its target, a
 * running clock is at risk and its technician and the dispatch are told;
 * at the target, the breach tells the managers too. Empty: no warning at
 * that priority.
 */
export function SlaEscalation({ settings }: { settings?: SlaSettings }) {
  const toast = useToast();
  const [form, setForm] = useState<Shares>(shares(settings));
  useEffect(() => setForm(shares(settings)), [settings]);
  const save = useAction(
    () =>
      unwrap(
        api.PATCH('/api/v1/maintenance/sla-settings/escalation', {
          body: Object.fromEntries(PRIORITIES.map((p) => [p, form[p].trim() === '' ? null : Number(form[p])])),
        }),
      ),
    { invalidate: [keys.slaSettings], onDone: () => toast.show('The escalation levels are saved.') },
  );
  return (
    <Card flush>
      <CardHeader title="Escalation levels" />
      <CardBody>
        <div className="stack">
          <p className="t-secondary">
            At this share of its target (50–95 %), a running clock is at risk: its technician and the maintenance
            supervisors are told once. At the target itself, the breach tells the managers too. Leave a priority
            empty for no warning.
          </p>
          <div className="row" style={{ gap: 12, flexWrap: 'wrap' }}>
            {PRIORITIES.map((p) => (
              <Field key={p} label={`${p.charAt(0).toUpperCase()}${p.slice(1)} (%)`} error={fieldError(save.error, p)}>
                {(f) => (
                  <Input
                    {...f}
                    inputMode="numeric"
                    style={{ maxWidth: 120 }}
                    value={form[p]}
                    onChange={(e) => setForm((x) => ({ ...x, [p]: e.target.value }))}
                  />
                )}
              </Field>
            ))}
          </div>
          <span>
            <Button variant="primary" loading={save.isPending} onClick={() => save.mutate()}>
              Save levels
            </Button>
          </span>
          <ErrorAlert error={save.error} />
        </div>
      </CardBody>
    </Card>
  );
}
