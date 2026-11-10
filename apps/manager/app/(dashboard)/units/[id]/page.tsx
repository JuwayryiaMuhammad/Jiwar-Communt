'use client';

import { REASON_CODES, unwrap, type Schema } from '@jiwar/api';
import { ErrorAlert, QueryState, useAction } from '@jiwar/api/react';
import { useFormat, useT } from '@jiwar/i18n';
import {
  Badge,
  Button,
  ButtonLink,
  Card,
  CardBody,
  CardHeader,
  ConfirmDialog,
  DataTable,
  PageHeader,
  ReasonDialog,
  StatusBadge,
  useCommonT,
  useLabel,
  useToast,
} from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { MemberOverrides } from '@/components/units/household-overrides';
import { OccupantActions } from '@/components/units/occupant-actions';
import { EditUnitDialog, UnitHistoryCard, UnitWorkersCard } from '@/components/units/register';
import { REVIEW_LABELS } from '@/components/units/review-labels';
import { UnitStates } from '@/components/units/unit-states';
import { api } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys } from '@/lib/queries';
import ar from '@/messages/ar/units-detail';
import en from '@/messages/en/units-detail';

type Occupant = Schema<'UnitOccupantView'>;
type Member = Schema<'HouseholdMemberItemView'>;

export default function UnitPage() {
  const t = useT(en, ar);
  const c = useCommonT();
  const fmt = useFormat();
  // The review reasons have their own words; every other code the shared ones.
  const label = useLabel(REVIEW_LABELS);
  const { id } = useParams<{ id: string }>();
  const toast = useToast();
  const { can } = usePermissions();
  const [ending, setEnding] = useState<Occupant | null>(null);
  const [primary, setPrimary] = useState<Occupant | null>(null);
  const [editing, setEditing] = useState(false);

  const unit = useQuery({ queryKey: keys.unit(id), queryFn: () => fetchers.unit(id) });
  const household = useQuery({
    queryKey: [...keys.unit(id), 'household'],
    queryFn: () => unwrap(api.GET('/api/v1/units/{unitId}/household', { params: { path: { unitId: id } } })),
  });

  const u = unit.data;

  const end = useAction(
    (v: { o: Occupant; reasonCode: string; reason: string }) =>
      unwrap(
        api.POST('/api/v1/occupancies/{id}/end', {
          params: { path: { id: v.o.occupancyId } },
          body: { reasonCode: v.reasonCode, reason: v.reason },
        }),
      ),
    {
      invalidate: [keys.unit(id), keys.unitsReview, keys.residents],
      onDone: () => {
        toast.show(t('occupancyEnded'));
        setEnding(null);
      },
    },
  );

  const makePrimary = useAction(
    (o: Occupant) =>
      unwrap(api.POST('/api/v1/units/{id}/primary', { params: { path: { id } }, body: { accountId: o.account.id } })),
    {
      invalidate: [keys.unit(id), keys.unitsReview],
      onDone: (_, o) => {
        toast.show(t('madePrimary', { name: o.account.fullName ?? c('resident') }));
        setPrimary(null);
      },
    },
  );

  const where = u
    ? [u.building ? t('buildingOf', { name: u.building }) : null, u.floor != null ? t('floorOf', { n: u.floor }) : null].filter(Boolean).join(' · ')
    : '';

  return (
    <>
      <PageHeader
        back={
          <ButtonLink href="/units" variant="text" size="sm" icon={<ArrowLeft aria-hidden className="icon-dir" />}>
            {t('units')}
          </ButtonLink>
        }
        actions={
          <>
            {can('units.manage') && u ? (
              <Button size="sm" onClick={() => setEditing(true)}>
                {t('editUnit')}
              </Button>
            ) : null}
            <ButtonLink href={`/units/${id}/papers`} size="sm">
              {t('papers')}
            </ButtonLink>
            {can('correspondence.read') ? (
              <ButtonLink href={`/units/${id}/correspondence`} size="sm">
                {t('correspondence')}
              </ButtonLink>
            ) : null}
          </>
        }
        title={
          u ? (
            <span className="row" style={{ gap: 12 }}>
              {t('title', { code: u.code })}
              {u.closed ? <Badge tone="dark">{t('closedByOwner')}</Badge> : null}
              {u.reviewReasons?.length ? <Badge tone="terracotta">{t('underReview')}</Badge> : null}
            </span>
          ) : (
            c('unit')
          )
        }
        description={where || undefined}
      />

      {editing && u ? <EditUnitDialog unit={u} onClose={() => setEditing(false)} /> : null}

      <QueryState query={unit}>
        {u ? (
          <div className="grid grid--main-aside">
            <div className="stack">
              <Card flush>
                <CardHeader title={t('occupants')} />
                <DataTable<Occupant>
                  rows={u.occupants}
                  rowKey={(o) => o.occupancyId}
                  empty={t('occupantsEmpty')}
                  columns={[
                    {
                      key: 'name',
                      header: c('resident'),
                      cell: (o) =>
                        o.account.erased ? (
                          <span className="t-secondary">{t('erased')}</span>
                        ) : (
                          <Link className="table__link" href={`/residents/${o.account.id}`}>
                            {o.account.fullName}
                          </Link>
                        ),
                    },
                    {
                      key: 'type',
                      header: t('col.occupancy'),
                      cell: (o) => (
                        <span className="row">
                          {label(o.occupancyType)}
                          {o.isPrimary ? <Badge tone="green">{t('primary')}</Badge> : null}
                        </span>
                      ),
                    },
                    { key: 'resides', header: t('col.livesHere'), cell: (o) => (o.resides ? c('yes') : c('no')) },
                    { key: 'since', header: t('col.since'), cell: (o) => fmt.date(o.startedAt) },
                    {
                      key: 'actions',
                      header: <span className="visually-hidden">{c('actions')}</span>,
                      className: 'table__actions',
                      cell: (o) => (
                        <span className="row" style={{ justifyContent: 'flex-end' }}>
                          {!o.isPrimary && o.resides && !o.account.erased ? (
                            <Button size="sm" onClick={() => setPrimary(o)}>
                              {t('makePrimary')}
                            </Button>
                          ) : null}
                          {can('residents.manage') ? <OccupantActions unitId={id} occupant={o} /> : null}
                          <Button size="sm" onClick={() => setEnding(o)}>
                            {t('end')}
                          </Button>
                        </span>
                      ),
                    },
                  ]}
                />
              </Card>

              <Card flush>
                <CardHeader title={t('household')} />
                <QueryState query={household} rows={3}>
                  <DataTable<Member>
                    rows={household.data?.members}
                    rowKey={(m) => m.id}
                    empty={t('householdEmpty')}
                    columns={[
                      {
                        key: 'name',
                        header: t('col.member'),
                        cell: (m) => (
                          <span className="row">
                            <span className="table__primary">{m.fullName ?? t('invited')}</span>
                            {m.isMinor ? (
                              <Badge tone="beige" plain>
                                {t('minor')}
                              </Badge>
                            ) : null}
                          </span>
                        ),
                      },
                      { key: 'relation', header: t('col.relation'), cell: (m) => label(m.relation) },
                      { key: 'status', header: c('status'), cell: (m) => <StatusBadge status={m.status} /> },
                      ...(can('household.override')
                        ? [
                            {
                              key: 'actions',
                              header: <span className="visually-hidden">{c('actions')}</span>,
                              className: 'table__actions',
                              cell: (m: Member) => <MemberOverrides unitId={id} member={m} />,
                            },
                          ]
                        : []),
                    ]}
                  />
                </QueryState>
              </Card>

              {can('residents.read') ? <UnitHistoryCard unitId={id} /> : null}
              {can('workers.review') ? <UnitWorkersCard unitId={id} /> : null}
            </div>

            <div className="stack">
              {can('residents.manage') ? (
                <UnitStates unit={u} />
              ) : u.reviewReasons?.length ? (
                <Card tone="beige">
                  <div className="stack stack--sm">
                    <h2 className="t-title-md">{t('underReview')}</h2>
                    <div className="chip-list">
                      {u.reviewReasons.map((r) => (
                        <Badge key={r} tone="terracotta">
                          {label(r)}
                        </Badge>
                      ))}
                    </div>
                    <p className="t-secondary">{t('reviewWait')}</p>
                  </div>
                </Card>
              ) : null}
              <Card>
                <dl className="dl">
                  <dt>{c('type')}</dt>
                  <dd>{label(u.unitType)}</dd>
                  <dt>{t('area')}</dt>
                  <dd>{u.areaSqm ? t('areaValue', { n: fmt.number(u.areaSqm) }) : '—'}</dd>
                  <dt>{c('building')}</dt>
                  <dd>{u.building ?? '—'}</dd>
                  <dt>{c('floor')}</dt>
                  <dd>{u.floor ?? '—'}</dd>
                  <dt>{t('added')}</dt>
                  <dd>{fmt.dateTime(u.createdAt)}</dd>
                </dl>
              </Card>
              {household.data?.invites?.length ? (
                <Card flush>
                  <CardHeader title={t('pendingInvites')} />
                  <CardBody>
                    <ul className="list">
                      {household.data.invites.map((i) => (
                        <li key={i.id} className="list__item" style={{ padding: '8px 0' }}>
                          <div className="list__text">
                            <div className="list__title">{i.fullName ?? t('invitee')}</div>
                            <div className="list__meta">{t('inviteMeta', { relation: label(i.relation), date: fmt.date(i.expiresAt) })}</div>
                          </div>
                        </li>
                      ))}
                    </ul>
                  </CardBody>
                </Card>
              ) : null}
            </div>
          </div>
        ) : null}
      </QueryState>

      <ReasonDialog
        open={ending !== null}
        onClose={() => {
          setEnding(null);
          end.reset();
        }}
        title={ending?.account.fullName ? t('endTitle', { name: ending.account.fullName }) : t('endTitleUnnamed')}
        description={t('endDescription')}
        codes={REASON_CODES.occupancyEnd}
        confirmLabel={t('endConfirm')}
        danger
        pending={end.isPending}
        error={<ErrorAlert error={end.error} />}
        onConfirm={(reason) => ending && end.mutate({ o: ending, ...reason })}
      />
      <ConfirmDialog
        open={primary !== null}
        onClose={() => {
          setPrimary(null);
          makePrimary.reset();
        }}
        title={t('primaryTitle', { name: primary?.account.fullName ?? '' })}
        description={t('primaryDescription')}
        confirmLabel={t('makePrimary')}
        pending={makePrimary.isPending}
        error={<ErrorAlert error={makePrimary.error} />}
        onConfirm={() => primary && makePrimary.mutate(primary)}
      />
    </>
  );
}
