'use client';

import { fieldError, unwrap } from '@jiwar/api';
import { ErrorAlert, useAction } from '@jiwar/api/react';
import { useT } from '@jiwar/i18n';
import { Button, Checkbox, Dialog, Field, Input, useCommonT, useToast } from '@jiwar/ui';
import { Plus, X } from 'lucide-react';
import { useState } from 'react';
import { api } from '@/lib/api';
import { keys, type Poll } from '@/lib/queries';
import ar from '@/messages/ar/community';
import en from '@/messages/en/community';
import { AudiencePicker, DateTimeField, EVERYONE, type AudienceValue } from './bits';
import { audienceBody, optionsReady, textOrNull, toIso, toLocalInput } from './logic';

interface Option {
  labelEn: string;
  labelAr: string;
}
const TWO: Option[] = [
  { labelEn: '', labelAr: '' },
  { labelEn: '', labelAr: '' },
];

/**
 * The poll builder. Before a poll opens everything can change; once it is
 * open only its closing time can (`closingOnly`), so that no ballot already
 * cast changes meaning.
 */
export function PollDialog({
  poll,
  closingOnly,
  open,
  onClose,
  onSaved,
}: {
  poll: Poll | null;
  closingOnly?: boolean;
  open: boolean;
  onClose: () => void;
  onSaved: (id: string) => void;
}) {
  const t = useT(en, ar);
  const c = useCommonT();
  const toast = useToast();
  const [questionEn, setQuestionEn] = useState(poll?.questionEn ?? '');
  const [questionAr, setQuestionAr] = useState(poll?.questionAr ?? '');
  const [options, setOptions] = useState<Option[]>(
    poll ? poll.options.map((o) => ({ labelEn: o.labelEn ?? '', labelAr: o.labelAr ?? '' })) : TWO,
  );
  const [multiple, setMultiple] = useState(poll?.multiple ?? false);
  const [opensAt, setOpensAt] = useState(poll && poll.status === 'scheduled' ? toLocalInput(poll.opensAt) : '');
  const [closesAt, setClosesAt] = useState(toLocalInput(poll?.closesAt));
  const [audience, setAudience] = useState<AudienceValue>(
    poll ? { occupancy: poll.audience.occupancy, buildings: poll.audience.buildings ?? [] } : EVERYONE,
  );
  const [idempotencyKey] = useState(() => crypto.randomUUID());
  const setOption = (i: number, patch: Partial<Option>) => setOptions(options.map((o, j) => (j === i ? { ...o, ...patch } : o)));
  const hasEn = questionEn.trim() !== '';
  const hasAr = questionAr.trim() !== '';

  const content = () => ({
    questionEn: textOrNull(questionEn),
    questionAr: textOrNull(questionAr),
    multiple,
    audience: audienceBody(audience.occupancy, audience.buildings),
    options: options.map((o) => ({ labelEn: textOrNull(o.labelEn), labelAr: textOrNull(o.labelAr) })),
    ...(opensAt ? { opensAt: toIso(opensAt) ?? undefined } : {}),
  });
  const save = useAction(
    async () => {
      const closing = toIso(closesAt) ?? '';
      if (poll) {
        await unwrap(
          api.PATCH('/api/v1/community/polls/{id}', {
            params: { path: { id: poll.id } },
            body: closingOnly ? { closesAt: closing } : { ...content(), closesAt: closing },
          }),
        );
        return poll.id;
      }
      const created = await unwrap(
        api.POST('/api/v1/community/polls', {
          params: { header: { 'Idempotency-Key': idempotencyKey } },
          body: { ...content(), closesAt: closing },
        }),
      );
      return created.id;
    },
    {
      invalidate: [keys.pollsAll],
      onDone: (id) => {
        toast.show(poll ? t('poll.saved') : opensAt ? t('poll.scheduled') : t('poll.open'));
        onSaved(id);
      },
    },
  );
  const ready = closesAt !== '' && (closingOnly || ((hasEn || hasAr) && optionsReady(options, hasEn, hasAr)));

  return (
    <Dialog
      open={open}
      onClose={onClose}
      wide
      title={closingOnly ? t('poll.closingTitle') : poll ? t('poll.editTitle') : t('poll.newTitle')}
      description={closingOnly ? t('poll.closingDescription') : t('poll.description')}
      onSubmit={() => ready && save.mutate()}
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
        {closingOnly ? null : (
          <>
            <Field label={t('poll.questionEn')} error={fieldError(save.error, 'questionEn')}>
              {(p) => <Input {...p} dir="ltr" lang="en" maxLength={500} value={questionEn} onChange={(e) => setQuestionEn(e.target.value)} />}
            </Field>
            <Field
              label={t('poll.questionAr')}
              hint={t('poll.questionHint')}
              error={fieldError(save.error, 'questionAr')}
            >
              {(p) => <Input {...p} dir="rtl" lang="ar" maxLength={500} value={questionAr} onChange={(e) => setQuestionAr(e.target.value)} />}
            </Field>
            <fieldset className="stack stack--sm" style={{ border: 0, padding: 0, margin: 0 }}>
              <legend>{t('poll.options')}</legend>
              {options.map((o, i) => (
                <div key={i} className="form__row" style={{ alignItems: 'end' }}>
                  <Field label={t('poll.optionEn', { n: i + 1 })} error={fieldError(save.error, `options.${i}.labelEn`)}>
                    {(p) => (
                      <Input {...p} dir="ltr" lang="en" maxLength={200} disabled={!hasEn} value={o.labelEn} onChange={(e) => setOption(i, { labelEn: e.target.value })} />
                    )}
                  </Field>
                  <Field label={t('poll.optionAr', { n: i + 1 })} error={fieldError(save.error, `options.${i}.labelAr`)}>
                    {(p) => (
                      <Input
                        {...p}
                        dir="rtl"
                        lang="ar"
                        maxLength={200}
                        disabled={!hasAr}
                        value={o.labelAr}
                        onChange={(e) => setOption(i, { labelAr: e.target.value })}
                      />
                    )}
                  </Field>
                  {options.length > 2 ? (
                    <Button
                      type="button"
                      size="sm"
                      variant="text"
                      icon={<X aria-hidden />}
                      onClick={() => setOptions(options.filter((_, j) => j !== i))}
                    >
                      {c('remove')}
                    </Button>
                  ) : null}
                </div>
              ))}
              {options.length < 10 ? (
                <div>
                  <Button type="button" size="sm" icon={<Plus aria-hidden />} onClick={() => setOptions([...options, { labelEn: '', labelAr: '' }])}>
                    {t('poll.addOption')}
                  </Button>
                </div>
              ) : null}
            </fieldset>
            <Checkbox label={t('poll.multiple')} checked={multiple} onChange={(e) => setMultiple(e.target.checked)} />
          </>
        )}
        <div className="form__row">
          {closingOnly ? null : (
            <DateTimeField
              label={t('poll.opens')}
              hint={t('poll.opensHint')}
              value={opensAt}
              onChange={setOpensAt}
              error={fieldError(save.error, 'opensAt')}
            />
          )}
          <DateTimeField
            label={t('poll.closes')}
            hint={t('poll.closesHint')}
            value={closesAt}
            onChange={setClosesAt}
            error={fieldError(save.error, 'closesAt')}
          />
        </div>
        {closingOnly ? null : (
          <AudiencePicker
            value={audience}
            onChange={setAudience}
            hint={t('poll.audienceHint')}
          />
        )}
        <ErrorAlert error={save.error} />
      </div>
    </Dialog>
  );
}
