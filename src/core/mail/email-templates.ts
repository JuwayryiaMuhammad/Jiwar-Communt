import { Injectable } from '@nestjs/common';
import type { Locale } from '../common/i18n/locale';
import type { RenderedEmail } from './layout';

/** Renders stored outbox params into an email, at send time. */
export type EmailRenderer = (
  locale: Locale,
  params: Record<string, unknown>,
) => RenderedEmail;

/**
 * Template key → renderer (ADR 0019). Domains own their templates and
 * register them at startup, so the core outbox can render them without
 * importing any domain (ADR 0015).
 */
@Injectable()
export class EmailTemplates {
  private readonly renderers = new Map<string, EmailRenderer>();

  register(key: string, renderer: EmailRenderer): void {
    if (this.renderers.has(key)) {
      throw new Error(`Email template ${key} is registered twice`);
    }
    this.renderers.set(key, renderer);
  }

  get(key: string): EmailRenderer | undefined {
    return this.renderers.get(key);
  }

  has(key: string): boolean {
    return this.renderers.has(key);
  }
}
