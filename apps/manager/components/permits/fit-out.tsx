'use client';

import { formatDateTime, humanize, REASON_CODES, unwrap, type Schema } from '@jiwar/api';
import { ErrorAlert, QueryState, useAction } from '@jiwar/api/react';
import {
  Alert,
  Button,
  Card,
  CardBody,
  CardHeader,
  DataTable,
  Dialog,
  Field,
  Input,
  ReasonCodeDialog,
  Select,
  StatusBadge,
  Textarea,
  useToast,
} from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { FileUpload } from '@/components/file-upload';
import { StepUpDialog } from '@/components/step-up-dialog';
import { api } from '@/lib/api';
import { keys } from '@/lib/queries';

type FitOut = Schema<'FitOutView'>;
type Slot = FitOut['debrisSlots'][number];
type Claim = FitOut['claims'][number];
type Area = FitOut['areas'][number];

/** Under the permits' key, so a decision on the permit refreshes it too. */
export const fitOutKey = (id: string) => [...keys.permitsAll, 'fit-out', id] as const;

const today = () => new Date().toISOString().slice(0, 10);

function RecordDeposit({ permitId, unitId, onClose }: { permitId: string; unitId: string; onClose: () => void }) {
  const toast = useToast();
  const [amount, setAmount] = useState('');
  const [receivedOn, setReceivedOn] = useState(today());
  const [method, setMethod] = useState<'cash' | 'bank_transfer' | 'cheque'>('cash');
  const record = useAction(
    async () => {
      const unit = await unwrap(api.GET('/api/v1/units/{id}', { params: { path: { id: unitId } } }));
      const primary = unit.occupants?.find((o) => o.isPrimary);
      if (!primary) throw new Error('The unit has no primary resident to hold the deposit for.');
      return unwrap(
        api.POST('/api/v1/staff/deposits', {
          body: { occupancyId: primary.occupancyId, kind: 'finishing_works', amount, receivedOn, method, permitId },
        }),
      );
    },
    {
      invalidate: [fitOutKey(permitId)],
      onDone: () => {
        toast.show('Recorded for this permit. It may be approved now.');
        onClose();
      },
    },
  );
  return (
    <Dialog
      open
      onClose={onClose}
      title="Record the finishing-works deposit"
      description="Held for the unit’s primary resident, named on this permit. One deposit per permit."
      onSubmit={() => record.mutate()}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" loading={record.isPending}>
            Record
          </Button>
        </>
      }
    >
      <div className="form">
        <Field label="Amount (EGP)">{(p) => <Input {...p} inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />}</Field>
        <Field label="Received on">{(p) => <Input {...p} type="date" value={receivedOn} onChange={(e) => setReceivedOn(e.target.value)} />}</Field>
        <Field label="Method">
          {(p) => (
            <Select {...p} value={method} onChange={(e) => setMethod(e.target.value as 'cash' | 'bank_transfer' | 'cheque')}>
              <option value="cash">Cash</option>
              <option value="bank_transfer">Bank transfer</option>
              <option value="cheque">Cheque</option>
            </Select>
          )}
        </Field>
        <ErrorAlert error={record.error} />
      </div>
    </Dialog>
  );
}

function ScheduleDebris({ permitId, onClose }: { permitId: string; onClose: () => void }) {
  const toast = useToast();
  const [day, setDay] = useState(today());
  const [from, setFrom] = useState('10:00');
  const [to, setTo] = useState('12:00');
  const schedule = useAction(
    () =>
      unwrap(
        api.POST('/api/v1/staff/unit-permits/{id}/debris-slots', {
          params: { path: { id: permitId } },
          body: { day, window: { from, to } },
        }),
      ),
    {
      invalidate: [fitOutKey(permitId)],
      onDone: () => {
        toast.show('Scheduled. The guard sees it at the gate that day.');
        onClose();
      },
    },
  );
  return (
    <Dialog
      open
      onClose={onClose}
      title="Schedule a debris removal"
      description="A work day of the permit, inside the compound’s hours, 30 minutes to 4 hours. Three scheduled at once at most."
      onSubmit={() => schedule.mutate()}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" loading={schedule.isPending}>
            Schedule
          </Button>
        </>
      }
    >
      <div className="form">
        <Field label="Day">{(p) => <Input {...p} type="date" value={day} onChange={(e) => setDay(e.target.value)} />}</Field>
        <Field label="From">{(p) => <Input {...p} type="time" value={from} onChange={(e) => setFrom(e.target.value)} />}</Field>
        <Field label="To">{(p) => <Input {...p} type="time" value={to} onChange={(e) => setTo(e.target.value)} />}</Field>
        <ErrorAlert error={schedule.error} />
      </div>
    </Dialog>
  );
}

