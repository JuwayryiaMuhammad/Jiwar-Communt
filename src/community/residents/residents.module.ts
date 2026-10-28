import { Module } from '@nestjs/common';
import { AccountsModule } from '../../core/accounts/accounts.module';
import { HouseholdsModule } from '../households/households.module';
import { NoticesModule } from '../notices/notices.module';
import { WorkersModule } from '../workers/workers.module';
import { ErasureHooks } from './erasure-hooks';
import { CommunityExportSections } from './export-sections';
import { FreezeHooks } from './freeze-hooks';
import { CapabilitiesModule } from '../capabilities/capabilities.module';
import { MeUnitsController } from './me-units.controller';
import { OccupanciesController } from './occupancies.controller';
import { UnitActionsController } from './unit-actions.controller';
import { UnitStatesController } from './unit-states.controller';
import { FilesModule } from '../../core/files/files.module';
import { RegistrationDocumentsService } from './registration-documents.service';
import { RegistrationPublicController } from './registration-public.controller';
import { RegistrationStatusController } from './registration-status.controller';
import { RegistrationStatusLinks } from './registration-status-links';
import { RegistrationService } from './registration.service';
import {
  StaffUnitDocumentsController,
  UnitDocumentsController,
} from '../units/unit-documents.controller';
import { UnitDocumentsService } from '../units/unit-documents.service';
import {
  ContractsController,
  StaffContractsController,
} from '../contracts/contracts.controller';
import { ContractsService } from '../contracts/contracts.service';
import {
  MovesController,
  StaffMovesController,
} from '../moves/moves.controller';
import { MovesService } from '../moves/moves.service';
import {
  MyProxyUnitsController,
  ProxiesController,
  ProxyAcceptanceController,
  StaffProxiesController,
} from '../proxies/proxies.controller';
import { ProxiesService } from '../proxies/proxies.service';
import { ProxyAcceptanceService } from '../proxies/proxy-acceptance.service';
import { RegistrationsController } from './registrations.controller';
import { AuthModule } from '../../core/auth/auth.module';
import { ResidentsController } from './residents.controller';
import { ResidentsService } from './residents.service';

/** Residents, occupancies, unit states and self-registration (API v0, ADR 0062). */
@Module({
  controllers: [
    RegistrationPublicController,
    RegistrationStatusController,
    MeUnitsController,
    UnitActionsController,
    OccupanciesController,
    UnitStatesController,
    ResidentsController,
    RegistrationsController,
    UnitDocumentsController,
    StaffUnitDocumentsController,
    ContractsController,
    StaffContractsController,
    MovesController,
    StaffMovesController,
    ProxiesController,
    MyProxyUnitsController,
    StaffProxiesController,
    ProxyAcceptanceController,
  ],
  imports: [
    AccountsModule,
    AuthModule,
    CapabilitiesModule,
    FilesModule,
    HouseholdsModule,
    NoticesModule,
    WorkersModule,
  ],
  providers: [
    ResidentsService,
    FreezeHooks,
    ErasureHooks,
    RegistrationService,
    RegistrationStatusLinks,
    RegistrationDocumentsService,
    UnitDocumentsService,
    ContractsService,
    MovesService,
    ProxiesService,
    ProxyAcceptanceService,
    CommunityExportSections,
  ],
  exports: [ResidentsService, RegistrationService, MovesService],
})
export class ResidentsModule {}
