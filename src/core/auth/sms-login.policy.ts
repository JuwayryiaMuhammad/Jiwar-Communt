import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { parsePhoneNumberFromString } from 'libphonenumber-js';
import type { Env } from '../config/env.schema';
import { RateLimitService } from '../redis/rate-limit.service';
import { SMS_SENDER, type SmsSender } from '../sms/sms-sender';

/** Why an SMS was not sent although it was possible: the cap that was hit. */
export type SmsCap = 'phone_daily' | 'global_hourly';

const DAY_SECONDS = 86_400;
const HOUR_SECONDS = 3_600;

/**
 * When a login code may go by SMS (ADR 0095). Two questions, asked in order:
 *
 * 1. `available`: is SMS on, and is the number in an allowed country? A
 *    number outside the list is treated exactly as if SMS were off, with
 *    nothing recorded.
 * 2. `admit`: is the number, and the service, under its caps? SMS costs
 *    money and an SMS to a stranger is spam, so each number has a daily
 *    cap and the service an hourly one, counted in Redis like the other
 *    limits. Every attempt counts, whether or not Twilio took it.
 */
@Injectable()
export class SmsLoginPolicy {
  private readonly allowedCodes: ReadonlySet<string>;
  private readonly perPhonePerDay: number;
  private readonly perHour: number;

  constructor(
    config: ConfigService<Env, true>,
    @Inject(SMS_SENDER) private readonly sender: SmsSender | null,
    private readonly rateLimit: RateLimitService,
  ) {
    this.allowedCodes = new Set(
      config.get('SMS_ALLOWED_COUNTRY_CODES', { infer: true }),
    );
    this.perPhonePerDay = config.get('SMS_MAX_PER_PHONE_PER_DAY', {
      infer: true,
    });
    this.perHour = config.get('SMS_MAX_PER_HOUR', { infer: true });
  }

  /** SMS is on and `phone` (E.164) is in an allowed country. */
  available(phone: string): boolean {
    if (!this.sender) return false;
    const parsed = parsePhoneNumberFromString(phone);
    return !!parsed && this.allowedCodes.has(`+${parsed.countryCallingCode}`);
  }

  /**
   * Counts one SMS attempt for this number (by its identifier hash: the
   * number itself never reaches Redis) and for the service. The number's
   * cap is checked first, so a number past its cap does not spend the
   * service's budget.
   */
  async admit(identifierHash: string): Promise<SmsCap | null> {
    const phoneCount = await this.rateLimit.hit(
      `sms:phone:${identifierHash}`,
      DAY_SECONDS,
    );
    if (phoneCount > this.perPhonePerDay) return 'phone_daily';
    const globalCount = await this.rateLimit.hit('sms:global', HOUR_SECONDS);
    if (globalCount > this.perHour) return 'global_hourly';
    return null;
  }
}
