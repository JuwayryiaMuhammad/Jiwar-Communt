'use client';

import { fieldError, REASON_CODES, unwrap } from '@jiwar/api';
import { ErrorAlert, LoadMore, QueryState, useAction, useCursorList } from '@jiwar/api/react';
import { useFormat, useLocale, useT } from '@jiwar/i18n';
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
  useCommonT,
  useLabel,
  useToast,
} from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { FileUpload } from '@/components/file-upload';
import { instantOf, personNameIn } from '@/components/security/logic';
import { blocklistReady, blocklistSubjectIn } from '@/components/security/ops-logic';
import { api } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys, type BlocklistEntry, type BlocklistFilters, type BlocklistMatch } from '@/lib/queries';
import ar from '@/messages/ar/safety-blocklist';
import en from '@/messages/en/safety-blocklist';

type Status = NonNullable<BlocklistFilters['status']>;
type Kind = 'ban' | 'watch';
const STATUSES = ['active', 'expired', 'lifted', ''] as const satisfies readonly Status[];
const KINDS = ['ban', 'watch'] as const;

function KindBadge({ kind }: { kind: string }) {
  const t = useT(en, ar);
  return <Badge tone={kind === 'ban' ? 'error' : 'terracotta'}>{kind === 'ban' ? t('kind.ban') : t('kind.watch')}</Badge>;
}

function PhotoField({ value, onChange }: { value: string | null; onChange: (id: string | null) => void }) {
  const t = useT(en, ar);
  const c = useCommonT();
  return (
    <Field label={t('photo')} hint={t('photoHint')}>
      {() =>
        value ? (
          <span className="row" style={{ gap: 8 }}>
            <span className="t-secondary">{t('photoAttached')}</span>
            <Button size="sm" onClick={() => onChange(null)}>
              {c('remove')}
            </Button>
          </span>
        ) : (
          <FileUpload purpose="blocklist_photo" label={t('addPhoto')} onUploaded={onChange} />
        )
      }
    </Field>
  );
}

