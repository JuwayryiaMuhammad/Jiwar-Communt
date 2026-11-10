'use client';

import { unwrap } from '@jiwar/api';
import { ErrorAlert, fieldError, LoadMore, QueryState, useAction, useCursorList } from '@jiwar/api/react';
import { useFormat, useLocale, useT } from '@jiwar/i18n';
import {
  Button,
  Card,
  ConfirmDialog,
  DataTable,
  Dialog,
  Field,
  ForbiddenState,
  Input,
  PageHeader,
  Segmented,
  StatusBadge,
  useCommonT,
  useToast,
} from '@jiwar/ui';
import { Plus, Printer } from 'lucide-react';
import { useState } from 'react';
import { positionFrom } from '@/components/patrols/logic';
import { CheckpointQr } from '@/components/patrols/qr';
import { nameIn, postBody, postNameIn } from '@/components/security/logic';
import { PostPicker } from '@/components/security/pickers';
import { api } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys, type Checkpoint, type CheckpointSecret } from '@/lib/queries';
import ar from '@/messages/ar/guard-checkpoints';
import en from '@/messages/en/guard-checkpoints';

const VIEWS = ['active', 'retired', 'all'] as const;
type View = (typeof VIEWS)[number];

/** The QR, shown once: print it now, or reissue later. */
function QrDialog({ checkpoint, onClose }: { checkpoint: CheckpointSecret; onClose: () => void }) {
  const t = useT(en, ar);
  const { locale } = useLocale();
  const name = nameIn(checkpoint, locale);
  return (
    <Dialog
      open
      onClose={onClose}
      title={t('qrTitle', { name })}
      description={t('qrDescription')}
      footer={
        <>
          <Button icon={<Printer aria-hidden />} onClick={() => window.print()}>
            {t('print')}
          </Button>
          <Button variant="primary" onClick={onClose}>
            {t('done')}
          </Button>
        </>
      }
    >
      <div className="stack" style={{ alignItems: 'center' }}>
        <CheckpointQr payload={checkpoint.qrPayload} label={t('qrTitle', { name })} />
        <p className="t-title-md" dir="ltr">
          {checkpoint.nameEn}
        </p>
        <p dir="rtl">{checkpoint.nameAr}</p>
        <code className="t-secondary" dir="ltr" style={{ wordBreak: 'break-all' }}>
          {checkpoint.qrPayload}
        </code>
      </div>
    </Dialog>
  );
}

function CheckpointDialog({ checkpoint, onClose, onIssued }: { checkpoint?: Checkpoint; onClose: () => void; onIssued: (c: CheckpointSecret) => void }) {
  const t = useT(en, ar);
  const c = useCommonT();
  const { locale } = useLocale();
  const toast = useToast();
  const [post, setPost] = useState('');
  const [nameEn, setNameEn] = useState(checkpoint?.nameEn ?? '');
  const [nameAr, setNameAr] = useState(checkpoint?.nameAr ?? '');
  const [lat, setLat] = useState(checkpoint?.position ? String(checkpoint.position.lat) : '');
  const [lng, setLng] = useState(checkpoint?.position ? String(checkpoint.position.lng) : '');
  const [radius, setRadius] = useState(checkpoint?.position ? String(checkpoint.position.radiusM) : '');
  const position = positionFrom(lat, lng, radius);
  const save = useAction(
    async () => {
      if (checkpoint)
        return {
          edited: await unwrap(
            api.PATCH('/api/v1/staff/security/patrols/checkpoints/{id}', {
              params: { path: { id: checkpoint.id } },
              body: { nameEn: nameEn.trim(), nameAr: nameAr.trim(), position: position === 'invalid' ? null : position },
            }),
          ),
        };
      return {
        made: await unwrap(
          api.POST('/api/v1/staff/security/patrols/checkpoints', {
            body: { ...postBody(post), nameEn: nameEn.trim(), nameAr: nameAr.trim(), ...(position && position !== 'invalid' ? { position } : {}) },
          }),
        ),
      };
    },
    {
      invalidate: [keys.checkpointsAll],
      onDone: (r) => {
        if ('made' in r && r.made) onIssued(r.made);
        else toast.show(t('saved'));
        onClose();
      },
    },
  );
  const ready = nameEn.trim() !== '' && nameAr.trim() !== '' && position !== 'invalid' && (checkpoint !== undefined || postBody(post) !== null);
  return (
    <Dialog
      open
      onClose={onClose}
      title={checkpoint ? t('editTitle', { name: nameIn(checkpoint, locale) }) : t('newTitle')}
      description={checkpoint ? t('editDescription') : t('newDescription')}
      onSubmit={() => save.mutate(undefined)}
      footer={
        <>
          <Button onClick={onClose}>{c('cancel')}</Button>
          <Button type="submit" variant="primary" loading={save.isPending} disabled={!ready}>
            {c('save')}
          </Button>
        </>
      }
    >
      <div className="form">
        {checkpoint ? null : (
          <Field label={t('post')} error={fieldError(save.error, 'gateId') ?? fieldError(save.error, 'zoneId')}>
            {(p) => <PostPicker {...p} value={post} onChange={(e) => setPost(e.target.value)} />}
          </Field>
        )}
        <Field label={t('nameEn')} error={fieldError(save.error, 'nameEn')}>
          {(p) => <Input {...p} dir="ltr" maxLength={60} value={nameEn} onChange={(e) => setNameEn(e.target.value)} />}
        </Field>
        <Field label={t('nameAr')} error={fieldError(save.error, 'nameAr')}>
          {(p) => <Input {...p} dir="rtl" lang="ar" maxLength={60} value={nameAr} onChange={(e) => setNameAr(e.target.value)} />}
        </Field>
        <div className="row">
          <Field label={t('latitude')} hint={t('latitudeHint')}>
            {(p) => <Input {...p} dir="ltr" inputMode="decimal" value={lat} onChange={(e) => setLat(e.target.value)} />}
          </Field>
          <Field label={t('longitude')}>{(p) => <Input {...p} dir="ltr" inputMode="decimal" value={lng} onChange={(e) => setLng(e.target.value)} />}</Field>
          <Field label={t('radius')} hint={t('radiusHint')}>
            {(p) => <Input {...p} dir="ltr" inputMode="numeric" value={radius} onChange={(e) => setRadius(e.target.value)} />}
          </Field>
        </div>
        {position === 'invalid' ? <p className="t-error">{t('positionInvalid')}</p> : null}
        <ErrorAlert error={save.error} />
      </div>
    </Dialog>
  );
}

