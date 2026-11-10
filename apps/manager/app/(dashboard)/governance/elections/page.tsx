'use client';

import { fieldError, unwrap } from '@jiwar/api';
import { ErrorAlert, LoadMore, QueryState, useAction, useCursorList } from '@jiwar/api/react';
import { useFormat, useLocale, useT } from '@jiwar/i18n';
import {
  Button,
  Card,
  DataTable,
  Dialog,
  Field,
  ForbiddenState,
  Input,
  PageHeader,
  Segmented,
  StatusBadge,
  Textarea,
  useCommonT,
  useToast,
} from '@jiwar/ui';
import Link from 'next/link';
import { useState } from 'react';
import { inLocale, turnoutText } from '@/components/governance/logic';
import { api } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys, type GovernanceElectionPhase, type StaffGovernanceElection } from '@/lib/queries';
import ar from '@/messages/ar/gov-elections';
import codesAr from '@/messages/ar/gov-codes';
import en from '@/messages/en/gov-elections';
import codesEn from '@/messages/en/gov-codes';

type View = GovernanceElectionPhase | 'all';
const VIEWS = ['all', 'nominating', 'voting', 'closed', 'certified'] as const satisfies readonly View[];
const iso = (local: string) => new Date(local).toISOString();

function NewElection({ onClose }: { onClose: () => void }) {
  const t = useT(en, ar);
  const c = useCommonT();
  const toast = useToast();
  const [key] = useState(() => crypto.randomUUID());
  const [titleEn, setTitleEn] = useState('');
  const [bodyEn, setBodyEn] = useState('');
  const [seats, setSeats] = useState(5);
  const [termMonths, setTerm] = useState(24);
  const [nominationsOpenAt, setNomOpen] = useState('');
  const [nominationsCloseAt, setNomClose] = useState('');
  const [votingOpensAt, setVoteOpen] = useState('');
  const [votingClosesAt, setVoteClose] = useState('');
  const create = useAction(
    () =>
      unwrap(
        api.POST('/api/v1/governance/elections', {
          params: { header: { 'Idempotency-Key': key } },
          body: {
            titleEn: titleEn.trim(),
            bodyEn: bodyEn.trim(),
            seats,
            termMonths,
            ...(nominationsOpenAt ? { nominationsOpenAt: iso(nominationsOpenAt) } : {}),
            nominationsCloseAt: iso(nominationsCloseAt),
            votingOpensAt: iso(votingOpensAt),
            votingClosesAt: iso(votingClosesAt),
          },
        }),
      ),
    {
      invalidate: [keys.governanceAll],
      onDone: () => {
        toast.show(t('called'));
        onClose();
      },
    },
  );
  const err = (f: string) => fieldError(create.error, f);
  const ok = titleEn.trim() && bodyEn.trim() && nominationsCloseAt && votingOpensAt && votingClosesAt;
  return (
    <Dialog
      open
      wide
      onClose={onClose}
      title={t('newTitle')}
      description={t('newDescription')}
      onSubmit={() => create.mutate(undefined)}
      footer={
        <>
          <Button onClick={onClose}>{c('cancel')}</Button>
          <Button type="submit" variant="primary" loading={create.isPending} disabled={!ok}>
            {t('callIt')}
          </Button>
        </>
      }
    >
      <div className="form">
        <Field label={t('titleLabel')} error={err('titleEn')}>
          {(p) => <Input {...p} maxLength={200} value={titleEn} onChange={(e) => setTitleEn(e.target.value)} />}
        </Field>
        <Field label={t('toOwners')} error={err('bodyEn')}>
          {(p) => <Textarea {...p} rows={3} maxLength={4000} value={bodyEn} onChange={(e) => setBodyEn(e.target.value)} />}
        </Field>
        <div className="row" style={{ gap: 16 }}>
          <Field label={t('seats')} error={err('seats')}>
            {(p) => <Input {...p} type="number" min={3} max={15} value={seats} onChange={(e) => setSeats(Number(e.target.value))} />}
          </Field>
          <Field label={t('termMonths')} error={err('termMonths')}>
            {(p) => <Input {...p} type="number" min={6} max={60} value={termMonths} onChange={(e) => setTerm(Number(e.target.value))} />}
          </Field>
        </div>
        <div className="row" style={{ gap: 16 }}>
          <Field label={t('nominationsOpen')} error={err('nominationsOpenAt')}>
            {(p) => <Input {...p} type="datetime-local" value={nominationsOpenAt} onChange={(e) => setNomOpen(e.target.value)} />}
          </Field>
          <Field label={t('nominationsClose')} error={err('nominationsCloseAt')}>
            {(p) => <Input {...p} type="datetime-local" value={nominationsCloseAt} onChange={(e) => setNomClose(e.target.value)} />}
          </Field>
        </div>
        <div className="row" style={{ gap: 16 }}>
          <Field label={t('votingOpens')} error={err('votingOpensAt')}>
            {(p) => <Input {...p} type="datetime-local" value={votingOpensAt} onChange={(e) => setVoteOpen(e.target.value)} />}
          </Field>
          <Field label={t('votingCloses')} error={err('votingClosesAt')}>
            {(p) => <Input {...p} type="datetime-local" value={votingClosesAt} onChange={(e) => setVoteClose(e.target.value)} />}
          </Field>
        </div>
        <ErrorAlert error={create.error} />
      </div>
    </Dialog>
  );
}

