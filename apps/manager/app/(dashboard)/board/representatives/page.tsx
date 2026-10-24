'use client';

import { fieldError, formatDateTime, unwrap } from '@jiwar/api';
import { ErrorAlert, LoadMore, QueryState, useAction, useCursorList } from '@jiwar/api/react';
import { Button, Card, CardHeader, DataTable, Dialog, Field, ForbiddenState, PageHeader, Segmented, Select, StatusBadge, useToast } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { REPRESENTATIVE_ACTION_TEXT, REPRESENTATIVE_END_TEXT } from '@/components/governance/matters';
import { api } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys, type Representative, type RepresentativeMatter, type RepresentativeMatterStatus } from '@/lib/queries';

/** Raising a matter: name an owner of a unit in a building, or end a sitting term. */
function RaiseMatter({ ending, onClose }: { ending: Representative | null; onClose: () => void }) {
  const toast = useToast();
  const router = useRouter();
  const [key] = useState(() => crypto.randomUUID());
  const [building, setBuilding] = useState('');
  const [accountId, setAccountId] = useState('');
  const buildings = useQuery({ queryKey: keys.boardBuildings, queryFn: fetchers.boardBuildings, enabled: !ending });
  const candidates = useQuery({
    queryKey: keys.boardCandidates(building),
    queryFn: () => fetchers.boardCandidates(building),
    enabled: !ending && !!building,
  });
  const raise = useAction(
    () =>
      unwrap(
        api.POST('/api/v1/board/representatives/matters', {
          params: { header: { 'Idempotency-Key': key } },
          body: ending ? { action: 'end', representativeId: ending.id } : { action: 'appoint', building, accountId },
        }),
      ),
    {
      invalidate: [keys.governanceAll],
      onDone: (m) => {
        toast.show('Raised. Propose a motion on it: the board decides it by vote.');
        onClose();
        router.push(`/board/representatives/${m.id}`);
      },
    },
  );
  return (
    <Dialog
      open
      onClose={onClose}
      title={ending ? `End the term of ${ending.fullName ?? 'an erased account'}?` : 'Name a building’s representative'}
      description={
        ending
          ? 'A matter for the board: the term ends once a motion to approve it is carried.'
          : 'A matter for the board: the owner represents the building once a motion to approve it is carried, replacing the sitting one. They take no part in the vote.'
      }
      onSubmit={() => raise.mutate(undefined)}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" loading={raise.isPending} disabled={!ending && (!building || !accountId)}>
            Raise
          </Button>
        </>
      }
    >
      {ending ? (
        <div className="form">
          <p>
            Building {ending.building} · unit {ending.unitCode} · since {formatDateTime(ending.appointedAt)}
          </p>
          <ErrorAlert error={raise.error} />
        </div>
      ) : (
        <div className="form">
          <Field label="Building" error={fieldError(raise.error, 'building')}>
            {(p) => (
              <Select
                {...p}
                value={building}
                onChange={(e) => {
                  setBuilding(e.target.value);
                  setAccountId('');
                }}
              >
                <option value="">Choose a building</option>
                {(buildings.data ?? []).map((b) => (
                  <option key={b} value={b}>
                    {b}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="Owner" hint="An owner of a unit in the building, now." error={fieldError(raise.error, 'accountId')}>
            {(p) => (
              <Select {...p} value={accountId} disabled={!building} onChange={(e) => setAccountId(e.target.value)}>
                <option value="">{building ? 'Choose an owner' : 'Choose a building first'}</option>
                {(candidates.data ?? []).map((o) => (
                  <option key={o.accountId} value={o.accountId}>
                    {o.fullName ?? 'An erased account'} · {o.unitCodes.join(', ')}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <ErrorAlert error={raise.error ?? buildings.error ?? candidates.error} />
        </div>
      )}
    </Dialog>
  );
}

/**
 * The buildings' representatives (ADR 0059), a sitting member's page:
 * who represents which building, and the board's matters naming or ending
 * one, each decided by its motions (ADR 0055).
 */
export default function BoardRepresentativesPage() {
  const { ready, can } = usePermissions();
  const allowed = can('governance.board');
  const [status, setStatus] = useState<RepresentativeMatterStatus>('pending');
  const [raising, setRaising] = useState<{ ending: Representative | null } | null>(null);
  const reps = useQuery({ queryKey: keys.boardRepresentatives, queryFn: fetchers.boardRepresentatives, enabled: allowed });
  const matters = useCursorList(keys.boardRepresentativeMatters(status), (c) => fetchers.boardRepresentativeMatters(status, c), {
    enabled: allowed,
  });
  if (ready && !allowed)
    return (
      <>
        <PageHeader title="Representatives" />
        <ForbiddenState />
      </>
    );
  const sitting = (reps.data ?? []).filter((r) => !r.endedAt);
  const past = (reps.data ?? []).filter((r) => r.endedAt);
  return (
    <>
      <PageHeader
        title="Representatives"
        description="An owner per building whom its residents write to. Naming one, or ending a term, is the board’s decision: a matter, decided by a carried motion."
        actions={
          <Button variant="primary" onClick={() => setRaising({ ending: null })}>
            Name a representative
          </Button>
        }
      />
      <div className="stack">
        <Card flush>
          <CardHeader title="Sitting" />
          <QueryState query={reps}>
            <DataTable<Representative>
              rows={sitting}
              rowKey={(r) => r.id}
              empty="No building has a representative yet"
              columns={[
                { key: 'b', header: 'Building', cell: (r) => r.building },
                { key: 'n', header: 'Representative', cell: (r) => r.fullName ?? 'An erased account' },
                { key: 'u', header: 'Unit', cell: (r) => r.unitCode },
                { key: 's', header: 'Since', cell: (r) => formatDateTime(r.appointedAt) },
                {
                  key: 'a',
                  header: '',
                  cell: (r) => (
                    <Button size="sm" onClick={() => setRaising({ ending: r })}>
                      End the term
                    </Button>
                  ),
                },
              ]}
            />
          </QueryState>
        </Card>
        <Card flush>
          <CardHeader title="The board’s matters" />
          <div className="toolbar" style={{ padding: '0 16px' }}>
            <Segmented<RepresentativeMatterStatus>
              label="Status"
              value={status}
              onChange={setStatus}
              options={[
                { value: 'pending', label: 'To decide' },
                { value: 'approved', label: 'Approved' },
                { value: 'rejected', label: 'Rejected' },
                { value: 'withdrawn', label: 'Withdrawn' },
              ]}
            />
          </div>
          <QueryState query={matters}>
            <DataTable<RepresentativeMatter>
              rows={matters.rows}
              rowKey={(m) => m.id}
              empty="Nothing here"
              columns={[
                {
                  key: 'w',
                  header: 'Matter',
                  cell: (m) => <Link href={`/board/representatives/${m.id}`}>{REPRESENTATIVE_ACTION_TEXT[m.action]}</Link>,
                },
                { key: 'b', header: 'Building', cell: (m) => m.building },
                { key: 'n', header: 'Owner', cell: (m) => m.fullName ?? 'An erased account' },
                { key: 'r', header: 'Raised', cell: (m) => formatDateTime(m.raisedAt) },
                { key: 's', header: 'Status', cell: (m) => <StatusBadge status={m.status} /> },
              ]}
            />
            <LoadMore query={matters} />
          </QueryState>
        </Card>
        {past.length ? (
          <Card flush>
            <CardHeader title="Past terms" />
            <DataTable<Representative>
              rows={past}
              rowKey={(r) => r.id}
              columns={[
                { key: 'b', header: 'Building', cell: (r) => r.building },
                { key: 'n', header: 'Representative', cell: (r) => r.fullName ?? 'An erased account' },
                { key: 's', header: 'From', cell: (r) => formatDateTime(r.appointedAt) },
                { key: 'e', header: 'To', cell: (r) => (r.endedAt ? formatDateTime(r.endedAt) : '—') },
                { key: 'w', header: 'Why', cell: (r) => (r.endReason ? REPRESENTATIVE_END_TEXT[r.endReason] : '—') },
              ]}
            />
          </Card>
        ) : null}
      </div>
      {raising ? <RaiseMatter ending={raising.ending} onClose={() => setRaising(null)} /> : null}
    </>
  );
}
