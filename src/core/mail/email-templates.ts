import { Injectable } from '@nestjs/common';
import type { Locale } from '../common/i18n/locale';
import type { DeliveryClass } from '../preferences/categories';
import type { RenderedEmail } from './layout';

/** Renders stored outbox params into an email, at send time. */
export type EmailRenderer = (
  locale: Locale,
  params: Record<string, unknown>,
) => RenderedEmail;

/**
 * How an email template is delivered (ADR 0036): its category, whether it
 * is critical, and whether it is the notice's only record (no inbox twin),
 * which a category switched off never skips.
 */
export interface EmailDelivery extends DeliveryClass {
  soleRecord: boolean;
}

/**
 * Template key → renderer (ADR 0019). Domains own their templates and
 * register them at startup, so the core outbox can render them without
 * importing any domain (ADR 0015). Each one declares how it is delivered,
 * so the outbox can apply the account's preferences (ADR 0036).
 */
@Injectable()
export class EmailTemplates {
  private readonly renderers = new Map<string, EmailRenderer>();
  private readonly deliveries = new Map<string, EmailDelivery>();

  register(
    key: string,
    renderer: EmailRenderer,
    delivery: EmailDelivery,
  ): void {
    if (this.renderers.has(key)) {
      throw new Error(`Email template ${key} is registered twice`);
    }
    this.renderers.set(key, renderer);
    this.deliveries.set(key, delivery);
  }

  get(key: string): EmailRenderer | undefined {
    return this.renderers.get(key);
  }

  has(key: string): boolean {
    return this.renderers.has(key);
  }

  /** How a registered template is delivered; throws on an unknown key. */
  delivery(key: string): EmailDelivery {
    const d = this.deliveries.get(key);
    if (!d) throw new Error(`Unknown email template ${key}`);
    return d;
  }

  /** Every registered key (the catalog test). */
  keys(): string[] {
    return [...this.renderers.keys()].sort();
  }
}
