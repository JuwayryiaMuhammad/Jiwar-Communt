'use client';

import { fieldError, formatDate, formatDateTime, humanize, REASON_CODES, unwrap } from '@jiwar/api';
import { ErrorAlert, LoadMore, QueryState, useAction, useCursorList } from '@jiwar/api/react';
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
  useToast,
} from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { api } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys, type MeterReading } from '@/lib/queries';

const iso = (d: Date) => d.toISOString().slice(0, 10);

/** A meter (ADR 0066): its readings, corrected or withdrawn once, and its use by month. */
export default function MeterPage() {
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
        toast.show('Recorded.');
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
        toast.show('Corrected.');
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
        toast.show('Withdrawn.');
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
        toast.show('Retired.');
        setRetiring(false);
      },
    },
  );
  if (ready && !can('energy.read'))
    return (
      <>
        <PageHeader title="Meter" />
        <ForbiddenState />
      </>
    );
  const m = meter.data;
  const months = use.data?.groups[0]?.months ?? [];
  return (
    <>
      <PageHeader
        title={m ? m.code : 'Meter'}
        description={m ? `${humanize(m.kind)} in ${m.unit}, ${m.mode}, ×${m.multiplier}${m.active ? '' : ' — retired'}` : undefined}
        actions={
          manage && m?.active ? (
            <>
              <Button onClick={() => setRetiring(true)}>Retire</Button>
              <Button variant="primary" onClick={() => setRecording(true)}>
                Enter a reading
              </Button>
            </>
          ) : null
        }
      />
      <Card flush>
        <CardHeader
          title="Readings"
          actions={
            <Button size="sm" onClick={() => setSuperseded(!superseded)}>
              {superseded ? 'Live only' : 'With corrections'}
            </Button>
          }
        />
        <QueryState query={readings}>
          <DataTable<MeterReading>
            rows={readings.rows}
            rowKey={(r) => r.id}
            empty="No reading"
            columns={[
              { key: 'd', header: 'Day', cell: (r) => formatDate(r.readOn) },
              { key: 'v', header: 'Reading', cell: (r) => (r.supersededAt ? <s>{r.value}</s> : r.value) },
              { key: 'r', header: 'Reset', cell: (r) => (r.reset ? 'Yes' : '') },
              { key: 's', header: 'By', cell: (r) => humanize(r.source) },
              { key: 'w', header: 'Entered', cell: (r) => formatDateTime(r.recordedAt) },
              {
                key: 'x',
                header: <span className="visually-hidden">Actions</span>,
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
                        Correct
                      </Button>
                      <Button size="sm" onClick={() => setWithdrawing(r)}>
                        Withdraw
                      </Button>
                    </span>
                  ) : r.supersededReason ? (
                    humanize(r.supersededReason)
                  ) : null,
              },
            ]}
          />
          <LoadMore query={readings} />
        </QueryState>
      </Card>
      <Card flush>
        <CardHeader title="Use by month">
          <span className="text-muted">The last twelve months, computed from the live readings.</span>
        </CardHeader>
        <QueryState query={use}>
          <CardBody>
            {months.length ? (
              <DataTable
                rows={months}
                rowKey={(x) => x.month}
                columns={[
                  { key: 'm', header: 'Month', cell: (x) => x.month },
                  { key: 'u', header: `Use (${use.data!.unit})`, cell: (x) => x.use },
                  { key: 'c', header: 'Cost', cell: (x) => (x.cost ? `${x.cost} EGP` : '—') },
                ]}
              />
            ) : (
              <p className="text-muted">Two readings make a period: nothing to show yet.</p>
            )}
          </CardBody>
        </QueryState>
      </Card>
      <Dialog
        open={recording}
        onClose={() => setRecording(false)}
        title="Enter a reading"
        description="One live reading a day. A cumulative register only climbs, unless it was reset."
        onSubmit={() => value && record.mutate()}
        footer={
          <>
            <Button onClick={() => setRecording(false)}>Cancel</Button>
            <Button type="submit" variant="primary" loading={record.isPending} disabled={!value}>
              Record
            </Button>
          </>
        }
      >
        <div className="form">
          <ErrorAlert error={record.error} />
          <div className="form__row">
            <Field label="Day" error={fieldError(record.error, 'readOn')}>
              {(p) => <Input {...p} type="date" value={readOn} onChange={(e) => setReadOn(e.target.value)} />}
            </Field>
            <Field label="Reading" error={fieldError(record.error, 'value')}>
              {(p) => <Input {...p} value={value} onChange={(e) => setValue(e.target.value)} />}
            </Field>
          </div>
          <label className="row" style={{ gap: 6 }}>
            <input type="checkbox" checked={reset} onChange={(e) => setReset(e.target.checked)} /> The register was reset
          </label>
        </div>
      </Dialog>
      <Dialog
        open={correcting !== null}
        onClose={() => setCorrecting(null)}
        title="Correct the reading"
        description="Once: the new reading supersedes it, checked without it."
        onSubmit={() => fixed.value && correct.mutate()}
        footer={
          <>
            <Button onClick={() => setCorrecting(null)}>Cancel</Button>
            <Button type="submit" variant="primary" loading={correct.isPending} disabled={!fixed.value}>
              Correct
            </Button>
          </>
        }
      >
        <div className="form">
          <ErrorAlert error={correct.error} />
          <div className="form__row">
            <Field label="Day" error={fieldError(correct.error, 'readOn')}>
              {(p) => <Input {...p} type="date" value={fixed.readOn} onChange={(e) => setFixed({ ...fixed, readOn: e.target.value })} />}
            </Field>
            <Field label="Reading" error={fieldError(correct.error, 'value')}>
              {(p) => <Input {...p} value={fixed.value} onChange={(e) => setFixed({ ...fixed, value: e.target.value })} />}
            </Field>
          </div>
          <Field label="Why" error={fieldError(correct.error, 'reasonCode')}>
            {(p) => (
              <Select {...p} value={fixed.reasonCode} onChange={(e) => setFixed({ ...fixed, reasonCode: e.target.value })}>
                {REASON_CODES.readingCorrect.map((c) => (
                  <option key={c} value={c}>
                    {humanize(c)}
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
        title="Withdraw the reading"
        codes={REASON_CODES.readingCorrect}
        confirmLabel="Withdraw"
        danger
        pending={withdraw.isPending}
        error={<ErrorAlert error={withdraw.error} />}
        onConfirm={(c) => withdrawing && withdraw.mutate({ readingId: withdrawing.id, reasonCode: c })}
      />
      <ReasonCodeDialog
        open={retiring}
        onClose={() => setRetiring(false)}
        title="Retire the meter"
        codes={REASON_CODES.meterRetire}
        confirmLabel="Retire"
        danger
        pending={retire.isPending}
        error={<ErrorAlert error={retire.error} />}
        onConfirm={(c) => retire.mutate(c)}
      />
    </>
  );
}
