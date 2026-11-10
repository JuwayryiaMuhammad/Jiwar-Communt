'use client';

import { useT } from '@jiwar/i18n';
import { ButtonLink } from '@jiwar/ui';
import { useQuery } from '@tanstack/react-query';
import { Bell } from 'lucide-react';
import { fetchers, keys } from '@/lib/queries';
import ar from '@/messages/ar/shell-components';
import en from '@/messages/en/shell-components';

/** The unread count, asked for again every minute; it opens the inbox. */
export function NotificationBell() {
  const t = useT(en, ar);
  const count = useQuery({ queryKey: keys.unreadCount, queryFn: fetchers.unreadCount, refetchInterval: 60_000, retry: false });
  const unread = count.data?.unread ?? 0;
  const critical = count.data?.critical ?? 0;
  const label =
    unread === 0
      ? t('notifications')
      : critical
        ? t('notificationsUrgent', { n: unread, urgent: critical })
        : t('notificationsUnread', { n: unread });
  return (
    <ButtonLink href="/notifications" size="sm" className="btn--icon bell" aria-label={label} title={label} icon={<Bell aria-hidden />}>
      {unread > 0 ? (
        <span className={`bell__count${critical ? ' bell__count--critical' : ''}`} aria-hidden>
          {unread > 99 ? '99+' : unread}
        </span>
      ) : null}
    </ButtonLink>
  );
}
