'use client';

import { fieldError, humanize, REASON_CODES, type Schema } from '@jiwar/api';
import { ErrorAlert } from '@jiwar/api/react';
import { Button, Dialog, Field, Input, Select, Textarea } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { FileUpload } from '@/components/file-upload';
import { addDays, validFineAmount } from '@/components/vehicles/logic';
import { fetchers, keys } from '@/lib/queries';

export type FineBody = Schema<'IssueFineDto'>;

const today = () => new Date().toLocaleDateString('en-CA');

/**
 * A fine's form (ADR 0045): the unit by its code, one of its vehicles or a
 * typed plate, a reason code, the amount, the day it happened, a note the
 * unit's people read and a photo. Issuing and converting a parking report
 * share it; a report's photo is never carried over.
 */
export function FineDialog({
  title,
  description,
  initial,
  confirmLabel,
  pending,
  error,
  onSubmit,
  onClose,
}: {
  title: string;
  description: string;
  initial?: { unitCode?: string; plate?: string };
  confirmLabel: string;
  pending: boolean;
  error: unknown;
  onSubmit: (body: FineBody) => void;
  onClose: () => void;
}) {
  const [unitCode, setUnitCode] = useState(initial?.unitCode ?? '');
  const [vehicleId, setVehicleId] = useState('');
  const [plate, setPlate] = useState(initial?.plate ?? '');
  const [reason, setReason] = useState('');
  const [amount, setAmount] = useState('');
  const [occurredOn, setOccurredOn] = useState(today());
  const [note, setNote] = useState('');
  const [photoFileId, setPhoto] = useState<string | null>(null);
  const code = unitCode.trim();
  const vehicles = useQuery({
    queryKey: keys.vehicles({ unitCode: code }),
    queryFn: () => fetchers.vehicles({ unitCode: code }, undefined, 50),
    enabled: code.length > 0,
  });
  const options = (vehicles.data?.data ?? []).filter((v) => v.status !== 'removed');
  const ready =
    code !== '' && (vehicleId !== '' || plate.trim() !== '') && reason !== '' && validFineAmount(amount) && occurredOn !== '';
  const body: FineBody = {
    unitCode: code,
    ...(vehicleId ? { vehicleId } : { plate: plate.trim() }),
    reason,
    amount: amount.trim(),
    occurredOn,
    ...(note.trim() ? { note: note.trim() } : {}),
    ...(photoFileId ? { photoFileId } : {}),
  };
  return (
    <Dialog
      open
      wide
      onClose={onClose}
      title={title}
      description={description}
      onSubmit={() => ready && onSubmit(body)}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" loading={pending} disabled={!ready}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      <div className="form">
        <Field label="Unit code" error={fieldError(error, 'unitCode')}>
          {(p) => <Input {...p} value={unitCode} onChange={(e) => setUnitCode(e.target.value)} />}
        </Field>
        <Field label="Vehicle" hint="One of the unit’s registered vehicles, or type the plate below." error={fieldError(error, 'vehicleId')}>
          {(p) => (
            <Select {...p} value={vehicleId} onChange={(e) => setVehicleId(e.target.value)} disabled={!code}>
              <option value="">Not registered: type the plate</option>
              {options.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.plate} · {v.makeAndModel}
                </option>
              ))}
            </Select>
          )}
        </Field>
        {vehicleId ? null : (
          <Field label="Plate" error={fieldError(error, 'plate')}>
            {(p) => <Input {...p} maxLength={40} value={plate} onChange={(e) => setPlate(e.target.value)} />}
          </Field>
        )}
        <Field label="Reason" error={fieldError(error, 'reason')}>
          {(p) => (
            <Select {...p} value={reason} onChange={(e) => setReason(e.target.value)}>
              <option value="">Select…</option>
              {REASON_CODES.vehicleFineReason.map((r) => (
                <option key={r} value={r}>
                  {humanize(r)}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field
          label="Amount, EGP"
          error={fieldError(error, 'amount') ?? (amount && !validFineAmount(amount) ? 'More than zero, at most 100,000, two decimals.' : undefined)}
        >
          {(p) => <Input {...p} inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />}
        </Field>
        <Field label="Day it happened" hint="Within the last 90 days." error={fieldError(error, 'occurredOn')}>
          {(p) => <Input {...p} type="date" min={addDays(today(), -90)} max={today()} value={occurredOn} onChange={(e) => setOccurredOn(e.target.value)} />}
        </Field>
        <Field label="Note for the unit" hint="Optional. The unit’s people read it." error={fieldError(error, 'note')}>
          {(p) => <Textarea {...p} maxLength={500} rows={3} value={note} onChange={(e) => setNote(e.target.value)} />}
        </Field>
        <Field label="Photo">
          {() =>
            photoFileId ? (
              <span className="row" style={{ gap: 8 }}>
                <span className="t-secondary">Photo attached.</span>
                <Button size="sm" onClick={() => setPhoto(null)}>
                  Remove
                </Button>
              </span>
            ) : (
              <FileUpload purpose="vehicle_fine_photo" label="Add a photo" onUploaded={setPhoto} />
            )
          }
        </Field>
        <ErrorAlert error={error} />
      </div>
    </Dialog>
  );
}
