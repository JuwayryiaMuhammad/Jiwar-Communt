'use client';

import { REASON_CODES, unwrap } from '@jiwar/api';
import { ErrorAlert, LoadMore, QueryState, useAction, useCursorList } from '@jiwar/api/react';
import { useT } from '@jiwar/i18n';
import { Badge, Button, Card, DataTable, ForbiddenState, PageHeader, ReasonCodeDialog, Select, useCommonT, useLabel, useToast } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useLocalName } from '@/components/facilities/bits';
import { useSlotText } from '@/components/management-requests/bits';
import { api } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys, type SpaceUse, type SpaceUseArea, type SpaceUseStatus } from '@/lib/queries';
import ar from '@/messages/ar/fac-space-uses';
import en from '@/messages/en/fac-space-uses';

const STATUSES: (SpaceUseStatus | '')[] = ['pending', 'approved', 'refused', 'cancelled', 'expired', ''];

/** The common areas open to requests (`spaces.manage`). */
function OpenAreas() {
  const t = useT(en, ar);
  const c = useCommonT();
  const localName = useLocalName();
  const toast = useToast();
  const open = useQuery({ queryKey: keys.spaceUseAreas, queryFn: fetchers.spaceUseAreas });
  const areas = useQuery({
    queryKey: keys.areas({ active: 'true' }),
    queryFn: () => fetchers.areas({ active: 'true' }),
  });
  const [picked, setPicked] = useState('');
  const change = useAction(
    (input: { id: string; open: boolean }) =>
      input.open
        ? unwrap(api.PUT('/api/v1/staff/space-use-areas/{commonAreaId}', { params: { path: { commonAreaId: input.id } } }))
        : unwrap(api.DELETE('/api/v1/staff/space-use-areas/{commonAreaId}', { params: { path: { commonAreaId: input.id } } })),
    {
      invalidate: [keys.spaceUseAreas],
      onDone: (_r, v) => {
        toast.show(v.open ? t('opened') : t('closedToRequests'));
        setPicked('');
      },
    },
  );
  const openIds = new Set((open.data?.data ?? []).map((a) => a.commonAreaId));
  const candidates = (areas.data?.data ?? []).filter((a) => a.kind !== 'building' && !openIds.has(a.id));
  return (
    <Card>
      <div className="stack">
        <h3>{t('openTitle')}</h3>
        <div className="row" style={{ gap: 8 }}>
          <Select value={picked} onChange={(e) => setPicked(e.target.value)} aria-label={t('openPick')}>
            <option value="">{t('openPlaceholder')}</option>
            {candidates.map((a) => (
              <option key={a.id} value={a.id}>
                {a.code} · {localName(a)}
              </option>
            ))}
          </Select>
          <Button disabled={!picked} loading={change.isPending} onClick={() => change.mutate({ id: picked, open: true })}>
            {c('open')}
          </Button>
        </div>
        <QueryState query={open}>
          <DataTable<SpaceUseArea>
            rows={open.data?.data ?? []}
            rowKey={(a) => a.commonAreaId}
            empty={t('openEmpty')}
            columns={[
              { key: 'area', header: t('col.area'), cell: (a) => `${a.code} · ${localName(a)}` },
              { key: 'facility', header: '', cell: (a) => (a.facilityId ? <Badge tone="beige">{t('facilityNote')}</Badge> : null) },
              {
                key: 'actions',
                header: '',
                className: 'table__actions',
                cell: (a) => (
                  <Button size="sm" onClick={() => change.mutate({ id: a.commonAreaId, open: false })}>
                    {c('close')}
                  </Button>
                ),
              },
            ]}
          />
        </QueryState>
        <ErrorAlert error={change.error} />
      </div>
    </Card>
  );
}

/**
 * Residents' requests to use a common area (ADR 0084): approve, refuse with
 * a reason, or cancel an approved one. An approval is refused when another
 * approved use overlaps, or the facility is booked or closed then.
 */
