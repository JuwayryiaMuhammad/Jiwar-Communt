'use client';

import { fieldError, unwrap } from '@jiwar/api';
import { ErrorAlert, QueryState, useAction } from '@jiwar/api/react';
import { useFormat, useLocale, useT } from '@jiwar/i18n';
import {
  Badge,
  Button,
  Card,
  CardBody,
  ConfirmDialog,
  Dialog,
  Field,
  ForbiddenState,
  PageHeader,
  Select,
  StatusBadge,
  Textarea,
  useCommonT,
  useLabel,
  useToast,
} from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { AttachmentPicker, Attachments, Back, SectionHeader, TextFields, TwoLanguages, type TwoTexts } from '@/components/community/bits';
import { languagesReady, needsResponse, nextStatuses, textOrNull } from '@/components/community/logic';
import { api } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys, type SuggestionDetail, type SuggestionStatus } from '@/lib/queries';
import ar from '@/messages/ar/community-suggestions';
import en from '@/messages/en/community-suggestions';

type Open = 'move' | 'respond' | 'publish' | 'unpublish' | 'note' | null;

/** A step forward, with or without an answer; or an answer alone. */
function AnswerDialog({ suggestion, move, onClose }: { suggestion: SuggestionDetail; move: boolean; onClose: () => void }) {
  const t = useT(en, ar);
  const c = useCommonT();
  const label = useLabel();
  const toast = useToast();
  const steps = nextStatuses(suggestion.status);
  const [status, setStatus] = useState<SuggestionStatus>(steps[0] ?? suggestion.status);
  const [response, setResponse] = useState(move ? '' : (suggestion.response ?? ''));
  const save = useAction(
    () =>
      move
        ? unwrap(
            api.POST('/api/v1/community/suggestions/{id}/status', {
              params: { path: { id: suggestion.id } },
              body: { status, ...(response.trim() ? { response: response.trim() } : {}) },
            }),
          )
        : unwrap(
            api.PUT('/api/v1/community/suggestions/{id}/response', {
              params: { path: { id: suggestion.id } },
              body: { response: response.trim() },
            }),
          ),
    {
      invalidate: [keys.suggestionsAll],
      onDone: () => {
        toast.show(move ? t('moved', { status }) : t('answered'));
        onClose();
      },
    },
  );
  const ready = move ? !needsResponse(status) || response.trim() !== '' : response.trim() !== '';
  return (
    <Dialog
      open
      onClose={onClose}
      title={move ? t('moveTitle') : t('answerTitle')}
      description={t('answerDescription')}
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
        {move ? (
          <Field label={t('newStatus')} hint={t('newStatusHint')} error={fieldError(save.error, 'status')}>
            {(p) => (
              <Select {...p} value={status} onChange={(e) => setStatus(e.target.value as SuggestionStatus)}>
                {steps.map((s) => (
                  <option key={s} value={s}>
                    {label(s)}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        ) : null}
        <Field
          label={t('answerLabel')}
          hint={move && needsResponse(status) ? t('answerRequired') : move ? t('answerOptional') : t('answerReplaces')}
          error={fieldError(save.error, 'response')}
        >
          {(p) => <Textarea {...p} dir="auto" rows={4} maxLength={2000} value={response} onChange={(e) => setResponse(e.target.value)} />}
        </Field>
        <ErrorAlert error={save.error} />
      </div>
    </Dialog>
  );
}

/** Puts it on the board under a summary the staff write. */
function PublishDialog({ suggestion, onClose }: { suggestion: SuggestionDetail; onClose: () => void }) {
  const t = useT(en, ar);
  const c = useCommonT();
  const toast = useToast();
  const s = suggestion.publicSummary;
  const [text, setText] = useState<TwoTexts>({
    titleEn: s?.titleEn ?? '',
    bodyEn: s?.textEn ?? '',
    titleAr: s?.titleAr ?? '',
    bodyAr: s?.textAr ?? '',
  });
  const save = useAction(
    () =>
      unwrap(
        api.POST('/api/v1/community/suggestions/{id}/publish', {
          params: { path: { id: suggestion.id } },
          body: {
            titleEn: textOrNull(text.titleEn),
            textEn: textOrNull(text.bodyEn),
            titleAr: textOrNull(text.titleAr),
            textAr: textOrNull(text.bodyAr),
          },
        }),
      ),
    {
      invalidate: [keys.suggestionsAll],
      onDone: () => {
        toast.show(t('published'));
        onClose();
      },
    },
  );
  const ready = languagesReady([text.titleEn, text.bodyEn], [text.titleAr, text.bodyAr]);
  return (
    <Dialog
      open
      onClose={onClose}
      wide
      title={suggestion.publishedAt ? t('rewriteTitle') : t('publishTitle')}
      description={t('publishDescription')}
      onSubmit={() => ready && save.mutate()}
      footer={
        <>
          <Button onClick={onClose}>{c('cancel')}</Button>
          <Button type="submit" variant="primary" loading={save.isPending} disabled={!ready}>
            {suggestion.publishedAt ? c('save') : t('publish')}
          </Button>
        </>
      }
    >
      <div className="form">
        <TextFields value={text} onChange={setText} error={save.error} bodyKey="text" bodyLabel={t('summary')} bodyMax={2000} />
        <ErrorAlert error={save.error} />
      </div>
    </Dialog>
  );
}

/** What was done, with photos: the "we did" of "you said, we did". */
function DoneNoteDialog({ suggestion, onClose }: { suggestion: SuggestionDetail; onClose: () => void }) {
  const t = useT(en, ar);
  const c = useCommonT();
  const toast = useToast();
  const [noteEn, setNoteEn] = useState(suggestion.done?.noteEn ?? '');
  const [noteAr, setNoteAr] = useState(suggestion.done?.noteAr ?? '');
  const photos = suggestion.done?.photos ?? [];
  const [kept, setKept] = useState<string[]>(photos.map((p) => p.id));
  const [added, setAdded] = useState<string[]>([]);
  const save = useAction(
    () =>
      unwrap(
        api.PUT('/api/v1/community/suggestions/{id}/done-note', {
          params: { path: { id: suggestion.id } },
          body: { noteEn: textOrNull(noteEn), noteAr: textOrNull(noteAr), attachmentFileIds: [...kept, ...added] },
        }),
      ),
    {
      invalidate: [keys.suggestionsAll],
      onDone: () => {
        toast.show(t('noteSaved'));
        onClose();
      },
    },
  );
  const ready = noteEn.trim() !== '' || noteAr.trim() !== '';
  return (
    <Dialog
      open
      onClose={onClose}
      wide
      title={t('doneTitle')}
      description={t('doneDescription')}
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
        <Field label={t('noteEn')} error={fieldError(save.error, 'noteEn')}>
          {(p) => <Textarea {...p} dir="ltr" lang="en" rows={3} maxLength={2000} value={noteEn} onChange={(e) => setNoteEn(e.target.value)} />}
        </Field>
        <Field label={t('noteAr')} hint={t('noteHint')} error={fieldError(save.error, 'noteAr')}>
          {(p) => <Textarea {...p} dir="rtl" lang="ar" rows={3} maxLength={2000} value={noteAr} onChange={(e) => setNoteAr(e.target.value)} />}
        </Field>
        <AttachmentPicker existing={photos} kept={kept} onKeptChange={setKept} added={added} onAddedChange={setAdded} label={t('addPhoto')} />
        <ErrorAlert error={save.error} />
      </div>
    </Dialog>
  );
}

export default function SuggestionPage() {
  const t = useT(en, ar);
  const fmt = useFormat();
  const { locale } = useLocale();
  const { id } = useParams<{ id: string }>();
  const toast = useToast();
  const { can, ready } = usePermissions();
  const allowed = can('community.suggestions');
  const query = useQuery({ queryKey: keys.suggestion(id), queryFn: () => fetchers.suggestion(id), enabled: allowed });
  const [open, setOpen] = useState<Open>(null);
  const unpublish = useAction(() => unwrap(api.POST('/api/v1/community/suggestions/{id}/unpublish', { params: { path: { id } } })), {
    invalidate: [keys.suggestionsAll],
    onDone: () => {
      toast.show(t('offBoard'));
      setOpen(null);
    },
  });

  if (ready && !allowed) return <ForbiddenState />;
  const s = query.data;
  const steps = s ? nextStatuses(s.status) : [];
  const author = s ? (s.author.fullName ?? t('erased')) : '';

  return (
    <>
      <PageHeader
        title={t('suggestion')}
        back={<Back href="/suggestions" label={t('title')} />}
        actions={
          s ? (
            <>
              <Button onClick={() => setOpen('respond')}>{s.response ? t('changeAnswer') : t('answer')}</Button>
              {steps.length ? (
                <Button variant="primary" onClick={() => setOpen('move')}>
                  {t('moveForward')}
                </Button>
              ) : null}
            </>
          ) : null
        }
      />
      <QueryState query={query}>
        {s ? (
          <div className="stack">
            <Card>
              <SectionHeader title={t('wrote')} description={t('wroteHint')} />
              <CardBody>
                <div className="stack">
                  <span className="row" style={{ gap: 8 }}>
                    <StatusBadge status={s.status} />
                    <Badge plain>{locale === 'ar' ? s.topic.nameAr : s.topic.nameEn}</Badge>
                  </span>
                  {s.body ? (
                    <p dir="auto" style={{ whiteSpace: 'pre-wrap', margin: 0 }}>
                      {s.body}
                    </p>
                  ) : (
                    <span className="t-secondary">{t('bodyErased')}</span>
                  )}
                  <dl className="dl">
                    <dt>{t('from')}</dt>
                    <dd>{s.unitCode ? t('fromUnit', { name: author, unit: s.unitCode }) : author}</dd>
                    <dt>{t('received')}</dt>
                    <dd>{fmt.dateTime(s.createdAt)}</dd>
                  </dl>
                </div>
              </CardBody>
            </Card>
            <Card>
              <SectionHeader title={t('yourAnswer')} description={t('yourAnswerHint')} />
              <CardBody>
                <div className="stack">
                  {s.response ? (
                    <p dir="auto" style={{ whiteSpace: 'pre-wrap', margin: 0 }}>
                      {s.response}
                    </p>
                  ) : (
                    <span className="t-secondary">{t('notAnswered')}</span>
                  )}
                  {s.updates.length ? (
                    <ol className="stack stack--sm" style={{ paddingInlineStart: 18, margin: 0 }}>
                      {s.updates.map((u, i) => (
                        <li key={i}>
                          <span className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                            <StatusBadge status={u.status} />
                            <span className="t-secondary">{fmt.dateTime(u.at)}</span>
                          </span>
                          {u.response ? (
                            <span dir="auto" style={{ whiteSpace: 'pre-wrap' }}>
                              {u.response}
                            </span>
                          ) : null}
                        </li>
                      ))}
                    </ol>
                  ) : null}
                </div>
              </CardBody>
            </Card>
            <Card>
              <SectionHeader
                title={t('publicBoard')}
                description={t('publicBoardHint')}
                actions={
                  s.publishedAt ? (
                    <>
                      <Button onClick={() => setOpen('publish')}>{t('rewriteSummary')}</Button>
                      <Button variant="danger" onClick={() => setOpen('unpublish')}>
                        {t('takeOff')}
                      </Button>
                    </>
                  ) : (
                    <Button onClick={() => setOpen('publish')}>{t('publishToBoard')}</Button>
                  )
                }
              />
              <CardBody>
                {s.publicSummary ? (
                  <div className="stack">
                    <TwoLanguages en={s.publicSummary.titleEn} ar={s.publicSummary.titleAr} strong />
                    <TwoLanguages en={s.publicSummary.textEn} ar={s.publicSummary.textAr} />
                    <span className="t-secondary">{t('onBoardSince', { when: fmt.dateTime(s.publishedAt), n: s.supports })}</span>
                  </div>
                ) : (
                  <span className="t-secondary">{t('notOnBoard')}</span>
                )}
              </CardBody>
            </Card>
            {s.status === 'done' ? (
              <Card>
                <SectionHeader
                  title={t('weDidTitle')}
                  description={t('weDidHint')}
                  actions={<Button onClick={() => setOpen('note')}>{s.done?.noteEn || s.done?.noteAr ? t('changeNote') : t('sayDone')}</Button>}
                />
                <CardBody>
                  {s.done && (s.done.noteEn || s.done.noteAr) ? (
                    <div className="stack">
                      <TwoLanguages en={s.done.noteEn} ar={s.done.noteAr} />
                      <Attachments items={s.done.photos} />
                    </div>
                  ) : (
                    <span className="t-secondary">{t('nothingSaid')}</span>
                  )}
                </CardBody>
              </Card>
            ) : null}
          </div>
        ) : null}
      </QueryState>
      {s && (open === 'move' || open === 'respond') ? <AnswerDialog key={open} suggestion={s} move={open === 'move'} onClose={() => setOpen(null)} /> : null}
      {s && open === 'publish' ? <PublishDialog suggestion={s} onClose={() => setOpen(null)} /> : null}
      {s && open === 'note' ? <DoneNoteDialog suggestion={s} onClose={() => setOpen(null)} /> : null}
      <ConfirmDialog
        open={open === 'unpublish'}
        onClose={() => setOpen(null)}
        title={t('takeOffTitle')}
        description={t('takeOffDescription')}
        confirmLabel={t('takeOff')}
        danger
        pending={unpublish.isPending}
        error={unpublish.error ? <ErrorAlert error={unpublish.error} /> : undefined}
        onConfirm={() => unpublish.mutate()}
      />
    </>
  );
}
