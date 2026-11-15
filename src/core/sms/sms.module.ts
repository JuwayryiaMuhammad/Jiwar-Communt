import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../config/env.schema';
import { LogSmsSender } from './log-sms.sender';
import { SMS_SENDER, type SmsSender } from './sms-sender';
import { TwilioSmsSender } from './twilio-sms.sender';

/**
 * Text messages (ADR 0095). Global, like push: the login code uses it now,
 * and worker notices and WhatsApp can use the same port later.
 */
@Global()
@Module({
  providers: [
    {
      provide: SMS_SENDER,
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>): SmsSender | null => {
        switch (config.get('SMS_PROVIDER', { infer: true })) {
          case 'log':
            return new LogSmsSender();
          case 'twilio':
            // The env schema refused a missing variable at startup.
            return new TwilioSmsSender(
              {
                accountSid: config.getOrThrow('TWILIO_ACCOUNT_SID', {
                  infer: true,
                }),
                apiKeySid: config.getOrThrow('TWILIO_API_KEY_SID', {
                  infer: true,
                }),
                apiKeySecret: config.getOrThrow('TWILIO_API_KEY_SECRET', {
                  infer: true,
                }),
                messagingServiceSid: config.getOrThrow(
                  'TWILIO_MESSAGING_SERVICE_SID',
                  { infer: true },
                ),
              },
              config.get('SMS_REQUEST_TIMEOUT_MS', { infer: true }),
            );
          default:
            return null;
        }
      },
    },
  ],
  exports: [SMS_SENDER],
})
export class SmsModule {}