export default function SpaceUsesPage() {
  const t = useT(en, ar);
  const c = useCommonT();
  const label = useLabel();
  const localName = useLocalName();
  const slotText = useSlotText();
  const toast = useToast();
  const { ready, can } = usePermissions();
  const handles = can('bookings.handle');
  const keeps = can('spaces.manage');
  const [status, setStatus] = useState<SpaceUseStatus | ''>('pending');
  const [refusing, setRefusing] = useState<SpaceUse | null>(null);
  const [cancelling, setCancelling] = useState<SpaceUse | null>(null);
  const list = useCursorList(keys.spaceUses(status), (x) => fetchers.spaceUses(status, x), { enabled: handles });
  const decide = useAction(
    (input: { id: string; action: 'approve' | 'refuse' | 'cancel'; reasonCode?: string }) =>
      input.action === 'approve'
        ? unwrap(api.POST('/api/v1/staff/space-uses/{id}/approve', { params: { path: { id: input.id } } }))
        : input.action === 'refuse'
          ? unwrap(
              api.POST('/api/v1/staff/space-uses/{id}/refuse', {
                params: { path: { id: input.id } },
                body: { reasonCode: input.reasonCode! },
              }),
            )
          : unwrap(
              api.POST('/api/v1/staff/space-uses/{id}/cancel', {
                params: { path: { id: input.id } },
                body: { reasonCode: input.reasonCode! },
              }),
            ),
    {
      invalidate: [keys.spacesAll],
      onDone: (_r, v) => {
        toast.show(v.action === 'approve' ? t('approvedToast') : v.action === 'refuse' ? t('refusedToast') : t('cancelledToast'));
        setRefusing(null);
        setCancelling(null);
      },
    },
  );
  if (ready && !handles && !keeps)
    return (
      <>
        <PageHeader title={t('title')} />
        <ForbiddenState />
      </>
    );
  return (
    <>
      <PageHeader title={t('title')} description={t('description')} />
      {keeps ? <OpenAreas /> : null}
      {handles ? (
        <>
          <div className="toolbar">
            <Select value={status} onChange={(e) => setStatus(e.target.value as SpaceUseStatus | '')} aria-label={c('status')}>
              {STATUSES.map((s) => (
                <option key={s} value={s}>
                  {s ? label(s) : c('all')}
                </option>
              ))}
            </Select>
          </div>
          <Card flush>
            <QueryState query={list}>
              <DataTable<SpaceUse>
                rows={list.rows}
                rowKey={(u) => u.id}
                empty={t('empty')}
                columns={[
                  { key: 'when', header: t('col.when'), cell: (u) => <span style={{ whiteSpace: 'nowrap' }}>{slotText(u.startsAt, u.endsAt)}</span> },
                  { key: 'area', header: t('col.area'), cell: (u) => `${u.areaCode} · ${localName({ nameEn: u.areaNameEn, nameAr: u.areaNameAr })}` },
                  { key: 'unit', header: c('unit'), cell: (u) => u.unitCode },
                  { key: 'purpose', header: t('col.purpose'), cell: (u) => u.purpose ?? '—' },
                  { key: 'guests', header: t('col.guests'), cell: (u) => u.guests },
                  {
                    key: 'status',
                    header: c('status'),
                    cell: (u) => (
                      <Badge tone={u.status === 'approved' ? 'terracotta' : 'beige'}>
                        {label(u.status)}
                        {u.reasonCode ? ` · ${label(u.reasonCode)}` : ''}
                      </Badge>
                    ),
                  },
                  {
                    key: 'actions',
                    header: '',
                    className: 'table__actions',
                    cell: (u) =>
                      u.status === 'pending' ? (
                        <>
                          <Button size="sm" variant="primary" loading={decide.isPending} onClick={() => decide.mutate({ id: u.id, action: 'approve' })}>
                            {c('approve')}
                          </Button>
                          <Button size="sm" onClick={() => setRefusing(u)}>
                            {t('refuse')}
                          </Button>
                        </>
                      ) : u.status === 'approved' && new Date(u.endsAt) > new Date() ? (
                        <Button size="sm" onClick={() => setCancelling(u)}>
                          {c('cancel')}
                        </Button>
                      ) : null,
                  },
                ]}
              />
              <LoadMore query={list} />
            </QueryState>
          </Card>
          <ErrorAlert error={refusing || cancelling ? null : decide.error} />
        </>
      ) : null}
      <ReasonCodeDialog
        open={refusing !== null}
        onClose={() => setRefusing(null)}
        title={t('refuseTitle')}
        description={t('told')}
        codes={REASON_CODES.spaceUseRefuse}
        confirmLabel={t('refuse')}
        pending={decide.isPending}
        error={<ErrorAlert error={decide.error} />}
        onConfirm={(reasonCode) => refusing && decide.mutate({ id: refusing.id, action: 'refuse', reasonCode })}
      />
      <ReasonCodeDialog
        open={cancelling !== null}
        onClose={() => setCancelling(null)}
        title={t('cancelTitle')}
        description={t('told')}
        codes={REASON_CODES.spaceUseCancel}
        confirmLabel={t('cancelUse')}
        pending={decide.isPending}
        error={<ErrorAlert error={decide.error} />}
        onConfirm={(reasonCode) => cancelling && decide.mutate({ id: cancelling.id, action: 'cancel', reasonCode })}
      />
    </>
  );
}
