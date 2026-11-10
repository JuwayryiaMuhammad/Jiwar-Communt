'use client';

import { REASON_CODES, unwrap, type Schema } from '@jiwar/api';
import { ErrorAlert, QueryState, useAction } from '@jiwar/api/react';
import { useFormat, useLocale, useT } from '@jiwar/i18n';
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
  useCommonT,
  useLabel,
  useToast,
} from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { FileUpload } from '@/components/file-upload';
import { StepUpDialog } from '@/components/step-up-dialog';
import { api } from '@/lib/api';
import { keys } from '@/lib/queries';
import ar from '@/messages/ar/places-fit-out';
import en from '@/messages/en/places-fit-out';

type FitOut = Schema<'FitOutView'>;
type Slot = FitOut['debrisSlots'][number];
type Claim = FitOut['claims'][number];
type Area = FitOut['areas'][number];

/** Under the permits' key, so a decision on the permit refreshes it too. */
export const fitOutKey = (id: string) => [...keys.permitsAll, 'fit-out', id] as const;

const today = () => new Date().toISOString().slice(0, 10);

/** An area's name in the page's language. */
function useAreaName() {
  const { locale } = useLocale();
  return (a: { nameEn: string; nameAr?: string | null }) => (locale === 'ar' && a.nameAr ? a.nameAr : a.nameEn);
}

function RecordDeposit({ permitId, unitId, onClose }: { permitId: string; unitId: string; onClose: () => void }) {
  const t = useT(en, ar);
  const c = useCommonT();
  const label = useLabel();
  const toast = useToast();
  const [amount, setAmount] = useState('');
  const [receivedOn, setReceivedOn] = useState(today());
  const [method, setMethod] = useState<'cash' | 'bank_transfer' | 'cheque'>('cash');
  const record = useAction(
    async () => {
      const unit = await unwrap(api.GET('/api/v1/units/{id}', { params: { path: { id: unitId } } }));
      const primary = unit.occupants?.find((o) => o.isPrimary);
      if (!primary) throw new Error(t('deposit.noPrimary'));
      return unwrap(
        api.POST('/api/v1/staff/deposits', {
          body: { occupancyId: primary.occupancyId, kind: 'finishing_works', amount, receivedOn, method, permitId },
        }),
      );
    },
    {
      invalidate: [fitOutKey(permitId)],
      onDone: () => {
        toast.show(t('deposit.recorded'));
        onClose();
      },
    },
  );
  return (
    <Dialog
      open
      onClose={onClose}
      title={t('deposit.title')}
      description={t('deposit.description')}
      onSubmit={() => record.mutate()}
      footer={
        <>
          <Button onClick={onClose}>{c('cancel')}</Button>
          <Button type="submit" variant="primary" loading={record.isPending}>
            {t('record')}
          </Button>
        </>
      }
    >
      <div className="form">
        <Field label={t('amountEgp')}>{(p) => <Input {...p} inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />}</Field>
        <Field label={t('receivedOn')}>{(p) => <Input {...p} type="date" value={receivedOn} onChange={(e) => setReceivedOn(e.target.value)} />}</Field>
        <Field label={t('method')}>
          {(p) => (
            <Select {...p} value={method} onChange={(e) => setMethod(e.target.value as 'cash' | 'bank_transfer' | 'cheque')}>
              {(['cash', 'bank_transfer', 'cheque'] as const).map((m) => (
                <option key={m} value={m}>
                  {label(m)}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <ErrorAlert error={record.error} />
      </div>
    </Dialog>
  );
}

function ScheduleDebris({ permitId, onClose }: { permitId: string; onClose: () => void }) {
  const t = useT(en, ar);
  const c = useCommonT();
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
        toast.show(t('debris.scheduled'));
        onClose();
      },
    },
  );
  return (
    <Dialog
      open
      onClose={onClose}
      title={t('debris.title')}
      description={t('debris.description')}
      onSubmit={() => schedule.mutate()}
      footer={
        <>
          <Button onClick={onClose}>{c('cancel')}</Button>
          <Button type="submit" variant="primary" loading={schedule.isPending}>
            {t('schedule')}
          </Button>
        </>
      }
    >
      <div className="form">
        <Field label={t('day')}>{(p) => <Input {...p} type="date" value={day} onChange={(e) => setDay(e.target.value)} />}</Field>
        <Field label={c('from')}>{(p) => <Input {...p} type="time" value={from} onChange={(e) => setFrom(e.target.value)} />}</Field>
        <Field label={c('to')}>{(p) => <Input {...p} type="time" value={to} onChange={(e) => setTo(e.target.value)} />}</Field>
        <ErrorAlert error={schedule.error} />
      </div>
    </Dialog>
  );
}

function RecordArea({ permitId, phase, area, onClose }: { permitId: string; phase: 'before' | 'after'; area?: Area; onClose: () => void }) {
  const t = useT(en, ar);
  const c = useCommonT();
  const name = useAreaName();
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
        toast.show(phase === 'before' ? t('area.recordedBefore') : t('area.recordedAfter'));
        onClose();
      },
    },
  );
  return (
    <Dialog
      open
      onClose={onClose}
      title={
        phase === 'before'
          ? t('area.beforeTitle')
          : area
            ? t('area.afterTitle', { area: name(area.commonArea) })
            : t('area.afterTitleAnon')
      }
      description={t('area.description')}
      onSubmit={() => record.mutate()}
      footer={
        <>
          <Button onClick={onClose}>{c('cancel')}</Button>
          <Button type="submit" variant="primary" loading={record.isPending} disabled={!commonAreaId || !photos.length}>
            {t('record')}
          </Button>
        </>
      }
    >
      <div className="form">
        {!area ? (
          <Field label={t('commonArea')}>
            {(p) => (
              <Select {...p} value={commonAreaId} onChange={(e) => setCommonAreaId(e.target.value)}>
                <option value="">{t('chooseArea')}</option>
                {(areas.data?.data ?? []).map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.code} · {name(a)}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        ) : null}
        <FileUpload
          purpose="fitout_photo"
          label={t('addPhotoCount', { count: photos.length, max: 10 })}
          disabled={photos.length >= 10}
          onUploaded={(fileId) => setPhotos((list) => [...list, fileId])}
        />
        <Field label={t('noteForUnit')}>{(p) => <Textarea {...p} rows={3} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} />}</Field>
        <ErrorAlert error={record.error} />
      </div>
    </Dialog>
  );
}