function RecordArea({ permitId, phase, area, onClose }: { permitId: string; phase: 'before' | 'after'; area?: Area; onClose: () => void }) {
  const toast = useToast();
  const [commonAreaId, setCommonAreaId] = useState(area?.commonArea.id ?? '');
  const [photos, setPhotos] = useState<string[]>([]);
  const [note, setNote] = useState('');
  const areas = useQuery({
    queryKey: ['maintenance', 'areas', 'fit-out'],
    queryFn: () => unwrap(api.GET('/api/v1/maintenance/areas', { params: { query: { limit: 100 } } })),
    enabled: !area,
  });
  const record = useAction(
    () =>
      unwrap(
        api.POST('/api/v1/staff/unit-permits/{id}/area-records', {
          params: { path: { id: permitId } },
          body: { commonAreaId, phase, photoFileIds: photos, ...(note.trim() ? { note: note.trim() } : {}) },
        }),
      ),
    {
      invalidate: [fitOutKey(permitId)],
      onDone: () => {
        toast.show(phase === 'before' ? 'Recorded before the works.' : 'Recorded after the works.');
        onClose();
      },
    },
  );
  return (
    <Dialog
      open
      onClose={onClose}
      title={phase === 'before' ? 'Record an area before the works' : `Record ${area?.commonArea.nameEn ?? 'the area'} after the works`}
      description="One to ten photos, and a note the unit reads. Once per area and stage; never changed."
      onSubmit={() => record.mutate()}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" loading={record.isPending} disabled={!commonAreaId || !photos.length}>
            Record
          </Button>
        </>
      }
    >
      <div className="form">
        {!area ? (
          <Field label="Common area">
            {(p) => (
              <Select {...p} value={commonAreaId} onChange={(e) => setCommonAreaId(e.target.value)}>
                <option value="">Choose an area</option>
                {(areas.data?.data ?? []).map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.code} · {a.nameEn}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        ) : null}
        <FileUpload purpose="fitout_photo" label={`Add a photo (${photos.length}/10)`} disabled={photos.length >= 10} onUploaded={(fileId) => setPhotos((list) => [...list, fileId])} />
        <Field label="Note (the unit reads it)">{(p) => <Textarea {...p} rows={3} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} />}</Field>
        <ErrorAlert error={record.error} />
      </div>
    </Dialog>
  );
}

