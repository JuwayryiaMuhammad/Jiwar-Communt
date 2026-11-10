'use client';

import { REASON_CODES, unwrap } from '@jiwar/api';
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
  useCommonT,
  useLabel,
  useToast,
} from '@jiwar/ui';
import { useFormat, useLocale, useT } from '@jiwar/i18n';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { api } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys, type MaintenanceCaseDetail } from '@/lib/queries';
import ar from '@/messages/ar/cases';
import en from '@/messages/en/cases';

type CaseTicket = MaintenanceCaseDetail['tickets'][number];

/**
 * A community case (ADR 0081): its tickets, its one work order, and its
 * close — resolved (each reporter told) or dismissed, with a code.
 */
export default function CasePage() {
  const { id } = useParams<{ id: string }>();
  const t = useT(en, ar);
  const cm = useCommonT();
  const f = useFormat();
  const label = useLabel();
  const { locale } = useLocale();
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
        toast.show(x.status === 'resolved' ? t('resolved') : t('dismissed'));
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
    { ...refresh, onDone: () => toast.show(t('workOrderOpened')) },
  );
  return (
    <>
      <PageHeader
        back={
          <ButtonLink href="/cases" variant="text" size="sm" icon={<ArrowLeft aria-hidden className="icon-dir" />}>
            {t('title')}
          </ButtonLink>
        }
        title={c ? `${label(c.categoryKey)} · ${c.buildingName ?? t('deletedBuilding')}` : t('case')}
        description={c ? t(c.automatic ? 'openedAuto' : 'openedOn', { when: f.dateTime(c.openedAt) }) : undefined}
        actions={
          c && c.status === 'open' ? (
            <span className="row" style={{ gap: 6 }}>
              <Button variant="primary" onClick={() => setClosing('resolve')}>
                {t('resolve')}
              </Button>
              <Button onClick={() => setClosing('dismiss')}>{t('dismiss')}</Button>
            </span>
          ) : c ? (
            <Badge>{label(c.status)}</Badge>
          ) : undefined
        }
      />
      <QueryState query={detail}>
        {c ? (
          <div className="stack">
            <Card flush>
              <CardHeader title={t('workOrder')} />
              <CardBody>
                {c.workOrder ? (
                  <Link className="table__link" href={`/maintenance/${c.workOrder.id}`}>
                    {c.workOrder.number} · {label(c.workOrder.status)}
                  </Link>
                ) : c.status === 'open' ? (
                  <div className="stack">
                    <p className="t-secondary">{t('workOrderHint')}</p>
                    <div className="form__row">
                      <Field label={t('commonArea')}>
                        {(p) => (
                          <Select {...p} value={areaId} onChange={(e) => setAreaId(e.target.value)}>
                            <option value="">{cm('select')}</option>
                            {(areas.rows ?? []).map((x) => (
                              <option key={x.id} value={x.id}>
                                <span className="ltr">{x.code}</span> · {locale === 'ar' ? x.nameAr : x.nameEn}
                              </option>
                            ))}
                          </Select>
                        )}
                      </Field>
                      <Field label={t('whatToDo')}>
                        {(p) => <Input {...p} value={words} onChange={(e) => setWords(e.target.value)} />}
                      </Field>
                    </div>
                    <span>
                      <Button loading={order.isPending} disabled={!areaId || !words.trim()} onClick={() => order.mutate()}>
                        {t('openWorkOrder')}
                      </Button>
                    </span>
                    <ErrorAlert error={order.error} />
                  </div>
                ) : (
                  <p className="t-secondary">{t('noWorkOrder')}</p>
                )}
              </CardBody>
            </Card>
            <Card flush>
              <CardHeader title={t('ticketsCount', { count: f.number(c.ticketCount) })} />
              <DataTable<CaseTicket>
                rows={c.tickets}
                rowKey={(x) => x.id}
                empty={t('noTicket')}
                columns={[
                  {
                    key: 'number',
                    header: t('ticket'),
                    cell: (x) => (
                      <Link className="table__link" href={`/maintenance/${x.id}`}>
                        {x.number}
                      </Link>
                    ),
                  },
                  { key: 'unit', header: cm('unit'), cell: (x) => x.unitCode ?? '—' },
                  { key: 'status', header: cm('status'), cell: (x) => label(x.status) },
                  { key: 'joined', header: t('joined'), cell: (x) => f.dateTime(x.linkedAt) },
                ]}
              />
            </Card>
          </div>
        ) : null}
      </QueryState>
      <ReasonCodeDialog
        open={closing !== null}
        onClose={() => setClosing(null)}
        title={closing === 'resolve' ? t('resolveTitle') : t('dismissTitle')}
        description={
          closing === 'resolve'
            ? t('resolveDescription')
            : t('dismissDescription')
        }
        codes={closing === 'resolve' ? REASON_CODES.maintenanceCaseResolve : REASON_CODES.maintenanceCaseDismiss}
        confirmLabel={closing === 'resolve' ? t('resolve') : t('dismiss')}
        pending={close.isPending}
        error={<ErrorAlert error={close.error} />}
        onConfirm={(code) => closing && close.mutate({ verb: closing, code })}
      />
    </>
  );
}
