'use client';

import { REASON_CODES, unwrap } from '@jiwar/api';
import { ErrorAlert, LoadMore, QueryState, useAction, useCursorList } from '@jiwar/api/react';
import { useFormat, useT } from '@jiwar/i18n';
import {
  Badge,
  Button,
  ButtonLink,
  Card,
  DataTable,
  Dialog,
  Field,
  ForbiddenState,
  PageHeader,
  Select,
  Textarea,
  useCommonT,
  useLabel,
  useToast,
} from '@jiwar/ui';
import Link from 'next/link';
import { useState } from 'react';
import { UnitPicker } from '@/components/unit-picker';
import { api } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys, type ExperienceCase, type ExperienceSignal } from '@/lib/queries';
import ar from '@/messages/ar/experience-cases';
import en from '@/messages/en/experience-cases';

type Status = 'open' | 'closed' | '';
type Kind = 'follow_up' | 'recovery' | '';

/**
 * Experience and recovery (ADR 0082): the follow-up and recovery cases, one
 * open per unit, and the signals the rules raised (no AI: ratings of 1 or 2,
 * tickets sent back, complaints the unit made, within the compound's
 * thresholds). A case is worked on its own page.
 */
export default function ExperiencePage() {
  const t = useT(en, ar);
  const c = useCommonT();
  const f = useFormat();
  const label = useLabel();
  const kindOf = (k: string) => (k === 'recovery' ? t('kind.recovery') : k === 'follow_up' ? t('kind.follow_up') : label(k));
  const { ready, can } = usePermissions();
  const allowed = can('experience.manage');
  const toast = useToast();
  const [status, setStatus] = useState<Status>('open');
  const [kind, setKind] = useState<Kind>('');
  const [opening, setOpening] = useState(false);
  const [unitId, setUnitId] = useState('');
  const [newKind, setNewKind] = useState<'follow_up' | 'recovery'>('recovery');
  const [failureCode, setFailureCode] = useState('');
  const [note, setNote] = useState('');
  const cases = useCursorList(keys.experienceCases({ status, kind }), (cursor) => fetchers.experienceCases({ status, kind }, cursor), {
    enabled: allowed,
  });
  const signals = useCursorList(keys.experienceSignals({}), (cursor) => fetchers.experienceSignals({}, cursor), { enabled: allowed });
  const open = useAction(
    () =>
      unwrap(
        api.POST('/api/v1/staff/experience/cases', {
          body: { unitId, kind: newKind, ...(failureCode ? { failureCode } : {}), ...(note.trim() ? { note } : {}) },
        }),
      ),
    {
      invalidate: [keys.experienceAll],
      onDone: (opened) => {
        toast.show(t('open.done', { number: opened.number }));
        setOpening(false);
        setUnitId('');
        setNote('');
      },
    },
  );
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
          <span className="row" style={{ gap: 6 }}>
            <ButtonLink href="/experience/reports">{t('reports')}</ButtonLink>
            <ButtonLink href="/experience/setup">{t('setup')}</ButtonLink>
            <Button variant="primary" onClick={() => setOpening(true)}>
              {t('openCase')}
            </Button>
          </span>
        }
      />
      <div className="toolbar">
        <Field label={c('status')}>
          {(p) => (
            <Select {...p} value={status} onChange={(e) => setStatus(e.target.value as Status)}>
              <option value="">{t('anyStatus')}</option>
              <option value="open">{label('open')}</option>
              <option value="closed">{label('closed')}</option>
            </Select>
          )}
        </Field>
        <Field label={c('kind')}>
          {(p) => (
            <Select {...p} value={kind} onChange={(e) => setKind(e.target.value as Kind)}>
              <option value="">{t('anyKind')}</option>
              <option value="follow_up">{t('kind.follow_up')}</option>
              <option value="recovery">{t('kind.recovery')}</option>
            </Select>
          )}
        </Field>
      </div>
      <Card flush>
        <QueryState query={cases}>
          <DataTable<ExperienceCase>
            rows={cases.rows}
            rowKey={(x) => x.id}
            empty={t('empty')}
            columns={[
              {
                key: 'number',
                header: t('case'),
                cell: (x) => (
                  <Link className="table__link" href={`/experience/cases/${x.id}`}>
                    {x.number}
                  </Link>
                ),
              },
              { key: 'unit', header: c('unit'), cell: (x) => `${x.unitCode ?? '—'}${x.building ? ` · ${x.building}` : ''}` },
              { key: 'kind', header: c('kind'), cell: (x) => kindOf(x.kind) },
              { key: 'origin', header: t('openedBy'), cell: (x) => (x.origin === 'signal' ? t('origin.signal') : t('origin.staff')) },
              { key: 'due', header: t('due'), width: 170, cell: (x) => (x.dueAt ? f.dateTime(x.dueAt) : '—') },
              { key: 'status', header: c('status'), cell: (x) => <Badge>{label(x.outcome ?? x.status)}</Badge> },
            ]}
          />
          <LoadMore query={cases} />
        </QueryState>
      </Card>
      <h2 className="t-title-md" style={{ margin: '24px 0 8px' }}>
        {t('signals')}
      </h2>
      <Card flush>
        <QueryState query={signals}>
          <DataTable<ExperienceSignal>
            rows={signals.rows}
            rowKey={(s) => s.id}
            empty={t('emptySignals')}
            columns={[
              { key: 'at', header: t('detected'), width: 170, cell: (s) => f.dateTime(s.detectedAt) },
              { key: 'unit', header: c('unit'), cell: (s) => s.unitCode ?? '—' },
              { key: 'rule', header: t('rule'), cell: (s) => label(s.code) },
              { key: 'count', header: t('events'), cell: (s) => t('eventsIn', { count: f.number(s.count), days: s.windowDays }) },
              {
                key: 'case',
                header: t('case'),
                cell: (s) =>
                  s.caseId ? (
                    <Link className="table__link" href={`/experience/cases/${s.caseId}`}>
                      {t('openCaseLink')}
                    </Link>
                  ) : (
                    '—'
                  ),
              },
            ]}
          />
          <LoadMore query={signals} />
        </QueryState>
      </Card>
      <Dialog
        open={opening}
        onClose={() => setOpening(false)}
        title={t('open.title')}
        description={t('open.description')}
        onSubmit={(e) => {
          e.preventDefault();
          open.mutate();
        }}
        footer={
          <Button type="submit" variant="primary" loading={open.isPending} disabled={!unitId}>
            {t('open.submit')}
          </Button>
        }
      >
        <div className="stack">
          <Field label={c('unit')}>{(p) => <UnitPicker {...p} value={unitId} onChange={(e) => setUnitId(e.target.value)} />}</Field>
          <Field label={c('kind')}>
            {(p) => (
              <Select {...p} value={newKind} onChange={(e) => setNewKind(e.target.value as 'follow_up' | 'recovery')}>
                <option value="recovery">{t('open.recovery')}</option>
                <option value="follow_up">{t('open.followUp')}</option>
              </Select>
            )}
          </Field>
          <Field label={t('whatFailed')}>
            {(p) => (
              <Select {...p} value={failureCode} onChange={(e) => setFailureCode(e.target.value)}>
                <option value="">{t('notSaid')}</option>
                {REASON_CODES.creditNoteCompensation.map((code) => (
                  <option key={code} value={code}>
                    {label(code)}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label={c('note')} hint={t('noteHint')}>
            {(p) => <Textarea {...p} value={note} maxLength={1000} onChange={(e) => setNote(e.target.value)} />}
          </Field>
          <ErrorAlert error={open.error} />
        </div>
      </Dialog>
    </>
  );
}
