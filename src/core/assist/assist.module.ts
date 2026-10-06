import { Module } from '@nestjs/common';
import { AccountsModule } from '../accounts/accounts.module';
import { AssistController } from './assist.controller';
import { AssistService } from './assist.service';

/**
 * The assisted path (ADR 0036). Preferences, consents and exports come from
 * their global modules.
 */
@Module({
  imports: [AccountsModule],
  controllers: [AssistController],
  providers: [AssistService],
})
export class AssistModule {}
