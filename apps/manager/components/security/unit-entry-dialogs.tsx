'use client';

import { ErrorText, REASON_CODES, unwrap } from '@jiwar/api';
import { ErrorAlert, fieldError, useAction } from '@jiwar/api/react';
import { useT } from '@jiwar/i18n';
import { Button, Dialog, Field, Input, Select, Textarea, useCommonT, useLabel, useToast } from '@jiwar/ui';
import { useState } from 'react';
import { FileUpload } from '@/components/file-upload';
import { instantOf } from '@/components/security/logic';
import { GuardPicker } from '@/components/security/pickers';
import { UnitPicker } from '@/components/unit-picker';
import { api } from '@/lib/api';
import ar from '@/messages/ar/sec-unit-entries';
import en from '@/messages/en/sec-unit-entries';

const ENTRIES = ['unit-entries'] as const;

/**
 * An emergency entry into a unit (ADR 0083): who went in with the caller
 * (two staff at least), why, when, and photos before. The unit's people are
 * told as soon as it is saved: it is never silent.
 */
export function RecordEntryDialog({
  unit,
  onClose,
}: {
  unit?: { id: string; code: string };
  onClose: () => void;
}) {
  const t = useT(en, ar);
  const c = useCommonT();
  const label = useLabel();
  const toast = useToast();
  const [unitId, setUnitId] = useState(unit?.id ?? '');
  const [reasonCode, setReasonCode] = useState('');
  const [enteredAt, setEnteredAt] = useState('');
  const [witnesses, setWitnesses] = useState<string[]>(['', '']);
  const [photos, setPhotos] = useState<string[]>([]);
  const [idempotencyKey] = useState(() => crypto.randomUUID());
  const witnessIds = [...new Set(witnesses.filter(Boolean))];
  const save = useAction(
    () =>
      unwrap(
        api.POST('/api/v1/staff/security/unit-entries', {
          params: { header: { 'Idempotency-Key': idempotencyKey } },
          body: {
            unitId,
            reasonCode: reasonCode as (typeof REASON_CODES.unitEntryReason)[number],
            enteredAt: instantOf(enteredAt) ?? new Date().toISOString(),
            witnessIds,
            ...(photos.length ? { photoFileIds: photos } : {}),
          },
        }),
      ),
    {
      invalidate: [ENTRIES, ['closed-units']],
      onDone: () => {
        toast.show(t('recorded'));
        onClose();
      },
    },
  );
  const ready = unitId !== '' && reasonCode !== '' && witnessIds.length > 0;
  return (
    <Dialog
      open
      wide
      onClose={onClose}
      title={t('recordTitle')}
      description={t('recordDescription')}
      onSubmit={() => save.mutate(undefined)}
      footer={
        <>
          <Button onClick={onClose}>{c('cancel')}</Button>
          <Button type="submit" variant="primary" loading={save.isPending} disabled={!ready}>
            {t('recordAndTell')}
          </Button>
        </>
      }
    >
      <div className="form">
        <ErrorAlert error={save.error} />
        {unit ? (
          <p className="t-secondary">{t('unitLine', { code: unit.code })}</p>
        ) : (
          <Field label={c('unit')} error={fieldError(save.error, 'unitId')}>
            {(p) => <UnitPicker {...p} value={unitId} onChange={(e) => setUnitId(e.target.value)} />}
          </Field>
        )}
        <Field label={t('col.why')} error={fieldError(save.error, 'reasonCode')}>
          {(p) => (
            <Select {...p} value={reasonCode} onChange={(e) => setReasonCode(e.target.value)}>
              <option value="">{t('selectReason')}</option>
              {REASON_CODES.unitEntryReason.map((code) => (
                <option key={code} value={code}>
                  {label(code)}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label={t('whenWentIn')} hint={t('whenHint')} error={fieldError(save.error, 'enteredAt')}>
          {(p) => <Input {...p} type="datetime-local" value={enteredAt} onChange={(e) => setEnteredAt(e.target.value)} />}
        </Field>
        {witnesses.map((w, i) => (
          <Field
            key={i}
            label={i === 0 ? t('witness') : t('secondWitness')}
            error={i === 0 ? fieldError(save.error, 'witnessIds') : undefined}
          >
            {(p) => (
              <GuardPicker
                {...p}
                value={w}
                onChange={(e) => setWitnesses(witnesses.map((x, j) => (j === i ? e.target.value : x)))}
              />
            )}
          </Field>
        ))}
        <FileUpload
          purpose="unit_entry_photo"
          label={t('photoBefore', { n: photos.length })}
          disabled={photos.length >= 5}
          onUploaded={(id) => setPhotos([...photos, id])}
        />
      </div>
    </Dialog>
  );
}

/** The entry's report, once (ADR 0083): what was found, the words, photos after. */
export function ReportEntryDialog({
  entry,
  onClose,
}: {
  entry: { id: string; reference: string; unitCode: string };
  onClose: () => void;
}) {
  const t = useT(en, ar);
  const c = useCommonT();
  const label = useLabel();
  const toast = useToast();
  const [outcome, setOutcome] = useState('');
  const [note, setNote] = useState('');
  const [photos, setPhotos] = useState<string[]>([]);
  const save = useAction(
    () =>
      unwrap(
        api.POST('/api/v1/staff/security/unit-entries/{id}/report', {
          params: { path: { id: entry.id } },
          body: {
            outcome: outcome as (typeof REASON_CODES.unitEntryOutcome)[number],
            note: note.trim(),
            photoFileIds: photos,
          },
        }),
      ),
    {
      invalidate: [ENTRIES],
      onDone: () => {
        toast.show(t('reported'));
        onClose();
      },
    },
  );
  const ready = outcome !== '' && note.trim() !== '' && photos.length > 0;
  return (
    <Dialog
      open
      wide
      onClose={onClose}
      title={t('reportTitle', { reference: entry.reference })}
      description={t('reportDescription', { unit: entry.unitCode })}
      onSubmit={() => save.mutate(undefined)}
      footer={
        <>
          <Button onClick={onClose}>{c('cancel')}</Button>
          <Button type="submit" variant="primary" loading={save.isPending} disabled={!ready}>
            {t('writeReport')}
          </Button>
        </>
      }
    >
      <div className="form">
        {save.error ? (
          <p className="t-error">
            <ErrorText error={save.error} />
          </p>
        ) : null}
        <Field label={t('whatFound')} error={fieldError(save.error, 'outcome')}>
          {(p) => (
            <Select {...p} value={outcome} onChange={(e) => setOutcome(e.target.value)}>
              <option value="">{t('select')}</option>
              {REASON_CODES.unitEntryOutcome.map((code) => (
                <option key={code} value={code}>
                  {label(code)}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label={t('whatDid')} error={fieldError(save.error, 'note')}>
          {(p) => <Textarea {...p} rows={4} maxLength={2000} value={note} onChange={(e) => setNote(e.target.value)} />}
        </Field>
        <FileUpload
          purpose="unit_entry_photo"
          label={t('photoAfter', { n: photos.length })}
          disabled={photos.length >= 5}
          onUploaded={(id) => setPhotos([...photos, id])}
        />
      </div>
    </Dialog>
  );
}
