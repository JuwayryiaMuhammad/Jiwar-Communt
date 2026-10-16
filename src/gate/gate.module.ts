import { Module } from '@nestjs/common';
import { GateExportSections } from './export/export-sections';
import { CommunityGatePortModule } from '../community';
import { AccountsModule } from '../core/accounts/accounts.module';
import { FilesModule } from '../core/files/files.module';
import { AuthModule } from '../core/auth/auth.module';
import { TenantSettingsModule } from '../core/tenant-settings/tenant-settings.module';
import { ApprovalsService } from './approvals/approvals.service';
import { AttendanceController } from './attendance/attendance.controller';
import { AttendanceService } from './attendance/attendance.service';
import {
  GuardApprovalsController,
  HostApprovalsController,
} from './approvals/approvals.controller';
import { EntriesController } from './entries/entries.controller';
import { EntryCredentialsController } from './entry/entry-credentials.controller';
import { EntryCredentialsService } from './entry/entry-credentials.service';
import { EntrySecrets } from './entry/entry-secrets';
import { ResidentVerifier } from './entry/resident-verifier';
import { EntriesService } from './entries/entries.service';
import { GateSubjects } from './entries/subjects';
import { VerifyService } from './entries/verify.service';
import { GatesController } from './gates/gates.controller';
import { GatesService } from './gates/gates.service';
import { ShiftsController } from './shifts/shifts.controller';
import { ShiftsService } from './shifts/shifts.service';
import { GateParcelsController } from './parcels/gate-parcels.controller';
import { ResidentParcelsController } from './parcels/resident-parcels.controller';
import { ResidentParcels } from './parcels/resident-parcels.service';
import {
  ManagerParcelsController,
  ParcelSettingsController,
} from './parcels/manager-parcels.controller';
import { ParcelSweeps } from './parcels/parcel-sweeps';
import { ParcelSettingsService } from './parcels/parcel-settings.service';
import { ParcelHandover } from './parcels/parcel-handover.service';
import { ParcelCore } from './parcels/parcel-core';
import { ParcelsService } from './parcels/parcels.service';
import { ParcelTokens } from './parcels/parcel-tokens';
import { ParcelProvisioning } from './parcels/parcel-provisioning';
import { InstructionsService } from './visitors/instructions.service';
import { VisitorDataSweep } from './visitors/visitor-data.sweep';
import { VisitorPageController } from './visitors/visitor-page.controller';
import { VisitorPageService } from './visitors/visitor-page.service';
import { PassTokens } from './visitors/pass-tokens';
import { StandingInstructionsService } from './visitors/standing-instructions.service';
import { VisitorPassesService } from './visitors/visitor-passes.service';
import { VisitorsController } from './visitors/visitors.controller';
import { StaffVehiclesService } from './vehicles/staff-vehicles.service';
import { VehicleCore } from './vehicles/vehicle-core';
import { VehicleProvisioning } from './vehicles/vehicle-provisioning';
import { VehicleSettingsService } from './vehicles/vehicle-settings.service';
import { VehicleSweeps } from './vehicles/vehicle-sweeps';
import {
  StaffVehiclesController,
  VehicleSettingsController,
  VehiclesController,
} from './vehicles/vehicles.controller';
import { VehiclesService } from './vehicles/vehicles.service';
import { GateVehiclesController } from './vehicles/gate-vehicles.controller';
import { PlateLookupService } from './vehicles/plate-lookup.service';
import {
  StaffFinesController,
  UnitFinesController,
} from './fines/fines.controller';
import { FinesService } from './fines/fines.service';
import { FinePaymentsController } from './fines/fine-payments.controller';
import { FinePaymentsService } from './fines/fine-payments.service';
import {
  MyParkingReportsController,
  StaffParkingReportsController,
} from './parking-reports/parking-reports.controller';
import { ParkingReportsService } from './parking-reports/parking-reports.service';
import { VehicleExportSections } from './vehicles/vehicle-export-sections';
import { VehiclesLifecycle } from './vehicles/vehicles-lifecycle';
import {
  ParkingSlotsController,
  StaffVisitorParkingController,
  UnitParkingController,
  VisitorAreasController,
} from './parking/parking.controller';
import { ParkingSweeps } from './parking/parking-sweeps';
import { StaffParkingService } from './parking/staff-parking.service';
import { VisitorParkingService } from './parking/visitor-parking.service';
import {
  CommunityPlacesController,
  PlacesController,
} from './places/places.controller';
import { PlaceProvisioning } from './places/place-provisioning';
import { PlacesService } from './places/places.service';
import { EmergencyContactsController } from './emergencies/emergency-contacts.controller';
import { EmergencyContactsService } from './emergencies/emergency-contacts.service';
import { EmergenciesController } from './emergencies/emergencies.controller';
import { EmergenciesService } from './emergencies/emergencies.service';
import { EmergencyRespondersController } from './emergencies/emergency-responders.controller';
import { EmergencyRespondersService } from './emergencies/emergency-responders.service';
import { EmergencyEscalation } from './emergencies/emergency-escalation';
import { EmergencyRecords } from './emergencies/emergency-records';
import { SafetyCore } from './safety/safety-core';
import { SafetyExportSections } from './safety/safety-export-sections';
import { SafetyLifecycle } from './safety/safety-lifecycle';
import { GateServicesController } from './gate-services/gate-services.controller';
import { GateServicesService } from './gate-services/gate-services.service';
import { GateServiceRecords } from './gate-services/gate-service-records';
import { GateServiceHandlersController } from './gate-services/gate-service-handlers.controller';
import { GateServiceHandlersService } from './gate-services/gate-service-handlers.service';
import {
  PermitRulesController,
  PermitSettingsController,
} from './permits/permit-settings.controller';
import { PermitProvisioning } from './permits/permit-provisioning';
import { PermitSettingsService } from './permits/permit-settings.service';

