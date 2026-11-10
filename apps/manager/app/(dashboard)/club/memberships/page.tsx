'use client';

import { unwrap } from '@jiwar/api';
import { ErrorAlert, QueryState, useAction } from '@jiwar/api/react';
import { useFormat, useT } from '@jiwar/i18n';
import { Button, Card, DataTable, Dialog, Field, ForbiddenState, Input, PageHeader, Segmented, StatusBadge, useCommonT, useToast } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { coverageBody, type PersonRef } from '@/components/club/logic';
import { PeoplePicker } from '@/components/club/people-picker';
import { api } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys, type ClubMembership, type ClubMembershipState, type ClubUnit } from '@/lib/queries';
import ar from '@/messages/ar/money-club-memberships';
import en from '@/messages/en/money-club-memberships';

const STATES = ['', 'active', 'expiring', 'expired', 'none'] as const;
type View = (typeof STATES)[number];

/** A unit found by its code, then whom its new membership covers. */
function NewMembershipDialog({ onClose }: { onClose: () => void }) {
  const t = useT(en, ar);
  const c = useCommonT();
  const toast = useToast();
  const router = useRouter();
  const [code, setCode] = useState('');
  const [unit, setUnit] = useState<ClubUnit | null>(null);
  const [people, setPeople] = useState<PersonRef[]>([]);
  const find = useAction(() => fetchers.clubUnit(code.trim()), {
    onDone: (found) => {
      if (found.membershipId) router.push(`/club/memberships/${found.membershipId}`);
      else setUnit(found);
    },
  });
  const create = useAction(
    () => unwrap(api.POST('/api/v1/staff/club-memberships', { body: { unitId: unit!.id, people: coverageBody(people) } })),
    {
      invalidate: [keys.clubAll],
      onDone: (m) => {
        toast.show(t('created', { unit: m.unitCode }));
        router.push(`/club/memberships/${m.id}`);
      },
    },
  );

  return (
    <Dialog
      open
      onClose={onClose}
      title={t('newMembership')}
      description={t('newDescription')}
      onSubmit={() => (unit ? create.mutate() : code.trim() && find.mutate())}
      footer={
        <>
          <Button onClick={onClose}>{c('cancel')}</Button>
          <Button type="submit" variant="primary" loading={find.isPending || create.isPending} disabled={!unit && !code.trim()}>
            {unit ? c('create') : t('findUnit')}
          </Button>
        </>
      }
    >
      <div className="form">
        <Field label={t('unitCode')}>
          {(p) => (
            <Input
              {...p}
              value={code}
              onChange={(e) => {
                setCode(e.target.value);
                setUnit(null);
              }}
            />
          )}
        </Field>
        {unit ? (
          <Field label={t('covers')}>{() => <PeoplePicker unitId={unit.id} value={people} onChange={setPeople} />}</Field>
        ) : null}
        <ErrorAlert error={find.error ?? create.error} />
      </div>
    </Dialog>
  );
}

/** The club's memberships (ADR 0044), for the accountant: one per unit, by state. */
export default function ClubMembershipsPage() {
  const t = useT(en, ar);
  const fmt = useFormat();
  const { ready, can } = usePermissions();
  const allowed = can('club.billing');
  const [view, setView] = useState<View>('');
  const [creating, setCreating] = useState(false);
  const list = useQuery({
    queryKey: keys.clubMemberships(view),
    queryFn: () => fetchers.clubMemberships(view as ClubMembershipState | ''),
    enabled: allowed,
  });
  if (ready && !allowed) return <ForbiddenState />;

  return (
    <>
      <PageHeader title={t('title')} description={t('description')} />
      <div className="toolbar">
        <Segmented<View>
          label={t('shown')}
          value={view}
          onChange={setView}
          options={STATES.map((v) => ({ value: v, label: t(`view.${v || 'all'}`) }))}
        />
        <span className="spacer" />
        <Button variant="primary" icon={<Plus aria-hidden />} onClick={() => setCreating(true)}>
          {t('newMembership')}
        </Button>
      </div>
      <Card flush>
        <QueryState query={list}>
          <DataTable<ClubMembership>
            rows={list.data?.data}
            rowKey={(m) => m.id}
            empty={t('empty')}
            columns={[
              {
                key: 'unit',
                header: t('col.unit'),
                cell: (m) => (
                  <Link className="table__link t-mono" href={`/club/memberships/${m.id}`}>
                    {m.unitCode}
                  </Link>
                ),
              },
              { key: 'state', header: t('col.state'), cell: (m) => <StatusBadge status={m.state} /> },
              { key: 'through', header: t('col.through'), cell: (m) => (m.activeThrough ? fmt.day(m.activeThrough) : '—') },
              { key: 'people', header: t('col.people'), cell: (m) => t('people', { n: m.people.length }) },
            ]}
          />
        </QueryState>
      </Card>
      {creating ? <NewMembershipDialog onClose={() => setCreating(false)} /> : null}
    </>
  );
}
