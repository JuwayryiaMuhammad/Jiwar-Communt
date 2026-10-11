'use client';

import { formatDateTime, relativeTime, unwrap } from '@jiwar/api';
import { ErrorAlert, LoadMore, QueryState, useAction, useCursorList } from '@jiwar/api/react';
import { Badge, Button, ButtonLink, Card, EmptyState, PageHeader, Segmented, useToast } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { Bell } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { api } from '@/lib/api';
import { notificationHref, notificationText } from '@/lib/notifications';
import { usePermissions } from '@/lib/permissions';
import { fetchers, keys, type Notification } from '@/lib/queries';

type View = 'unread' | 'all';

/**
 * The signed-in account's own inbox (ADR 0027): what the compound told this
 * person, whatever their notification settings deliver. Opening one marks it
 * read. Read notifications are removed by the API after its retention period.
 */
export default function NotificationsPage() {
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
    onDone: (result) => toast.show(result.read === 1 ? '1 notification marked read.' : `${result.read} notifications marked read.`),
  });

  return (
    <>
      <PageHeader
        title="Notifications"
        description="What the compound told you. Your notification settings decide what is also sent by email, never what is listed here."
        actions={
          <>
            <ButtonLink href="/account">Settings</ButtonLink>
            <Button variant="primary" disabled={unread === 0} loading={readAll.isPending} onClick={() => readAll.mutate(undefined)}>
              Mark all read
            </Button>
          </>
        }
      />
      <div className="row" style={{ marginBottom: 16 }}>
        <Segmented<View>
          label="Which notifications"
          value={view}
          onChange={setView}
          options={[
            { value: 'unread', label: unread ? `Unread (${unread > 99 ? '99+' : unread})` : 'Unread' },
            { value: 'all', label: 'All' },
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
                const text = notificationText(n);
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
                        {n.priority === 'critical' ? <Badge tone="error">Urgent</Badge> : null}
                      </span>
                      <span className="list__meta" title={formatDateTime(n.createdAt)}>
                        {relativeTime(n.createdAt)}
                        {isUnread ? '' : ' · read'}
                      </span>
                    </span>
                    {isUnread ? (
                      <Button size="sm" disabled={read.isPending && read.variables === n.id} onClick={() => read.mutate(n.id)}>
                        Mark read
                      </Button>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          ) : (
            <EmptyState title={view === 'unread' ? 'Nothing unread' : 'No notifications'} icon={<Bell aria-hidden />}>
              <p>
                {view === 'unread'
                  ? 'You have read everything. Earlier notifications are under All.'
                  : 'Emergencies, tickets that need a dispatcher, parcels held too long and deletion requests appear here.'}
              </p>
            </EmptyState>
          )}
          <LoadMore query={list} />
        </QueryState>
      </Card>
    </>
  );
}
