'use client';

import { ErrorText, REASON_CODES, unwrap } from '@jiwar/api';
import { ErrorAlert, fieldError, useAction } from '@jiwar/api/react';
import { Button, Dialog, Field, Input, Select, Textarea, useToast } from '@jiwar/ui';
import { useState } from 'react';
import { FileUpload } from '@/components/file-upload';
import { instantOf } from '@/components/security/logic';
import { GuardPicker } from '@/components/security/pickers';
import { UnitPicker } from '@/components/unit-picker';
import { api } from '@/lib/api';

const words = (code: string) => code.replace(/_/g, ' ');
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
        toast.show('Entry recorded. The unit’s people are told now; write the report once you are out.');
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
      title="Record an emergency entry"
      description="Staff went into a unit without its owner. Its occupants and its proxy are told at once."
      onSubmit={() => save.mutate(undefined)}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" loading={save.isPending} disabled={!ready}>
            Record and tell the unit
          </Button>
        </>
      }
    >
      <div className="form">
        <ErrorAlert error={save.error} />
        {unit ? (
          <p className="t-secondary">Unit {unit.code}</p>
        ) : (
          <Field label="Unit" error={fieldError(save.error, 'unitId')}>
            {(p) => <UnitPicker {...p} value={unitId} onChange={(e) => setUnitId(e.target.value)} />}
          </Field>
        )}
        <Field label="Why" error={fieldError(save.error, 'reasonCode')}>
          {(p) => (
            <Select {...p} value={reasonCode} onChange={(e) => setReasonCode(e.target.value)}>
              <option value="">Select a reason…</option>
              {REASON_CODES.unitEntryReason.map((c) => (
                <option key={c} value={c}>
                  {words(c)}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="When staff went in" hint="Within the last week; empty for now." error={fieldError(save.error, 'enteredAt')}>
          {(p) => <Input {...p} type="datetime-local" value={enteredAt} onChange={(e) => setEnteredAt(e.target.value)} />}
        </Field>
        {witnesses.map((w, i) => (
          <Field
            key={i}
            label={i === 0 ? 'Witness' : 'Second witness (optional)'}
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
          label={`Photo before (${photos.length} of 5)`}
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
        toast.show('Report written. The unit’s people are told.');
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
      title={`Report ${entry.reference}`}
      description={`What staff found in ${entry.unitCode}, and did. The unit’s people read it.`}
      onSubmit={() => save.mutate(undefined)}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" loading={save.isPending} disabled={!ready}>
            Write the report
          </Button>
        </>
      }
    >
      <div className="form">
        {save.error ? <p className="t-error"><ErrorText error={save.error} /></p> : null}
        <Field label="What was found" error={fieldError(save.error, 'outcome')}>
          {(p) => (
            <Select {...p} value={outcome} onChange={(e) => setOutcome(e.target.value)}>
              <option value="">Select…</option>
              {REASON_CODES.unitEntryOutcome.map((c) => (
                <option key={c} value={c}>
                  {words(c)}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="What staff did" error={fieldError(save.error, 'note')}>
          {(p) => <Textarea {...p} rows={4} maxLength={2000} value={note} onChange={(e) => setNote(e.target.value)} />}
        </Field>
        <FileUpload
          purpose="unit_entry_photo"
          label={`Photo after (${photos.length} of 5)`}
          disabled={photos.length >= 5}
          onUploaded={(id) => setPhotos([...photos, id])}
        />
      </div>
    </Dialog>
  );
}
