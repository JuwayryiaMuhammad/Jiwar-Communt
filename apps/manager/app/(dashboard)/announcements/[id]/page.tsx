'use client';

import { formatDateTime, humanize, unwrap } from '@jiwar/api';
import { ErrorAlert, QueryState, useAction } from '@jiwar/api/react';
import { Badge, Button, Card, CardBody, ConfirmDialog, Dialog, ForbiddenState, PageHeader, Stat, StatusBadge, useToast } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { AnnouncementDialog } from '@/components/community/announcement-dialog';
import { Attachments, Back, DateTimeField, SectionHeader, TwoLanguages } from '@/components/community/bits';
import { announcementActions, audienceText, percent, toIso } from '@/components/community/logic';
import { api } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys, type AnnouncementDetail } from '@/lib/queries';

/** Publishes now, or at a time; moves the time of one that is scheduled. */
function PublishDialog({ announcement, onClose }: { announcement: AnnouncementDetail; onClose: () => void }) {
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
        toast.show(at ? 'The announcement is scheduled.' : 'The announcement is out.');
        onClose();
      },
    },
  );
  return (
    <Dialog
      open
      onClose={onClose}
      title="Publish"
      description={
        announcement.priority === 'important'
          ? 'Its audience reads it from then on, and is notified once, when it comes out.'
          : 'Its audience reads it from then on. Nobody is notified: it is not marked important.'
      }
      onSubmit={() => publish.mutate()}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" loading={publish.isPending}>
            {at ? 'Schedule' : 'Publish now'}
          </Button>
        </>
      }
    >
      <div className="form">
        <DateTimeField label="When" hint="Empty: now." value={at} onChange={setAt} />
        <ErrorAlert error={publish.error} />
      </div>
    </Dialog>
  );
}

/** How many opened it. Counts only: who read it is not stored anywhere. */
function ReadCounts({ id }: { id: string }) {
  const reads = useQuery({ queryKey: keys.announcementPart(id, 'reads'), queryFn: () => fetchers.announcementReads(id), refetchInterval: 60_000 });
  return (
    <Card>
      <SectionHeader title="Opened by" description="Counts only. Who opened it is not recorded, so there is no list to show." />
      <CardBody>
        <QueryState query={reads}>
          {reads.data ? (
            <div className="row" style={{ gap: 32, flexWrap: 'wrap' }}>
              <Stat
                label="Units"
                value={`${reads.data.units} of ${reads.data.audienceUnits}`}
                hint={`${percent(reads.data.units, reads.data.audienceUnits)}% of the units it is for now`}
              />
              <Stat
                label="People"
                value={`${reads.data.accounts} of ${reads.data.audienceAccounts}`}
                hint={`${percent(reads.data.accounts, reads.data.audienceAccounts)}% of the people it is for now`}
              />
            </div>
          ) : null}
        </QueryState>
      </CardBody>
    </Card>
  );
}

