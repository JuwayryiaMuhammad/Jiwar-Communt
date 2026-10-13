import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AccountsModule } from '../accounts/accounts.module';
import { AuthModule } from '../auth/auth.module';
import type { Env } from '../config/env.schema';
import { parseFcmServiceAccount } from '../config/fcm-service-account';
import { FcmTransport } from './fcm-transport';
import { PushDevices } from './push-devices.service';
import { PushOutbox } from './push-outbox';
import { PushProcessor } from './push-processor';
import { PushTokensController } from './push-tokens.controller';
import { PUSH_TRANSPORT, type PushTransport } from './push-transport';

/**
 * Push notifications (ADR 0041). Global: Notifier queues a push for every
 * notification it writes.
 */
@Global()
@Module({
  imports: [AccountsModule, AuthModule],
  controllers: [PushTokensController],
  providers: [
    {
      provide: PUSH_TRANSPORT,
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>): PushTransport | null => {
        const projectId = config.get('FCM_PROJECT_ID', { infer: true });
        const encoded = config.get('FCM_SERVICE_ACCOUNT', { infer: true });
        const account = encoded ? parseFcmServiceAccount(encoded) : null;
        return projectId && account
          ? new FcmTransport(projectId, account)
          : null;
      },
    },
    PushDevices,
    PushOutbox,
    PushProcessor,
  ],
  exports: [PushOutbox, PushProcessor, PUSH_TRANSPORT],
})
export class PushModule {}
