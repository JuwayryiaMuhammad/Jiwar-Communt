'use client';

import { formatDate, formatDateTime, humanize, REASON_CODES, unwrap, type Schema } from '@jiwar/api';
import { ErrorAlert, QueryState, useAction } from '@jiwar/api/react';
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
  useToast,
} from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { api } from '@/lib/api';
import { REVIEW_TEXT } from '@/lib/labels';
import { fetchers, keys } from '@/lib/queries';

type Occupant = Schema<'UnitOccupantView'>;
type Member = Schema<'HouseholdMemberItemView'>;

export default function UnitPage() {
  const { id } = useParams<{ id: string }>();
  const toast = useToast();
  const [ending, setEnding] = useState<Occupant | null>(null);
  const [primary, setPrimary] = useState<Occupant | null>(null);

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
        toast.show('Occupancy ended.');
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
        toast.show(`${o.account.fullName ?? 'Resident'} is now the primary resident.`);
        setPrimary(null);
      },
    },
  );

  return (
    <>
      <PageHeader
        back={
          <ButtonLink href="/units" variant="text" size="sm" icon={<ArrowLeft aria-hidden />}>
            Units
          </ButtonLink>
        }
        title={
          u ? (
            <span className="row" style={{ gap: 12 }}>
              Unit {u.code}
              {u.closed ? <Badge tone="dark">Closed by owner</Badge> : null}
              {u.reviewReasons?.length ? <Badge tone="terracotta">Under review</Badge> : null}
            </span>
          ) : (
            'Unit'
          )
        }
        description={u ? [u.building && `Building ${u.building}`, u.floor != null && `Floor ${u.floor}`].filter(Boolean).join(' · ') || undefined : undefined}
      />

      <QueryState query={unit}>
        {u ? (
          <div className="grid grid--main-aside">
            <div className="stack">
              <Card flush>
                <CardHeader title="Occupants" />
                <DataTable<Occupant>
                  rows={u.occupants}
                  rowKey={(o) => o.occupancyId}
                  empty="Nobody occupies this unit"
                  columns={[
                    {
                      key: 'name',
                      header: 'Resident',
                      cell: (o) =>
                        o.account.erased ? (
                          <span className="t-secondary">Erased account</span>
                        ) : (
                          <Link className="table__link" href={`/residents/${o.account.id}`}>
                            {o.account.fullName}
                          </Link>
                        ),
                    },
                    {
                      key: 'type',
                      header: 'Occupancy',
                      cell: (o) => (
                        <span className="row">
                          {humanize(o.occupancyType)}
                          {o.isPrimary ? <Badge tone="green">Primary</Badge> : null}
                        </span>
                      ),
                    },
                    { key: 'resides', header: 'Lives here', cell: (o) => (o.resides ? 'Yes' : 'No') },
                    { key: 'since', header: 'Since', cell: (o) => formatDate(o.startedAt) },
                    {
                      key: 'actions',
                      header: <span className="visually-hidden">Actions</span>,
                      className: 'table__actions',
                      cell: (o) => (
                        <span className="row" style={{ justifyContent: 'flex-end' }}>
                          {!o.isPrimary && o.resides && !o.account.erased ? (
                            <Button size="sm" onClick={() => setPrimary(o)}>
                              Make primary
                            </Button>
                          ) : null}
                          <Button size="sm" onClick={() => setEnding(o)}>
                            End
                          </Button>
                        </span>
                      ),
                    },
                  ]}
                />
              </Card>

              <Card flush>
                <CardHeader title="Household" />
                <QueryState query={household} rows={3}>
                  <DataTable<Member>
                    rows={household.data?.members}
                    rowKey={(m) => m.id}
                    empty="No household members"
                    columns={[
                      {
                        key: 'name',
                        header: 'Member',
                        cell: (m) => (
                          <span className="row">
                            <span className="table__primary">{m.fullName ?? 'Invited'}</span>
                            {m.isMinor ? <Badge tone="beige" plain>Minor</Badge> : null}
                          </span>
                        ),
                      },
                      { key: 'relation', header: 'Relation', cell: (m) => humanize(m.relation) },
                      { key: 'status', header: 'Status', cell: (m) => <StatusBadge status={m.status} /> },
                    ]}
                  />
                </QueryState>
              </Card>

            </div>

            <div className="stack">
              {u.reviewReasons?.length ? (
                <Card tone="beige">
                  <div className="stack stack--sm">
                    <h2 className="t-title-md">Under review</h2>
                    <div className="chip-list">
                      {u.reviewReasons.map((r) => (
                        <Badge key={r} tone="terracotta">
                          {REVIEW_TEXT[r] ?? humanize(r)}
                        </Badge>
                      ))}
                    </div>
                    <p className="t-secondary">Household changes wait until a manager settles who now holds the unit.</p>
                  </div>
                </Card>
              ) : null}
              <Card>
                <dl className="dl">
                  <dt>Type</dt>
                  <dd>{humanize(u.unitType)}</dd>
                  <dt>Area</dt>
                  <dd>{u.areaSqm ? `${u.areaSqm} m²` : '—'}</dd>
                  <dt>Building</dt>
                  <dd>{u.building ?? '—'}</dd>
                  <dt>Floor</dt>
                  <dd>{u.floor ?? '—'}</dd>
                  <dt>Added</dt>
                  <dd>{formatDateTime(u.createdAt)}</dd>
                </dl>
              </Card>
              {household.data?.invites?.length ? (
                <Card flush>
                  <CardHeader title="Pending invites" />
                  <CardBody>
                    <ul className="list">
                      {household.data.invites.map((i) => (
                        <li key={i.id} className="list__item" style={{ padding: '8px 0' }}>
                          <div className="list__text">
                            <div className="list__title">{i.fullName ?? 'Invitee'}</div>
                            <div className="list__meta">
                              {humanize(i.relation)} · expires {formatDate(i.expiresAt)}
                            </div>
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
        title={`End ${ending?.account.fullName ?? 'this'}'s occupancy?`}
        description="They lose access to this unit. If they were the primary resident, the unit goes under review."
        codes={REASON_CODES.occupancyEnd}
        confirmLabel="End occupancy"
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
        title={`Make ${primary?.account.fullName ?? ''} the primary resident?`}
        description="The primary resident manages the household, workers and visitors of the unit."
        confirmLabel="Make primary"
        pending={makePrimary.isPending}
        error={<ErrorAlert error={makePrimary.error} />}
        onConfirm={() => primary && makePrimary.mutate(primary)}
      />
    </>
  );
}
