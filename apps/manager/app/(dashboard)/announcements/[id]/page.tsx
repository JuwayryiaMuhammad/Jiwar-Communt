'use client';

import { unwrap } from '@jiwar/api';
import { ErrorAlert, QueryState, useAction } from '@jiwar/api/react';
import { useFormat, useLocale, useT } from '@jiwar/i18n';
import { Badge, Button, Card, CardBody, ConfirmDialog, Dialog, ForbiddenState, PageHeader, Stat, StatusBadge, useCommonT, useLabel, useToast } from '@jiwar/ui';
import { AnnouncementDelivery } from '@/components/office-queue/announcement-delivery';
import { useQuery } from '@tanstack/react-query';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { AnnouncementDialog } from '@/components/community/announcement-dialog';
import { Attachments, Back, DateTimeField, SectionHeader, TwoLanguages } from '@/components/community/bits';
import { announcementActions, audienceText, percent, toIso } from '@/components/community/logic';
import { api } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys, type AnnouncementDetail } from '@/lib/queries';
import communityAr from '@/messages/ar/community';
import ar from '@/messages/ar/community-announcements';
import communityEn from '@/messages/en/community';
import en from '@/messages/en/community-announcements';

/** Publishes now, or at a time; moves the time of one that is scheduled. */
function PublishDialog({ announcement, onClose }: { announcement: AnnouncementDetail; onClose: () => void }) {
  const t = useT(en, ar);
  const c = useCommonT();
  const toast = useToast();
  const [at, setAt] = useState('');
  const publish = useAction(
    () =>
      unwrap(
        api.POST('/api/v1/community/announcements/{id}/publish', {
          params: { path: { id: announcement.id } },
          body: at ? { publishAt: toIso(at) ?? undefined } : {},
        }),
      ),
    {
      invalidate: [keys.announcementsAll],
      onDone: () => {
        toast.show(at ? t('scheduledToast') : t('outToast'));
        onClose();
      },
    },
  );
  return (
    <Dialog
      open
      onClose={onClose}
      title={t('publish')}
      description={announcement.priority === 'important' ? t('publishImportant') : t('publishNormal')}
      onSubmit={() => publish.mutate()}
      footer={
        <>
          <Button onClick={onClose}>{c('cancel')}</Button>
          <Button type="submit" variant="primary" loading={publish.isPending}>
            {at ? t('schedule') : t('publishNow')}
          </Button>
        </>
      }
    >
      <div className="form">
        <DateTimeField label={t('when')} hint={t('whenHint')} value={at} onChange={setAt} />
        <ErrorAlert error={publish.error} />
      </div>
    </Dialog>
  );
}

/** How many opened it. Counts only: who read it is not stored anywhere. */
function ReadCounts({ id }: { id: string }) {
  const t = useT(en, ar);
  const fmt = useFormat();
  const reads = useQuery({ queryKey: keys.announcementPart(id, 'reads'), queryFn: () => fetchers.announcementReads(id), refetchInterval: 60_000 });
  const share = (part: number, whole: number) => fmt.percent(percent(part, whole) / 100, 0);
  return (
    <Card>
      <SectionHeader title={t('openedBy')} description={t('openedByHint')} />
      <CardBody>
        <QueryState query={reads}>
          {reads.data ? (
            <div className="row" style={{ gap: 32, flexWrap: 'wrap' }}>
              <Stat
                label={t('units')}
                value={t('ofTotal', { part: reads.data.units, whole: reads.data.audienceUnits })}
                hint={t('unitsShare', { share: share(reads.data.units, reads.data.audienceUnits) })}
              />
              <Stat
                label={t('people')}
                value={t('ofTotal', { part: reads.data.accounts, whole: reads.data.audienceAccounts })}
                hint={t('peopleShare', { share: share(reads.data.accounts, reads.data.audienceAccounts) })}
              />
            </div>
          ) : null}
        </QueryState>
      </CardBody>
    </Card>
  );
}

function Versions({ id }: { id: string }) {
  const t = useT(en, ar);
  const fmt = useFormat();
  const versions = useQuery({ queryKey: keys.announcementPart(id, 'versions'), queryFn: () => fetchers.announcementVersions(id) });
  return (
    <Card>
      <SectionHeader title={t('versions')} description={t('versionsHint')} />
      <CardBody>
        <QueryState query={versions}>
          <div className="stack">
            {[...(versions.data?.data ?? [])].reverse().map((v) => (
              <div key={v.version} className="stack stack--sm">
                <span className="row" style={{ gap: 8 }}>
                  <Badge plain>{t('version', { version: v.version })}</Badge>
                  <span className="t-secondary">{fmt.dateTime(v.createdAt)}</span>
                </span>
                <TwoLanguages en={v.titleEn} ar={v.titleAr} strong />
                <TwoLanguages en={v.bodyEn} ar={v.bodyAr} />
                <Attachments items={v.attachments} />
              </div>
            ))}
          </div>
        </QueryState>
      </CardBody>
    </Card>
  );
}

