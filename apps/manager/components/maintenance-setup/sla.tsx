'use client';

import { formatDateTime, unwrap } from '@jiwar/api';
import { ErrorAlert, QueryState, useAction } from '@jiwar/api/react';
import { Badge, Button, Card, CardBody, CardHeader, ConfirmDialog, useToast } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '@/lib/api';
import { fetchers, keys } from '@/lib/queries';
import { Categories } from './categories';

/**
 * The SLA (ADR 0034): whether the compound measures response and resolution
 * times, and each category's targets. The switch is confirmed on its own:
 * it starts or stops the clocks of every open ticket.
 */
export function Sla() {
  const toast = useToast();
  const settings = useQuery({ queryKey: keys.slaSettings, queryFn: fetchers.slaSettings });
  const [confirming, setConfirming] = useState(false);
  const on = settings.data?.slaEnabled === true;
  const toggle = useAction(() => unwrap(api.PATCH('/api/v1/maintenance/sla-settings', { body: { slaEnabled: !on } })), {
    invalidate: [keys.slaSettings, keys.ticketsAll],
    onDone: (next) => {
      toast.show(next.slaEnabled ? 'The SLA is on. Clocks start for the open tickets now.' : 'The SLA is off. The running clocks have stopped.');
      setConfirming(false);
    },
  });

  return (
    <div className="stack">
      <Card flush>
        <CardHeader title="Measuring the SLA" actions={<Badge tone={on ? 'green' : 'beige'}>{on ? 'On' : 'Off'}</Badge>} />
        <QueryState query={settings} rows={2}>
          <CardBody>
            <div className="stack">
              <p>
                {on
                  ? `Response and resolution times are measured against each category's targets below. On since ${formatDateTime(settings.data?.enabledAt)}.`
                  : 'No ticket has a due time, nothing is overdue, and residents cannot escalate. The targets below are kept for when you turn it on.'}
              </p>
              <span>
                <Button variant={on ? 'secondary' : 'primary'} onClick={() => setConfirming(true)}>
                  {on ? 'Turn off' : 'Turn on'}
                </Button>
              </span>
            </div>
          </CardBody>
        </QueryState>
      </Card>
      <div className="stack stack--sm">
        <h2 className="t-title-md">Targets by category</h2>
        <p className="t-secondary">Response / resolution, per priority. A change retargets the clocks still running.</p>
      </div>
      <Categories view="sla" />
      <ConfirmDialog
        open={confirming}
        onClose={() => {
          setConfirming(false);
          toggle.reset();
        }}
        title={on ? 'Stop measuring the SLA?' : 'Start measuring the SLA?'}
        description={
          on
            ? 'Every running clock stops now. Open tickets lose their due times, nothing is overdue any more, and residents can no longer escalate. Turning it on again starts fresh clocks; the time in between is never counted.'
            : "Clocks start now for every open ticket, against its category's targets. Nothing is backdated: a ticket opened last week is measured from this moment. Residents will see due times and may escalate a ticket that becomes overdue."
        }
        confirmLabel={on ? 'Turn off and stop the clocks' : 'Turn on and start the clocks'}
        danger={on}
        pending={toggle.isPending}
        error={<ErrorAlert error={toggle.error} />}
        onConfirm={() => toggle.mutate()}
      />
    </div>
  );
}
