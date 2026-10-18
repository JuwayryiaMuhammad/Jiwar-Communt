'use client';

import { fieldError, formatDateTime, humanize, REASON_CODES, relativeTime, unwrap } from '@jiwar/api';
import { ErrorAlert, LoadMore, QueryState, useAction, useCursorList } from '@jiwar/api/react';
import {
  Badge,
  Button,
  Card,
  CardHeader,
  DataTable,
  Dialog,
  Field,
  ForbiddenState,
  Input,
  PageHeader,
  ReasonCodeDialog,
  Segmented,
  Select,
  StatusBadge,
  Textarea,
  useToast,
} from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { FileUpload } from '@/components/file-upload';
import { instantOf, personName } from '@/components/security/logic';
import { blocklistReady, blocklistSubject } from '@/components/security/ops-logic';
import { api } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys, type BlocklistEntry, type BlocklistFilters, type BlocklistMatch } from '@/lib/queries';

type Status = NonNullable<BlocklistFilters['status']>;
type Kind = 'ban' | 'watch';

const kindBadge = (kind: string) => <Badge tone={kind === 'ban' ? 'error' : 'terracotta'}>{kind === 'ban' ? 'Ban' : 'Watch'}</Badge>;

function PhotoField({ value, onChange }: { value: string | null; onChange: (id: string | null) => void }) {
  return (
    <Field label="Photo" hint="Optional. The guards on duty see it.">
      {() =>
        value ? (
          <span className="row" style={{ gap: 8 }}>
            <span className="t-secondary">Photo attached.</span>
            <Button size="sm" onClick={() => onChange(null)}>
              Remove
            </Button>
          </span>
        ) : (
          <FileUpload purpose="blocklist_photo" label="Add a photo" onUploaded={onChange} />
        )
      }
    </Field>
  );
}