function AddEntry({ onClose }: { onClose: () => void }) {
  const t = useT(en, ar);
  const c = useCommonT();
  const label = useLabel();
  const { locale } = useLocale();
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
        toast.show(t('added', { kind: e.kind, subject: blocklistSubjectIn(e, locale) }));
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
      title={t('addTitle')}
      description={t('addDescription')}
      onSubmit={() => ready && add.mutate(undefined)}
      footer={
        <>
          <Button onClick={onClose}>{c('cancel')}</Button>
          <Button type="submit" variant="primary" loading={add.isPending} disabled={!ready}>
            {t('add')}
          </Button>
        </>
      }
    >
      <div className="form">
        <Segmented<Kind> label={t('kind')} value={kind} onChange={setKind} options={KINDS.map((k) => ({ value: k, label: t(`kind.${k}`) }))} />
        <Segmented<'plate' | 'person'>
          label={t('about')}
          value={subject}
          onChange={setSubject}
          options={[
            { value: 'plate', label: t('about.plate') },
            { value: 'person', label: t('about.person') },
          ]}
        />
        {subject === 'plate' ? (
          <Field label={t('plate')} error={fieldError(add.error, 'plate')}>
            {(p) => <Input {...p} maxLength={40} value={plate} onChange={(e) => setPlate(e.target.value)} />}
          </Field>
        ) : (
          <>
            <Field label={t('fullName')} error={fieldError(add.error, 'fullName')}>
              {(p) => <Input {...p} maxLength={120} value={fullName} onChange={(e) => setFullName(e.target.value)} />}
            </Field>
            <Field label={t('idNumber')} hint={t('idNumberHint')} error={fieldError(add.error, 'idNumber')}>
              {(p) => <Input {...p} autoComplete="off" maxLength={40} value={idNumber} onChange={(e) => setIdNumber(e.target.value)} />}
            </Field>
          </>
        )}
        <Field label={t('reason')} error={fieldError(add.error, 'reasonCode')}>
          {(p) => (
            <Select {...p} value={reasonCode} onChange={(e) => setReason(e.target.value)}>
              <option value="">{c('select')}</option>
              {REASON_CODES.blocklistReason.map((r) => (
                <option key={r} value={r}>
                  {label(r)}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label={t('note')} hint={t('noteHint')} error={fieldError(add.error, 'note')}>
          {(p) => <Textarea {...p} rows={3} maxLength={1000} value={note} onChange={(e) => setNote(e.target.value)} />}
        </Field>
        <Field label={t('until')} hint={t('untilHint')} error={fieldError(add.error, 'expiresAt')}>
          {(p) => <Input {...p} type="datetime-local" value={expires} onChange={(e) => setExpires(e.target.value)} />}
        </Field>
        <PhotoField value={photoFileId} onChange={setPhoto} />
        <ErrorAlert error={add.error} />
      </div>
    </Dialog>
  );
}

function EditEntry({ entry, onClose }: { entry: BlocklistEntry; onClose: () => void }) {
  const t = useT(en, ar);
  const c = useCommonT();
  const fmt = useFormat();
  const label = useLabel();
  const { locale } = useLocale();
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
        toast.show(c('saved'));
        onClose();
      },
    },
  );
  return (
    <Dialog
      open
      onClose={onClose}
      title={t('editTitle', { subject: blocklistSubjectIn(entry, locale) })}
      description={t('editDescription')}
      onSubmit={() => save.mutate(undefined)}
      footer={
        <>
          <Button onClick={onClose}>{c('cancel')}</Button>
          <Button type="submit" variant="primary" loading={save.isPending}>
            {c('save')}
          </Button>
        </>
      }
    >
      <div className="form">
        <Segmented<Kind> label={t('kind')} value={kind} onChange={setKind} options={KINDS.map((k) => ({ value: k, label: t(`kind.${k}`) }))} />
        <Field label={t('reason')} error={fieldError(save.error, 'reasonCode')}>
          {(p) => (
            <Select {...p} value={reasonCode} onChange={(e) => setReason(e.target.value)}>
              {REASON_CODES.blocklistReason.map((r) => (
                <option key={r} value={r}>
                  {label(r)}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label={t('note')} hint={t('noteClearHint')} error={fieldError(save.error, 'note')}>
          {(p) => <Textarea {...p} rows={3} maxLength={1000} value={note} onChange={(e) => setNote(e.target.value)} />}
        </Field>
        <Field
          label={t('until')}
          hint={entry.expiresAt ? t('untilNow', { when: fmt.dateTime(entry.expiresAt) }) : t('untilNone')}
          error={fieldError(save.error, 'expiresAt')}
        >
          {(p) => <Input {...p} type="datetime-local" value={expires} disabled={clearExpiry} onChange={(e) => setExpires(e.target.value)} />}
        </Field>
        {entry.expiresAt ? (
          <label className="row" style={{ gap: 8 }}>
            <input type="checkbox" checked={clearExpiry} onChange={(e) => setClearExpiry(e.target.checked)} />
            {t('noEnd')}
          </label>
        ) : null}
        <ErrorAlert error={save.error} />
      </div>
    </Dialog>
  );
}

function EntryDetail({ id, onClose }: { id: string; onClose: () => void }) {
  const t = useT(en, ar);
  const c = useCommonT();
  const fmt = useFormat();
  const label = useLabel();
  const { locale } = useLocale();
  const toast = useToast();
  const entry = useQuery({ queryKey: keys.blocklistEntry(id), queryFn: () => fetchers.blocklistEntry(id) });
  const matches = useCursorList(keys.blocklistMatches(id), (cursor) => fetchers.blocklistMatches(id, cursor));
  const [step, setStep] = useState<'edit' | 'lift' | 'photo' | null>(null);
  const lift = useAction(
    (reasonCode: string) =>
      unwrap(api.POST('/api/v1/staff/security/blocklist/{id}/lift', { params: { path: { id } }, body: { reasonCode } })),
    {
      invalidate: [keys.blocklistAll],
      onDone: () => {
        toast.show(t('lifted'));
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
        toast.show(t('photoSaved'));
        setStep(null);
      },
    },
  );
  const e = entry.data;
  const active = e?.status === 'active';
  const who = (ref: Parameters<typeof personNameIn>[0]) => personNameIn(ref, locale);
  return (
    <>
      <Dialog
        open={step === null || step === 'lift'}
        wide
        onClose={onClose}
        title={e ? blocklistSubjectIn(e, locale) : t('entry')}
        description={e ? `${e.kind === 'ban' ? t('kind.ban') : t('kind.watch')} · ${label(e.reasonCode)}` : undefined}
        footer={
          <>
            {active ? (
              <>
                <Button onClick={() => setStep('edit')}>{c('edit')}</Button>
                <Button onClick={() => setStep('photo')}>{e?.photo ? t('changePhoto') : t('addPhoto')}</Button>
                <Button variant="danger" onClick={() => setStep('lift')}>
                  {t('lift')}
                </Button>
              </>
            ) : null}
            <Button onClick={onClose}>{c('close')}</Button>
          </>
        }
      >
        <QueryState query={entry} rows={4}>
          {e ? (
            <div className="stack">
              <dl className="dl">
                <dt>{t('status')}</dt>
                <dd>
                  <StatusBadge status={e.status} /> <KindBadge kind={e.kind} />
                </dd>
                {e.subject === 'person' ? (
                  <>
                    <dt>{t('idNumber')}</dt>
                    <dd>{e.hasIdNumber ? t('idRecorded') : t('idPurged')}</dd>
                  </>
                ) : null}
                <dt>{t('addedAt')}</dt>
                <dd>{t('addedBy', { when: fmt.dateTime(e.since), who: who(e.createdBy) })}</dd>
                <dt>{t('until')}</dt>
                <dd>{e.expiresAt ? fmt.dateTime(e.expiresAt) : t('noEnd')}</dd>
                {e.liftedAt ? (
                  <>
                    <dt>{t('liftedAt')}</dt>
                    <dd>
                      {fmt.dateTime(e.liftedAt)} · {label(e.liftReason)} · {e.liftedBy ? who(e.liftedBy) : t('bySystem')}
                    </dd>
                  </>
                ) : null}
                {e.purgedAt ? (
                  <>
                    <dt>{t('purgedAt')}</dt>
                    <dd>{t('purgedText', { when: fmt.dateTime(e.purgedAt) })}</dd>
                  </>
                ) : null}
                {e.note ? (
                  <>
                    <dt>{t('note')}</dt>
                    <dd>{e.note}</dd>
                  </>
                ) : null}
              </dl>
              {e.photo ? (
                <a className="btn btn--secondary btn--sm" href={e.photo.url} target="_blank" rel="noreferrer">
                  {t('openPhoto')}
                </a>
              ) : null}
              <Card flush>
                <CardHeader title={t('met')} />
                <QueryState query={matches}>
                  <DataTable<BlocklistMatch>
                    rows={matches.rows}
                    rowKey={(m) => m.id}
                    empty={t('neverMet')}
                    columns={[
                      { key: 'when', header: t('col.when'), cell: (m) => <span title={fmt.dateTime(m.at)}>{fmt.relative(m.at)}</span> },
                      { key: 'where', header: t('col.where'), cell: (m) => label(m.source) },
                      { key: 'gate', header: t('col.gate'), cell: (m) => m.gate?.name ?? '—' },
                      { key: 'outcome', header: t('col.outcome'), cell: (m) => <StatusBadge status={m.outcome} /> },
                      { key: 'by', header: t('col.by'), cell: (m) => who(m.actor) },
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
          title={t('photoTitle')}
          footer={
            <>
              {e.photo ? (
                <Button variant="danger" loading={photo.isPending} onClick={() => photo.mutate(null)}>
                  {t('removePhoto')}
                </Button>
              ) : null}
              <Button onClick={() => setStep(null)}>{c('close')}</Button>
            </>
          }
        >
          <div className="form">
            <FileUpload purpose="blocklist_photo" label={t('uploadPhoto')} onUploaded={(fileId) => photo.mutate(fileId)} />
            <ErrorAlert error={photo.error} />
          </div>
        </Dialog>
      ) : null}
      <ReasonCodeDialog
        open={step === 'lift'}
        onClose={() => setStep(null)}
        title={t('liftTitle', { subject: e ? blocklistSubjectIn(e, locale) : '' })}
        description={t('liftDescription')}
        codes={REASON_CODES.blocklistLift}
        confirmLabel={t('lift')}
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
  const t = useT(en, ar);
  const fmt = useFormat();
  const label = useLabel();
  const { locale } = useLocale();
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
          <Button variant="primary" onClick={() => setAdding(true)}>
            {t('add')}
          </Button>
        }
      />
      <div className="toolbar">
        <Segmented<Status>
          label={t('shown')}
          value={status}
          onChange={setStatus}
          options={STATUSES.map((v) => ({ value: v, label: t(`view.${v || 'all'}`) }))}
        />
        <Field label={t('kind')}>
          {(p) => (
            <Select {...p} value={kind} onChange={(e) => setKind(e.target.value as Kind | '')}>
              <option value="">{t('kindFilter.all')}</option>
              <option value="ban">{t('kindFilter.ban')}</option>
              <option value="watch">{t('kindFilter.watch')}</option>
            </Select>
          )}
        </Field>
      </div>
      <Card flush>
        <QueryState query={list}>
          <DataTable<BlocklistEntry>
            rows={list.rows}
            rowKey={(e) => e.id}
            empty={t('empty')}
            columns={[
              {
                key: 'subject',
                header: t('col.subject'),
                cell: (e) => (
                  <Button variant="text" className="table__link" onClick={() => setOpen(e.id)}>
                    {blocklistSubjectIn(e, locale)}
                  </Button>
                ),
              },
              { key: 'kind', header: t('col.kind'), cell: (e) => <KindBadge kind={e.kind} /> },
              { key: 'reason', header: t('col.reason'), cell: (e) => label(e.reasonCode) },
              { key: 'status', header: t('col.status'), cell: (e) => <StatusBadge status={e.status} /> },
              { key: 'until', header: t('col.until'), cell: (e) => (e.expiresAt ? fmt.dateTime(e.expiresAt) : '—') },
              { key: 'since', header: t('col.since'), cell: (e) => <span title={fmt.dateTime(e.since)}>{fmt.relative(e.since)}</span> },
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
