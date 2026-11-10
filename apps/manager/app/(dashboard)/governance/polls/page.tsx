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
  useCommonT,
  useToast,
} from '@jiwar/ui';
import Link from 'next/link';
import { useState } from 'react';
import { codeText, inLocale, turnoutText } from '@/components/governance/logic';
import { languagesReady, textOrNull } from '@/components/community/logic';
import { NO_TEXT, TextFields, type TwoTexts } from '@/components/community/bits';
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
  const [text, setText] = useState<TwoTexts>(NO_TEXT);
  const [options, setOptions] = useState<{ en: string; ar: string }[]>([
    { en: '', ar: '' },
    { en: '', ar: '' },
  ]);
  const { locale } = useLocale();
  // An answer is written in the languages the question is written in, no other.
  const written = { en: text.titleEn.trim() !== '', ar: text.titleAr.trim() !== '' };
  const languages = (locale === 'ar' ? (['ar', 'en'] as const) : (['en', 'ar'] as const)).filter((l) => written[l]);
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
            titleEn: textOrNull(text.titleEn),
            bodyEn: textOrNull(text.bodyEn),
            titleAr: textOrNull(text.titleAr),
            bodyAr: textOrNull(text.bodyAr),
            secret,
            weighting: 'unit',
            quorumPct,
            thresholdPct,
            ...(kind === 'choice' ? {
                  options: options.map((o) => ({
                    ...(written.en ? { labelEn: o.en.trim() } : {}),
                    ...(written.ar ? { labelAr: o.ar.trim() } : {}),
                  })),
                } : {}),
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
          <Button type="submit" variant="primary" loading={create.isPending} disabled={!languagesReady([text.titleEn, text.bodyEn], [text.titleAr, text.bodyAr]) || !closesAt}>
            {t('putIt')}
          </Button>
        </>
      }
    >
      <div className="form">
        <TextFields value={text} onChange={setText} error={create.error} titleLabel={t('question')} bodyLabel={t('about')} titleMax={200} bodyMax={4000} />
        <Field label={t('answers')}>
          {(p) => (
            <Select {...p} value={kind} onChange={(e) => setKind(e.target.value as 'yes_no' | 'choice')}>
              <option value="yes_no">{t('yesNo')}</option>
              <option value="choice">{t('choice')}</option>
            </Select>
          )}
        </Field>
        {kind === 'choice'
          ? options.map((o, i) =>
              languages.map((l) => (
                <Field
                  key={`${i}-${l}`}
                  label={t(l === 'ar' ? 'optionNAr' : 'optionNEn', { n: i + 1 })}
                  error={err(`options.${i}.label${l === 'ar' ? 'Ar' : 'En'}`)}
                >
                  {(p) => (
                    <Input
                      {...p}
                      dir={l === 'ar' ? 'rtl' : 'ltr'}
                      lang={l}
                      maxLength={200}
                      value={o[l]}
                      onChange={(e) => setOptions(options.map((x, j) => (j === i ? { ...x, [l]: e.target.value } : x)))}
                    />
                  )}
                </Field>
              )),
            )
          : null}
        {kind === 'choice' && languages.length === 0 ? <p className="t-secondary">{t('optionsNeedQuestion')}</p> : null}
        {kind === 'choice' && options.length < 10 ? (
          <Button variant="text" onClick={() => setOptions([...options, { en: '', ar: '' }])}>
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