/**
 * The gate domain (ADR 0028): the gate, visitors, parcels (ADR 0035), and
 * vehicles and parking (ADR 0045), emergencies and gate services
 * (ADR 0047), and a unit's permits and contractors (ADR 0049). It imports core freely and the community
 * domain only through src/community/index.ts (ADR 0015).
 */
@Module({
  imports: [
    AccountsModule,
    AuthModule,
    FilesModule,
    TenantSettingsModule,
    CommunityGatePortModule,
  ],
  controllers: [
    GatesController,
    ShiftsController,
    VisitorsController,
    VisitorPageController,
    EntriesController,
    GuardApprovalsController,
    HostApprovalsController,
    AttendanceController,
    EntryCredentialsController,
    GateParcelsController,
    ResidentParcelsController,
    ManagerParcelsController,
    ParcelSettingsController,
    VehiclesController,
    StaffVehiclesController,
    VehicleSettingsController,
    UnitParkingController,
    ParkingSlotsController,
    VisitorAreasController,
    StaffVisitorParkingController,
    GateVehiclesController,
    UnitFinesController,
    StaffFinesController,
    FinePaymentsController,
    MyParkingReportsController,
    StaffParkingReportsController,
    CommunityPlacesController,
    PlacesController,
    EmergencyContactsController,
    EmergenciesController,
    EmergencyRespondersController,
    GateServicesController,
    GateServiceHandlersController,
    PermitRulesController,
    PermitSettingsController,
  ],
  providers: [
    GatesService,
    ShiftsService,
    VisitorPassesService,
    PassTokens,
    StandingInstructionsService,
    VisitorPageService,
    InstructionsService,
    VisitorDataSweep,
    GateSubjects,
    EntriesService,
    VerifyService,
    ApprovalsService,
    AttendanceService,
    EntrySecrets,
    EntryCredentialsService,
    ResidentVerifier,
    ParcelProvisioning,
    ParcelTokens,
    ParcelCore,
    ParcelsService,
    ResidentParcels,
    ParcelHandover,
    ParcelSettingsService,
    ParcelSweeps,
    GateExportSections,
    VehicleCore,
    VehicleProvisioning,
    VehiclesService,
    StaffVehiclesService,
    VehicleSettingsService,
    VehicleSweeps,
    VisitorParkingService,
    StaffParkingService,
    ParkingSweeps,
    PlateLookupService,
    FinesService,
    FinePaymentsService,
    ParkingReportsService,
    VehiclesLifecycle,
    VehicleExportSections,
    PlaceProvisioning,
    PlacesService,
    EmergencyContactsService,
    SafetyCore,
    EmergencyRecords,
    EmergencyEscalation,
    EmergenciesService,
    EmergencyRespondersService,
    GateServiceRecords,
    GateServicesService,
    GateServiceHandlersService,
    SafetyLifecycle,
    SafetyExportSections,
    PermitProvisioning,
    PermitSettingsService,
  ],
})
export class GateModule {}
