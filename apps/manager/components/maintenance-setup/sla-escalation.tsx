'use client';

import { fieldError, unwrap } from '@jiwar/api';
import { ErrorAlert, useAction } from '@jiwar/api/react';
import { useT } from '@jiwar/i18n';
import { Button, Card, CardBody, CardHeader, Field, Input, useLabel, useToast } from '@jiwar/ui';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { keys, type SlaSettings } from '@/lib/queries';
import ar from '@/messages/ar/ms-sla';
import en from '@/messages/en/ms-sla';

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
  const t = useT(en, ar);
  const label = useLabel();
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
    { invalidate: [keys.slaSettings], onDone: () => toast.show(t('escalationSaved')) },
  );
  return (
    <Card flush>
      <CardHeader title={t('escalationLevels')} />
      <CardBody>
        <div className="stack">
          <p className="t-secondary">{t('escalationHint')}</p>
          <div className="row" style={{ gap: 12, flexWrap: 'wrap' }}>
            {PRIORITIES.map((p) => (
              <Field key={p} label={t('priorityPercent', { priority: label(p) })} error={fieldError(save.error, p)}>
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
              {t('saveLevels')}
            </Button>
          </span>
          <ErrorAlert error={save.error} />
        </div>
      </CardBody>
    </Card>
  );
}
