'use client';

import { fieldError, unwrap } from '@jiwar/api';
import { ErrorAlert, useAction } from '@jiwar/api/react';
import { Button, Checkbox, Dialog, Field, Input, useToast } from '@jiwar/ui';
import { useState } from 'react';
import { api } from '@/lib/api';
import { keys, type CommunityEventDetail } from '@/lib/queries';
import { AttachmentPicker, AudiencePicker, DateTimeField, EVERYONE, TextFields, type AudienceValue, type TwoTexts } from './bits';
import { audienceBody, childAges, languagesReady, textOrNull, toIso, toLocalInput } from './logic';

/** Writes an event, or changes one that has not started. */
export function EventDialog({
  event,
  open,
  onClose,
  onSaved,
}: {
  event: CommunityEventDetail | null;
  open: boolean;
  onClose: () => void;
  onSaved: (id: string) => void;
}) {
  const toast = useToast();
  const [text, setText] = useState<TwoTexts>({
    titleEn: event?.titleEn ?? '',
    bodyEn: event?.descriptionEn ?? '',
    titleAr: event?.titleAr ?? '',
    bodyAr: event?.descriptionAr ?? '',
  });
  const [place, setPlace] = useState(event?.place ?? '');
  const [startsAt, setStartsAt] = useState(toLocalInput(event?.startsAt));
  const [endsAt, setEndsAt] = useState(toLocalInput(event?.endsAt));
  const [capacity, setCapacity] = useState(event?.capacity ? String(event.capacity) : '');
  const [audience, setAudience] = useState<AudienceValue>(EVERYONE);
  const [kept, setKept] = useState<string[]>(event?.attachments.map((x) => x.id) ?? []);
  const [added, setAdded] = useState<string[]>([]);
  const [idempotencyKey] = useState(() => crypto.randomUUID());
  // For children (ADR 0054): fixed once the event is saved.
  const [forChildren, setForChildren] = useState(false);
  const [ageMin, setAgeMin] = useState('5');
  const [ageMax, setAgeMax] = useState('12');
  const ages = childAges(ageMin, ageMax);

  const seats = capacity === '' ? null : Number(capacity);
  const body = () => ({
    titleEn: textOrNull(text.titleEn),
    descriptionEn: textOrNull(text.bodyEn),
    titleAr: textOrNull(text.titleAr),
    descriptionAr: textOrNull(text.bodyAr),
    place: place.trim(),
    startsAt: toIso(startsAt) ?? '',
    endsAt: toIso(endsAt) ?? '',
    capacity: seats,
    attachmentFileIds: [...kept, ...added],
  });
  const save = useAction(
    async () => {
      if (event) {
        await unwrap(api.PATCH('/api/v1/community/events/{id}', { params: { path: { id: event.id } }, body: body() }));
        return event.id;
      }
      const created = await unwrap(
        api.POST('/api/v1/community/events', {
          params: { header: { 'Idempotency-Key': idempotencyKey } },
          body: {
            ...body(),
            audience: audienceBody(audience.occupancy, audience.buildings),
            ...(forChildren && ages ? { forChildren: true, childAgeMin: ages.min, childAgeMax: ages.max } : {}),
          },
        }),
      );
      return created.id;
    },
    {
      invalidate: [keys.communityEventsAll],
      onDone: (id) => {
        toast.show(event ? 'The event is saved.' : 'The event is out: residents can answer.');
        onSaved(id);
      },
    },
  );
  const ready =
    languagesReady([text.titleEn, text.bodyEn], [text.titleAr, text.bodyAr]) &&
    place.trim() !== '' &&
    startsAt !== '' &&
    endsAt !== '' &&
    (seats === null || (Number.isInteger(seats) && seats >= 1)) &&
    (event !== null || !forChildren || ages !== null);

  return (
    <Dialog
      open={open}
      onClose={onClose}
      wide
      title={event ? 'Edit event' : 'New event'}
      description={
        event
          ? 'Whoever said they are going is not notified of a change: cancel the event if it can no longer be what they answered.'
          : 'It is out as soon as it is saved. Residents say whether they are going, and with how many guests.'
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
        <TextFields value={text} onChange={setText} error={save.error} bodyLabel="Description" bodyKey="description" />
        <Field label="Where" error={fieldError(save.error, 'place')}>
          {(p) => <Input {...p} maxLength={200} value={place} onChange={(e) => setPlace(e.target.value)} />}
        </Field>
        <div className="form__row">
          <DateTimeField label="Starts" value={startsAt} onChange={setStartsAt} error={fieldError(save.error, 'startsAt')} />
          <DateTimeField label="Ends" value={endsAt} onChange={setEndsAt} error={fieldError(save.error, 'endsAt')} />
        </div>
        <Field
          label="Seats"
          hint="Everyone counts, guests included. Empty: no limit. Never below the seats already taken."
          error={fieldError(save.error, 'capacity')}
        >
          {(p) => <Input {...p} type="number" min={1} step={1} value={capacity} onChange={(e) => setCapacity(e.target.value)} />}
        </Field>
        {event ? null : <AudiencePicker value={audience} onChange={setAudience} hint="Fixed once the event is saved." />}
        {event ? null : (
          <>
            <Checkbox
              label="For children: households register their children of these ages, each a seat (fixed once saved)"
              checked={forChildren}
              onChange={(e) => setForChildren(e.target.checked)}
            />
            {forChildren ? (
              <div className="form__row">
                <Field label="Youngest, years" error={fieldError(save.error, 'childAgeMin') ?? (ages ? undefined : 'Ages from 0 to 17, youngest first.')}>
                  {(p) => <Input {...p} type="number" min={0} max={17} step={1} value={ageMin} onChange={(e) => setAgeMin(e.target.value)} />}
                </Field>
                <Field label="Oldest, years" error={fieldError(save.error, 'childAgeMax')}>
                  {(p) => <Input {...p} type="number" min={0} max={17} step={1} value={ageMax} onChange={(e) => setAgeMax(e.target.value)} />}
                </Field>
              </div>
            ) : null}
          </>
        )}
        <AttachmentPicker existing={event?.attachments ?? []} kept={kept} onKeptChange={setKept} added={added} onAddedChange={setAdded} />
        <ErrorAlert error={save.error} />
      </div>
    </Dialog>
  );
}
