'use client';

import { fieldError, formatDateTime, humanize, unwrap } from '@jiwar/api';
import { ErrorAlert, QueryState, useAction } from '@jiwar/api/react';
import { Badge, Button, Card, CardBody, ConfirmDialog, Dialog, Field, ForbiddenState, PageHeader, Select, StatusBadge, Textarea, useToast } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { AttachmentPicker, Attachments, Back, SectionHeader, TextFields, TwoLanguages, type TwoTexts } from '@/components/community/bits';
import { languagesReady, needsResponse, nextStatuses, textOrNull } from '@/components/community/logic';
import { api } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys, type SuggestionDetail, type SuggestionStatus } from '@/lib/queries';

type Open = 'move' | 'respond' | 'publish' | 'unpublish' | 'note' | null;

/** A step forward, with or without an answer; or an answer alone. */
function AnswerDialog({ suggestion, move, onClose }: { suggestion: SuggestionDetail; move: boolean; onClose: () => void }) {
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
        toast.show(move ? `The suggestion is ${humanize(status).toLowerCase()}. Its author was told.` : 'The answer is saved. Its author was told.');
        onClose();
      },
    },
  );
  const ready = move ? !needsResponse(status) || response.trim() !== '' : response.trim() !== '';
  return (
    <Dialog
      open
      onClose={onClose}
      title={move ? 'Move the suggestion' : 'Answer the suggestion'}
      description="The author is notified that it moved or was answered; the answer itself is read on the suggestion, never in the notification."
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
        {move ? (
          <Field label="New status" hint="A suggestion only moves forward. Done and declined are final." error={fieldError(save.error, 'status')}>
            {(p) => (
              <Select {...p} value={status} onChange={(e) => setStatus(e.target.value as SuggestionStatus)}>
                {steps.map((s) => (
                  <option key={s} value={s}>
                    {humanize(s)}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        ) : null}
        <Field
          label="Answer to the author"
          hint={move && needsResponse(status) ? 'Required: tell them why.' : move ? 'Optional. Replaces an earlier answer.' : 'Replaces an earlier answer.'}
          error={fieldError(save.error, 'response')}
        >
          {(p) => <Textarea {...p} rows={4} maxLength={2000} value={response} onChange={(e) => setResponse(e.target.value)} />}
        </Field>
        <ErrorAlert error={save.error} />
      </div>
    </Dialog>
  );
}

/** Puts it on the board under a summary the staff write. */
function PublishDialog({ suggestion, onClose }: { suggestion: SuggestionDetail; onClose: () => void }) {
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
        toast.show('The suggestion is on the board, under your summary.');
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
      title={suggestion.publishedAt ? 'Rewrite the public summary' : 'Publish to the board'}
      description="Residents see this summary and can support it. They never see the author’s words, name or unit: write it so that it does not give them away."
      onSubmit={() => ready && save.mutate()}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" loading={save.isPending} disabled={!ready}>
            {suggestion.publishedAt ? 'Save' : 'Publish'}
          </Button>
        </>
      }
    >
      <div className="form">
        <TextFields value={text} onChange={setText} error={save.error} bodyKey="text" bodyLabel="Summary" bodyMax={2000} />
        <ErrorAlert error={save.error} />
      </div>
    </Dialog>
  );
}

/** What was done, with photos: the "we did" of "you said, we did". */
function DoneNoteDialog({ suggestion, onClose }: { suggestion: SuggestionDetail; onClose: () => void }) {
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
        toast.show('The note is saved. The suggestion is in "you said, we did".');
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
      title="What was done"
      description="Shown to every resident in “you said, we did”, with the photos. Never with the author."
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
        <Field label="Note (English)" error={fieldError(save.error, 'noteEn')}>
          {(p) => <Textarea {...p} rows={3} maxLength={2000} value={noteEn} onChange={(e) => setNoteEn(e.target.value)} />}
        </Field>
        <Field label="Note (Arabic)" hint="Write one language or both." error={fieldError(save.error, 'noteAr')}>
          {(p) => <Textarea {...p} dir="rtl" lang="ar" rows={3} maxLength={2000} value={noteAr} onChange={(e) => setNoteAr(e.target.value)} />}
        </Field>
        <AttachmentPicker existing={photos} kept={kept} onKeptChange={setKept} added={added} onAddedChange={setAdded} label="Add a photo" />
        <ErrorAlert error={save.error} />
      </div>
    </Dialog>
  );
}

export default function SuggestionPage() {
  const { id } = useParams<{ id: string }>();
  const toast = useToast();
  const { can, ready } = usePermissions();
  const allowed = can('community.suggestions');
  const query = useQuery({ queryKey: keys.suggestion(id), queryFn: () => fetchers.suggestion(id), enabled: allowed });
  const [open, setOpen] = useState<Open>(null);
  const unpublish = useAction(() => unwrap(api.POST('/api/v1/community/suggestions/{id}/unpublish', { params: { path: { id } } })), {
    invalidate: [keys.suggestionsAll],
    onDone: () => {
      toast.show('The suggestion is off the board.');
      setOpen(null);
    },
  });

  if (ready && !allowed) return <ForbiddenState />;
  const s = query.data;
  const steps = s ? nextStatuses(s.status) : [];

  return (
    <>
      <PageHeader
        title="Suggestion"
        back={<Back href="/suggestions" label="Suggestions" />}
        actions={
          s ? (
            <>
              <Button onClick={() => setOpen('respond')}>{s.response ? 'Change the answer' : 'Answer'}</Button>
              {steps.length ? (
                <Button variant="primary" onClick={() => setOpen('move')}>
                  Move forward
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
              <SectionHeader title="What the resident wrote" description="Private: only its author and the staff who handle suggestions read this." />
              <CardBody>
                <div className="stack">
                  <span className="row" style={{ gap: 8 }}>
                    <StatusBadge status={s.status} />
                    <Badge plain>{s.topic.nameEn}</Badge>
                  </span>
                  {s.body ? (
                    <p style={{ whiteSpace: 'pre-wrap', margin: 0 }}>{s.body}</p>
                  ) : (
                    <span className="t-secondary">The author’s account was erased, and their words with it. Your answer and the public summary are kept.</span>
                  )}
                  <dl className="dl">
                    <dt>From</dt>
                    <dd>
                      {s.author.fullName ?? 'Erased account'}
                      {s.unitCode ? `, unit ${s.unitCode}` : ''}
                    </dd>
                    <dt>Received</dt>
                    <dd>{formatDateTime(s.createdAt)}</dd>
                  </dl>
                </div>
              </CardBody>
            </Card>
            <Card>
              <SectionHeader title="Your answer" description="What the author reads on their suggestion." />
              <CardBody>
                <div className="stack">
                  {s.response ? <p style={{ whiteSpace: 'pre-wrap', margin: 0 }}>{s.response}</p> : <span className="t-secondary">Not answered yet.</span>}
                  {s.updates.length ? (
                    <ol className="stack stack--sm" style={{ paddingInlineStart: 18, margin: 0 }}>
                      {s.updates.map((u, i) => (
                        <li key={i}>
                          <span className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                            <StatusBadge status={u.status} />
                            <span className="t-secondary">{formatDateTime(u.at)}</span>
                          </span>
                          {u.response ? <span style={{ whiteSpace: 'pre-wrap' }}>{u.response}</span> : null}
                        </li>
                      ))}
                    </ol>
                  ) : null}
                </div>
              </CardBody>
            </Card>
            <Card>
              <SectionHeader
                title="Public board"
                description="Shown to every resident by your summary, without the author. Residents can support it."
                actions={
                  s.publishedAt ? (
                    <>
                      <Button onClick={() => setOpen('publish')}>Rewrite the summary</Button>
                      <Button variant="danger" onClick={() => setOpen('unpublish')}>
                        Take off the board
                      </Button>
                    </>
                  ) : (
                    <Button onClick={() => setOpen('publish')}>Publish to the board</Button>
                  )
                }
              />
              <CardBody>
                {s.publicSummary ? (
                  <div className="stack">
                    <TwoLanguages en={s.publicSummary.titleEn} ar={s.publicSummary.titleAr} strong />
                    <TwoLanguages en={s.publicSummary.textEn} ar={s.publicSummary.textAr} />
                    <span className="t-secondary">
                      On the board since {formatDateTime(s.publishedAt)} · supported by {s.supports} {s.supports === 1 ? 'resident' : 'residents'}
                    </span>
                  </div>
                ) : (
                  <span className="t-secondary">Not on the board.</span>
                )}
              </CardBody>
            </Card>
            {s.status === 'done' ? (
              <Card>
                <SectionHeader
                  title="You said, we did"
                  description="A done suggestion with a note is listed for every resident."
                  actions={<Button onClick={() => setOpen('note')}>{s.done?.noteEn || s.done?.noteAr ? 'Change the note' : 'Say what was done'}</Button>}
                />
                <CardBody>
                  {s.done && (s.done.noteEn || s.done.noteAr) ? (
                    <div className="stack">
                      <TwoLanguages en={s.done.noteEn} ar={s.done.noteAr} />
                      <Attachments items={s.done.photos} />
                    </div>
                  ) : (
                    <span className="t-secondary">Nothing said yet: it is not in the list.</span>
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
        title="Take this suggestion off the board?"
        description="Residents no longer see it, and its summary is removed. The suggestion itself, its status and your answer stay as they are."
        confirmLabel="Take off the board"
        danger
        pending={unpublish.isPending}
        error={unpublish.error ? <ErrorAlert error={unpublish.error} /> : undefined}
        onConfirm={() => unpublish.mutate()}
      />
    </>
  );
}
