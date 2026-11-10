'use client';

import { fieldError, REASON_CODES, unwrap, type Schema } from '@jiwar/api';
import { ErrorAlert, QueryState, useAction } from '@jiwar/api/react';
import { useFormat, useT } from '@jiwar/i18n';
import { Alert, Button, ConfirmDialog, DataTable, Dialog, Field, Input, ReasonCodeDialog, ReasonDialog, Select, Textarea, useCommonT, useToast } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { FileUpload } from '@/components/file-upload';
import { api } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';
import { keys } from '@/lib/queries';
import ar from '@/messages/ar/workers';
import en from '@/messages/en/workers';

type Engagement = Schema<'EngagementDetailView'>;
type Code = Schema<'AccessCodeView'>;
type Day = Schema<'AttendanceDayView'>;
type Open = 'birth' | 'ban' | 'unban' | 'underage' | 'incident' | 'reissue' | 'attendance' | null;

/** The browser's local day, `YYYY-MM-DD` (not UTC's: before 03:00 in Cairo that is yesterday). */
const isoDay = (d: Date) => d.toLocaleDateString('en-CA');

function Attendance({ engagementId }: { engagementId: string }) {
  const t = useT(en, ar);
  const c = useCommonT();
  const f = useFormat();
  const [from, setFrom] = useState(() => isoDay(new Date(Date.now() - 29 * 86_400_000)));
  const [to, setTo] = useState(() => isoDay(new Date()));
  const attendance = useQuery({
    queryKey: [...keys.engagement(engagementId), 'attendance', from, to],
    queryFn: () =>
      unwrap(api.GET('/api/v1/worker-engagements/{id}/attendance', { params: { path: { id: engagementId }, query: { from, to } } })),
  });
  return (
    <div className="stack">
      <div className="form__row">
        <Field label={c('from')}>{(p) => <Input {...p} type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} />}</Field>
        <Field label={c('to')}>{(p) => <Input {...p} type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} />}</Field>
      </div>
      <QueryState query={attendance} rows={3}>
        <p className="t-secondary">
          {t('daysAtGate', { days: attendance.data?.totalDays ?? 0 })}
        </p>
        <DataTable<Day>
          rows={attendance.data?.days}
          rowKey={(d) => d.date}
          empty={t('noEntry')}
          columns={[
            { key: 'date', header: t('day'), cell: (d) => f.day(d.date) },
            { key: 'in', header: t('firstIn'), cell: (d) => f.time(d.firstIn) },
            {
              key: 'out',
              header: t('lastOut'),
              cell: (d) =>
                d.lastOut ? (
                  <span>
                    {f.time(d.lastOut)}
                    {d.unconfirmedExit ? <span className="t-secondary">{t('assumedExit')}</span> : null}
                  </span>
                ) : (
                  <span className="t-secondary">{t('stillInside')}</span>
                ),
            },
            { key: 'full', header: t('fullDay'), cell: (d) => (d.fullDay ? c('yes') : c('no')) },
          ]}
        />
      </QueryState>
    </div>
  );
}

/**
 * Management's actions on a worker beyond the review (ADR 0017, 0022), each
 * shown to a role holding its permission: their photo, a corrected birth
 * date, a ban, an underage report, a lost or confiscated card, a new code,
 * and their attendance at the gate.
 */
