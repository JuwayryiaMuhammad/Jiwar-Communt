import { Module } from '@nestjs/common';
import { FineBoardAppeals } from './fines/fine-board-appeals';
import { ViolationBoardAppeals } from './violations/violation-board-appeals';
import { SecurityOverview } from './reports/security-overview';
import { GateExportSections } from './export/export-sections';
import {
  GuardFieldExceptionsController,
  StaffFieldExceptionsController,
} from './exceptions/field-exceptions.controller';
import { FieldExceptionsService } from './exceptions/field-exceptions.service';
import { GateSettingsController } from './settings/gate-settings.controller';
import { GateSettingsProvisioning } from './settings/gate-settings-provisioning';
import { GateSettingsService } from './settings/gate-settings.service';
import { VisitOverstaySweep } from './visitors/visit-overstay.sweep';
import {
  GuardServiceVehiclesController,
  StaffServiceVehiclesController,
} from './service-vehicles/service-vehicles.controller';
import { ServiceVehiclesService } from './service-vehicles/service-vehicles.service';
import { EntryPhotosSweep } from './entries/entry-photos.sweep';
import {
  GateIncidentEvidenceController,
  StaffIncidentEvidenceController,
} from './incidents/incident-evidence.controller';
import { IncidentEvidenceService } from './incidents/incident-evidence.service';
import { GateDirectoryController } from './directory/gate-directory.controller';
import { GateDirectoryService } from './directory/gate-directory.service';
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
import { GuardSosController } from './emergencies/guard-sos.controller';
import { GuardSosService } from './emergencies/guard-sos.service';
import { BlocklistCore } from './blocklist/blocklist-core';
import { BlocklistService } from './blocklist/blocklist.service';
import { BlocklistMatcher } from './blocklist/blocklist-matcher';
import {
  GateBlocklistController,
  GateIdLookupController,
} from './blocklist/gate-blocklist.controller';
import { IdLookupService } from './blocklist/id-lookup.service';
import { StaffBlocklistController } from './blocklist/staff-blocklist.controller';
import { GateIncidentsController } from './incidents/gate-incidents.controller';
import { IncidentExportSections } from './incidents/incident-export-sections';
import { IncidentLifecycle } from './incidents/incident-lifecycle';
import { IncidentsService } from './incidents/incidents.service';
import { StaffIncidentsController } from './incidents/staff-incidents.controller';
import { GateLockdownsController } from './lockdown/gate-lockdowns.controller';
import {
  GateViolationsController,
  StaffViolationsController,
  UnitViolationsController,
} from './violations/violations.controller';
import { ViolationExportSections } from './violations/violation-export-sections';
import { ViolationLifecycle } from './violations/violation-lifecycle';
import { ViolationPaymentsController } from './violations/violation-payments.controller';
import { ViolationPaymentsService } from './violations/violation-payments.service';
import { ViolationsService } from './violations/violations.service';
import { LockdownCore } from './lockdown/lockdown-core';
import { LockdownProvisioning } from './lockdown/lockdown-provisioning';
import { LockdownService } from './lockdown/lockdown.service';
import { StaffLockdownsController } from './lockdown/staff-lockdowns.controller';
import { SafetyCore } from './safety/safety-core';
import { SafetyExportSections } from './safety/safety-export-sections';
import { SafetyLifecycle } from './safety/safety-lifecycle';
import { GateServicesController } from './gate-services/gate-services.controller';
import { GateServicesService } from './gate-services/gate-services.service';
import { GateServiceRecords } from './gate-services/gate-service-records';
import { GateServiceHandlersController } from './gate-services/gate-service-handlers.controller';
import { GateServiceHandlersService } from './gate-services/gate-service-handlers.service';
import { DailyReportController } from './reports/daily-report.controller';
import { DailyReportService } from './reports/daily-report.service';
import {
  IncidentReportController,
  ViolationReportController,
} from './reports/security-reports.controller';
import { SecurityReportsService } from './reports/security-reports.service';
import {
  PermitRulesController,
  PermitSettingsController,
} from './permits/permit-settings.controller';
import { PermitProvisioning } from './permits/permit-provisioning';
import { PermitWorkStopsService } from './permits/permit-work-stops.service';
import { PermitSettingsService } from './permits/permit-settings.service';
import { PermitCore } from './permits/permit-core';
import { PermitRecords } from './permits/permit-records';
import { PermitsController } from './permits/permits.controller';
import { PermitsService } from './permits/permits.service';
import { PermitWorkersService } from './permits/permit-workers.service';
import { PermitRequestsService } from './permits/permit-requests.service';
import { PermitGuestsService } from './permits/permit-guests.service';
import { StaffPermitsController } from './permits/staff-permits.controller';
import { StaffPermitsService } from './permits/staff-permits.service';
import { PermitSweeps } from './permits/permit-sweeps';
import { PermitIdCheck } from './permits/permit-id-check';
import {
  GatePermitsController,
  MaterialEntriesController,
} from './permits/gate-permits.controller';
import { MaterialEntriesService } from './permits/material-entries.service';
import { PermitLifecycle } from './permits/permit-lifecycle';
import { PermitExportSections } from './permits/permit-export-sections';
import { GatePermitsService } from './permits/gate-permits.service';
import {
  GuardFoundItemsController,
  StaffFoundItemsController,
} from './found-items/found-items.controller';
import { FoundItemsService } from './found-items/found-items.service';
import {
  GuardInstructionsController,
  StaffGuardInstructionsController,
} from './guard-instructions/guard-instructions.controller';
import { GuardInstructionsService } from './guard-instructions/guard-instructions.service';
import {
  GuardHandoverController,
  StaffHandoverController,
} from './handover/handover.controller';
import { HandoverService } from './handover/handover.service';
import { GuardDutyExportSections } from './roster/duty-export-sections';
import { GuardDutyLifecycle } from './roster/duty-lifecycle';
import { CheckpointsController } from './patrols/checkpoints.controller';
import { CheckpointsService } from './patrols/checkpoints.service';
import { PatrolCore } from './patrols/patrol-core';
import { RoutesController } from './patrols/routes.controller';
import { RoutesService } from './patrols/routes.service';
import { GuardPatrolsService } from './patrols/guard-patrols.service';
import { PatrolScansService } from './patrols/patrol-scans.service';
import { PatrolExportSections } from './patrols/patrol-export-sections';
import { PatrolLifecycle } from './patrols/patrol-lifecycle';
import { PatrolReportService } from './patrols/patrol-report.service';
import { PatrolReportController } from './patrols/report.controller';
import { PatrolSweeps } from './patrols/patrol-sweeps';
import { PatrolTrackService } from './patrols/patrol-track.service';
import {
  GuardPatrolsController,
  StaffRunsController,
} from './patrols/runs.controller';
import { RunsCore } from './patrols/runs-core';
import { StaffRunsService } from './patrols/staff-runs.service';
import { DutyNamesReader } from './roster/duty-names';
import {
  GuardSwapsController,
  StaffSwapsController,
} from './swaps/swaps.controller';
import { SwapsService } from './swaps/swaps.service';
import { MyWorkService } from './tasks/my-work.service';
import {
  GuardTasksController,
  MyWorkController,
  StaffTasksController,
} from './tasks/tasks.controller';
import { TasksService } from './tasks/tasks.service';
import { RosterAttendance } from './roster/roster-attendance';
import { RosterCore } from './roster/roster-core';
import {
  GuardRosterController,
  StaffRosterController,
} from './roster/roster.controller';
import { RosterService } from './roster/roster.service';
import { ChildControlsController } from './children/child-controls.controller';
import { ChildControlsService } from './children/child-controls.service';
import { ChildCore } from './children/child-core';
import { ChildEscortsController } from './children/child-escorts.controller';
import { ChildEscortsService } from './children/child-escorts.service';
import { PickupPageController } from './children/pickup-page.controller';
import { ChildGateController } from './children/child-gate.controller';
import { ChildGateService } from './children/child-gate.service';
import {
  ChildAlertsController,
  ChildPickupsController,
} from './children/child-records.controller';
import { ChildRecordsService } from './children/child-records.service';
import { ChildExportSections } from './children/child-export-sections';
import { PickupPageService } from './children/pickup-page.service';

