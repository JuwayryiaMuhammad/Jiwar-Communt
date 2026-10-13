'use client';

import { fieldError, unwrap } from '@jiwar/api';
import { ErrorAlert, useAction } from '@jiwar/api/react';
import { Button, Checkbox, Dialog, Field, Input, Select, useToast } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '@/lib/api';
import { fetchers, keys, type AnnouncementDetail, type AnnouncementKind } from '@/lib/queries';
import { AttachmentPicker, AudiencePicker, DateTimeField, EVERYONE, TextFields, type AudienceValue, type TwoTexts } from './bits';
import { announcementActions, audienceBody, languagesReady, textOrNull, toIso, toLocalInput } from './logic';

type AreaKind = NonNullable<AnnouncementDetail['works']>['areaKind'];

/**
 * The composer: writes a new announcement as a draft, or changes one. New
 * words or files make a new version; the audience can change only until the
 * announcement is out.
 */
export function AnnouncementDialog({
  announcement,
  kind: initialKind,
  open,
  onClose,
  onSaved,
}: {
  announcement: AnnouncementDetail | null;
  kind: AnnouncementKind;
  open: boolean;
  onClose: () => void;
  onSaved: (id: string) => void;
}) {
  const toast = useToast();
  const a = announcement;
  const kind = a?.kind ?? initialKind;
  const actions = a ? announcementActions(a.status) : announcementActions('draft');
  const [text, setText] = useState<TwoTexts>({
    titleEn: a?.titleEn ?? '',
    bodyEn: a?.bodyEn ?? '',
    titleAr: a?.titleAr ?? '',
    bodyAr: a?.bodyAr ?? '',
  });
  const [important, setImportant] = useState(a?.priority === 'important');
  const [pinnedUntil, setPinnedUntil] = useState(toLocalInput(a?.pinnedUntil));
  const [expiresAt, setExpiresAt] = useState(toLocalInput(a?.expiresAt));
  const [audience, setAudience] = useState<AudienceValue>(
    a ? { occupancy: a.audience.occupancy, buildings: a.audience.buildings ?? [] } : EVERYONE,
  );
  const [startsAt, setStartsAt] = useState(toLocalInput(a?.works?.startsAt));
  const [endsAt, setEndsAt] = useState(toLocalInput(a?.works?.endsAt));
  const [areaKind, setAreaKind] = useState<AreaKind>(a?.works?.areaKind ?? 'road');
  const [gateId, setGateId] = useState(a?.works?.gate?.id ?? '');
  const [place, setPlace] = useState(a?.works?.place ?? '');
  const [kept, setKept] = useState<string[]>(a?.attachments.map((x) => x.id) ?? []);
  const [added, setAdded] = useState<string[]>([]);
  const [idempotencyKey] = useState(() => crypto.randomUUID());
  const gates = useQuery({ queryKey: keys.gates, queryFn: fetchers.gates, enabled: open && kind === 'works' });

  const body = () => ({
    titleEn: textOrNull(text.titleEn),
    bodyEn: textOrNull(text.bodyEn),
    titleAr: textOrNull(text.titleAr),
    bodyAr: textOrNull(text.bodyAr),
    priority: important ? ('important' as const) : ('normal' as const),
    pinnedUntil: important ? toIso(pinnedUntil) : null,
    ...(kind === 'general' ? { expiresAt: toIso(expiresAt) } : {}),
    ...(actions.audience ? { audience: audienceBody(audience.occupancy, audience.buildings) } : {}),
    ...(kind === 'works'
      ? {
          works: {
            startsAt: toIso(startsAt) ?? '',
            endsAt: toIso(endsAt) ?? '',
            areaKind,
            gateId: areaKind === 'gate' && gateId ? gateId : null,
            place: textOrNull(place),
          },
        }
      : {}),
    attachmentFileIds: [...kept, ...added],
  });

  const save = useAction(
    async () => {
      if (a) {
        await unwrap(api.PATCH('/api/v1/community/announcements/{id}', { params: { path: { id: a.id } }, body: body() }));
        return a.id;
      }
      const created = await unwrap(
        api.POST('/api/v1/community/announcements', {
          params: { header: { 'Idempotency-Key': idempotencyKey } },
          body: { kind, ...body() },
        }),
      );
      return created.id;
    },
    {
      invalidate: [keys.announcementsAll],
      onDone: (id) => {
        toast.show(a ? 'The announcement is saved.' : 'The draft is saved. Nobody sees it until it is published.');
        onSaved(id);
      },
    },
  );
  const ready =
    languagesReady([text.titleEn, text.bodyEn], [text.titleAr, text.bodyAr]) && (kind !== 'works' || (startsAt !== '' && endsAt !== ''));
  const what = kind === 'works' ? 'works and closures' : 'announcement';

  return (
    <Dialog
      open={open}
      onClose={onClose}
      wide
      title={a ? `Edit ${what}` : `New ${what}`}
      description={
        a && a.status !== 'draft' && a.status !== 'scheduled'
          ? 'It is out: new words or files show as "edited", and the earlier version is kept.'
          : 'Saved as a draft. It is published, now or at a time you choose, from its page.'
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
        <TextFields value={text} onChange={setText} error={save.error} />
        {kind === 'works' ? (
          <>
            <div className="form__row">
              <DateTimeField label="Starts" value={startsAt} onChange={setStartsAt} error={fieldError(save.error, 'works.startsAt')} />
              <DateTimeField
                label="Ends"
                hint="It stops being shown by itself then."
                value={endsAt}
                onChange={setEndsAt}
                error={fieldError(save.error, 'works.endsAt')}
              />
            </div>
            <div className="form__row">
              <Field label="What is affected">
                {(p) => (
                  <Select {...p} value={areaKind} onChange={(e) => setAreaKind(e.target.value as AreaKind)}>
                    <option value="road">A road</option>
                    <option value="facility">A facility</option>
                    <option value="gate">A gate</option>
                  </Select>
                )}
              </Field>
              {areaKind === 'gate' ? (
                <Field label="Gate" error={fieldError(save.error, 'works.gateId')}>
                  {(p) => (
                    <Select {...p} value={gateId} onChange={(e) => setGateId(e.target.value)}>
                      <option value="">Not one in particular</option>
                      {(gates.data?.data ?? []).map((g) => (
                        <option key={g.id} value={g.id}>
                          {g.name}
                        </option>
                      ))}
                    </Select>
                  )}
                </Field>
              ) : null}
            </div>
            <Field label="Where" hint="In your words, e.g. the road behind building C." error={fieldError(save.error, 'works.place')}>
              {(p) => <Input {...p} maxLength={200} value={place} onChange={(e) => setPlace(e.target.value)} />}
            </Field>
          </>
        ) : null}
        <Checkbox
          label="Important: its audience is notified when it comes out, and it may be pinned"
          checked={important}
          onChange={(e) => setImportant(e.target.checked)}
        />
        <div className="form__row">
          {important ? (
            <DateTimeField
              label="Pinned until"
              hint="Stays on top of the feed until then. Empty: not pinned."
              value={pinnedUntil}
              onChange={setPinnedUntil}
              error={fieldError(save.error, 'pinnedUntil')}
            />
          ) : null}
          {kind === 'general' ? (
            <DateTimeField
              label="Expires"
              hint="No longer shown from then on. Empty: until archived."
              value={expiresAt}
              onChange={setExpiresAt}
              error={fieldError(save.error, 'expiresAt')}
            />
          ) : null}
        </div>
        <AudiencePicker
          value={audience}
          onChange={setAudience}
          disabled={!actions.audience}
          hint={actions.audience ? undefined : 'The audience is fixed once the announcement is out.'}
        />
        <AttachmentPicker existing={a?.attachments ?? []} kept={kept} onKeptChange={setKept} added={added} onAddedChange={setAdded} />
        <ErrorAlert error={save.error} />
      </div>
    </Dialog>
  );
}