function RaiseClaim({ permitId, onClose }: { permitId: string; onClose: () => void }) {
  const t = useT(en, ar);
  const c = useCommonT();
  const label = useLabel();
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
        toast.show(t('claim.claimed'));
        onClose();
      },
    },
  );
  return (
    <Dialog
      open
      onClose={onClose}
      title={t('claim.title')}
      description={t('claim.description')}
      onSubmit={() => raise.mutate()}
      footer={
        <>
          <Button onClick={onClose}>{c('cancel')}</Button>
          <Button type="submit" variant="primary" loading={raise.isPending} disabled={!photos.length}>
            {t('claim')}
          </Button>
        </>
      }
    >
      <div className="form">
        <Field label={t('whatFor')}>
          {(p) => (
            <Select {...p} value={reasonCode} onChange={(e) => setReasonCode(e.target.value)}>
              {REASON_CODES.damageClaim.map((code) => (
                <option key={code} value={code}>
                  {label(code)}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label={t('whatDamaged')}>
          {(p) => <Textarea {...p} rows={3} maxLength={1000} value={description} onChange={(e) => setDescription(e.target.value)} />}
        </Field>
        <Field label={t('amountEgp')}>{(p) => <Input {...p} inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />}</Field>
        <FileUpload
          purpose="fitout_photo"
          label={t('addPhotoCount', { count: photos.length, max: 6 })}
          disabled={photos.length >= 6}
          onUploaded={(fileId) => setPhotos((list) => [...list, fileId])}
        />
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
  const t = useT(en, ar);
  const c = useCommonT();
  const fmt = useFormat();
  const label = useLabel();
  const name = useAreaName();
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
    { ...refresh, onDone: () => toast.show(t('markedDone')) },
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
    { ...refresh, onDone: () => toast.show(t('decided')) },
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
    { ...refresh, onDone: () => toast.show(t('settled')) },
  );
  const f = fitOut.data;
  const photosAt = (r: { photos: unknown[]; recordedAt: string }) => t('photosAt', { count: r.photos.length, when: fmt.dateTime(r.recordedAt) });
  return (
    <QueryState query={fitOut}>
      {f ? (
        <>
          {f.certificateBlockedBy ? (
            <Alert tone="warn">
              {t('blocked', { violations: f.certificateBlockedBy.violations, claims: f.certificateBlockedBy.claims })}
            </Alert>
          ) : null}
          <Card>
            <CardHeader
              title={t('depositTitle')}
              actions={!f.deposit ? <Button onClick={() => setDialog('deposit')}>{t('recordDeposit')}</Button> : null}
            />
            <CardBody>
              {f.deposit ? (
                <p>{t('depositLine', { number: f.deposit.number, amount: fmt.money(f.deposit.amount), held: fmt.money(f.deposit.held) })}</p>
              ) : (
                <p className="t-secondary">{f.depositRequired ? t('noDepositRequired') : t('noDeposit')}</p>
              )}
            </CardBody>
          </Card>
          <Card flush>
            <CardHeader title={t('drawings', { count: f.drawings.length })} />
            <DataTable
              rows={f.drawings}
              rowKey={(d) => d.id}
              empty={t('noDrawing')}
              columns={[
                { key: 'a', header: t('col.joined'), cell: (d) => fmt.dateTime(d.addedAt) },
                {
                  key: 'f',
                  header: '',
                  cell: (d) =>
                    d.file ? (
                      <a href={d.file.url} target="_blank" rel="noreferrer">
                        {c('open')}
                      </a>
                    ) : (
                      <span className="t-secondary">{t('gone')}</span>
                    ),
                },
              ]}
            />
          </Card>
          <Card flush>
            <CardHeader title={t('debris')} actions={<Button onClick={() => setDialog('debris')}>{t('schedule')}</Button>} />
            <DataTable<Slot>
              rows={f.debrisSlots}
              rowKey={(d) => d.id}
              empty={t('noneScheduled')}
              columns={[
                { key: 'd', header: t('col.day'), cell: (d) => fmt.day(d.day) },
                { key: 'w', header: t('col.window'), cell: (d) => `${d.window.from}–${d.window.to}` },
                { key: 'b', header: t('col.by'), cell: (d) => label(d.scheduledSide) },
                { key: 's', header: t('col.status'), cell: (d) => <StatusBadge status={d.status} /> },
                {
                  key: 'x',
                  header: '',
                  cell: (d) =>
                    d.status === 'scheduled' ? (
                      <span className="row" style={{ gap: 8 }}>
                        <Button size="sm" onClick={() => done.mutate(d.id)} loading={done.isPending}>
                          {t('done')}
                        </Button>
                        <Button size="sm" onClick={() => setCancelling(d)}>
                          {t('callOff')}
                        </Button>
                      </span>
                    ) : null,
                },
              ]}
            />
            <ErrorAlert error={done.error} />
          </Card>
          <Card flush>
            <CardHeader title={t('areas')} actions={<Button onClick={() => setDialog('before')}>{t('recordBefore')}</Button>} />
            <DataTable<Area>
              rows={f.areas}
              rowKey={(a) => a.commonArea.id}
              empty={t('noArea')}
              columns={[
                { key: 'n', header: t('col.area'), cell: (a) => `${a.commonArea.code} · ${name(a.commonArea)}` },
                { key: 'b', header: t('col.before'), cell: (a) => (a.before ? photosAt(a.before) : '—') },
                {
                  key: 'a',
                  header: t('col.after'),
                  cell: (a) =>
                    a.after ? (
                      photosAt(a.after)
                    ) : (
                      <Button size="sm" onClick={() => setAfter(a)}>
                        {t('recordAfter')}
                      </Button>
                    ),
                },
              ]}
            />
          </Card>
          <Card flush>
            <CardHeader title={t('claims')} actions={<Button onClick={() => setDialog('claim')}>{t('claimDamage')}</Button>} />
            <DataTable<Claim>
              rows={f.claims}
              rowKey={(cl) => cl.id}
              empty={t('noClaim')}
              columns={[
                { key: 'n', header: t('col.claim'), cell: (cl) => <span className="t-mono">{cl.number}</span> },
                { key: 'r', header: t('col.for'), cell: (cl) => label(cl.reasonCode) },
                { key: 'm', header: t('col.amount'), cell: (cl) => fmt.money(cl.amount) },
                { key: 's', header: t('col.status'), cell: (cl) => <StatusBadge status={cl.status} /> },
                {
                  key: 'o',
                  header: t('col.outcome'),
                  cell: (cl) =>
                    cl.settlement
                      ? t('outcome.settled', { deducted: fmt.money(cl.settlement.deducted), charged: fmt.money(cl.settlement.charged) })
                      : cl.withdrawn
                        ? label(cl.withdrawn.reason)
                        : cl.appeal && !cl.appeal.decision
                          ? cl.appeal.text
                            ? t('outcome.appealed', { text: cl.appeal.text })
                            : t('outcome.appealedGone')
                          : t('outcome.appealUntil', { when: fmt.dateTime(cl.appealUntil) }),
                },
                {
                  key: 'x',
                  header: '',
                  cell: (cl) =>
                    cl.status === 'under_appeal' ? (
                      <span className="row" style={{ gap: 8 }}>
                        <Button size="sm" onClick={() => decide.mutate({ claimId: cl.id, decision: 'upheld' })}>
                          {t('uphold')}
                        </Button>
                        <Button size="sm" onClick={() => decide.mutate({ claimId: cl.id, decision: 'accepted' })}>
                          {t('acceptAppeal')}
                        </Button>
                      </span>
                    ) : cl.status === 'open' ? (
                      <span className="row" style={{ gap: 8 }}>
                        <Button size="sm" variant="primary" onClick={() => setSettling(cl)}>
                          {t('settle')}
                        </Button>
                        <Button size="sm" onClick={() => setWithdrawing(cl)}>
                          {t('withdraw')}
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
              title={t('stepUpTitle')}
              description={t('stepUpDescription', { number: settling.number })}
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
            title={t('callOffTitle')}
            codes={REASON_CODES.debrisSlotCancel}
            confirmLabel={t('callOff')}
            danger
            pending={cancel.isPending}
            error={<ErrorAlert error={cancel.error} />}
            onConfirm={(reasonCode) => cancelling && cancel.mutate({ slotId: cancelling.id, reasonCode })}
          />
          <ReasonCodeDialog
            open={withdrawing !== null}
            onClose={() => setWithdrawing(null)}
            title={withdrawing ? t('withdrawTitle', { number: withdrawing.number }) : t('withdrawTitleAnon')}
            description={t('withdrawDescription')}
            codes={REASON_CODES.damageClaimWithdraw.filter((code) => code !== 'appeal_accepted')}
            confirmLabel={t('withdraw')}
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
