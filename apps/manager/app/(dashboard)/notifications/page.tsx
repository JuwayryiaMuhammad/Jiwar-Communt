'use client';

import { unwrap } from '@jiwar/api';
import { ErrorAlert, LoadMore, QueryState, useAction, useCursorList } from '@jiwar/api/react';
import { useFormat, useLocale, useT } from '@jiwar/i18n';
import { Badge, Button, ButtonLink, Card, EmptyState, PageHeader, Segmented, useToast } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { Bell } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { api } from '@/lib/api';
import { notificationHref, notificationText } from '@/lib/notifications';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys, type Notification } from '@/lib/queries';
import ar from '@/messages/ar/notifications-page';
import en from '@/messages/en/notifications-page';

type View = 'unread' | 'all';

/**
 * The signed-in account's own inbox (ADR 0027): what the compound told this
 * person, whatever their notification settings deliver. Opening one marks it
 * read. Read notifications are removed by the API after its retention period.
 */
export default function NotificationsPage() {
  const t = useT(en, ar);
  const f = useFormat();
  const { locale } = useLocale();
  const toast = useToast();
  const { can } = usePermissions();
  const [view, setView] = useState<View>('unread');
  const list = useCursorList<Notification>(keys.notifications(view === 'unread'), (cursor) =>
    fetchers.notifications(view === 'unread', cursor),
  );
  const count = useQuery({ queryKey: keys.unreadCount, queryFn: fetchers.unreadCount, retry: false });
  const unread = count.data?.unread ?? 0;

  const read = useAction((id: string) => unwrap(api.POST('/api/v1/me/notifications/{id}/read', { params: { path: { id } } })), {
    invalidate: [keys.notificationsAll],
  });
  const readAll = useAction(() => unwrap(api.POST('/api/v1/me/notifications/read-all')), {
    invalidate: [keys.notificationsAll],
    onDone: (result) => toast.show(t('markedRead', { n: result.read })),
  });

  return (
    <>
      <PageHeader
        title={t('title')}
        description={t('description')}
        actions={
          <>
            <ButtonLink href="/account">{t('settings')}</ButtonLink>
            <Button variant="primary" disabled={unread === 0} loading={readAll.isPending} onClick={() => readAll.mutate(undefined)}>
              {t('markAllRead')}
            </Button>
          </>
        }
      />
      <div className="row" style={{ marginBottom: 16 }}>
        <Segmented<View>
          label={t('which')}
          value={view}
          onChange={setView}
          options={[
            { value: 'unread', label: unread ? t('unreadCount', { count: unread > 99 ? '99+' : unread }) : t('unread') },
            { value: 'all', label: t('all') },
          ]}
        />
      </div>
      <ErrorAlert error={read.error ?? readAll.error} />
      <Card flush>
        <QueryState query={list}>
          {list.rows?.length ? (
            <ul className="list">
              {list.rows.map((n) => {
                const href = notificationHref(n, can);
                const text = notificationText(n, locale);
                const isUnread = n.readAt === null;
                return (
                  <li key={n.id} className={`list__item${isUnread ? ' list__item--unread' : ''}`}>
                    <span className="list__text">
                      <span className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                        {href ? (
                          <Link
                            href={href}
                            className="table__link"
                            style={{ fontWeight: isUnread ? 600 : 400 }}
                            onClick={() => {
                              if (isUnread) read.mutate(n.id);
                            }}
                          >
                            {text}
                          </Link>
                        ) : (
                          <span style={{ fontWeight: isUnread ? 600 : 400, color: 'var(--color-ink)' }}>{text}</span>
                        )}
                        {n.priority === 'critical' ? <Badge tone="error">{t('urgent')}</Badge> : null}
                      </span>
                      <span className="list__meta" title={f.dateTime(n.createdAt)}>
                        {f.relative(n.createdAt)}
                        {isUnread ? '' : t('readSuffix')}
                      </span>
                    </span>
                    {isUnread ? (
                      <Button size="sm" disabled={read.isPending && read.variables === n.id} onClick={() => read.mutate(n.id)}>
                        {t('markRead')}
                      </Button>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          ) : (
            <EmptyState title={view === 'unread' ? t('nothingUnread') : t('noNotifications')} icon={<Bell aria-hidden />}>
              <p>
                {view === 'unread' ? t('allRead') : t('emptyAll')}
              </p>
            </EmptyState>
          )}
          <LoadMore query={list} />
        </QueryState>
      </Card>
    </>
  );
}
