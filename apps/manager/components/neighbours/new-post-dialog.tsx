'use client';

import { fieldError, unwrap } from '@jiwar/api';
import { ErrorAlert, useAction } from '@jiwar/api/react';
import { useT } from '@jiwar/i18n';
import { Button, Dialog, Field, Input, Segmented, Textarea, useCommonT } from '@jiwar/ui';
import { X } from 'lucide-react';
import { useState } from 'react';
import { FileUpload } from '@/components/file-upload';
import { api } from '@/lib/api';
import { keys } from '@/lib/queries';
import ar from '@/messages/ar/neighbours-posts';
import en from '@/messages/en/neighbours-posts';
import { postProblemCodes } from './words';

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
  const t = useT(en, ar);
  const c = useCommonT();
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
  const codes = postProblemCodes(form, today());
  const ready = Object.keys(codes).length === 0;
  const problems = {
    body: codes.body ? t(`problem.${codes.body}`) : undefined,
    place: codes.place ? t(`problem.${codes.place}`) : undefined,
    occurredOn: codes.occurredOn ? t(`problem.${codes.occurredOn}`) : undefined,
  };
  const err = (field: string) => fieldError(create.error, field);

  return (
    <Dialog
      open={open}
      onClose={close}
      wide
      title={t('new.title')}
      description={t('new.description')}
      onSubmit={() => ready && create.mutate()}
      footer={
        <>
          <Button onClick={close}>{c('cancel')}</Button>
          <Button type="submit" variant="primary" loading={create.isPending} disabled={!ready}>
            {t('new.submit')}
          </Button>
        </>
      }
    >
      <div className="form">
        <Segmented<Kind>
          label={t('new.kind')}
          value={form.kind}
          onChange={(kind) => set('kind', kind)}
          options={[
            { value: 'found', label: t('new.found') },
            { value: 'lost', label: t('new.lost') },
          ]}
        />
        <Field label={t('new.what')} hint={t('new.whatHint')} error={err('body') ?? (form.body !== '' ? problems.body : undefined)}>
          {(p) => <Textarea {...p} rows={3} maxLength={500} value={form.body} onChange={(e) => set('body', e.target.value)} />}
        </Field>
        <div className="form__row">
          <Field label={form.kind === 'found' ? t('new.whereFound') : t('new.whereLost')} hint={t('new.optional')} error={err('place') ?? problems.place}>
            {(p) => <Input {...p} maxLength={120} value={form.place} onChange={(e) => set('place', e.target.value)} />}
          </Field>
          <Field label={t('new.day')} hint={t('new.dayHint')} error={err('occurredOn') ?? problems.occurredOn}>
            {(p) => <Input {...p} type="date" max={today()} value={form.occurredOn} onChange={(e) => set('occurredOn', e.target.value)} />}
          </Field>
        </div>
        <span className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
          <FileUpload
            purpose="neighbour_post_photo"
            label={photoIds.length ? t('new.addAnotherPhoto', { count: photoIds.length, max: MAX_PHOTOS }) : t('new.addPhoto')}
            disabled={photoIds.length >= MAX_PHOTOS}
            onUploaded={(id) => setPhotoIds((ids) => [...ids, id])}
          />
          {photoIds.length ? (
            <Button type="button" size="sm" variant="text" icon={<X aria-hidden />} onClick={() => setPhotoIds([])}>
              {t('new.removePhotos')}
            </Button>
          ) : null}
        </span>
        <ErrorAlert error={create.error} />
      </div>
    </Dialog>
  );
}
