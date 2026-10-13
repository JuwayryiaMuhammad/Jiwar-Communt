'use client';

import { fieldError, unwrap } from '@jiwar/api';
import { ErrorAlert, useAction } from '@jiwar/api/react';
import { Button, Dialog, Field, Input, Segmented, Textarea } from '@jiwar/ui';
import { X } from 'lucide-react';
import { useState } from 'react';
import { FileUpload } from '@/components/file-upload';
import { api } from '@/lib/api';
import { keys } from '@/lib/queries';
import { postProblems } from './logic';

const MAX_PHOTOS = 3;
type Kind = 'lost' | 'found';
const EMPTY = { kind: 'found' as Kind, body: '', place: '', occurredOn: '' };

/** Today as the browser sees it: the API allows a day up to tomorrow by UTC. */
function today(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * A lost or found item posted by the management (ADR 0042): something
 * handed in at the office, or reported lost at the desk. It reads as the
 * management's, and a found item is claimed and handed over at the office.
 */
export function NewPostDialog({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: (post: { id: string }) => void }) {
  const [form, setForm] = useState(EMPTY);
  const [photoIds, setPhotoIds] = useState<string[]>([]);
  // One key for this form: a retry after a lost answer replays the first, it
  // never posts the item twice.
  const [idempotencyKey, setIdempotencyKey] = useState(() => crypto.randomUUID());
  const set = <K extends keyof typeof EMPTY>(key: K, value: (typeof EMPTY)[K]) => setForm((f) => ({ ...f, [key]: value }));

  const reset = () => {
    setForm(EMPTY);
    setPhotoIds([]);
    setIdempotencyKey(crypto.randomUUID());
  };
  const create = useAction(
    () =>
      unwrap(
        api.POST('/api/v1/neighbours/posts', {
          params: { header: { 'Idempotency-Key': idempotencyKey } },
          body: {
            kind: form.kind,
            body: form.body.trim(),
            ...(form.place.trim() ? { place: form.place.trim() } : {}),
            ...(form.occurredOn ? { occurredOn: form.occurredOn } : {}),
            ...(photoIds.length ? { photoFileIds: photoIds } : {}),
          },
        }),
      ),
    {
      invalidate: [keys.neighbourPostsAll],
      onDone: (post) => {
        reset();
        onCreated(post);
      },
    },
  );

  const close = () => {
    reset();
    create.reset();
    onClose();
  };
  const problems = postProblems(form, today());
  const ready = Object.keys(problems).length === 0;
  const err = (field: string) => fieldError(create.error, field);

  return (
    <Dialog
      open={open}
      onClose={close}
      wide
      title="Post a lost or found item"
      description="Posted as the management, on the lost-and-found board every resident reads. A found item is kept at the office until someone claims it."
      onSubmit={() => ready && create.mutate()}
      footer={
        <>
          <Button onClick={close}>Cancel</Button>
          <Button type="submit" variant="primary" loading={create.isPending} disabled={!ready}>
            Post
          </Button>
        </>
      }
    >
      <div className="form">
        <Segmented<Kind>
          label="Kind"
          value={form.kind}
          onChange={(kind) => set('kind', kind)}
          options={[
            { value: 'found', label: 'Found: it is at the office' },
            { value: 'lost', label: 'Lost: someone is looking for it' },
          ]}
        />
        <Field label="What it is" hint="A few words. Leave out what only its owner would know: that is how a claim is checked." error={err('body') ?? (form.body !== '' ? problems.body : undefined)}>
          {(p) => <Textarea {...p} rows={3} maxLength={500} value={form.body} onChange={(e) => set('body', e.target.value)} />}
        </Field>
        <div className="form__row">
          <Field label={form.kind === 'found' ? 'Where it was found' : 'Where it was lost'} hint="Optional." error={err('place') ?? problems.place}>
            {(p) => <Input {...p} maxLength={120} value={form.place} onChange={(e) => set('place', e.target.value)} />}
          </Field>
          <Field label="The day" hint="Optional; not in the future." error={err('occurredOn') ?? problems.occurredOn}>
            {(p) => <Input {...p} type="date" max={today()} value={form.occurredOn} onChange={(e) => set('occurredOn', e.target.value)} />}
          </Field>
        </div>
        <span className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
          <FileUpload
            purpose="neighbour_post_photo"
            label={photoIds.length ? `Add another photo (${photoIds.length} of ${MAX_PHOTOS})` : 'Add a photo'}
            disabled={photoIds.length >= MAX_PHOTOS}
            onUploaded={(id) => setPhotoIds((ids) => [...ids, id])}
          />
          {photoIds.length ? (
            <Button type="button" size="sm" variant="text" icon={<X aria-hidden />} onClick={() => setPhotoIds([])}>
              Remove photos
            </Button>
          ) : null}
        </span>
        <ErrorAlert error={create.error} />
      </div>
    </Dialog>
  );
}