export default function AnnouncementPage() {
  const t = useT(en, ar);
  const tc = useT(communityEn, communityAr);
  const fmt = useFormat();
  const label = useLabel();
  const { locale } = useLocale();
  const { id } = useParams<{ id: string }>();
  const toast = useToast();
  const { can, ready } = usePermissions();
  const allowed = can('community.publish');
  const query = useQuery({ queryKey: keys.announcement(id), queryFn: () => fetchers.announcement(id), enabled: allowed });
  const [dialog, setDialog] = useState<'edit' | 'publish' | 'archive' | null>(null);
  const archive = useAction(() => unwrap(api.POST('/api/v1/community/announcements/{id}/archive', { params: { path: { id } } })), {
    invalidate: [keys.announcementsAll],
    onDone: () => {
      toast.show(t('archived'));
      setDialog(null);
    },
  });

  if (ready && !allowed) return <ForbiddenState />;
  const a = query.data;
  // The board's decisions and minutes change under Governance (ADR 0051).
  const actions = a && a.kind !== 'board' ? announcementActions(a.status) : null;
  // The title in the page's language when it was written in it.
  const heading = a ? ((locale === 'ar' ? (a.titleAr ?? a.titleEn) : (a.titleEn ?? a.titleAr)) ?? t('announcement')) : t('announcement');
  const affects = (w: NonNullable<AnnouncementDetail['works']>) => {
    const area = w.gate ? t('affects.gate', { area: label(w.areaKind), gate: w.gate.name }) : label(w.areaKind);
    return w.place ? t('affects.place', { what: area, place: w.place }) : area;
  };

  return (
    <>
      <PageHeader
        title={heading}
        back={<Back href="/announcements" label={t('title')} />}
        actions={
          a && actions ? (
            <>
              {actions.edit ? <Button onClick={() => setDialog('edit')}>{t('edit')}</Button> : null}
              {actions.archive ? (
                <Button variant="danger" onClick={() => setDialog('archive')}>
                  {t('archive')}
                </Button>
              ) : null}
              {actions.publish ? (
                <Button variant="primary" onClick={() => setDialog('publish')}>
                  {a.status === 'scheduled' ? t('changeTime') : t('publish')}
                </Button>
              ) : null}
            </>
          ) : null
        }
      />
      <QueryState query={query}>
        {a ? (
          <div className="stack">
            <Card>
              <SectionHeader title={t('asRead')} description={t('versionLine', { version: a.version, edited: a.editedAt ? 'yes' : 'no' })} />
              <CardBody>
                <div className="stack">
                  <span className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
                    <StatusBadge status={a.status} />
                    {a.kind === 'works' ? <Badge plain>{t('works')}</Badge> : null}
                    {a.priority === 'important' ? <Badge tone="terracotta">{t('important')}</Badge> : null}
                    {a.pinned ? <Badge tone="green">{t('pinned')}</Badge> : null}
                  </span>
                  <TwoLanguages en={a.titleEn} ar={a.titleAr} strong />
                  <TwoLanguages en={a.bodyEn} ar={a.bodyAr} />
                  <Attachments items={a.attachments} />
                </div>
              </CardBody>
            </Card>
            <Card>
              <SectionHeader title={t('settings')} />
              <CardBody>
                <dl className="dl">
                  <dt>{t('audience')}</dt>
                  <dd>{audienceText(a.audience, tc, fmt)}</dd>
                  <dt>{t('published')}</dt>
                  <dd>{a.publishAt ? fmt.dateTime(a.publishAt) : t('notYetDraft')}</dd>
                  {a.kind === 'general' ? (
                    <>
                      <dt>{t('expires')}</dt>
                      <dd>{a.expiresAt ? fmt.dateTime(a.expiresAt) : t('whenArchived')}</dd>
                    </>
                  ) : null}
                  {a.priority === 'important' ? (
                    <>
                      <dt>{t('pinnedUntil')}</dt>
                      <dd>{a.pinnedUntil ? fmt.dateTime(a.pinnedUntil) : t('notPinned')}</dd>
                      <dt>{t('notified')}</dt>
                      <dd>{a.notifiedAt ? fmt.dateTime(a.notifiedAt) : t('whenOut')}</dd>
                    </>
                  ) : null}
                  {a.works ? (
                    <>
                      <dt>{t('worksLabel')}</dt>
                      <dd>
                        {t(a.works.active ? 'worksSpanActive' : 'worksSpan', {
                          from: fmt.dateTime(a.works.startsAt),
                          to: fmt.dateTime(a.works.endsAt),
                        })}
                      </dd>
                      <dt>{t('affects')}</dt>
                      <dd>{affects(a.works)}</dd>
                    </>
                  ) : null}
                </dl>
              </CardBody>
            </Card>
            {a.publishAt ? <ReadCounts id={a.id} /> : null}
            {a.publishAt ? <AnnouncementDelivery id={a.id} out={a.status === 'published'} /> : null}
            <Versions id={a.id} />
          </div>
        ) : null}
      </QueryState>
      {a && dialog === 'edit' ? (
        <AnnouncementDialog
          key={a.version}
          announcement={a}
          kind={a.kind === 'works' ? 'works' : 'general'}
          open
          onClose={() => setDialog(null)}
          onSaved={() => setDialog(null)}
        />
      ) : null}
      {a && dialog === 'publish' ? <PublishDialog announcement={a} onClose={() => setDialog(null)} /> : null}
      <ConfirmDialog
        open={dialog === 'archive'}
        onClose={() => setDialog(null)}
        title={t('archiveTitle')}
        description={t('archiveDescription')}
        confirmLabel={t('archive')}
        danger
        pending={archive.isPending}
        error={archive.error ? <ErrorAlert error={archive.error} /> : undefined}
        onConfirm={() => archive.mutate()}
      />
    </>
  );
}