function Versions({ id }: { id: string }) {
  const versions = useQuery({ queryKey: keys.announcementPart(id, 'versions'), queryFn: () => fetchers.announcementVersions(id) });
  return (
    <Card>
      <SectionHeader title="Versions" description="What it said, each time it was changed. Nothing is rewritten." />
      <CardBody>
        <QueryState query={versions}>
          <div className="stack">
            {[...(versions.data?.data ?? [])].reverse().map((v) => (
              <div key={v.version} className="stack stack--sm">
                <span className="row" style={{ gap: 8 }}>
                  <Badge plain>Version {v.version}</Badge>
                  <span className="t-secondary">{formatDateTime(v.createdAt)}</span>
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
  const { id } = useParams<{ id: string }>();
  const toast = useToast();
  const { can, ready } = usePermissions();
  const allowed = can('community.publish');
  const query = useQuery({ queryKey: keys.announcement(id), queryFn: () => fetchers.announcement(id), enabled: allowed });
  const [dialog, setDialog] = useState<'edit' | 'publish' | 'archive' | null>(null);
  const archive = useAction(() => unwrap(api.POST('/api/v1/community/announcements/{id}/archive', { params: { path: { id } } })), {
    invalidate: [keys.announcementsAll],
    onDone: () => {
      toast.show('The announcement is archived.');
      setDialog(null);
    },
  });

  if (ready && !allowed) return <ForbiddenState />;
  const a = query.data;
  const actions = a ? announcementActions(a.status) : null;

  return (
    <>
      <PageHeader
        title={a ? (a.titleEn ?? a.titleAr ?? 'Announcement') : 'Announcement'}
        back={<Back href="/announcements" label="Announcements" />}
        actions={
          a && actions ? (
            <>
              {actions.edit ? <Button onClick={() => setDialog('edit')}>Edit</Button> : null}
              {actions.archive ? (
                <Button variant="danger" onClick={() => setDialog('archive')}>
                  Archive
                </Button>
              ) : null}
              {actions.publish ? (
                <Button variant="primary" onClick={() => setDialog('publish')}>
                  {a.status === 'scheduled' ? 'Change the time' : 'Publish'}
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
              <SectionHeader title="As residents read it" description={`Version ${a.version}${a.editedAt ? ', shown as edited' : ''}.`} />
              <CardBody>
                <div className="stack">
                  <span className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
                    <StatusBadge status={a.status} />
                    {a.kind === 'works' ? <Badge plain>Works and closures</Badge> : null}
                    {a.priority === 'important' ? <Badge tone="terracotta">Important</Badge> : null}
                    {a.pinned ? <Badge tone="green">Pinned</Badge> : null}
                  </span>
                  <TwoLanguages en={a.titleEn} ar={a.titleAr} strong />
                  <TwoLanguages en={a.bodyEn} ar={a.bodyAr} />
                  <Attachments items={a.attachments} />
                </div>
              </CardBody>
            </Card>
            <Card>
              <SectionHeader title="Settings" />
              <CardBody>
                <dl className="dl">
                  <dt>Audience</dt>
                  <dd>{audienceText(a.audience)}</dd>
                  <dt>Published</dt>
                  <dd>{a.publishAt ? formatDateTime(a.publishAt) : 'Not yet: a draft'}</dd>
                  {a.kind === 'general' ? (
                    <>
                      <dt>Expires</dt>
                      <dd>{a.expiresAt ? formatDateTime(a.expiresAt) : 'When archived'}</dd>
                    </>
                  ) : null}
                  {a.priority === 'important' ? (
                    <>
                      <dt>Pinned until</dt>
                      <dd>{a.pinnedUntil ? formatDateTime(a.pinnedUntil) : 'Not pinned'}</dd>
                      <dt>Audience notified</dt>
                      <dd>{a.notifiedAt ? formatDateTime(a.notifiedAt) : 'When it comes out'}</dd>
                    </>
                  ) : null}
                  {a.works ? (
                    <>
                      <dt>Works</dt>
                      <dd>
                        {formatDateTime(a.works.startsAt)} to {formatDateTime(a.works.endsAt)}
                        {a.works.active ? ' (under way)' : ''}
                      </dd>
                      <dt>Affects</dt>
                      <dd>
                        {humanize(a.works.areaKind)}
                        {a.works.gate ? `: ${a.works.gate.name}` : ''}
                        {a.works.place ? `, ${a.works.place}` : ''}
                      </dd>
                    </>
                  ) : null}
                </dl>
              </CardBody>
            </Card>
            {a.publishAt ? <ReadCounts id={a.id} /> : null}
            <Versions id={a.id} />
          </div>
        ) : null}
      </QueryState>
      {a && dialog === 'edit' ? (
        <AnnouncementDialog key={a.version} announcement={a} kind={a.kind} open onClose={() => setDialog(null)} onSaved={() => setDialog(null)} />
      ) : null}
      {a && dialog === 'publish' ? <PublishDialog announcement={a} onClose={() => setDialog(null)} /> : null}
      <ConfirmDialog
        open={dialog === 'archive'}
        onClose={() => setDialog(null)}
        title="Archive this announcement?"
        description="Residents stop seeing it. It stays here with its versions; an announcement is never deleted, and an archived one cannot be brought back."
        confirmLabel="Archive"
        danger
        pending={archive.isPending}
        error={archive.error ? <ErrorAlert error={archive.error} /> : undefined}
        onConfirm={() => archive.mutate()}
      />
    </>
  );
}