/** Elections of the board (ADR 0051). */
export default function GovernanceElectionsPage() {
  const t = useT(en, ar);
  const g = useT(codesEn, codesAr);
  const f = useFormat();
  const { locale } = useLocale();
  const { ready, can } = usePermissions();
  const allowed = can('governance.manage');
  const [view, setView] = useState<View>('all');
  const [creating, setCreating] = useState(false);
  const phase = view === 'all' ? '' : view;
  const list = useCursorList(keys.governanceElections(phase), (cursor) => fetchers.governanceElections(phase, cursor), {
    enabled: allowed,
  });
  if (ready && !allowed)
    return (
      <>
        <PageHeader title={t('title')} />
        <ForbiddenState />
      </>
    );
  return (
    <>
      <PageHeader
        title={t('title')}
        description={t('description')}
        actions={
          <Button variant="primary" onClick={() => setCreating(true)}>
            {t('newElection')}
          </Button>
        }
      />
      <div className="toolbar">
        <Segmented<View>
          label={t('shown')}
          value={view}
          onChange={setView}
          options={VIEWS.map((v) => ({ value: v, label: t(`view.${v}`) }))}
        />
      </div>
      <Card flush>
        <QueryState query={list}>
          <DataTable<StaffGovernanceElection>
            rows={list.rows}
            rowKey={(e) => e.id}
            empty={t('none')}
            columns={[
              {
                key: 'r',
                header: t('col.election'),
                cell: (e) => (
                  <Link className="table__link" href={`/governance/elections/${e.id}`}>
                    <span className="t-mono ltr">{e.reference}</span> · {inLocale(locale, e.titleEn, e.titleAr)}
                  </Link>
                ),
              },
              { key: 's', header: t('col.seats'), cell: (e) => f.number(e.seats) },
              { key: 'c', header: t('col.candidates'), cell: (e) => f.number(e.candidates.filter((c) => c.status === 'nominated').length) },
              {
                key: 'v',
                header: t('col.voting'),
                cell: (e) => `${f.dateTime(e.votingOpensAt)} – ${f.dateTime(e.votingClosesAt)}`,
              },
              { key: 't', header: t('col.turnout'), cell: (e) => turnoutText(g, e.turnout, e.electorate) },
              { key: 'p', header: t('col.phase'), cell: (e) => <StatusBadge status={e.phase} /> },
            ]}
          />
          <LoadMore query={list} />
        </QueryState>
      </Card>
      {creating ? <NewElection onClose={() => setCreating(false)} /> : null}
    </>
  );
}
