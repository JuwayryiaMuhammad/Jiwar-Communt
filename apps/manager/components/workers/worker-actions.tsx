'use client';

import { fieldError, formatDate, formatDateTime, REASON_CODES, unwrap, type Schema } from '@jiwar/api';
import { ErrorAlert, QueryState, useAction } from '@jiwar/api/react';
import { Alert, Button, ConfirmDialog, DataTable, Dialog, Field, Input, ReasonCodeDialog, ReasonDialog, Select, Textarea, useToast } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { FileUpload } from '@/components/file-upload';
import { api } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';
import { keys } from '@/lib/queries';

type Engagement = Schema<'EngagementDetailView'>;
type Code = Schema<'AccessCodeView'>;
type Day = Schema<'AttendanceDayView'>;
type Open = 'birth' | 'ban' | 'unban' | 'underage' | 'incident' | 'reissue' | 'attendance' | null;

/** The browser's local day, `YYYY-MM-DD` (not UTC's: before 03:00 in Cairo that is yesterday). */
const isoDay = (d: Date) => d.toLocaleDateString('en-CA');

function Attendance({ engagementId }: { engagementId: string }) {
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
        <Field label="From">{(p) => <Input {...p} type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} />}</Field>
        <Field label="To">{(p) => <Input {...p} type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} />}</Field>
      </div>
      <QueryState query={attendance} rows={3}>
        <p className="t-secondary">
          {attendance.data?.totalDays ?? 0} day{attendance.data?.totalDays === 1 ? '' : 's'} at the gate in this period.
        </p>
        <DataTable<Day>
          rows={attendance.data?.days}
          rowKey={(d) => d.date}
          empty="No entry at the gate in this period"
          columns={[
            { key: 'date', header: 'Day', cell: (d) => formatDate(d.date) },
            { key: 'in', header: 'First in', cell: (d) => formatDateTime(d.firstIn).slice(-5) },
            {
              key: 'out',
              header: 'Last out',
              cell: (d) =>
                d.lastOut ? (
                  <span>
                    {formatDateTime(d.lastOut).slice(-5)}
                    {d.unconfirmedExit ? <span className="t-secondary"> · assumed, no exit scan</span> : null}
                  </span>
                ) : (
                  <span className="t-secondary">Still inside</span>
                ),
            },
            { key: 'full', header: 'Full day', cell: (d) => (d.fullDay ? 'Yes' : 'No') },
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
    { invalidate: refresh, onDone: () => toast.show('Photo saved. The gate sees it on the next scan.') },
  );
  const correct = useAction(
    () => unwrap(api.POST('/api/v1/workers/{id}/birth-date', { params: at, body: { birthDate } })),
    options('Birth date corrected. The next approval needs the passport checked again.'),
  );
  const ban = useAction((reason: Reason) => unwrap(api.POST('/api/v1/workers/{id}/ban', { params: at, body: reason })), options(`${worker.fullName} is banned from the compound.`));
  const unban = useAction(() => unwrap(api.POST('/api/v1/workers/{id}/unban', { params: at })), options('Ban lifted. Suspended engagements still need a resume.'));
  const underage = useAction(
    (reason: Reason) => unwrap(api.POST('/api/v1/workers/{id}/report-underage', { params: at, body: reason })),
    options('Reported. Every code of this worker has stopped and a compliance case is open.'),
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
      <strong>More about this worker</strong>
      {can('workers.review') ? (
        <FileUpload purpose="worker_photo" label={worker.photo ? 'Replace photo' : 'Add photo'} disabled={photo.isPending} onUploaded={(fileId) => photo.mutateAsync(fileId).then(() => undefined)} />
      ) : null}
      <ErrorAlert error={photo.error} />
      <span className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
        {can('workers.review') ? (
          <Button size="sm" onClick={() => setOpen('attendance')}>
            Attendance
          </Button>
        ) : null}
        {can('workers.review') && worker.idDocumentType === 'passport' ? (
          <Button size="sm" onClick={() => setOpen('birth')}>
            Correct birth date
          </Button>
        ) : null}
        {live && can('workers.review') ? (
          <Button size="sm" onClick={() => setOpen('reissue')}>
            New code
          </Button>
        ) : null}
        {live && can('workers.incidents') ? (
          <Button size="sm" onClick={() => setOpen('incident')}>
            Lost or confiscated card
          </Button>
        ) : null}
        {can('workers.compliance') ? (
          <Button size="sm" onClick={() => setOpen('underage')}>
            Report underage
          </Button>
        ) : null}
        {can('workers.ban') ? (
          worker.banned ? (
            <Button size="sm" onClick={() => setOpen('unban')}>
              Lift ban
            </Button>
          ) : (
            <Button size="sm" variant="danger" onClick={() => setOpen('ban')}>
              Ban
            </Button>
          )
        ) : null}
      </span>

      <Dialog open={open === 'attendance'} wide onClose={close} title={`${worker.fullName}'s attendance`} description={`For this engagement in unit ${engagement.unitCode}, from the gate's scans.`} footer={<Button onClick={close}>Close</Button>}>
        {open === 'attendance' ? <Attendance engagementId={engagement.id} /> : null}
      </Dialog>

      <Dialog
        open={open === 'birth'}
        onClose={close}
        title={`Correct ${worker.fullName}'s birth date`}
        description="As printed on the passport. The earlier check no longer counts, so the next approval asks for it again. If this makes the worker under 18, every active engagement is suspended at once."
        onSubmit={() => birthDate !== worker.birthDate && correct.mutate()}
        footer={
          <>
            <Button onClick={close}>Cancel</Button>
            <Button type="submit" variant="primary" loading={correct.isPending} disabled={birthDate === worker.birthDate || birthDate === ''}>
              Save birth date
            </Button>
          </>
        }
      >
        <div className="form">
          <Field label="Birth date" hint={`Now: ${formatDate(worker.birthDate)}.`} error={fieldError(correct.error, 'birthDate')}>
            {(p) => <Input {...p} type="date" max={isoDay(new Date())} value={birthDate} onChange={(e) => setBirthDate(e.target.value)} />}
          </Field>
          <ErrorAlert error={correct.error} />
        </div>
      </Dialog>

      <ReasonDialog
        open={open === 'ban'}
        onClose={close}
        title={`Ban ${worker.fullName} from the compound?`}
        description="Every active engagement of this worker, in every unit, is suspended by management and their codes stop working. Each unit is told its worker was suspended by management, never why. No resident can register them again while the ban stands."
        codes={REASON_CODES.workerBan}
        textLabel="Note for the record"
        textHint="Kept for management. The residents are never told the reason."
        confirmLabel="Ban worker"
        danger
        pending={ban.isPending}
        error={<ErrorAlert error={ban.error} />}
        onConfirm={(reason) => ban.mutate(reason)}
      />
      <ConfirmDialog
        open={open === 'unban'}
        onClose={close}
        title={`Lift the ban on ${worker.fullName}?`}
        description="Residents may register them again. The engagements the ban suspended stay suspended until each is resumed."
        confirmLabel="Lift ban"
        pending={unban.isPending}
        error={<ErrorAlert error={unban.error} />}
        onConfirm={() => unban.mutate()}
      />
      <ReasonDialog
        open={open === 'underage'}
        onClose={close}
        title={`Report that ${worker.fullName} may be under 18?`}
        description="Even when their document says otherwise. Every active code of this worker stops at once and a compliance case opens for the compliance officer. Their wage stays owed in full."
        codes={REASON_CODES.complianceReport}
        textLabel="What was seen or reported"
        textHint="Kept on the compliance case for management."
        confirmLabel="Report and stop the codes"
        danger
        pending={underage.isPending}
        error={<ErrorAlert error={underage.error} />}
        onConfirm={(reason) => underage.mutate(reason)}
      />
      <Dialog
        open={open === 'incident'}
        onClose={close}
        title={`${worker.fullName}'s card`}
        description="The old code dies now and a new one is issued, free. A confiscation is known to management and security only: the resident learns the code was reissued, not why."
        onSubmit={() => incident.mutate()}
        footer={
          <>
            <Button onClick={close}>Cancel</Button>
            <Button type="submit" variant="primary" loading={incident.isPending}>
              File and issue a new code
            </Button>
          </>
        }
      >
        <div className="form">
          <Field label="What happened">
            {(p) => (
              <Select {...p} value={incidentType} onChange={(e) => setIncidentType(e.target.value as 'lost' | 'confiscated')}>
                <option value="lost">The card was lost</option>
                <option value="confiscated">The card was confiscated</option>
              </Select>
            )}
          </Field>
          <Field label="Note" hint="Optional. Kept on the incident for management and security.">
            {(p) => <Textarea {...p} maxLength={1000} value={note} onChange={(e) => setNote(e.target.value)} />}
          </Field>
          {incidentType === 'confiscated' ? <Alert tone="warn">Who took the card and why belongs in the note, not in a message to the unit.</Alert> : null}
          <ErrorAlert error={incident.error} />
        </div>
      </Dialog>
      <ReasonCodeDialog
        open={open === 'reissue'}
        onClose={close}
        title={`Issue ${worker.fullName} a new code?`}
        description='The current code stops working now. "Lost" also files a lost-card incident.'
        codes={REASON_CODES.cardReissue}
        confirmLabel="Issue new code"
        pending={reissue.isPending}
        error={<ErrorAlert error={reissue.error} />}
        onConfirm={(reasonCode) => reissue.mutate(reasonCode)}
      />
    </div>
  );
}
