'use client';

import { fieldError, unwrap } from '@jiwar/api';
import { ErrorAlert, useAction } from '@jiwar/api/react';
import { Button, Checkbox, Dialog, Field, Input, useToast } from '@jiwar/ui';
import { Plus, X } from 'lucide-react';
import { useState } from 'react';
import { api } from '@/lib/api';
import { keys, type Poll } from '@/lib/queries';
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
        toast.show(poll ? 'The poll is saved.' : opensAt ? 'The poll is scheduled.' : 'The poll is open.');
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
      title={closingOnly ? 'Change the closing time' : poll ? 'Edit poll' : 'New poll'}
      description={
        closingOnly
          ? 'The poll is open: its question and options no longer change, so that no vote already cast changes meaning.'
          : 'Consultative: one vote per unit, secret. Nobody, the management included, can see what a unit chose.'
      }
      onSubmit={() => ready && save.mutate()}
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
        {closingOnly ? null : (
          <>
            <Field label="Question (English)" error={fieldError(save.error, 'questionEn')}>
              {(p) => <Input {...p} maxLength={500} value={questionEn} onChange={(e) => setQuestionEn(e.target.value)} />}
            </Field>
            <Field
              label="Question (Arabic)"
              hint="Write one language or both. Each option is then written in the same languages."
              error={fieldError(save.error, 'questionAr')}
            >
              {(p) => <Input {...p} dir="rtl" lang="ar" maxLength={500} value={questionAr} onChange={(e) => setQuestionAr(e.target.value)} />}
            </Field>
            <fieldset className="stack stack--sm" style={{ border: 0, padding: 0, margin: 0 }}>
              <legend>Options, in the order shown (2 to 10)</legend>
              {options.map((o, i) => (
                <div key={i} className="form__row" style={{ alignItems: 'end' }}>
                  <Field label={`Option ${i + 1} (English)`} error={fieldError(save.error, `options.${i}.labelEn`)}>
                    {(p) => (
                      <Input {...p} maxLength={200} disabled={!hasEn} value={o.labelEn} onChange={(e) => setOption(i, { labelEn: e.target.value })} />
                    )}
                  </Field>
                  <Field label={`Option ${i + 1} (Arabic)`} error={fieldError(save.error, `options.${i}.labelAr`)}>
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
                      Remove
                    </Button>
                  ) : null}
                </div>
              ))}
              {options.length < 10 ? (
                <div>
                  <Button type="button" size="sm" icon={<Plus aria-hidden />} onClick={() => setOptions([...options, { labelEn: '', labelAr: '' }])}>
                    Add an option
                  </Button>
                </div>
              ) : null}
            </fieldset>
            <Checkbox label="Several options may be chosen" checked={multiple} onChange={(e) => setMultiple(e.target.checked)} />
          </>
        )}
        <div className="form__row">
          {closingOnly ? null : (
            <DateTimeField
              label="Opens"
              hint="Empty: now. Residents see it from then on."
              value={opensAt}
              onChange={setOpensAt}
              error={fieldError(save.error, 'opensAt')}
            />
          )}
          <DateTimeField
            label="Closes"
            hint="It closes by itself then, and the results are shown to everyone."
            value={closesAt}
            onChange={setClosesAt}
            error={fieldError(save.error, 'closesAt')}
          />
        </div>
        {closingOnly ? null : (
          <AudiencePicker
            value={audience}
            onChange={setAudience}
            hint="Owners only: a unit’s owner casts its vote. Otherwise its primary resident does, or a household member they gave the vote to."
          />
        )}
        <ErrorAlert error={save.error} />
      </div>
    </Dialog>
  );
}
