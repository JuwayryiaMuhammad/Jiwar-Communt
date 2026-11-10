'use client';

import { fieldError, unwrap } from '@jiwar/api';
import { ErrorAlert, useAction } from '@jiwar/api/react';
import { useT } from '@jiwar/i18n';
import { Button, Checkbox, Dialog, Field, Input, Select, useCommonT, useToast } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '@/lib/api';
import { fetchers, keys, type AnnouncementDetail, type AnnouncementKind } from '@/lib/queries';
import ar from '@/messages/ar/community';
import en from '@/messages/en/community';
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
  /** What the staff write: the board's own kind is never theirs (ADR 0051). */
  kind: Exclude<AnnouncementKind, 'board'>;
  open: boolean;
  onClose: () => void;
  onSaved: (id: string) => void;
}) {
  const t = useT(en, ar);
  const c = useCommonT();
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
          body: { kind: initialKind, ...body() },
        }),
      );
      return created.id;
    },
    {
      invalidate: [keys.announcementsAll],
      onDone: (id) => {
        toast.show(a ? t('announcement.saved') : t('announcement.draftSaved'));
        onSaved(id);
      },
    },
  );
  const ready =
    languagesReady([text.titleEn, text.bodyEn], [text.titleAr, text.bodyAr]) && (kind !== 'works' || (startsAt !== '' && endsAt !== ''));

  return (
    <Dialog
      open={open}
      onClose={onClose}
      wide
      title={a ? t('announcement.editTitle', { kind }) : t('announcement.newTitle', { kind })}
      description={
        a && a.status !== 'draft' && a.status !== 'scheduled' ? t('announcement.outDescription') : t('announcement.draftDescription')
      }
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
        <TextFields value={text} onChange={setText} error={save.error} />
        {kind === 'works' ? (
          <>
            <div className="form__row">
              <DateTimeField label={t('starts')} value={startsAt} onChange={setStartsAt} error={fieldError(save.error, 'works.startsAt')} />
              <DateTimeField
                label={t('ends')}
                hint={t('works.endsHint')}
                value={endsAt}
                onChange={setEndsAt}
                error={fieldError(save.error, 'works.endsAt')}
              />
            </div>
            <div className="form__row">
              <Field label={t('works.affected')}>
                {(p) => (
                  <Select {...p} value={areaKind} onChange={(e) => setAreaKind(e.target.value as AreaKind)}>
                    <option value="road">{t('area.road')}</option>
                    <option value="facility">{t('area.facility')}</option>
                    <option value="gate">{t('area.gate')}</option>
                  </Select>
                )}
              </Field>
              {areaKind === 'gate' ? (
                <Field label={t('works.gate')} error={fieldError(save.error, 'works.gateId')}>
                  {(p) => (
                    <Select {...p} value={gateId} onChange={(e) => setGateId(e.target.value)}>
                      <option value="">{t('works.anyGate')}</option>
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
            <Field label={t('where')} hint={t('works.whereHint')} error={fieldError(save.error, 'works.place')}>
              {(p) => <Input {...p} maxLength={200} value={place} onChange={(e) => setPlace(e.target.value)} />}
            </Field>
          </>
        ) : null}
        <Checkbox
          label={t('announcement.important')}
          checked={important}
          onChange={(e) => setImportant(e.target.checked)}
        />
        <div className="form__row">
          {important ? (
            <DateTimeField
              label={t('announcement.pinnedUntil')}
              hint={t('announcement.pinnedHint')}
              value={pinnedUntil}
              onChange={setPinnedUntil}
              error={fieldError(save.error, 'pinnedUntil')}
            />
          ) : null}
          {kind === 'general' ? (
            <DateTimeField
              label={t('announcement.expires')}
              hint={t('announcement.expiresHint')}
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
          hint={actions.audience ? undefined : t('announcement.audienceFixed')}
        />
        <AttachmentPicker existing={a?.attachments ?? []} kept={kept} onKeptChange={setKept} added={added} onAddedChange={setAdded} />
        <ErrorAlert error={save.error} />
      </div>
    </Dialog>
  );
}
