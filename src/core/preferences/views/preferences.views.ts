import { ApiProperty } from '@nestjs/swagger';
import {
  NOTIFICATION_CATEGORIES,
  type NotificationCategory,
} from '../categories';
import type { PreferencesRead } from '../notification-preferences.service';

export class CategoryPreferenceView {
  @ApiProperty({
    enum: [...NOTIFICATION_CATEGORIES],
    enumName: 'NotificationCategory',
  })
  category: NotificationCategory;
  @ApiProperty({ type: Boolean })
  email: boolean;
  @ApiProperty({ type: Boolean })
  push: boolean;
}

export class QuietHoursView {
  @ApiProperty({ type: String, example: '22:00' })
  start: string;
  @ApiProperty({ type: String, example: '07:00' })
  end: string;
}

export class PauseView {
  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    description: '`null`: until turned back on.',
  })
  until: Date | null;
}

/**
 * Delivery preferences (ADR 0036). Critical notifications (security,
 * emergencies, work assigned to the reader) are delivered whatever these say.
 */
export class PreferencesView {
  @ApiProperty({ type: [CategoryPreferenceView] })
  categories: CategoryPreferenceView[];
  @ApiProperty({ type: QuietHoursView, nullable: true })
  quietHours: QuietHoursView | null;
  @ApiProperty({ type: PauseView, nullable: true })
  pause: PauseView | null;
  @ApiProperty({
    type: String,
    example: 'Africa/Cairo',
    description: 'The compound’s time zone, which quiet hours are read in.',
  })
  timeZone: string;

  static from(p: PreferencesRead): PreferencesView {
    return {
      categories: p.categories.map((c) => ({
        category: c.category,
        email: c.email,
        push: c.push,
      })),
      quietHours: p.quietHours
        ? { start: p.quietHours.start, end: p.quietHours.end }
        : null,
      pause: p.pause ? { until: p.pause.until } : null,
      timeZone: p.timeZone,
    };
  }
}
