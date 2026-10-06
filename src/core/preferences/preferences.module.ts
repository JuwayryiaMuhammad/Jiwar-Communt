import { Global, Module } from '@nestjs/common';
import { AccountsModule } from '../accounts/accounts.module';
import { DeliveryPreferences } from './delivery-preferences';
import { NotificationPreferencesService } from './notification-preferences.service';
import { PreferencesController } from './preferences.controller';

/**
 * Delivery preferences (ADR 0036). Global: the outbox reads them for every
 * message to an account.
 */
@Global()
@Module({
  imports: [AccountsModule],
  controllers: [PreferencesController],
  providers: [DeliveryPreferences, NotificationPreferencesService],
  exports: [DeliveryPreferences, NotificationPreferencesService],
})
export class PreferencesModule {}
