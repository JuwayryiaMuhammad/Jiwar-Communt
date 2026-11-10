'use client';

import { fieldError, REASON_CODES, unwrap } from '@jiwar/api';
import { ErrorAlert, QueryState, useAction } from '@jiwar/api/react';
import { useFormat, useLocale, useT } from '@jiwar/i18n';
import {
  Button,
  Card,
  CardBody,
  CardHeader,
  DataTable,
  Dialog,
  Field,
  ForbiddenState,
  Input,
  PageHeader,
  ReasonCodeDialog,
  Textarea,
  useCommonT,
  useLabel,
  useToast,
} from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { api } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys, type ComplianceItemDetail } from '@/lib/queries';
import ar from '@/messages/ar/compliance-item';
import en from '@/messages/en/compliance-item';

type Occurrence = ComplianceItemDetail['occurrences'][number];

/** A due day done (ADR 0087): the day, what it gave, and the next due day. */
function CompleteDialog({ item, onClose }: { item: ComplianceItemDetail; onClose: () => void }) {
  const t = useT(en, ar);
  const c = useCommonT();
  const fmt = useFormat();
  const toast = useToast();
  const [f, setF] = useState({ doneOn: '', certificateNumber: '', expiresOn: '', nextDueOn: '', note: '' });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const save = useAction(
    () =>
      unwrap(
        api.POST('/api/v1/staff/compliance/occurrences/{occurrenceId}/complete', {
          params: { path: { occurrenceId: item.current!.id } },
          body: {
            doneOn: f.doneOn,
            ...(f.certificateNumber.trim() ? { certificateNumber: f.certificateNumber.trim() } : {}),
            ...(f.expiresOn ? { expiresOn: f.expiresOn } : {}),
            ...(f.nextDueOn ? { nextDueOn: f.nextDueOn } : {}),
            ...(f.note.trim() ? { note: f.note.trim() } : {}),
          },
        }),
      ),
    {
      invalidate: [keys.complianceAll],
      onDone: (d) => {
        toast.show(d.current ? t('recordedNext', { day: fmt.day(d.current.dueOn) }) : t('recordedLast'));
        onClose();
      },
    },
  );
  return (
    <Dialog
      open
      onClose={onClose}
      title={t('recordTitle')}
      onSubmit={() => f.doneOn && save.mutate()}
      footer={
        <>
          <Button onClick={onClose}>{c('cancel')}</Button>
          <Button type="submit" variant="primary" loading={save.isPending} disabled={!f.doneOn}>
            {t('record')}
          </Button>
        </>
      }
    >
      <div className="form">
        <ErrorAlert error={save.error} />
        <div className="form__row">
          <Field label={t('doneOn')} error={fieldError(save.error, 'doneOn')}>
            {(p) => <Input {...p} type="date" value={f.doneOn} onChange={set('doneOn')} />}
          </Field>
          <Field label={t('expiresOn')} hint={t('expiresHint')} error={fieldError(save.error, 'expiresOn')}>
            {(p) => <Input {...p} type="date" value={f.expiresOn} onChange={set('expiresOn')} />}
          </Field>
        </div>
        <div className="form__row">
          <Field label={t('certificateNumber')} error={fieldError(save.error, 'certificateNumber')}>
            {(p) => <Input {...p} className="ltr" value={f.certificateNumber} onChange={set('certificateNumber')} />}
          </Field>
          <Field label={t('nextDue')} hint={t('nextDueHint')} error={fieldError(save.error, 'nextDueOn')}>
            {(p) => <Input {...p} type="date" value={f.nextDueOn} onChange={set('nextDueOn')} />}
          </Field>
        </div>
        <Field label={c('note')} hint={t('noteHint')} error={fieldError(save.error, 'note')}>
          {(p) => <Textarea {...p} rows={2} maxLength={1000} value={f.note} onChange={set('note')} />}
        </Field>
      </div>
    </Dialog>
  );
}

