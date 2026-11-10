'use client';

import { fieldError, unwrap } from '@jiwar/api';
import { ErrorAlert, LoadMore, QueryState, useAction, useCursorList } from '@jiwar/api/react';
import { useFormat, useLocale, useT } from '@jiwar/i18n';
import {
  Button,
  Card,
  Checkbox,
  DataTable,
  Dialog,
  Field,
  ForbiddenState,
  Input,
  PageHeader,
  Segmented,
  Select,
  StatusBadge,
  Textarea,
  useCommonT,
  useToast,
} from '@jiwar/ui';
import Link from 'next/link';
import { useState } from 'react';
import { codeText, inLocale, turnoutText } from '@/components/governance/logic';
import { api } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys, type GovernanceContestStatus, type StaffGovernancePoll } from '@/lib/queries';
import ar from '@/messages/ar/gov-polls';
import codesAr from '@/messages/ar/gov-codes';
import en from '@/messages/en/gov-polls';
import codesEn from '@/messages/en/gov-codes';

type View = GovernanceContestStatus | 'all';
const VIEWS = ['open', 'scheduled', 'closed', 'cancelled', 'all'] as const satisfies readonly View[];

function NewPoll({ onClose }: { onClose: () => void }) {
  const t = useT(en, ar);
  const c = useCommonT();
  const toast = useToast();
  const [key] = useState(() => crypto.randomUUID());
  const [kind, setKind] = useState<'yes_no' | 'choice'>('yes_no');
  const [titleEn, setTitleEn] = useState('');
  const [bodyEn, setBodyEn] = useState('');
  const [options, setOptions] = useState(['', '']);
  const [secret, setSecret] = useState(true);
  const [quorumPct, setQuorum] = useState(50);
  const [thresholdPct, setThreshold] = useState(50);
  const [opensAt, setOpensAt] = useState('');
  const [closesAt, setClosesAt] = useState('');
  const create = useAction(
    () =>
      unwrap(
        api.POST('/api/v1/governance/polls', {
          params: { header: { 'Idempotency-Key': key } },
          body: {
            kind,
            titleEn: titleEn.trim(),
            bodyEn: bodyEn.trim(),
            secret,
            weighting: 'unit',
            quorumPct,
            thresholdPct,
            ...(kind === 'choice' ? { options: options.map((labelEn) => ({ labelEn: labelEn.trim() })) } : {}),
            ...(opensAt ? { opensAt: new Date(opensAt).toISOString() } : {}),
            closesAt: new Date(closesAt).toISOString(),
          },
        }),
      ),
    {
      invalidate: [keys.governanceAll],
      onDone: () => {
        toast.show(t('put'));
        onClose();
      },
    },
  );
  const err = (f: string) => fieldError(create.error, f);
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
          <Button type="submit" variant="primary" loading={create.isPending} disabled={!titleEn.trim() || !bodyEn.trim() || !closesAt}>
            {t('putIt')}
          </Button>
        </>
      }
    >
      <div className="form">
        <Field label={t('question')} error={err('titleEn')}>
          {(p) => <Input {...p} maxLength={200} value={titleEn} onChange={(e) => setTitleEn(e.target.value)} />}
        </Field>
        <Field label={t('about')} error={err('bodyEn')}>
          {(p) => <Textarea {...p} rows={4} maxLength={4000} value={bodyEn} onChange={(e) => setBodyEn(e.target.value)} />}
        </Field>
        <Field label={t('answers')}>
          {(p) => (
            <Select {...p} value={kind} onChange={(e) => setKind(e.target.value as 'yes_no' | 'choice')}>
              <option value="yes_no">{t('yesNo')}</option>
              <option value="choice">{t('choice')}</option>
            </Select>
          )}
        </Field>
        {kind === 'choice'
          ? options.map((o, i) => (
              <Field key={i} label={t('optionN', { n: i + 1 })} error={err(`options.${i}.labelEn`)}>
                {(p) => (
                  <Input
                    {...p}
                    maxLength={200}
                    value={o}
                    onChange={(e) => setOptions(options.map((x, j) => (j === i ? e.target.value : x)))}
                  />
                )}
              </Field>
            ))
          : null}
        {kind === 'choice' && options.length < 10 ? (
          <Button variant="text" onClick={() => setOptions([...options, ''])}>
            {t('addOption')}
          </Button>
        ) : null}
        <Checkbox label={t('secretLabel')} checked={secret} onChange={(e) => setSecret(e.target.checked)} />
        <div className="row" style={{ gap: 16 }}>
          <Field label={t('quorumLabel')} error={err('quorumPct')}>
            {(p) => <Input {...p} type="number" min={1} max={100} value={quorumPct} onChange={(e) => setQuorum(Number(e.target.value))} />}
          </Field>
          <Field label={t('passLabel')} error={err('thresholdPct')}>
            {(p) => (
              <Input {...p} type="number" min={50} max={100} value={thresholdPct} onChange={(e) => setThreshold(Number(e.target.value))} />
            )}
          </Field>
        </div>
        <div className="row" style={{ gap: 16 }}>
          <Field label={t('opens')} error={err('opensAt')}>
            {(p) => <Input {...p} type="datetime-local" value={opensAt} onChange={(e) => setOpensAt(e.target.value)} />}
          </Field>
          <Field label={t('closes')} error={err('closesAt')}>
            {(p) => <Input {...p} type="datetime-local" value={closesAt} onChange={(e) => setClosesAt(e.target.value)} />}
          </Field>
        </div>
        <ErrorAlert error={create.error} />
      </div>
    </Dialog>
  );
}

/** The owners' polls (ADR 0051): put by the board, or the manager for it. */
export default function GovernancePollsPage() {
  const t = useT(en, ar);
  const g = useT(codesEn, codesAr);
  const c = useCommonT();
  const f = useFormat();
  const { locale } = useLocale();
  const { ready, can } = usePermissions();
  const allowed = can('governance.manage');
  const [view, setView] = useState<View>('open');
  const [creating, setCreating] = useState(false);
  const status = view === 'all' ? '' : view;
  const list = useCursorList(keys.governancePolls(status), (cursor) => fetchers.governancePolls(status, cursor), { enabled: allowed });
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
            {t('newPoll')}
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
          <DataTable<StaffGovernancePoll>
            rows={list.rows}
            rowKey={(p) => p.id}
            empty={t('none')}
            columns={[
              {
                key: 'r',
                header: t('col.poll'),
                cell: (p) => (
                  <Link className="table__link" href={`/governance/polls/${p.id}`}>
                    <span className="t-mono ltr">{p.reference}</span> · {inLocale(locale, p.titleEn, p.titleAr)}
                  </Link>
                ),
              },
              { key: 'k', header: t('col.ballot'), cell: (p) => (p.secret ? t('secret') : t('openBallot')) },
              { key: 'c', header: t('col.closes'), cell: (p) => f.dateTime(p.closesAt) },
              { key: 't', header: t('col.turnout'), cell: (p) => turnoutText(g, p.turnout, p.electorate) },
              {
                key: 's',
                header: c('status'),
                cell: (p) => <StatusBadge status={p.result ?? p.status} />,
              },
              { key: 'x', header: t('col.result'), cell: (p) => (p.result ? codeText(g, 'result', p.result) : '—') },
            ]}
          />
          <LoadMore query={list} />
        </QueryState>
      </Card>
      {creating ? <NewPoll onClose={() => setCreating(false)} /> : null}
    </>
  );
}
