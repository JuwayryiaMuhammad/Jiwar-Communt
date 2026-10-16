'use client';

import { formatDateTime, unwrap } from '@jiwar/api';
import { ErrorAlert, fieldError, LoadMore, QueryState, useAction, useCursorList } from '@jiwar/api/react';
import { Button, Card, ConfirmDialog, DataTable, Dialog, Field, ForbiddenState, Input, PageHeader, Segmented, StatusBadge, useToast } from '@jiwar/ui';
import { Plus, Printer } from 'lucide-react';
import { useState } from 'react';
import { positionFrom } from '@/components/patrols/logic';
import { CheckpointQr } from '@/components/patrols/qr';
import { postBody, postName } from '@/components/security/logic';
import { PostPicker } from '@/components/security/pickers';
import { api } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys, type Checkpoint, type CheckpointSecret } from '@/lib/queries';

const VIEWS = ['active', 'retired', 'all'] as const;
type View = (typeof VIEWS)[number];

/** The QR, shown once: print it now, or reissue later. */
function QrDialog({ checkpoint, onClose }: { checkpoint: CheckpointSecret; onClose: () => void }) {
  return (
    <Dialog
      open
      onClose={onClose}
      title={`QR of ${checkpoint.nameEn}`}
      description="Shown once: only its fingerprint is kept. Print it now; a new one can be issued later, and the old one then stops scanning. Write the same text to the checkpoint’s NFC tag."
      footer={
        <>
          <Button icon={<Printer aria-hidden />} onClick={() => window.print()}>
            Print
          </Button>
          <Button variant="primary" onClick={onClose}>
            Done
          </Button>
        </>
      }
    >
      <div className="stack" style={{ alignItems: 'center' }}>
        <CheckpointQr payload={checkpoint.qrPayload} label={`QR of ${checkpoint.nameEn}`} />
        <p className="t-title-md">{checkpoint.nameEn}</p>
        <p dir="rtl">{checkpoint.nameAr}</p>
        <code className="t-secondary" style={{ wordBreak: 'break-all' }}>
          {checkpoint.qrPayload}
        </code>
      </div>
    </Dialog>
  );
}

function CheckpointDialog({ checkpoint, onClose, onIssued }: { checkpoint?: Checkpoint; onClose: () => void; onIssued: (c: CheckpointSecret) => void }) {
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
        else toast.show('Checkpoint saved.');
        onClose();
      },
    },
  );
  const ready = nameEn.trim() !== '' && nameAr.trim() !== '' && position !== 'invalid' && (checkpoint !== undefined || postBody(post) !== null);
  return (
    <Dialog
      open
      onClose={onClose}
      title={checkpoint ? `Edit ${checkpoint.nameEn}` : 'New checkpoint'}
      description={checkpoint ? 'Its post never changes.' : 'At a gate or a zone. Its QR is shown once, when it is made.'}
      onSubmit={() => save.mutate(undefined)}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" loading={save.isPending} disabled={!ready}>
            Save
          </Button>
        </>
      }
    >
      <div className="form">
        {checkpoint ? null : (
          <Field label="Post" error={fieldError(save.error, 'gateId') ?? fieldError(save.error, 'zoneId')}>
            {(p) => <PostPicker {...p} value={post} onChange={(e) => setPost(e.target.value)} />}
          </Field>
        )}
        <Field label="Name (English)" error={fieldError(save.error, 'nameEn')}>
          {(p) => <Input {...p} maxLength={60} value={nameEn} onChange={(e) => setNameEn(e.target.value)} />}
        </Field>
        <Field label="Name (Arabic)" error={fieldError(save.error, 'nameAr')}>
          {(p) => <Input {...p} dir="rtl" maxLength={60} value={nameAr} onChange={(e) => setNameAr(e.target.value)} />}
        </Field>
        <div className="row">
          <Field label="Latitude" hint="Optional, with the longitude.">
            {(p) => <Input {...p} inputMode="decimal" value={lat} onChange={(e) => setLat(e.target.value)} />}
          </Field>
          <Field label="Longitude">{(p) => <Input {...p} inputMode="decimal" value={lng} onChange={(e) => setLng(e.target.value)} />}</Field>
          <Field label="Radius (m)" hint="30 by default; a scan farther away is flagged.">
            {(p) => <Input {...p} inputMode="numeric" value={radius} onChange={(e) => setRadius(e.target.value)} />}
          </Field>
        </div>
        {position === 'invalid' ? <p className="t-error">A latitude and a longitude together, in range; a radius of 5 to 500 metres.</p> : null}
        <ErrorAlert error={save.error} />
      </div>
    </Dialog>
  );
}

/** The points a patrol scans (ADR 0052), and their QR. */
export default function PatrolCheckpointsPage() {
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
        <PageHeader title="Checkpoints" />
        <ForbiddenState />
      </>
    );
  return (
    <>
      <PageHeader title="Checkpoints" description="What a patrol scans: a QR, or an NFC tag carrying the same text. A retired checkpoint keeps its scans." />
      <div className="toolbar">
        <Segmented<View>
          label="Checkpoints shown"
          value={view}
          onChange={setView}
          options={[
            { value: 'active', label: 'In service' },
            { value: 'retired', label: 'Retired' },
            { value: 'all', label: 'All' },
          ]}
        />
        <Button variant="primary" icon={<Plus aria-hidden />} onClick={() => setAdding(true)}>
          New checkpoint
        </Button>
      </div>
      <Card flush>
        <QueryState query={list}>
          <DataTable<Checkpoint>
            rows={list.rows}
            rowKey={(c) => c.id}
            empty="No checkpoint"
            columns={[
              { key: 'name', header: 'Checkpoint', cell: (c) => <span className="table__primary">{c.nameEn}</span> },
              { key: 'post', header: 'Post', cell: (c) => postName(c.post) },
              { key: 'where', header: 'Position', cell: (c) => (c.position ? `${c.position.lat}, ${c.position.lng} · ${c.position.radiusM} m` : '—') },
              { key: 'routes', header: 'Routes', cell: (c) => <span className="t-num">{c.routes}</span> },
              { key: 'qr', header: 'QR printed', cell: (c) => formatDateTime(c.tokenIssuedAt) },
              {
                key: 'actions',
                header: '',
                cell: (c) =>
                  c.retiredAt ? (
                    <StatusBadge status="retired" />
                  ) : (
                    <span className="row">
                      <Button size="sm" onClick={() => setEditing(c)}>
                        Edit
                      </Button>
                      <Button size="sm" onClick={() => setReissuing(c)}>
                        New QR
                      </Button>
                      <Button size="sm" onClick={() => setRetiring(c)}>
                        Retire
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
        title={`A new QR for ${reissuing?.nameEn ?? ''}?`}
        description="The printed one stops scanning at once: replace it on the spot."
        confirmLabel="Issue a new QR"
        pending={reissue.isPending}
        error={<ErrorAlert error={reissue.error} />}
        onConfirm={() => reissuing && reissue.mutate(reissuing.id)}
      />
      <ConfirmDialog
        open={retiring !== null}
        onClose={() => setRetiring(null)}
        title={`Retire ${retiring?.nameEn ?? ''}?`}
        description="For good: it scans no more. Its scans stay. A route in service must leave it out first."
        confirmLabel="Retire"
        danger
        pending={retire.isPending}
        error={<ErrorAlert error={retire.error} />}
        onConfirm={() => retiring && retire.mutate(retiring.id)}
      />
    </>
  );
}
