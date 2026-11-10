'use client';

import { fieldError, unwrap } from '@jiwar/api';
import { ErrorAlert, LoadMore, QueryState, useAction, useCursorList } from '@jiwar/api/react';
import { useFormat, useT } from '@jiwar/i18n';
import {
  Button,
  Card,
  CardHeader,
  DataTable,
  Dialog,
  Field,
  ForbiddenState,
  PageHeader,
  Segmented,
  Select,
  StatusBadge,
  useCommonT,
  useToast,
} from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { codeText } from '@/components/governance/logic';
import { api } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys, type Representative, type RepresentativeMatter, type RepresentativeMatterStatus } from '@/lib/queries';
import ar from '@/messages/ar/gov-representatives';
import codesAr from '@/messages/ar/gov-codes';
import en from '@/messages/en/gov-representatives';
import codesEn from '@/messages/en/gov-codes';

const VIEWS = ['pending', 'approved', 'rejected', 'withdrawn'] as const satisfies readonly RepresentativeMatterStatus[];

/** Raising a matter: name an owner of a unit in a building, or end a sitting term. */
function RaiseMatter({ ending, onClose }: { ending: Representative | null; onClose: () => void }) {
  const t = useT(en, ar);
  const c = useCommonT();
  const f = useFormat();
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
        toast.show(t('raisedToast'));
        onClose();
        router.push(`/board/representatives/${m.id}`);
      },
    },
  );
  return (
    <Dialog
      open
      onClose={onClose}
      title={ending ? t('endTitle', { name: ending.fullName ?? t('erased') }) : t('nameTitle')}
      description={ending ? t('endDescription') : t('nameDescription')}
      onSubmit={() => raise.mutate(undefined)}
      footer={
        <>
          <Button onClick={onClose}>{c('cancel')}</Button>
          <Button type="submit" variant="primary" loading={raise.isPending} disabled={!ending && (!building || !accountId)}>
            {t('raise')}
          </Button>
        </>
      }
    >
      {ending ? (
        <div className="form">
          <p>{t('endingLine', { building: ending.building, unit: ending.unitCode, when: f.dateTime(ending.appointedAt) })}</p>
          <ErrorAlert error={raise.error} />
        </div>
      ) : (
        <div className="form">
          <Field label={t('building')} error={fieldError(raise.error, 'building')}>
            {(p) => (
              <Select
                {...p}
                value={building}
                onChange={(e) => {
                  setBuilding(e.target.value);
                  setAccountId('');
                }}
              >
                <option value="">{t('chooseBuilding')}</option>
                {(buildings.data ?? []).map((b) => (
                  <option key={b} value={b}>
                    {b}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label={t('owner')} hint={t('ownerHint')} error={fieldError(raise.error, 'accountId')}>
            {(p) => (
              <Select {...p} value={accountId} disabled={!building} onChange={(e) => setAccountId(e.target.value)}>
                <option value="">{building ? t('chooseOwner') : t('chooseBuildingFirst')}</option>
                {(candidates.data ?? []).map((o) => (
                  <option key={o.accountId} value={o.accountId}>
                    {`${o.fullName ?? t('erased')} · ${f.list(o.unitCodes)}`}
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
  const t = useT(en, ar);
  const g = useT(codesEn, codesAr);
  const c = useCommonT();
  const f = useFormat();
  const { ready, can } = usePermissions();
  const allowed = can('governance.board');
  const [status, setStatus] = useState<RepresentativeMatterStatus>('pending');
  const [raising, setRaising] = useState<{ ending: Representative | null } | null>(null);
  const reps = useQuery({ queryKey: keys.boardRepresentatives, queryFn: fetchers.boardRepresentatives, enabled: allowed });
  const matters = useCursorList(keys.boardRepresentativeMatters(status), (cursor) => fetchers.boardRepresentativeMatters(status, cursor), {
    enabled: allowed,
  });
  if (ready && !allowed)
    return (
      <>
        <PageHeader title={t('title')} />
        <ForbiddenState />
      </>
    );
  const sitting = (reps.data ?? []).filter((r) => !r.endedAt);
  const past = (reps.data ?? []).filter((r) => r.endedAt);
  return (
    <>
      <PageHeader
        title={t('title')}
        description={t('description')}
        actions={
          <Button variant="primary" onClick={() => setRaising({ ending: null })}>
            {t('name')}
          </Button>
        }
      />
      <div className="stack">
        <Card flush>
          <CardHeader title={t('sitting')} />
          <QueryState query={reps}>
            <DataTable<Representative>
              rows={sitting}
              rowKey={(r) => r.id}
              empty={t('noneSitting')}
              columns={[
                { key: 'b', header: t('col.building'), cell: (r) => r.building },
                { key: 'n', header: t('col.representative'), cell: (r) => r.fullName ?? t('erased') },
                { key: 'u', header: t('col.unit'), cell: (r) => r.unitCode },
                { key: 's', header: t('col.since'), cell: (r) => f.dateTime(r.appointedAt) },
                {
                  key: 'a',
                  header: '',
                  cell: (r) => (
                    <Button size="sm" onClick={() => setRaising({ ending: r })}>
                      {t('endTerm')}
                    </Button>
                  ),
                },
              ]}
            />
          </QueryState>
        </Card>
        <Card flush>
          <CardHeader title={t('matters')} />
          <div className="toolbar" style={{ padding: '0 16px' }}>
            <Segmented<RepresentativeMatterStatus>
              label={c('status')}
              value={status}
              onChange={setStatus}
              options={VIEWS.map((v) => ({ value: v, label: t(`view.${v}`) }))}
            />
          </div>
          <QueryState query={matters}>
            <DataTable<RepresentativeMatter>
              rows={matters.rows}
              rowKey={(m) => m.id}
              empty={t('nothing')}
              columns={[
                {
                  key: 'w',
                  header: t('col.matter'),
                  cell: (m) => <Link href={`/board/representatives/${m.id}`}>{codeText(g, 'repAction', m.action)}</Link>,
                },
                { key: 'b', header: t('col.building'), cell: (m) => m.building },
                { key: 'n', header: t('col.owner'), cell: (m) => m.fullName ?? t('erased') },
                { key: 'r', header: t('col.raised'), cell: (m) => f.dateTime(m.raisedAt) },
                { key: 's', header: c('status'), cell: (m) => <StatusBadge status={m.status} /> },
              ]}
            />
            <LoadMore query={matters} />
          </QueryState>
        </Card>
        {past.length ? (
          <Card flush>
            <CardHeader title={t('pastTerms')} />
            <DataTable<Representative>
              rows={past}
              rowKey={(r) => r.id}
              columns={[
                { key: 'b', header: t('col.building'), cell: (r) => r.building },
                { key: 'n', header: t('col.representative'), cell: (r) => r.fullName ?? t('erased') },
                { key: 's', header: t('col.from'), cell: (r) => f.dateTime(r.appointedAt) },
                { key: 'e', header: t('col.to'), cell: (r) => (r.endedAt ? f.dateTime(r.endedAt) : '—') },
                { key: 'w', header: t('col.why'), cell: (r) => (r.endReason ? codeText(g, 'repEnd', r.endReason) : '—') },
              ]}
            />
          </Card>
        ) : null}
      </div>
      {raising ? <RaiseMatter ending={raising.ending} onClose={() => setRaising(null)} /> : null}
    </>
  );
}
