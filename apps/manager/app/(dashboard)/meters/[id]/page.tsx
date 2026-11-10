'use client';

import { fieldError, REASON_CODES, unwrap } from '@jiwar/api';
import { ErrorAlert, LoadMore, QueryState, useAction, useCursorList } from '@jiwar/api/react';
import { useFormat, useT } from '@jiwar/i18n';
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
  Select,
  useCommonT,
  useLabel,
  useToast,
} from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { api } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys, type MeterReading } from '@/lib/queries';
import ar from '@/messages/ar/meters-detail';
import en from '@/messages/en/meters-detail';

const iso = (d: Date) => d.toISOString().slice(0, 10);

/** A meter (ADR 0066): its readings, corrected or withdrawn once, and its use by month. */
export default function MeterPage() {
  const t = useT(en, ar);
  const c = useCommonT();
  const label = useLabel();
  const f = useFormat();
  const { id } = useParams<{ id: string }>();
  const { ready, can } = usePermissions();
  const toast = useToast();
  const manage = can('energy.manage');
  const meter = useQuery({ queryKey: keys.meter(id), queryFn: () => fetchers.meter(id), enabled: can('energy.read') });
  const [superseded, setSuperseded] = useState(false);
  const readings = useCursorList(keys.meterReadings(id, superseded), (c) => fetchers.meterReadings(id, superseded, c), {
    enabled: can('energy.read'),
  });
  const now = new Date();
  const from = iso(new Date(now.getFullYear() - 1, now.getMonth(), 1));
  const to = iso(now);
  const use = useQuery({ queryKey: keys.meterConsumption(id, from, to), queryFn: () => fetchers.meterConsumption(id, from, to), enabled: can('energy.read') });
  const [recording, setRecording] = useState(false);
  const [readOn, setReadOn] = useState(to);
  const [value, setValue] = useState('');
  const [reset, setReset] = useState(false);
  const [correcting, setCorrecting] = useState<MeterReading | null>(null);
  const [fixed, setFixed] = useState({ value: '', readOn: '', reasonCode: 'misread' });
  const [withdrawing, setWithdrawing] = useState<MeterReading | null>(null);
  const [retiring, setRetiring] = useState(false);
  const refresh = [keys.energyAll];
  const record = useAction(
    () =>
      unwrap(
        api.POST('/api/v1/maintenance/meters/{id}/readings', {
          params: { path: { id } },
          body: { readOn, value, reset },
        }),
      ),
    {
      invalidate: refresh,
      onDone: () => {
        toast.show(t('recorded'));
        setRecording(false);
        setValue('');
        setReset(false);
      },
    },
  );
  const correct = useAction(
    () =>
      unwrap(
        api.POST('/api/v1/maintenance/meters/{id}/readings/{readingId}/correct', {
          params: { path: { id, readingId: correcting!.id } },
          body: {
            value: fixed.value,
            ...(fixed.readOn && fixed.readOn !== correcting!.readOn ? { readOn: fixed.readOn } : {}),
            reasonCode: fixed.reasonCode,
          },
        }),
      ),
    {
      invalidate: refresh,
      onDone: () => {
        toast.show(t('corrected'));
        setCorrecting(null);
      },
    },
  );
  const withdraw = useAction(
    ({ readingId, reasonCode }: { readingId: string; reasonCode: string }) =>
      unwrap(
        api.POST('/api/v1/maintenance/meters/{id}/readings/{readingId}/withdraw', {
          params: { path: { id, readingId } },
          body: { reasonCode },
        }),
      ),
    {
      invalidate: refresh,
      onDone: () => {
        toast.show(t('withdrawn'));
        setWithdrawing(null);
      },
    },
  );
  const retire = useAction(
    (reasonCode: string) =>
      unwrap(api.POST('/api/v1/maintenance/meters/{id}/retire', { params: { path: { id } }, body: { reasonCode } })),
    {
      invalidate: refresh,
      onDone: () => {
        toast.show(t('retired'));
        setRetiring(false);
      },
    },
  );
  if (ready && !can('energy.read'))
    return (
      <>
        <PageHeader title={t('title')} />
        <ForbiddenState />
      </>
    );
  const m = meter.data;
  const months = use.data?.groups[0]?.months ?? [];
  return (
    <>
      <PageHeader
        title={m ? m.code : t('title')}
        description={
          m
            ? t(m.active ? 'description' : 'descriptionRetired', {
                kind: label(m.kind),
                unit: m.unit,
                mode: label(m.mode),
                multiplier: m.multiplier,
              })
            : undefined
        }
        actions={
          manage && m?.active ? (
            <>
              <Button onClick={() => setRetiring(true)}>{t('retire')}</Button>
              <Button variant="primary" onClick={() => setRecording(true)}>
                {t('enterReading')}
              </Button>
            </>
          ) : null
        }
      />
      <Card flush>
        <CardHeader
          title={t('readings')}
          actions={
            <Button size="sm" onClick={() => setSuperseded(!superseded)}>
              {superseded ? t('liveOnly') : t('withCorrections')}
            </Button>
          }
        />
        <QueryState query={readings}>
          <DataTable<MeterReading>
            rows={readings.rows}
            rowKey={(r) => r.id}
            empty={t('empty')}
            columns={[
              { key: 'd', header: t('col.day'), cell: (r) => f.day(r.readOn) },
              { key: 'v', header: t('col.reading'), cell: (r) => (r.supersededAt ? <s>{r.value}</s> : r.value) },
              { key: 'r', header: t('col.reset'), cell: (r) => (r.reset ? c('yes') : '') },
              { key: 's', header: t('col.by'), cell: (r) => label(r.source) },
              { key: 'w', header: t('col.entered'), cell: (r) => f.dateTime(r.recordedAt) },
              {
                key: 'x',
                header: <span className="visually-hidden">{c('actions')}</span>,
                className: 'table__actions',
                cell: (r) =>
                  manage && !r.supersededAt ? (
                    <span className="row" style={{ gap: 6 }}>
                      <Button
                        size="sm"
                        onClick={() => {
                          setFixed({ value: r.value, readOn: r.readOn, reasonCode: 'misread' });
                          setCorrecting(r);
                        }}
                      >
                        {t('correct')}
                      </Button>
                      <Button size="sm" onClick={() => setWithdrawing(r)}>
                        {t('withdraw')}
                      </Button>
                    </span>
                  ) : r.supersededReason ? (
                    label(r.supersededReason)
                  ) : null,
              },
            ]}
          />
          <LoadMore query={readings} />
        </QueryState>
      </Card>
      <Card flush>
        <CardHeader title={t('useByMonth')}>
          <span className="text-muted">{t('useByMonthHint')}</span>
        </CardHeader>
        <QueryState query={use}>
          <CardBody>
            {months.length ? (
              <DataTable
                rows={months}
                rowKey={(x) => x.month}
                columns={[
                  { key: 'm', header: t('col.month'), cell: (x) => f.month(x.month) },
                  { key: 'u', header: t('use', { unit: use.data!.unit }), cell: (x) => x.use },
                  { key: 'c', header: t('cost'), cell: (x) => (x.cost ? f.money(x.cost) : '—') },
                ]}
              />
            ) : (
              <p className="text-muted">{t('twoReadings')}</p>
            )}
          </CardBody>
        </QueryState>
      </Card>
      <Dialog
        open={recording}
        onClose={() => setRecording(false)}
        title={t('enterReading')}
        description={t('enterDescription')}
        onSubmit={() => value && record.mutate()}
        footer={
          <>
            <Button onClick={() => setRecording(false)}>{c('cancel')}</Button>
            <Button type="submit" variant="primary" loading={record.isPending} disabled={!value}>
              {t('record')}
            </Button>
          </>
        }
      >
        <div className="form">
          <ErrorAlert error={record.error} />
          <div className="form__row">
            <Field label={t('day')} error={fieldError(record.error, 'readOn')}>
              {(p) => <Input {...p} type="date" value={readOn} onChange={(e) => setReadOn(e.target.value)} />}
            </Field>
            <Field label={t('reading')} error={fieldError(record.error, 'value')}>
              {(p) => <Input {...p} value={value} onChange={(e) => setValue(e.target.value)} />}
            </Field>
          </div>
          <label className="row" style={{ gap: 6 }}>
            <input type="checkbox" checked={reset} onChange={(e) => setReset(e.target.checked)} /> {t('wasReset')}
          </label>
        </div>
      </Dialog>
      <Dialog
        open={correcting !== null}
        onClose={() => setCorrecting(null)}
        title={t('correctTitle')}
        description={t('correctDescription')}
        onSubmit={() => fixed.value && correct.mutate()}
        footer={
          <>
            <Button onClick={() => setCorrecting(null)}>{c('cancel')}</Button>
            <Button type="submit" variant="primary" loading={correct.isPending} disabled={!fixed.value}>
              {t('correct')}
            </Button>
          </>
        }
      >
        <div className="form">
          <ErrorAlert error={correct.error} />
          <div className="form__row">
            <Field label={t('day')} error={fieldError(correct.error, 'readOn')}>
              {(p) => <Input {...p} type="date" value={fixed.readOn} onChange={(e) => setFixed({ ...fixed, readOn: e.target.value })} />}
            </Field>
            <Field label={t('reading')} error={fieldError(correct.error, 'value')}>
              {(p) => <Input {...p} value={fixed.value} onChange={(e) => setFixed({ ...fixed, value: e.target.value })} />}
            </Field>
          </div>
          <Field label={t('why')} error={fieldError(correct.error, 'reasonCode')}>
            {(p) => (
              <Select {...p} value={fixed.reasonCode} onChange={(e) => setFixed({ ...fixed, reasonCode: e.target.value })}>
                {REASON_CODES.readingCorrect.map((code) => (
                  <option key={code} value={code}>
                    {label(code)}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        </div>
      </Dialog>
      <ReasonCodeDialog
        open={withdrawing !== null}
        onClose={() => setWithdrawing(null)}
        title={t('withdrawTitle')}
        codes={REASON_CODES.readingCorrect}
        confirmLabel={t('withdraw')}
        danger
        pending={withdraw.isPending}
        error={<ErrorAlert error={withdraw.error} />}
        onConfirm={(code) => withdrawing && withdraw.mutate({ readingId: withdrawing.id, reasonCode: code })}
      />
      <ReasonCodeDialog
        open={retiring}
        onClose={() => setRetiring(false)}
        title={t('retireTitle')}
        codes={REASON_CODES.meterRetire}
        confirmLabel={t('retire')}
        danger
        pending={retire.isPending}
        error={<ErrorAlert error={retire.error} />}
        onConfirm={(code) => retire.mutate(code)}
      />
    </>
  );
}