export function WorkerActions({ engagement, onCode }: { engagement: Engagement; onCode: (code: Code) => void }) {
  const t = useT(en, ar);
  const c = useCommonT();
  const f = useFormat();
  const toast = useToast();
  const { can } = usePermissions();
  const [open, setOpen] = useState<Open>(null);
  const [birthDate, setBirthDate] = useState(engagement.worker.birthDate);
  const [incidentType, setIncidentType] = useState<'lost' | 'confiscated'>('lost');
  const [note, setNote] = useState('');
  const worker = engagement.worker;
  const at = { path: { id: worker.id } };
  const refresh = [keys.engagementsAll, ['compliance-cases'], ['card-incidents']];
  const live = engagement.status === 'active' || engagement.status === 'suspended';

  const close = () => {
    setOpen(null);
    setBirthDate(worker.birthDate);
    setIncidentType('lost');
    setNote('');
    for (const a of [correct, ban, unban, underage, incident, reissue]) a.reset();
  };
  const options = (text: string) => ({
    invalidate: refresh,
    onDone: () => {
      toast.show(text);
      close();
    },
  });
  type Reason = { reasonCode: string; reason: string };

  const photo = useAction(
    (fileId: string) => unwrap(api.PUT('/api/v1/workers/{id}/photo', { params: at, body: { fileId } })),
    { invalidate: refresh, onDone: () => toast.show(t('photoSaved')) },
  );
  const correct = useAction(
    () => unwrap(api.POST('/api/v1/workers/{id}/birth-date', { params: at, body: { birthDate } })),
    options(t('birthCorrected')),
  );
  const ban = useAction((reason: Reason) => unwrap(api.POST('/api/v1/workers/{id}/ban', { params: at, body: reason })), options(t('banned', { name: worker.fullName })));
  const unban = useAction(() => unwrap(api.POST('/api/v1/workers/{id}/unban', { params: at })), options(t('unbanned')));
  const underage = useAction(
    (reason: Reason) => unwrap(api.POST('/api/v1/workers/{id}/report-underage', { params: at, body: reason })),
    options(t('reportedUnderage')),
  );
  const incident = useAction(
    () =>
      unwrap(
        api.POST('/api/v1/worker-engagements/{id}/card-incident', {
          params: { path: { id: engagement.id } },
          body: { type: incidentType, ...(note.trim() ? { note: note.trim() } : {}) },
        }),
      ),
    {
      invalidate: refresh,
      onDone: (result) => {
        close();
        onCode(result);
      },
    },
  );
  const reissue = useAction(
    (reasonCode: string) =>
      unwrap(api.POST('/api/v1/worker-engagements/{id}/reissue-code', { params: { path: { id: engagement.id } }, body: { reasonCode } })),
    {
      invalidate: refresh,
      onDone: (result) => {
        close();
        onCode(result);
      },
    },
  );

  const any =
    can('workers.review') || can('workers.ban') || can('workers.compliance') || (live && can('workers.incidents'));
  if (!any) return null;

  return (
    <div className="stack stack--sm" style={{ borderTop: '1px solid var(--hairline-soft)', paddingTop: 16 }}>
      <strong>{t('moreAbout')}</strong>
      {can('workers.review') ? (
        <FileUpload purpose="worker_photo" label={worker.photo ? t('replacePhoto') : t('addPhoto')} disabled={photo.isPending} onUploaded={(fileId) => photo.mutateAsync(fileId).then(() => undefined)} />
      ) : null}
      <ErrorAlert error={photo.error} />
      <span className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
        {can('workers.review') ? (
          <Button size="sm" onClick={() => setOpen('attendance')}>
            {t('attendance')}
          </Button>
        ) : null}
        {can('workers.review') && worker.idDocumentType === 'passport' ? (
          <Button size="sm" onClick={() => setOpen('birth')}>
            {t('correctBirth')}
          </Button>
        ) : null}
        {live && can('workers.review') ? (
          <Button size="sm" onClick={() => setOpen('reissue')}>
            {t('newCode')}
          </Button>
        ) : null}
        {live && can('workers.incidents') ? (
          <Button size="sm" onClick={() => setOpen('incident')}>
            {t('lostCard')}
          </Button>
        ) : null}
        {can('workers.compliance') ? (
          <Button size="sm" onClick={() => setOpen('underage')}>
            {t('reportUnderage')}
          </Button>
        ) : null}
        {can('workers.ban') ? (
          worker.banned ? (
            <Button size="sm" onClick={() => setOpen('unban')}>
              {t('liftBan')}
            </Button>
          ) : (
            <Button size="sm" variant="danger" onClick={() => setOpen('ban')}>
              {t('ban')}
            </Button>
          )
        ) : null}
      </span>

      <Dialog open={open === 'attendance'} wide onClose={close} title={t('attendanceTitle', { name: worker.fullName })} description={t('attendanceDescription', { unit: engagement.unitCode })} footer={<Button onClick={close}>{c('close')}</Button>}>
        {open === 'attendance' ? <Attendance engagementId={engagement.id} /> : null}
      </Dialog>

      <Dialog
        open={open === 'birth'}
        onClose={close}
        title={t('birthTitle', { name: worker.fullName })}
        description={t('birthDescription')}
        onSubmit={() => birthDate !== worker.birthDate && correct.mutate()}
        footer={
          <>
            <Button onClick={close}>{c('cancel')}</Button>
            <Button type="submit" variant="primary" loading={correct.isPending} disabled={birthDate === worker.birthDate || birthDate === ''}>
              {t('saveBirth')}
            </Button>
          </>
        }
      >
        <div className="form">
          <Field label={t('birthDate')} hint={t('birthNow', { date: f.day(worker.birthDate) })} error={fieldError(correct.error, 'birthDate')}>
            {(p) => <Input {...p} type="date" max={isoDay(new Date())} value={birthDate} onChange={(e) => setBirthDate(e.target.value)} />}
          </Field>
          <ErrorAlert error={correct.error} />
        </div>
      </Dialog>

      <ReasonDialog
        open={open === 'ban'}
        onClose={close}
        title={t('banTitle', { name: worker.fullName })}
        description={t('banDescription')}
        codes={REASON_CODES.workerBan}
        textLabel={t('banTextLabel')}
        textHint={t('banTextHint')}
        confirmLabel={t('banConfirm')}
        danger
        pending={ban.isPending}
        error={<ErrorAlert error={ban.error} />}
        onConfirm={(reason) => ban.mutate(reason)}
      />
      <ConfirmDialog
        open={open === 'unban'}
        onClose={close}
        title={t('unbanTitle', { name: worker.fullName })}
        description={t('unbanDescription')}
        confirmLabel={t('liftBan')}
        pending={unban.isPending}
        error={<ErrorAlert error={unban.error} />}
        onConfirm={() => unban.mutate()}
      />
      <ReasonDialog
        open={open === 'underage'}
        onClose={close}
        title={t('underageTitle', { name: worker.fullName })}
        description={t('underageDescription')}
        codes={REASON_CODES.complianceReport}
        textLabel={t('underageTextLabel')}
        textHint={t('underageTextHint')}
        confirmLabel={t('underageConfirm')}
        danger
        pending={underage.isPending}
        error={<ErrorAlert error={underage.error} />}
        onConfirm={(reason) => underage.mutate(reason)}
      />
      <Dialog
        open={open === 'incident'}
        onClose={close}
        title={t('cardTitle', { name: worker.fullName })}
        description={t('cardDescription')}
        onSubmit={() => incident.mutate()}
        footer={
          <>
            <Button onClick={close}>{c('cancel')}</Button>
            <Button type="submit" variant="primary" loading={incident.isPending}>
              {t('fileAndIssue')}
            </Button>
          </>
        }
      >
        <div className="form">
          <Field label={t('whatHappened')}>
            {(p) => (
              <Select {...p} value={incidentType} onChange={(e) => setIncidentType(e.target.value as 'lost' | 'confiscated')}>
                <option value="lost">{t('card.lost')}</option>
                <option value="confiscated">{t('card.confiscated')}</option>
              </Select>
            )}
          </Field>
          <Field label={c('note')} hint={t('noteHint')}>
            {(p) => <Textarea {...p} maxLength={1000} value={note} onChange={(e) => setNote(e.target.value)} />}
          </Field>
          {incidentType === 'confiscated' ? <Alert tone="warn">{t('confiscatedWarning')}</Alert> : null}
          <ErrorAlert error={incident.error} />
        </div>
      </Dialog>
      <ReasonCodeDialog
        open={open === 'reissue'}
        onClose={close}
        title={t('reissueTitle', { name: worker.fullName })}
        description={t('reissueDescription')}
        codes={REASON_CODES.cardReissue}
        confirmLabel={t('reissueConfirm')}
        pending={reissue.isPending}
        error={<ErrorAlert error={reissue.error} />}
        onConfirm={(reasonCode) => reissue.mutate(reasonCode)}
      />
    </div>
  );
}
