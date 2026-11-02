'use client';

import { formatDateTime, humanize, REASON_CODES, unwrap } from '@jiwar/api';
import { ErrorAlert, QueryState, useAction, useCursorList } from '@jiwar/api/react';
import {
  Badge,
  Button,
  ButtonLink,
  Card,
  CardBody,
  CardHeader,
  DataTable,
  Field,
  Input,
  PageHeader,
  ReasonCodeDialog,
  Select,
  useToast,
} from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { api } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys, type MaintenanceCaseDetail } from '@/lib/queries';

type CaseTicket = MaintenanceCaseDetail['tickets'][number];

/**
 * A community case (ADR 0081): its tickets, its one work order, and its
 * close — resolved (each reporter told) or dismissed, with a code.
 */
export default function CasePage() {
  const { id } = useParams<{ id: string }>();
  const { can } = usePermissions();
  const toast = useToast();
  const detail = useQuery({ queryKey: keys.case(id), queryFn: () => fetchers.case(id) });
  const c = detail.data;
  const [closing, setClosing] = useState<'resolve' | 'dismiss' | null>(null);
  const [areaId, setAreaId] = useState('');
  const [words, setWords] = useState('');
  const areas = useCursorList(keys.areas({ active: 'true' }), (cur) => fetchers.areas({ active: 'true' }, cur), {
    enabled: can('tickets.dispatch'),
  });
  const refresh = { invalidate: [keys.case(id), keys.cases('open'), keys.ticketsAll] };
  const close = useAction(
    (r: { verb: 'resolve' | 'dismiss'; code: string }) =>
      unwrap(
        r.verb === 'resolve'
          ? api.POST('/api/v1/maintenance/cases/{id}/resolve', { params: { path: { id } }, body: { reasonCode: r.code } })
          : api.POST('/api/v1/maintenance/cases/{id}/dismiss', { params: { path: { id } }, body: { reasonCode: r.code } }),
      ),
    {
      ...refresh,
      onDone: (x) => {
        toast.show(x.status === 'resolved' ? 'Resolved. Its reporters are told.' : 'Dismissed.');
        setClosing(null);
      },
    },
  );
  const order = useAction(
    () =>
      unwrap(
        api.POST('/api/v1/maintenance/work-orders', {
          body: { commonAreaId: areaId, categoryId: c!.categoryId, caseId: id, description: words },
        }),
      ),
    { ...refresh, onDone: () => toast.show('The case’s work order is open.') },
  );
  return (
    <>
      <PageHeader
        back={
          <ButtonLink href="/cases" variant="text" size="sm" icon={<ArrowLeft aria-hidden />}>
            Community cases
          </ButtonLink>
        }
        title={c ? `${humanize(c.categoryKey)} · ${c.buildingName ?? 'a deleted building'}` : 'Case'}
        description={c ? `Opened ${formatDateTime(c.openedAt)}${c.automatic ? ' by itself, at the threshold' : ''}` : undefined}
        actions={
          c && c.status === 'open' ? (
            <span className="row" style={{ gap: 6 }}>
              <Button variant="primary" onClick={() => setClosing('resolve')}>
                Resolve
              </Button>
              <Button onClick={() => setClosing('dismiss')}>Dismiss</Button>
            </span>
          ) : c ? (
            <Badge>{humanize(c.status)}</Badge>
          ) : undefined
        }
      />
      <QueryState query={detail}>
        {c ? (
          <div className="stack">
            <Card flush>
              <CardHeader title="Work order" />
              <CardBody>
                {c.workOrder ? (
                  <Link className="table__link" href={`/maintenance/${c.workOrder.id}`}>
                    {c.workOrder.number} · {humanize(c.workOrder.status)}
                  </Link>
                ) : c.status === 'open' ? (
                  <div className="stack">
                    <p className="t-secondary">One work order answers the whole case, on the common area where the fault is.</p>
                    <div className="form__row">
                      <Field label="Common area">
                        {(p) => (
                          <Select {...p} value={areaId} onChange={(e) => setAreaId(e.target.value)}>
                            <option value="">Choose…</option>
                            {(areas.rows ?? []).map((x) => (
                              <option key={x.id} value={x.id}>
                                {x.code} · {x.nameEn}
                              </option>
                            ))}
                          </Select>
                        )}
                      </Field>
                      <Field label="What is to be done">
                        {(p) => <Input {...p} value={words} onChange={(e) => setWords(e.target.value)} />}
                      </Field>
                    </div>
                    <span>
                      <Button loading={order.isPending} disabled={!areaId || !words.trim()} onClick={() => order.mutate()}>
                        Open the work order
                      </Button>
                    </span>
                    <ErrorAlert error={order.error} />
                  </div>
                ) : (
                  <p className="t-secondary">None.</p>
                )}
              </CardBody>
            </Card>
            <Card flush>
              <CardHeader title={`Tickets (${c.ticketCount})`} />
              <DataTable<CaseTicket>
                rows={c.tickets}
                rowKey={(t) => t.id}
                empty="No ticket you may see"
                columns={[
                  {
                    key: 'number',
                    header: 'Ticket',
                    cell: (t) => (
                      <Link className="table__link" href={`/maintenance/${t.id}`}>
                        {t.number}
                      </Link>
                    ),
                  },
                  { key: 'unit', header: 'Unit', cell: (t) => t.unitCode ?? '—' },
                  { key: 'status', header: 'Status', cell: (t) => humanize(t.status) },
                  { key: 'joined', header: 'Joined', cell: (t) => formatDateTime(t.linkedAt) },
                ]}
              />
            </Card>
          </div>
        ) : null}
      </QueryState>
      <ReasonCodeDialog
        open={closing !== null}
        onClose={() => setClosing(null)}
        title={closing === 'resolve' ? 'Resolve this case?' : 'Dismiss this case?'}
        description={
          closing === 'resolve'
            ? 'Each resident who reported one of its tickets is told. The tickets keep their own course.'
            : 'Nobody is told. Its tickets stay in it and do not count towards a new case.'
        }
        codes={closing === 'resolve' ? REASON_CODES.maintenanceCaseResolve : REASON_CODES.maintenanceCaseDismiss}
        confirmLabel={closing === 'resolve' ? 'Resolve' : 'Dismiss'}
        pending={close.isPending}
        error={<ErrorAlert error={close.error} />}
        onConfirm={(code) => closing && close.mutate({ verb: closing, code })}
      />
    </>
  );
}
