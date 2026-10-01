import { Global, Module } from '@nestjs/common';
import { AccountsModule } from '../accounts/accounts.module';
import { NotificationsController } from './notifications.controller';
import { NotificationsService } from './notifications.service';
import { Notifier } from './notifier';

/** The in-app inbox (ADR 0027). Domains write through Notifier. */
@Global()
@Module({
  imports: [AccountsModule],
  controllers: [NotificationsController],
  providers: [NotificationsService, Notifier],
  exports: [Notifier],
})
export class NotificationsModule {}