/**
 * The gate domain (ADR 0028): the gate, visitors, parcels (ADR 0035), and
 * vehicles and parking (ADR 0045), emergencies and gate services
 * (ADR 0047), a unit's permits and contractors (ADR 0049), and the children's exit control (ADR 0054). It imports core freely and the community
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
    // The gate's completion (ADR 0056).
    GateSettingsController,
    GuardFieldExceptionsController,
    StaffFieldExceptionsController,
    GuardServiceVehiclesController,
    StaffServiceVehiclesController,
    GateIncidentEvidenceController,
    StaffIncidentEvidenceController,
    GateDirectoryController,
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
    GuardSosController,
    GateLockdownsController,
    StaffLockdownsController,
    StaffBlocklistController,
    GateBlocklistController,
    GateIdLookupController,
    GateIncidentsController,
    StaffIncidentsController,
    UnitViolationsController,
    StaffViolationsController,
    GateViolationsController,
    ViolationPaymentsController,
    GateServicesController,
    GateServiceHandlersController,
    PermitRulesController,
    PermitSettingsController,
    PermitsController,
    StaffPermitsController,
    GatePermitsController,
    MaterialEntriesController,
    StaffRosterController,
    GuardRosterController,
    GuardHandoverController,
    StaffHandoverController,
    StaffTasksController,
    GuardTasksController,
    MyWorkController,
    GuardSwapsController,
    StaffSwapsController,
    StaffGuardInstructionsController,
    GuardInstructionsController,
    GuardFoundItemsController,
    StaffFoundItemsController,
    DailyReportController,
    IncidentReportController,
    ViolationReportController,
    CheckpointsController,
    RoutesController,
    GuardPatrolsController,
    StaffRunsController,
    PatrolReportController,
    ChildControlsController,
    ChildEscortsController,
    PickupPageController,
    ChildPickupsController,
    ChildGateController,
    ChildAlertsController,
  ],
  providers: [
    FineBoardAppeals,
    ViolationBoardAppeals,
    SecurityOverview,
    GateSettingsService,
    GateSettingsProvisioning,
    FieldExceptionsService,
    VisitOverstaySweep,
    ServiceVehiclesService,
    EntryPhotosSweep,
    IncidentEvidenceService,
    GateDirectoryService,
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
    GuardSosService,
    LockdownCore,
    LockdownService,
    LockdownProvisioning,
    BlocklistCore,
    BlocklistService,
    BlocklistMatcher,
    IdLookupService,
    IncidentsService,
    IncidentLifecycle,
    IncidentExportSections,
    ViolationsService,
    ViolationPaymentsService,
    ViolationLifecycle,
    ViolationExportSections,
    GateServiceRecords,
    GateServicesService,
    GateServiceHandlersService,
    SafetyLifecycle,
    SafetyExportSections,
    PermitProvisioning,
    PermitWorkStopsService,
    PermitSettingsService,
    PermitCore,
    PermitRecords,
    PermitsService,
    PermitWorkersService,
    PermitRequestsService,
    PermitGuestsService,
    StaffPermitsService,
    PermitSweeps,
    PermitIdCheck,
    GatePermitsService,
    MaterialEntriesService,
    PermitLifecycle,
    PermitExportSections,
    DutyNamesReader,
    RosterCore,
    RosterService,
    RosterAttendance,
    HandoverService,
    TasksService,
    MyWorkService,
    SwapsService,
    GuardInstructionsService,
    FoundItemsService,
    DailyReportService,
    SecurityReportsService,
    GuardDutyLifecycle,
    GuardDutyExportSections,
    CheckpointsService,
    PatrolCore,
    RunsCore,
    RoutesService,
    GuardPatrolsService,
    StaffRunsService,
    PatrolScansService,
    PatrolTrackService,
    PatrolReportService,
    PatrolSweeps,
    PatrolLifecycle,
    PatrolExportSections,
    ChildCore,
    ChildControlsService,
    ChildEscortsService,
    PickupPageService,
    ChildGateService,
    ChildRecordsService,
    ChildExportSections,
  ],
})
export class GateModule {}
