import { Logger } from '@nestjs/common';
import type { SmsMessage, SmsResult, SmsSender } from './sms-sender';

export interface LoggedSms extends SmsMessage {
  at: Date;
}

/** More than any suite sends; the oldest are dropped. */
const KEEP = 500;

/**
 * SMS_PROVIDER=log: never sends. Keeps what it was given in memory, newest
 * last, for the e2e tests to read the way they read Mailpit for email, and
 * writes one line with the number masked that a developer can read the code
 * from. The app refuses to start with it in production (a server that
 * "sends" and delivers nothing would lock everyone out).
 */
export class LogSmsSender implements SmsSender {
  readonly provider = 'log' as const;
  private readonly logger = new Logger('Sms');
  private readonly kept: LoggedSms[] = [];

  send(message: SmsMessage): Promise<SmsResult> {
    this.kept.push({ ...message, at: new Date() });
    if (this.kept.length > KEEP) this.kept.shift();
    this.logger.log(`SMS (not sent) to ${mask(message.to)}: ${message.body}`);
    return Promise.resolve({ ok: true });
  }

  /** Every text kept, oldest first. */
  messages(): readonly LoggedSms[] {
    return this.kept;
  }

  clear(): void {
    this.kept.length = 0;
  }
}

/** `+20******34`: enough to tell two numbers apart in a log, not to dial. */
export function mask(phone: string): string {
  if (phone.length <= 6) return '***';
  return `${phone.slice(0, 3)}${'*'.repeat(phone.length - 5)}${phone.slice(-2)}`;
}
