'use client';

import { unwrap } from '@jiwar/api';
import { ErrorAlert, QueryState, useAction } from '@jiwar/api/react';
import { Button, Card, DataTable, Dialog, Field, ForbiddenState, Input, PageHeader, Segmented, StatusBadge, useToast } from '@jiwar/ui';
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

const STATES = ['', 'active', 'expiring', 'expired', 'none'] as const;
type View = (typeof STATES)[number];

/** A unit found by its code, then whom its new membership covers. */
function NewMembershipDialog({ onClose }: { onClose: () => void }) {
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
        toast.show(`Unit ${m.unitCode} has a membership. Record its payment next.`);
        router.push(`/club/memberships/${m.id}`);
      },
    },
  );

  return (
    <Dialog
      open
      onClose={onClose}
      title="New membership"
      description="One per unit. It is active once a payment is recorded."
      onSubmit={() => (unit ? create.mutate() : code.trim() && find.mutate())}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" loading={find.isPending || create.isPending} disabled={!unit && !code.trim()}>
            {unit ? 'Create' : 'Find the unit'}
          </Button>
        </>
      }
    >
      <div className="form">
        <Field label="Unit code">
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
          <Field label="Whom it covers">{() => <PeoplePicker unitId={unit.id} value={people} onChange={setPeople} />}</Field>
        ) : null}
        <ErrorAlert error={find.error ?? create.error} />
      </div>
    </Dialog>
  );
}

/** The club's memberships (ADR 0044), for the accountant: one per unit, by state. */
export default function ClubMembershipsPage() {
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
      <PageHeader title="Club memberships" description="Each unit’s membership, whom it covers, and the payments made at the office that keep it active." />
      <div className="toolbar">
        <Segmented<View>
          label="Memberships shown"
          value={view}
          onChange={setView}
          options={[
            { value: '', label: 'All' },
            { value: 'active', label: 'Active' },
            { value: 'expiring', label: 'Ending this week' },
            { value: 'expired', label: 'Expired' },
            { value: 'none', label: 'Never paid' },
          ]}
        />
        <span className="spacer" />
        <Button variant="primary" icon={<Plus aria-hidden />} onClick={() => setCreating(true)}>
          New membership
        </Button>
      </div>
      <Card flush>
        <QueryState query={list}>
          <DataTable<ClubMembership>
            rows={list.data?.data}
            rowKey={(m) => m.id}
            empty="No membership matches"
            columns={[
              {
                key: 'unit',
                header: 'Unit',
                cell: (m) => (
                  <Link className="table__link t-mono" href={`/club/memberships/${m.id}`}>
                    {m.unitCode}
                  </Link>
                ),
              },
              { key: 'state', header: 'State', cell: (m) => <StatusBadge status={m.state} /> },
              { key: 'through', header: 'Active through', cell: (m) => m.activeThrough ?? '—' },
              { key: 'people', header: 'Covers', cell: (m) => `${m.people.length} ${m.people.length === 1 ? 'person' : 'people'}` },
            ]}
          />
        </QueryState>
      </Card>
      {creating ? <NewMembershipDialog onClose={() => setCreating(false)} /> : null}
    </>
  );
}
