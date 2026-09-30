import { Global, Module } from '@nestjs/common';
import { EmailTemplates } from './email-templates';
import { Mailer } from './mailer';
import { Outbox } from './outbox';
import { OutboxProcessor } from './outbox-processor';

/** One SMTP transport, the email template registry and the outbox (ADR 0019). */
@Global()
@Module({
  providers: [Mailer, EmailTemplates, Outbox, OutboxProcessor],
  exports: [Mailer, EmailTemplates, Outbox, OutboxProcessor],
})
export class MailModule {}