function RaiseClaim({ permitId, onClose }: { permitId: string; onClose: () => void }) {
  const toast = useToast();
  const [reasonCode, setReasonCode] = useState<string>(REASON_CODES.damageClaim[0]);
  const [description, setDescription] = useState('');
  const [amount, setAmount] = useState('');
  const [photos, setPhotos] = useState<string[]>([]);
  const raise = useAction(
    () =>
      unwrap(
        api.POST('/api/v1/staff/unit-permits/{id}/damage-claims', {
          params: { path: { id: permitId } },
          body: { reasonCode, description, amount, photoFileIds: photos },
        }),
      ),
    {
      invalidate: [fitOutKey(permitId)],
      onDone: () => {
        toast.show('Claimed. The requester and the primary were told; they may appeal for 14 days.');
        onClose();
      },
    },
  );
  return (
    <Dialog
      open
      onClose={onClose}
      title="Claim damage the works did"
      description="Settled after the unit’s 14 days to appeal, from the works deposit first and the rest as an invoice of the unit’s."
      onSubmit={() => raise.mutate()}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" loading={raise.isPending} disabled={!photos.length}>
            Claim
          </Button>
        </>
      }
    >
      <div className="form">
        <Field label="What for">
          {(p) => (
            <Select {...p} value={reasonCode} onChange={(e) => setReasonCode(e.target.value)}>
              {REASON_CODES.damageClaim.map((c) => (
                <option key={c} value={c}>
                  {humanize(c)}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="What was damaged (the unit reads it)">{(p) => <Textarea {...p} rows={3} maxLength={1000} value={description} onChange={(e) => setDescription(e.target.value)} />}</Field>
        <Field label="Amount (EGP)">{(p) => <Input {...p} inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />}</Field>
        <FileUpload purpose="fitout_photo" label={`Add a photo (${photos.length}/6)`} disabled={photos.length >= 6} onUploaded={(fileId) => setPhotos((list) => [...list, fileId])} />
        <ErrorAlert error={raise.error} />
      </div>
    </Dialog>
  );
}

/**
 * A works permit's fit-out (ADR 0074): its deposit, what blocks its
 * certificate, its drawings, debris removals, the common areas before and
 * after the works, and its damage claims, with the management's actions.
 */
export function FitOutCards({ permitId, unitId }: { permitId: string; unitId: string }) {
  const toast = useToast();
  const fitOut = useQuery({
    queryKey: fitOutKey(permitId),
    queryFn: () => unwrap(api.GET('/api/v1/staff/unit-permits/{id}/fit-out', { params: { path: { id: permitId } } })),
  });
  const [dialog, setDialog] = useState<null | 'deposit' | 'debris' | 'before' | 'claim'>(null);
  const [after, setAfter] = useState<Area | null>(null);
  const [cancelling, setCancelling] = useState<Slot | null>(null);
  const [withdrawing, setWithdrawing] = useState<Claim | null>(null);
  const [settling, setSettling] = useState<Claim | null>(null);
  const refresh = { invalidate: [fitOutKey(permitId)] };
  const done = useAction(
    (slotId: string) =>
      unwrap(api.POST('/api/v1/staff/unit-permits/{id}/debris-slots/{slotId}/done', { params: { path: { id: permitId, slotId } } })),
    { ...refresh, onDone: () => toast.show('Marked done.') },
  );
  const cancel = useAction(
    (v: { slotId: string; reasonCode: string }) =>
      unwrap(
        api.POST('/api/v1/staff/unit-permits/{id}/debris-slots/{slotId}/cancel', {
          params: { path: { id: permitId, slotId: v.slotId } },
          body: { reasonCode: v.reasonCode },
        }),
      ),
    { ...refresh, onDone: () => setCancelling(null) },
  );
  const decide = useAction(
    (v: { claimId: string; decision: 'upheld' | 'accepted' }) =>
      unwrap(
        api.POST('/api/v1/staff/unit-permits/{id}/damage-claims/{claimId}/appeal-decision', {
          params: { path: { id: permitId, claimId: v.claimId } },
          body: { decision: v.decision },
        }),
      ),
    { ...refresh, onDone: () => toast.show('Decided. The appellant was told.') },
  );
  const withdraw = useAction(
    (v: { claimId: string; reasonCode: string }) =>
      unwrap(
        api.POST('/api/v1/staff/unit-permits/{id}/damage-claims/{claimId}/withdraw', {
          params: { path: { id: permitId, claimId: v.claimId } },
          body: { reasonCode: v.reasonCode },
        }),
      ),
    { ...refresh, onDone: () => setWithdrawing(null) },
  );
  const settle = useAction(
    (claimId: string) =>
      unwrap(api.POST('/api/v1/staff/unit-permits/{id}/damage-claims/{claimId}/settle', { params: { path: { id: permitId, claimId } } })),
    { ...refresh, onDone: () => toast.show('Settled: from the deposit first, the rest as an invoice of the unit’s.') },
  );
  const f = fitOut.data;
  return (
    <QueryState query={fitOut}>
      {f ? (
        <>
          {f.certificateBlockedBy ? (
            <Alert tone="warn">
              The completion certificate waits for {f.certificateBlockedBy.violations} open violation(s) and {f.certificateBlockedBy.claims} open damage claim(s).
            </Alert>
          ) : null}
          <Card>
            <CardHeader
              title="Finishing-works deposit"
              actions={!f.deposit ? <Button onClick={() => setDialog('deposit')}>Record the deposit</Button> : null}
            />
            <CardBody>
              {f.deposit ? (
                <p>
                  {f.deposit.number}: {f.deposit.amount} EGP received, {f.deposit.held} EGP held.
                </p>
              ) : (
                <p className="t-secondary">
                  None recorded for this permit.{f.depositRequired ? ' The compound approves works only once their deposit holds money.' : ''}
                </p>
              )}
            </CardBody>
          </Card>
          <Card flush>
            <CardHeader title={`Drawings (${f.drawings.length})`} />
            <DataTable
              rows={f.drawings}
              rowKey={(d) => d.id}
              empty="No drawing joined"
              columns={[
                { key: 'a', header: 'Joined', cell: (d) => formatDateTime(d.addedAt) },
                { key: 'f', header: '', cell: (d) => (d.file ? <a href={d.file.url} target="_blank" rel="noreferrer">Open</a> : <span className="t-secondary">Gone</span>) },
              ]}
            />
          </Card>
          <Card flush>
            <CardHeader title="Debris removals" actions={<Button onClick={() => setDialog('debris')}>Schedule</Button>} />
            <DataTable<Slot>
              rows={f.debrisSlots}
              rowKey={(d) => d.id}
              empty="None scheduled"
              columns={[
                { key: 'd', header: 'Day', cell: (d) => d.day },
                { key: 'w', header: 'Window', cell: (d) => `${d.window.from}–${d.window.to}` },
                { key: 'b', header: 'By', cell: (d) => humanize(d.scheduledSide) },
                { key: 's', header: 'Status', cell: (d) => <StatusBadge status={d.status} /> },
                {
                  key: 'x',
                  header: '',
                  cell: (d) =>
                    d.status === 'scheduled' ? (
                      <span className="row" style={{ gap: 8 }}>
                        <Button size="sm" onClick={() => done.mutate(d.id)} loading={done.isPending}>
                          Done
                        </Button>
                        <Button size="sm" onClick={() => setCancelling(d)}>
                          Call off
                        </Button>
                      </span>
                    ) : null,
                },
              ]}
            />
            <ErrorAlert error={done.error} />
          </Card>
          <Card flush>
            <CardHeader title="Common areas before and after" actions={<Button onClick={() => setDialog('before')}>Record before</Button>} />
            <DataTable<Area>
              rows={f.areas}
              rowKey={(a) => a.commonArea.id}
              empty="No area recorded"
              columns={[
                { key: 'n', header: 'Area', cell: (a) => `${a.commonArea.code} · ${a.commonArea.nameEn}` },
                { key: 'b', header: 'Before', cell: (a) => (a.before ? `${a.before.photos.length} photo(s), ${formatDateTime(a.before.recordedAt)}` : '—') },
                {
                  key: 'a',
                  header: 'After',
                  cell: (a) =>
                    a.after ? (
                      `${a.after.photos.length} photo(s), ${formatDateTime(a.after.recordedAt)}`
                    ) : (
                      <Button size="sm" onClick={() => setAfter(a)}>
                        Record after
                      </Button>
                    ),
                },
              ]}
            />
          </Card>
          <Card flush>
            <CardHeader title="Damage claims" actions={<Button onClick={() => setDialog('claim')}>Claim damage</Button>} />
            <DataTable<Claim>
              rows={f.claims}
              rowKey={(c) => c.id}
              empty="No claim"
              columns={[
                { key: 'n', header: 'Claim', cell: (c) => <span className="t-mono">{c.number}</span> },
                { key: 'r', header: 'For', cell: (c) => humanize(c.reasonCode) },
                { key: 'm', header: 'EGP', cell: (c) => c.amount },
                { key: 's', header: 'Status', cell: (c) => <StatusBadge status={c.status} /> },
                {
                  key: 'o',
                  header: 'Outcome',
                  cell: (c) =>
                    c.settlement
                      ? `${c.settlement.deducted} from the deposit, ${c.settlement.charged} invoiced`
                      : c.withdrawn
                        ? humanize(c.withdrawn.reason)
                        : c.appeal && !c.appeal.decision
                          ? `Appealed: ${c.appeal.text ?? '(words gone)'}`
                          : `Appeal until ${formatDateTime(c.appealUntil)}`,
                },
                {
                  key: 'x',
                  header: '',
                  cell: (c) =>
                    c.status === 'under_appeal' ? (
                      <span className="row" style={{ gap: 8 }}>
                        <Button size="sm" onClick={() => decide.mutate({ claimId: c.id, decision: 'upheld' })}>
                          Uphold
                        </Button>
                        <Button size="sm" onClick={() => decide.mutate({ claimId: c.id, decision: 'accepted' })}>
                          Accept appeal
                        </Button>
                      </span>
                    ) : c.status === 'open' ? (
                      <span className="row" style={{ gap: 8 }}>
                        <Button size="sm" variant="primary" onClick={() => setSettling(c)}>
                          Settle
                        </Button>
                        <Button size="sm" onClick={() => setWithdrawing(c)}>
                          Withdraw
                        </Button>
                      </span>
                    ) : null,
                },
              ]}
            />
            <ErrorAlert error={decide.error ?? settle.error} />
          </Card>
          {dialog === 'deposit' ? <RecordDeposit permitId={permitId} unitId={unitId} onClose={() => setDialog(null)} /> : null}
          {dialog === 'debris' ? <ScheduleDebris permitId={permitId} onClose={() => setDialog(null)} /> : null}
          {dialog === 'before' ? <RecordArea permitId={permitId} phase="before" onClose={() => setDialog(null)} /> : null}
          {after ? <RecordArea permitId={permitId} phase="after" area={after} onClose={() => setAfter(null)} /> : null}
          {dialog === 'claim' ? <RaiseClaim permitId={permitId} onClose={() => setDialog(null)} /> : null}
          {settling ? (
            <StepUpDialog
              title="Confirm it is you"
              description={`Settling ${settling.number} takes money from the works deposit: we sent a code to your email.`}
              onClose={() => setSettling(null)}
              onVerified={() => {
                const id = settling.id;
                setSettling(null);
                settle.mutate(id);
              }}
            />
          ) : null}
          <ReasonCodeDialog
            open={cancelling !== null}
            onClose={() => setCancelling(null)}
            title="Call off this debris removal?"
            codes={REASON_CODES.debrisSlotCancel}
            confirmLabel="Call off"
            danger
            pending={cancel.isPending}
            error={<ErrorAlert error={cancel.error} />}
            onConfirm={(reasonCode) => cancelling && cancel.mutate({ slotId: cancelling.id, reasonCode })}
          />
          <ReasonCodeDialog
            open={withdrawing !== null}
            onClose={() => setWithdrawing(null)}
            title={`Withdraw ${withdrawing?.number ?? 'this claim'}?`}
            description="The requester and the primary are told the reason."
            codes={REASON_CODES.damageClaimWithdraw.filter((c) => c !== 'appeal_accepted')}
            confirmLabel="Withdraw"
            danger
            pending={withdraw.isPending}
            error={<ErrorAlert error={withdraw.error} />}
            onConfirm={(reasonCode) => withdrawing && withdraw.mutate({ claimId: withdrawing.id, reasonCode })}
          />
        </>
      ) : null}
    </QueryState>
  );
}
