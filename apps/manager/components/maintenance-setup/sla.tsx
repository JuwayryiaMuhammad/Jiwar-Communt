'use client';

import { unwrap } from '@jiwar/api';
import { ErrorAlert, QueryState, useAction } from '@jiwar/api/react';
import { useFormat, useT } from '@jiwar/i18n';
import { Badge, Button, Card, CardBody, CardHeader, ConfirmDialog, useToast } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '@/lib/api';
import { fetchers, keys } from '@/lib/queries';
import ar from '@/messages/ar/ms-sla';
import en from '@/messages/en/ms-sla';
import { Categories } from './categories';
import { SlaEscalation } from './sla-escalation';
import { AnalyticsSettingsCard } from './analytics-settings';

/**
 * The SLA (ADR 0034): whether the compound measures response and resolution
 * times, and each category's targets. The switch is confirmed on its own:
 * it starts or stops the clocks of every open ticket.
 */
export function Sla() {
  const t = useT(en, ar);
  const f = useFormat();
  const toast = useToast();
  const settings = useQuery({ queryKey: keys.slaSettings, queryFn: fetchers.slaSettings });
  const [confirming, setConfirming] = useState(false);
  const on = settings.data?.slaEnabled === true;
  const toggle = useAction(() => unwrap(api.PATCH('/api/v1/maintenance/sla-settings', { body: { slaEnabled: !on } })), {
    invalidate: [keys.slaSettings, keys.ticketsAll],
    onDone: (next) => {
      toast.show(next.slaEnabled ? t('turnedOn') : t('turnedOff'));
      setConfirming(false);
    },
  });

  return (
    <div className="stack">
      <Card flush>
        <CardHeader title={t('measuring')} actions={<Badge tone={on ? 'green' : 'beige'}>{on ? t('on') : t('off')}</Badge>} />
        <QueryState query={settings} rows={2}>
          <CardBody>
            <div className="stack">
              <p>
                {on ? t('measuredBody', { when: f.dateTime(settings.data?.enabledAt) }) : t('notMeasuredBody')}
              </p>
              <span>
                <Button variant={on ? 'secondary' : 'primary'} onClick={() => setConfirming(true)}>
                  {on ? t('turnOff') : t('turnOn')}
                </Button>
              </span>
            </div>
          </CardBody>
        </QueryState>
      </Card>
      <SlaEscalation settings={settings.data} />
      {/* ADR 0081. */}
      <AnalyticsSettingsCard />
      <div className="stack stack--sm">
        <h2 className="t-title-md">{t('targetsByCategory')}</h2>
        <p className="t-secondary">{t('targetsHint')}</p>
      </div>
      <Categories view="sla" />
      <ConfirmDialog
        open={confirming}
        onClose={() => {
          setConfirming(false);
          toggle.reset();
        }}
        title={on ? t('stopTitle') : t('startTitle')}
        description={on ? t('stopBody') : t('startBody')}
        confirmLabel={on ? t('stopConfirm') : t('startConfirm')}
        // Red only here: stopping the clocks loses what they had measured.
        danger={on}
        pending={toggle.isPending}
        error={<ErrorAlert error={toggle.error} />}
        onConfirm={() => toggle.mutate()}
      />
    </div>
  );
}