/** The points a patrol scans (ADR 0052), and their QR. */
export default function PatrolCheckpointsPage() {
  const t = useT(en, ar);
  const fmt = useFormat();
  const { locale } = useLocale();
  const { ready, can } = usePermissions();
  const allowed = can('patrols.manage');
  const [view, setView] = useState<View>('active');
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<Checkpoint | null>(null);
  const [issued, setIssued] = useState<CheckpointSecret | null>(null);
  const [reissuing, setReissuing] = useState<Checkpoint | null>(null);
  const [retiring, setRetiring] = useState<Checkpoint | null>(null);
  const status = view === 'all' ? '' : view;
  const list = useCursorList(keys.checkpoints(status), (c) => fetchers.checkpoints(status, c), { enabled: allowed });
  const reissue = useAction(
    (id: string) => unwrap(api.POST('/api/v1/staff/security/patrols/checkpoints/{id}/reissue', { params: { path: { id } } })),
    {
      invalidate: [keys.checkpointsAll],
      onDone: (c) => {
        setReissuing(null);
        setIssued(c);
      },
    },
  );
  const retire = useAction(
    (id: string) => unwrap(api.POST('/api/v1/staff/security/patrols/checkpoints/{id}/retire', { params: { path: { id } } })),
    { invalidate: [keys.checkpointsAll], onDone: () => setRetiring(null) },
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
      <PageHeader title={t('title')} description={t('description')} />
      <div className="toolbar">
        <Segmented<View> label={t('shown')} value={view} onChange={setView} options={VIEWS.map((v) => ({ value: v, label: t(`view.${v}`) }))} />
        <Button variant="primary" icon={<Plus aria-hidden />} onClick={() => setAdding(true)}>
          {t('add')}
        </Button>
      </div>
      <Card flush>
        <QueryState query={list}>
          <DataTable<Checkpoint>
            rows={list.rows}
            rowKey={(c) => c.id}
            empty={t('empty')}
            columns={[
              { key: 'name', header: t('col.checkpoint'), cell: (c) => <span className="table__primary">{nameIn(c, locale)}</span> },
              { key: 'post', header: t('col.post'), cell: (c) => postNameIn(c.post, locale) },
              {
                key: 'where',
                header: t('col.position'),
                cell: (c) =>
                  c.position ? (
                    <span className="t-num">
                      {t('position', { lat: String(c.position.lat), lng: String(c.position.lng), radius: c.position.radiusM })}
                    </span>
                  ) : (
                    '—'
                  ),
              },
              { key: 'routes', header: t('col.routes'), cell: (c) => <span className="t-num">{fmt.number(c.routes)}</span> },
              { key: 'qr', header: t('col.qr'), cell: (c) => fmt.dateTime(c.tokenIssuedAt) },
              {
                key: 'actions',
                header: '',
                cell: (c) =>
                  c.retiredAt ? (
                    <StatusBadge status="retired" />
                  ) : (
                    <span className="row">
                      <Button size="sm" onClick={() => setEditing(c)}>
                        {t('edit')}
                      </Button>
                      <Button size="sm" onClick={() => setReissuing(c)}>
                        {t('newQr')}
                      </Button>
                      <Button size="sm" onClick={() => setRetiring(c)}>
                        {t('retire')}
                      </Button>
                    </span>
                  ),
              },
            ]}
          />
          <LoadMore query={list} />
        </QueryState>
      </Card>
      {adding ? <CheckpointDialog onClose={() => setAdding(false)} onIssued={setIssued} /> : null}
      {editing ? <CheckpointDialog checkpoint={editing} onClose={() => setEditing(null)} onIssued={setIssued} /> : null}
      {issued ? <QrDialog checkpoint={issued} onClose={() => setIssued(null)} /> : null}
      <ConfirmDialog
        open={reissuing !== null}
        onClose={() => setReissuing(null)}
        title={t('reissueTitle', { name: reissuing ? nameIn(reissuing, locale) : '' })}
        description={t('reissueDescription')}
        confirmLabel={t('reissueConfirm')}
        pending={reissue.isPending}
        error={<ErrorAlert error={reissue.error} />}
        onConfirm={() => reissuing && reissue.mutate(reissuing.id)}
      />
      <ConfirmDialog
        open={retiring !== null}
        onClose={() => setRetiring(null)}
        title={t('retireTitle', { name: retiring ? nameIn(retiring, locale) : '' })}
        description={t('retireDescription')}
        confirmLabel={t('retire')}
        danger
        pending={retire.isPending}
        error={<ErrorAlert error={retire.error} />}
        onConfirm={() => retiring && retire.mutate(retiring.id)}
      />
    </>
  );
}