/** A compliance item (ADR 0087): where it stands, its archive, and its completion. */
export default function ComplianceItemPage() {
  const t = useT(en, ar);
  const c = useCommonT();
  const fmt = useFormat();
  const label = useLabel();
  const { locale } = useLocale();
  const { id } = useParams<{ id: string }>();
  const { ready, can } = usePermissions();
  const toast = useToast();
  const allowed = can('compliance.manage');
  const item = useQuery({ queryKey: keys.complianceItem(id), queryFn: () => fetchers.complianceItem(id), enabled: allowed });
  const [completing, setCompleting] = useState(false);
  const [retiring, setRetiring] = useState(false);
  const retire = useAction(
    (reasonCode: string) =>
      unwrap(api.POST('/api/v1/staff/compliance/items/{id}/retire', { params: { path: { id } }, body: { reasonCode } })),
    {
      invalidate: [keys.complianceAll],
      onDone: () => {
        toast.show(t('retired'));
        setRetiring(false);
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
  const i = item.data;
  return (
    <QueryState query={item}>
      {i ? (
        <>
          <PageHeader
            title={i.title}
            description={
              i.current
                ? t('descriptionDue', { kind: label(i.kind), state: label(i.state), day: fmt.day(i.current.dueOn) })
                : `${label(i.kind)} · ${label(i.state)}`
            }
            actions={
              i.retiredAt ? null : (
                <>
                  {i.current ? (
                    <Button variant="primary" onClick={() => setCompleting(true)}>
                      {t('recordDone')}
                    </Button>
                  ) : null}
                  <Button onClick={() => setRetiring(true)}>{t('retire')}</Button>
                </>
              )
            }
          />
          <Card flush>
            <CardHeader title={t('detailsTitle')} />
            <CardBody>
              <dl className="dl">
                <dt>{t('authority')}</dt>
                <dd>{i.authority ?? '—'}</dd>
                <dt>{t('reference')}</dt>
                <dd>{i.reference ?? '—'}</dd>
                <dt>{t('about')}</dt>
                <dd>
                  {i.asset
                    ? t('asset', { code: i.asset.code })
                    : i.commonArea
                      ? `${locale === 'ar' ? i.commonArea.nameAr : i.commonArea.nameEn} (${i.commonArea.code})`
                      : t('theCompound')}
                </dd>
                <dt>{t('answers')}</dt>
                <dd>{[i.vendor?.name, i.owner?.fullName].filter(Boolean).join(' · ') || '—'}</dd>
                <dt>{t('recurs')}</dt>
                <dd>{i.recurrenceMonths ? t('everyMonths', { n: i.recurrenceMonths }) : t('once')}</dd>
                <dt>{t('toldAhead')}</dt>
                <dd>
                  {fmt.list(i.leadDays.map((d) => t('daysAhead', { n: d })))}
                  {i.ownLeadDays ? '' : t('compoundsOwn')}
                </dd>
              </dl>
            </CardBody>
          </Card>
          <Card flush>
            <CardHeader title={t('occurrencesTitle')} />
            <DataTable<Occurrence>
              rows={i.occurrences}
              rowKey={(o) => o.id}
              empty={t('noOccurrence')}
              columns={[
                { key: 'd', header: t('col.due'), cell: (o) => fmt.day(o.dueOn) },
                { key: 's', header: c('status'), cell: (o) => label(o.status) },
                { key: 'done', header: t('col.done'), cell: (o) => (o.doneOn ? fmt.day(o.doneOn) : '—') },
                { key: 'c', header: t('col.certificate'), cell: (o) => (o.certificateNumber ? <span className="ltr">{o.certificateNumber}</span> : '—') },
                { key: 'e', header: t('col.expires'), cell: (o) => (o.expiresOn ? fmt.day(o.expiresOn) : '—') },
                {
                  key: 'f',
                  header: t('col.evidence'),
                  cell: (o) =>
                    o.evidence.length
                      ? o.evidence.map((e, n) =>
                          e.fileUrl ? (
                            <a key={e.id} className="table__link" href={e.fileUrl} target="_blank" rel="noreferrer">
                              {t('file', { n: n + 1 })}{' '}
                            </a>
                          ) : null,
                        )
                      : '—',
                },
              ]}
            />
          </Card>
          {completing ? <CompleteDialog item={i} onClose={() => setCompleting(false)} /> : null}
          <ReasonCodeDialog
            open={retiring}
            onClose={() => setRetiring(false)}
            title={t('retireTitle')}
            description={t('retireDescription')}
            codes={REASON_CODES.complianceRetire}
            confirmLabel={t('retire')}
            danger
            pending={retire.isPending}
            error={<ErrorAlert error={retire.error} />}
            onConfirm={(code) => retire.mutate(code)}
          />
        </>
      ) : null}
    </QueryState>
  );
}
