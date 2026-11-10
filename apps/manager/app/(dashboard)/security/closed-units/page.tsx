'use client';

import { unwrap, type Schema } from '@jiwar/api';
import { QueryState } from '@jiwar/api/react';
import { useFormat, useT } from '@jiwar/i18n';
import { Badge, Button, Card, DataTable, PageHeader, useLabel } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useState } from 'react';
import { NewTaskDialog } from '@/components/security/new-task-dialog';
import { RecordEntryDialog } from '@/components/security/unit-entry-dialogs';
import { api } from '@/lib/api';
import ar from '@/messages/ar/sec-closed-units';
import en from '@/messages/en/sec-closed-units';

type ClosedUnit = Schema<'ClosedUnitView'>;
const KEY = ['closed-units'] as const;

/**
 * The units in closed mode (ADR 0083): since when, their last inspection,
 * an owner's open request, their proxies, and their round. A round falls
 * due every N days (the gate settings) after the unit closed or was last
 * inspected: schedule it as a guard's inspection. An emergency entry is
 * recorded from here too.
 */
export default function ClosedUnitsPage() {
  const t = useT(en, ar);
  const f = useFormat();
  const label = useLabel();
  const [scheduling, setScheduling] = useState<ClosedUnit | null>(null);
  const [entering, setEntering] = useState<ClosedUnit | null>(null);
  const list = useQuery({
    queryKey: KEY,
    queryFn: () => unwrap(api.GET('/api/v1/staff/security/closed-units')),
    refetchInterval: 300_000,
  });
  return (
    <>
      <PageHeader title={t('title')} description={t('description')} />
      <Card flush>
        <QueryState query={list}>
          <DataTable<ClosedUnit>
            rows={list.data?.data}
            rowKey={(u) => u.unitId}
            empty={t('empty')}
            emptyHint={t('emptyHint')}
            columns={[
              {
                key: 'unit',
                header: t('col.unit'),
                cell: (u) => (
                  <span>
                    <strong>{u.unitCode}</strong>
                    {u.building ? <span className="t-secondary"> · {u.building}</span> : null}
                  </span>
                ),
              },
              { key: 'since', header: t('col.since'), cell: (u) => f.date(u.closedSince) },
              {
                key: 'last',
                header: t('col.last'),
                cell: (u) =>
                  u.lastInspection ? (
                    <span>
                      {f.dateTime(u.lastInspection.doneAt)}{' '}
                      <Badge tone={u.lastInspection.outcome === 'issue_found' ? 'terracotta' : 'green'}>{label(u.lastInspection.outcome)}</Badge>
                    </span>
                  ) : (
                    <span className="t-secondary">{t('noneYet')}</span>
                  ),
              },
              {
                key: 'request',
                header: t('col.request'),
                cell: (u) =>
                  u.openRequest ? (
                    <Link className="table__link" href="/security/inspection-requests">
                      {t('requestStatus', { reference: u.openRequest.reference, status: label(u.openRequest.status) })}
                    </Link>
                  ) : (
                    '—'
                  ),
              },
              { key: 'proxies', header: t('col.proxies'), cell: (u) => f.number(u.liveProxies) },
              {
                key: 'round',
                header: t('col.round'),
                cell: (u) =>
                  u.round ? (
                    <Badge tone={u.round.status === 'due' ? 'terracotta' : 'beige'}>
                      {u.round.status === 'due' ? t('dueSince', { date: f.day(u.round.dueOn) }) : t('scheduled')}
                    </Badge>
                  ) : (
                    <span className="t-secondary">{t('next', { date: f.day(u.nextRoundOn) })}</span>
                  ),
              },
              {
                key: 'act',
                header: '',
                cell: (u) => (
                  <span style={{ display: 'flex', gap: 8 }}>
                    {u.round?.status === 'due' ? (
                      <Button size="sm" variant="primary" onClick={() => setScheduling(u)}>
                        {t('schedule')}
                      </Button>
                    ) : null}
                    <Button size="sm" onClick={() => setEntering(u)}>
                      {t('emergencyEntry')}
                    </Button>
                  </span>
                ),
              },
            ]}
          />
        </QueryState>
      </Card>
      {scheduling?.round ? (
        <NewTaskDialog
          round={{ id: scheduling.round.id, unitId: scheduling.unitId, unitCode: scheduling.unitCode }}
          onClose={() => setScheduling(null)}
        />
      ) : null}
      {entering ? (
        <RecordEntryDialog
          unit={{ id: entering.unitId, code: entering.unitCode }}
          onClose={() => setEntering(null)}
        />
      ) : null}
    </>
  );
}
