'use client';

import { fieldError, unwrap } from '@jiwar/api';
import { ErrorAlert, useAction } from '@jiwar/api/react';
import { useLocale, useT } from '@jiwar/i18n';
import { Button, Checkbox, Dialog, Field, Select, Textarea, useCommonT } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { X } from 'lucide-react';
import { useState } from 'react';
import { FileUpload } from '@/components/file-upload';
import { UnitPicker } from '@/components/unit-picker';
import { api } from '@/lib/api';
import { fetchers, keys } from '@/lib/queries';
import ar from '@/messages/ar/services-mgmt-requests';
import en from '@/messages/en/services-mgmt-requests';
import { localName } from './logic';

const MAX_ATTACHMENTS = 5;
const EMPTY = { unitId: '', residentId: '', aboutUnit: false, topicId: '', body: '' };

/**
 * A conversation the management starts with a resident (ADR 0080). Its first
 * message is the office's official one, so the request starts answered: it
 * waits for the resident, who is told, and enters the queue only when they
 * answer. The resident is picked through their unit, as for a request opened
 * for them; it needs `requests.handle` and `residents.read`.
 */
export function OutreachDialog({
  open,
  onClose,
  onStarted,
}: {
  open: boolean;
  onClose: () => void;
  onStarted: (request: { id: string; number: string }) => void;
}) {
  const t = useT(en, ar);
  const c = useCommonT();
  const { locale } = useLocale();
  const [form, setForm] = useState(EMPTY);
  const [fileIds, setFileIds] = useState<string[]>([]);
  // One key for this form: a retry after a lost answer replays the first, it
  // never starts a second conversation.
  const [idempotencyKey, setIdempotencyKey] = useState(() => crypto.randomUUID());
  const set = <K extends keyof typeof EMPTY>(key: K, value: (typeof EMPTY)[K]) => setForm((f) => ({ ...f, [key]: value }));

  const topics = useQuery({ queryKey: keys.requestTopicOptions, queryFn: fetchers.requestTopicOptions, enabled: open });
  const residents = useQuery({
    queryKey: keys.requestAuthors(form.unitId),
    queryFn: () => fetchers.requestAuthors(form.unitId),
    enabled: open && form.unitId !== '',
  });

  const start = useAction(
    () =>
      unwrap(
        api.POST('/api/v1/management/outreach', {
          params: { header: { 'Idempotency-Key': idempotencyKey } },
          body: {
            residentAccountId: form.residentId,
            topicId: form.topicId,
            body: form.body.trim(),
            ...(form.aboutUnit ? { unitId: form.unitId } : {}),
            ...(fileIds.length ? { attachmentFileIds: fileIds } : {}),
          },
        }),
      ),
    {
      invalidate: [keys.managementAll],
      onDone: (request) => {
        reset();
        onStarted(request);
      },
    },
  );
  function reset() {
    setForm(EMPTY);
    setFileIds([]);
    start.reset();
    setIdempotencyKey(crypto.randomUUID());
  }
  const close = () => {
    reset();
    onClose();
  };
  const ready = form.residentId !== '' && form.topicId !== '' && form.body.trim() !== '';
  const err = (field: string) => fieldError(start.error, field);

  return (
    <Dialog
      open={open}
      onClose={close}
      wide
      title={t('outreach.title')}
      description={t('outreach.description')}
      onSubmit={() => ready && start.mutate()}
      footer={
        <>
          <Button onClick={close}>{c('cancel')}</Button>
          <Button type="submit" variant="primary" loading={start.isPending} disabled={!ready}>
            {t('outreach.submit')}
          </Button>
        </>
      }
    >
      <div className="form">
        <div className="form__row">
          <Field label={c('unit')} hint={t('new.unitHint')}>
            {(p) => (
              <UnitPicker
                {...p}
                value={form.unitId}
                onChange={(e) => setForm((f) => ({ ...f, unitId: e.target.value, residentId: '', aboutUnit: false }))}
              />
            )}
          </Field>
          <Field label={t('resident')} error={err('residentAccountId')}>
            {(p) => (
              <Select {...p} value={form.residentId} disabled={form.unitId === ''} onChange={(e) => set('residentId', e.target.value)}>
                <option value="">
                  {form.unitId === ''
                    ? t('new.pickUnit')
                    : residents.isPending
                      ? t('loading')
                      : residents.data?.data.length
                        ? c('select')
                        : t('new.nobody')}
                </option>
                {(residents.data?.data ?? []).map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.fullName ?? t('unnamed')}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        </div>
        <Checkbox
          label={t('outreach.aboutUnit')}
          checked={form.aboutUnit}
          disabled={form.unitId === ''}
          onChange={(e) => set('aboutUnit', e.target.checked)}
        />
        <Field label={t('topic')} error={err('topicId')}>
          {(p) => (
            <Select {...p} value={form.topicId} onChange={(e) => set('topicId', e.target.value)}>
              <option value="">{c('select')}</option>
              {(topics.data?.data ?? []).map((topic) => (
                <option key={topic.id} value={topic.id}>
                  {localName(locale, topic)}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label={t('outreach.body')} hint={t('outreach.bodyHint')} error={err('body')}>
          {(p) => <Textarea {...p} rows={5} maxLength={4000} value={form.body} onChange={(e) => set('body', e.target.value)} />}
        </Field>
        <span className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
          <FileUpload
            purpose="request_attachment"
            label={fileIds.length ? t('attachAnother', { n: fileIds.length, max: MAX_ATTACHMENTS }) : t('attach')}
            disabled={fileIds.length >= MAX_ATTACHMENTS}
            onUploaded={(id) => setFileIds((ids) => [...ids, id])}
          />
          {fileIds.length ? (
            <Button type="button" size="sm" variant="text" icon={<X aria-hidden />} onClick={() => setFileIds([])}>
              {t('removeAttachments')}
            </Button>
          ) : null}
        </span>
        <ErrorAlert error={start.error} />
      </div>
    </Dialog>
  );
}
