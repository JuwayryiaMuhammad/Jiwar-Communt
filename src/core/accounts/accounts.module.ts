import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { ObjectStorageModule } from '../files/object-storage.module';
import { AccountsController } from './accounts.controller';
import { ErasureController } from './erasure.controller';
import { MeController } from './me.controller';
import {
  MeDevicesController,
  PublicNotMeController,
} from './not-me.controller';
import { NotMeService } from './not-me.service';
import { AccountDeletionService } from './account-deletion.service';
import { AccountEmailTemplates } from './account-emails';
import { AccountLifecycle } from './account-lifecycle';
import { AccountSelfService } from './account-self.service';
import { AccountWriter } from './account-writer';
import { AccountsService } from './accounts.service';
import { ContactChangeService } from './contact-change.service';
import { IdentityChangesController } from './identity-changes.controller';
import { IdentityChangesService } from './identity-changes.service';
import { SelfContactController } from './self-contact.controller';

@Module({
  imports: [AuthModule, ObjectStorageModule],
  controllers: [
    AccountsController,
    MeController,
    ErasureController,
    MeDevicesController,
    PublicNotMeController,
    SelfContactController,
    IdentityChangesController,
  ],
  providers: [
    AccountsService,
    AccountWriter,
    AccountLifecycle,
    AccountSelfService,
    AccountEmailTemplates,
    AccountDeletionService,
    NotMeService,
    ContactChangeService,
    IdentityChangesService,
  ],
  exports: [
    AccountWriter,
    AccountLifecycle,
    AccountSelfService,
    AccountDeletionService,
  ],
})
export class AccountsModule {}