function AddEntry({ onClose }: { onClose: () => void }) {
  const toast = useToast();
  const [kind, setKind] = useState<Kind>('ban');
  const [subject, setSubject] = useState<'plate' | 'person'>('plate');
  const [plate, setPlate] = useState('');
  const [fullName, setFullName] = useState('');
  const [idNumber, setIdNumber] = useState('');
  const [reasonCode, setReason] = useState('');
  const [note, setNote] = useState('');
  const [expires, setExpires] = useState('');
  const [photoFileId, setPhoto] = useState<string | null>(null);
  const add = useAction(
    () =>
      unwrap(
        api.POST('/api/v1/staff/security/blocklist', {
          body: {
            kind,
            subject,
            ...(subject === 'plate' ? { plate: plate.trim() } : { fullName: fullName.trim(), idNumber: idNumber.trim() }),
            reasonCode,
            ...(note.trim() ? { note: note.trim() } : {}),
            ...(instantOf(expires) ? { expiresAt: instantOf(expires) } : {}),
            ...(photoFileId ? { photoFileId } : {}),
          },
        }),
      ),
    {
      invalidate: [keys.blocklistAll],
      onDone: (e) => {
        toast.show(`${e.kind === 'ban' ? 'Banned' : 'Watched'}: ${blocklistSubject(e)}. The guards see it now.`);
        onClose();
      },
    },
  );
  const ready = blocklistReady({ subject, plate, fullName, idNumber, reasonCode });
  return (
    <Dialog
      open
      wide
      onClose={onClose}
      title="Add to the blocklist"
      description="A ban refuses entry at the gate; a watch lets in and tells you. Matched at every plate and ID check."
      onSubmit={() => ready && add.mutate(undefined)}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" loading={add.isPending} disabled={!ready}>
            Add
          </Button>
        </>
      }
    >
      <div className="form">
        <Segmented<Kind>
          label="Kind"
          value={kind}
          onChange={setKind}
          options={[
            { value: 'ban', label: 'Ban' },
            { value: 'watch', label: 'Watch' },
          ]}
        />
        <Segmented<'plate' | 'person'>
          label="About"
          value={subject}
          onChange={setSubject}
          options={[
            { value: 'plate', label: 'A plate' },
            { value: 'person', label: 'A person' },
          ]}
        />
        {subject === 'plate' ? (
          <Field label="Plate" error={fieldError(add.error, 'plate')}>
            {(p) => <Input {...p} maxLength={40} value={plate} onChange={(e) => setPlate(e.target.value)} />}
          </Field>
        ) : (
          <>
            <Field label="Full name" error={fieldError(add.error, 'fullName')}>
              {(p) => <Input {...p} maxLength={120} value={fullName} onChange={(e) => setFullName(e.target.value)} />}
            </Field>
            <Field
              label="ID number"
              hint="Matched when a guard checks an ID. Never shown again, to anyone: only a keyed hash is kept."
              error={fieldError(add.error, 'idNumber')}
            >
              {(p) => <Input {...p} autoComplete="off" maxLength={40} value={idNumber} onChange={(e) => setIdNumber(e.target.value)} />}
            </Field>
          </>
        )}
        <Field label="Reason" error={fieldError(add.error, 'reasonCode')}>
          {(p) => (
            <Select {...p} value={reasonCode} onChange={(e) => setReason(e.target.value)}>
              <option value="">Select…</option>
              {REASON_CODES.blocklistReason.map((r) => (
                <option key={r} value={r}>
                  {humanize(r)}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Note" hint="Optional. The management’s only: guards never read it." error={fieldError(add.error, 'note')}>
          {(p) => <Textarea {...p} rows={3} maxLength={1000} value={note} onChange={(e) => setNote(e.target.value)} />}
        </Field>
        <Field label="Until" hint="Optional. Lifted by itself then." error={fieldError(add.error, 'expiresAt')}>
          {(p) => <Input {...p} type="datetime-local" value={expires} onChange={(e) => setExpires(e.target.value)} />}
        </Field>
        <PhotoField value={photoFileId} onChange={setPhoto} />
        <ErrorAlert error={add.error} />
      </div>
    </Dialog>
  );
}

function EditEntry({ entry, onClose }: { entry: BlocklistEntry; onClose: () => void }) {
  const toast = useToast();
  const [kind, setKind] = useState<Kind>(entry.kind as Kind);
  const [reasonCode, setReason] = useState<string>(entry.reasonCode);
  const [note, setNote] = useState(entry.note ?? '');
  const [expires, setExpires] = useState('');
  const [clearExpiry, setClearExpiry] = useState(false);
  const save = useAction(
    () =>
      unwrap(
        api.PATCH('/api/v1/staff/security/blocklist/{id}', {
          params: { path: { id: entry.id } },
          body: {
            ...(kind !== entry.kind ? { kind } : {}),
            ...(reasonCode !== entry.reasonCode ? { reasonCode } : {}),
            ...(note.trim() !== (entry.note ?? '') ? { note: note.trim() || null } : {}),
            ...(clearExpiry ? { expiresAt: null } : instantOf(expires) ? { expiresAt: instantOf(expires) } : {}),
          },
        }),
      ),
    {
      invalidate: [keys.blocklistAll],
      onDone: () => {
        toast.show('Saved.');
        onClose();
      },
    },
  );
  return (
    <Dialog
      open
      onClose={onClose}
      title={`Edit ${blocklistSubject(entry)}`}
      description="The plate or the person never changes: lift this entry and add another."
      onSubmit={() => save.mutate(undefined)}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" loading={save.isPending}>
            Save
          </Button>
        </>
      }
    >
      <div className="form">
        <Segmented<Kind>
          label="Kind"
          value={kind}
          onChange={setKind}
          options={[
            { value: 'ban', label: 'Ban' },
            { value: 'watch', label: 'Watch' },
          ]}
        />
        <Field label="Reason" error={fieldError(save.error, 'reasonCode')}>
          {(p) => (
            <Select {...p} value={reasonCode} onChange={(e) => setReason(e.target.value)}>
              {REASON_CODES.blocklistReason.map((r) => (
                <option key={r} value={r}>
                  {humanize(r)}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Note" hint="Empty clears it." error={fieldError(save.error, 'note')}>
          {(p) => <Textarea {...p} rows={3} maxLength={1000} value={note} onChange={(e) => setNote(e.target.value)} />}
        </Field>
        <Field
          label="Until"
          hint={entry.expiresAt ? `Now until ${formatDateTime(entry.expiresAt)}.` : 'Now with no end.'}
          error={fieldError(save.error, 'expiresAt')}
        >
          {(p) => <Input {...p} type="datetime-local" value={expires} disabled={clearExpiry} onChange={(e) => setExpires(e.target.value)} />}
        </Field>
        {entry.expiresAt ? (
          <label className="row" style={{ gap: 8 }}>
            <input type="checkbox" checked={clearExpiry} onChange={(e) => setClearExpiry(e.target.checked)} />
            No end
          </label>
        ) : null}
        <ErrorAlert error={save.error} />
      </div>
    </Dialog>
  );
}

function EntryDetail({ id, onClose }: { id: string; onClose: () => void }) {
  const toast = useToast();
  const entry = useQuery({ queryKey: keys.blocklistEntry(id), queryFn: () => fetchers.blocklistEntry(id) });
  const matches = useCursorList(keys.blocklistMatches(id), (c) => fetchers.blocklistMatches(id, c));
  const [step, setStep] = useState<'edit' | 'lift' | 'photo' | null>(null);
  const lift = useAction(
    (reasonCode: string) =>
      unwrap(api.POST('/api/v1/staff/security/blocklist/{id}/lift', { params: { path: { id } }, body: { reasonCode } })),
    {
      invalidate: [keys.blocklistAll],
      onDone: () => {
        toast.show('Lifted. The guards no longer see it.');
        setStep(null);
      },
    },
  );
  const photo = useAction(
    (photoFileId: string | null) =>
      unwrap(api.PATCH('/api/v1/staff/security/blocklist/{id}', { params: { path: { id } }, body: { photoFileId } })),
    {
      invalidate: [keys.blocklistAll],
      onDone: () => {
        toast.show('Photo saved.');
        setStep(null);
      },
    },
  );
  const e = entry.data;
  const active = e?.status === 'active';
  return (
    <>
      <Dialog
        open={step === null || step === 'lift'}
        wide
        onClose={onClose}
        title={e ? blocklistSubject(e) : 'Blocklist entry'}
        description={e ? `${e.kind === 'ban' ? 'Ban' : 'Watch'} · ${humanize(e.reasonCode)}` : undefined}
        footer={
          <>
            {active ? (
              <>
                <Button onClick={() => setStep('edit')}>Edit</Button>
                <Button onClick={() => setStep('photo')}>{e?.photo ? 'Change the photo' : 'Add a photo'}</Button>
                <Button variant="danger" onClick={() => setStep('lift')}>
                  Lift
                </Button>
              </>
            ) : null}
            <Button onClick={onClose}>Close</Button>
          </>
        }
      >
        <QueryState query={entry} rows={4}>
          {e ? (
            <div className="stack">
              <dl className="dl">
                <dt>Status</dt>
                <dd>
                  <StatusBadge status={e.status} /> {kindBadge(e.kind)}
                </dd>
                {e.subject === 'person' ? (
                  <>
                    <dt>ID number</dt>
                    <dd>{e.hasIdNumber ? 'Recorded (never shown)' : 'Purged'}</dd>
                  </>
                ) : null}
                <dt>Added</dt>
                <dd>
                  {formatDateTime(e.since)} · by {personName(e.createdBy)}
                </dd>
                <dt>Until</dt>
                <dd>{e.expiresAt ? formatDateTime(e.expiresAt) : 'No end'}</dd>
                {e.liftedAt ? (
                  <>
                    <dt>Lifted</dt>
                    <dd>
                      {formatDateTime(e.liftedAt)} · {humanize(e.liftReason)} · {e.liftedBy ? personName(e.liftedBy) : 'by the system'}
                    </dd>
                  </>
                ) : null}
                {e.purgedAt ? (
                  <>
                    <dt>Purged</dt>
                    <dd>{formatDateTime(e.purgedAt)}: the person’s name, ID, photo and note are gone.</dd>
                  </>
                ) : null}
                {e.note ? (
                  <>
                    <dt>Note</dt>
                    <dd>{e.note}</dd>
                  </>
                ) : null}
              </dl>
              {e.photo ? (
                <a className="btn btn--secondary btn--sm" href={e.photo.url} target="_blank" rel="noreferrer">
                  Open the photo
                </a>
              ) : null}
              <Card flush>
                <CardHeader title="Met at the gate" />
                <QueryState query={matches}>
                  <DataTable<BlocklistMatch>
                    rows={matches.rows}
                    rowKey={(m) => m.id}
                    empty="Never met"
                    columns={[
                      { key: 'when', header: 'When', cell: (m) => <span title={formatDateTime(m.at)}>{relativeTime(m.at)}</span> },
                      { key: 'where', header: 'Where', cell: (m) => humanize(m.source) },
                      { key: 'gate', header: 'Gate', cell: (m) => m.gate?.name ?? '—' },
                      { key: 'outcome', header: 'Outcome', cell: (m) => <StatusBadge status={m.outcome} /> },
                      { key: 'by', header: 'By', cell: (m) => personName(m.actor) },
                    ]}
                  />
                  <LoadMore query={matches} />
                </QueryState>
              </Card>
            </div>
          ) : null}
        </QueryState>
      </Dialog>
      {e && step === 'edit' ? <EditEntry entry={e} onClose={() => setStep(null)} /> : null}
      {e && step === 'photo' ? (
        <Dialog
          open
          onClose={() => setStep(null)}
          title="The entry’s photo"
          footer={
            <>
              {e.photo ? (
                <Button variant="danger" loading={photo.isPending} onClick={() => photo.mutate(null)}>
                  Remove the photo
                </Button>
              ) : null}
              <Button onClick={() => setStep(null)}>Close</Button>
            </>
          }
        >
          <div className="form">
            <FileUpload purpose="blocklist_photo" label="Upload a photo" onUploaded={(fileId) => photo.mutate(fileId)} />
            <ErrorAlert error={photo.error} />
          </div>
        </Dialog>
      ) : null}
      <ReasonCodeDialog
        open={step === 'lift'}
        onClose={() => setStep(null)}
        title={`Lift ${e ? blocklistSubject(e) : ''}?`}
        description="The gate lets them in again. A person’s name, ID and photo are purged 30 days later."
        codes={REASON_CODES.blocklistLift}
        confirmLabel="Lift"
        danger
        pending={lift.isPending}
        error={<ErrorAlert error={lift.error} />}
        onConfirm={(reasonCode) => lift.mutate(reasonCode)}
      />
    </>
  );
}

/**
 * The blocklist and the watchlist (ADR 0053), `blocklist.manage`: plates
 * and people banned or watched at the gate, and where each was met.
 */
export default function BlocklistPage() {
  const { ready, can } = usePermissions();
  const allowed = can('blocklist.manage');
  const [status, setStatus] = useState<Status>('active');
  const [kind, setKind] = useState<Kind | ''>('');
  const [open, setOpen] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  useEffect(() => {
    const linked = new URLSearchParams(window.location.search).get('entry');
    if (linked) setOpen(linked);
  }, []);
  const filters: BlocklistFilters = { status, kind };
  const list = useCursorList(keys.blocklist(filters), (c) => fetchers.blocklist(filters, c), { enabled: allowed });
  if (ready && !allowed)
    return (
      <>
        <PageHeader title="Blocklist" />
        <ForbiddenState />
      </>
    );
  return (
    <>
      <PageHeader
        title="Blocklist"
        description="Matched at every plate and ID check at the gate. The management’s only; guards on duty see the active entries."
        actions={
          <Button variant="primary" onClick={() => setAdding(true)}>
            Add
          </Button>
        }
      />
      <div className="toolbar">
        <Segmented<Status>
          label="Entries shown"
          value={status}
          onChange={setStatus}
          options={[
            { value: 'active', label: 'Active' },
            { value: 'expired', label: 'Expired' },
            { value: 'lifted', label: 'Lifted' },
            { value: '', label: 'All' },
          ]}
        />
        <Field label="Kind">
          {(p) => (
            <Select {...p} value={kind} onChange={(e) => setKind(e.target.value as Kind | '')}>
              <option value="">Bans and watches</option>
              <option value="ban">Bans</option>
              <option value="watch">Watches</option>
            </Select>
          )}
        </Field>
      </div>
      <Card flush>
        <QueryState query={list}>
          <DataTable<BlocklistEntry>
            rows={list.rows}
            rowKey={(e) => e.id}
            empty="No entry"
            columns={[
              {
                key: 'subject',
                header: 'Plate or person',
                cell: (e) => (
                  <Button variant="text" className="table__link" onClick={() => setOpen(e.id)}>
                    {blocklistSubject(e)}
                  </Button>
                ),
              },
              { key: 'kind', header: 'Kind', cell: (e) => kindBadge(e.kind) },
              { key: 'reason', header: 'Reason', cell: (e) => humanize(e.reasonCode) },
              { key: 'status', header: 'Status', cell: (e) => <StatusBadge status={e.status} /> },
              { key: 'until', header: 'Until', cell: (e) => (e.expiresAt ? formatDateTime(e.expiresAt) : '—') },
              { key: 'since', header: 'Added', cell: (e) => <span title={formatDateTime(e.since)}>{relativeTime(e.since)}</span> },
            ]}
          />
          <LoadMore query={list} />
        </QueryState>
      </Card>
      {open ? <EntryDetail id={open} onClose={() => setOpen(null)} /> : null}
      {adding ? <AddEntry onClose={() => setAdding(false)} /> : null}
    </>
  );
}
