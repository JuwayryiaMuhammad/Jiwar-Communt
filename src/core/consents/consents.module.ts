import { Global, Module } from '@nestjs/common';
import { AccountsModule } from '../accounts/accounts.module';
import { ConsentsController } from './consents.controller';
import { ConsentsService } from './consents.service';

/** Consents (ADR 0036). Global: domains check them at read time. */
@Global()
@Module({
  imports: [AccountsModule],
  controllers: [ConsentsController],
  providers: [ConsentsService],
  exports: [ConsentsService],
})
export class ConsentsModule {}
