import { Module } from '@nestjs/common';
import { MaintenanceExportSections } from './export/export-sections';
import { CommunityMaintenancePortModule } from '../community';
import { AccountsModule } from '../core/accounts/accounts.module';
import { FilesModule } from '../core/files/files.module';
import {
  CategoriesController,
  CategoryOptionsController,
} from './categories/categories.controller';
import { CategoriesService } from './categories/categories.service';
import {
  PreventiveServiceOptionsController,
  PreventiveServicesController,
} from './preventive/preventive-services.controller';
import { PreventiveRequestsController } from './preventive/preventive-requests.controller';
import { PreventiveServicesService } from './preventive/preventive-services.service';
import { AvailabilityService } from './dispatch/availability.service';
import {
  DispatchAvailabilityController,
  TechnicianAvailabilityController,
} from './dispatch/availability.controller';
import { DispatchLimiter } from './dispatch/dispatch-limiter';
import { DispatchEngine } from './dispatch/dispatch-engine';
import { TechnicianQualification } from './dispatch/technician-qualification';
import { DispatchSweep } from './dispatch/dispatch-sweep';
import { DispatchSettingsController } from './dispatch/dispatch-settings.controller';
import { DispatchSettingsService } from './dispatch/dispatch-settings.service';
import { MaintenanceProvisioning } from './provisioning';
import {
  CategorySlaTargetsController,
  SlaSettingsController,
} from './sla/sla-settings.controller';
import { SlaRecorder } from './sla/sla-recorder';
import { SlaService } from './sla/sla.service';
import { SlaSettingsService } from './sla/sla-settings.service';
import { SlaSweep } from './sla/sla-sweep';
import { SlaTargetsService } from './sla/sla-targets.service';
import {
  CategorySpecialtiesController,
  SpecialtiesController,
} from './specialties/specialties.controller';
import { SpecialtiesService } from './specialties/specialties.service';
import { MaintenanceSettingsController } from './settings/maintenance-settings.controller';
import { MaintenanceSettingsService } from './settings/maintenance-settings.service';
import { AttachmentsService } from './tickets/attachments.service';
import { DispatchUnitsController } from './tickets/dispatch-units.controller';
import {
  DispatchTicketsController,
  TechniciansController,
} from './tickets/dispatch-tickets.controller';
import { ConfirmationService } from './tickets/confirmation.service';
import { EscalationService } from './tickets/escalation.service';
import { DispatchService } from './tickets/dispatch.service';
import { MessagesService } from './tickets/messages.service';
import { TechnicianRelease } from './tickets/technician-release';
import { TechnicianTicketsController } from './tickets/technician-tickets.controller';
import { WorkService } from './tickets/work.service';
import { ResidentTicketFeed } from './tickets/resident-ticket-feed';
import { ResidentTicketSummary } from './tickets/resident-ticket-summary';
import { ResidentTicketItems } from './tickets/resident-ticket-items';
import { ResidentTicketsController } from './tickets/resident-tickets.controller';
import { TicketAccess } from './tickets/ticket-access';
import { TicketLog } from './tickets/ticket-log';
import { TicketNotices } from './tickets/ticket-notices';
import { TicketsService } from './tickets/tickets.service';
import { VisitAccess } from './visits/visit-access';
import { VisitConsentService } from './visits/visit-consent.service';
import { VisitLifecycle } from './visits/visit-lifecycle';
import { VisitLog } from './visits/visit-log';
import {
  DispatchVisitsController,
  ResidentVisitsController,
  TechnicianVisitsController,
  UnitVisitsController,
} from './visits/visits.controller';
import { VisitsService } from './visits/visits.service';
import {
  DispatchQuotesController,
  ResidentQuotesController,
} from './quotes/quotes.controller';
import { CommonAreasController } from './locations/common-areas.controller';
import { CommonAreasService } from './locations/common-areas.service';
import { AssetTypesController } from './assets/asset-types.controller';
import { AssetTypesService } from './assets/asset-types.service';
import { AssetsController } from './assets/assets.controller';
import { AssetsService } from './assets/assets.service';
import { DocumentsController } from './assets/documents.controller';
import { DocumentsService } from './assets/documents.service';
import { AssetImportsController } from './assets/asset-imports.controller';
import { AssetImportsService } from './assets/asset-imports.service';
import { WarrantySweep } from './assets/warranty-sweep';
import { CompoundCalendar } from './schedules/compound-calendar';
import { AssetReadings } from './checklists/asset-readings.service';
import { ChecklistRuns } from './checklists/checklist-runs';
import {
  ChecklistsController,
  DispatchChecklistController,
  TechnicianChecklistController,
} from './checklists/checklists.controller';
import { ChecklistsService } from './checklists/checklists.service';
import { TicketChecklists } from './checklists/ticket-checklists.service';
import {
  PlanOccurrencesController,
  PlansController,
} from './plans/plans.controller';
import { PlansService } from './plans/plans.service';
import { PlanSweep } from './plans/plan-sweep';
import {
  InspectionReportController,
  InspectionRoundsController,
  InspectionsController,
  MyInspectionsController,
} from './inspections/inspections.controller';
import { InspectionsService } from './inspections/inspections.service';
import { InspectionReports } from './inspections/inspection-reports';
import { InspectionSweep } from './inspections/inspection-sweep';
import {
  FieldController,
  ReplacementsController,
} from './field/field.controller';
import { FieldWorkService } from './field/field-work.service';
import { ReplacementsService } from './field/replacements.service';
import { QuotesService } from './quotes/quotes.service';
import { TicketCostsController } from './costs/ticket-costs.controller';
import { TicketCostsService } from './costs/ticket-costs.service';
import {
  DispatchQuoteSuggestionsController,
  TechnicianQuoteSuggestionsController,
} from './quotes/quote-suggestions.controller';
import { QuoteSuggestionsService } from './quotes/quote-suggestions.service';
import {
  DispatchTicketPartsController,
  PartRequestsController,
  StockController,
  StoresController,
  TechnicianPartsController,
} from './stock/stock.controller';
import { PartRequestsService } from './stock/part-requests.service';
import { StockItemsService } from './stock/stock-items.service';
import { StockLedger } from './stock/stock-ledger';
import { StoresService } from './stock/stores.service';
import {
  AssetContractsController,
  MaintenanceContractsController,
} from './contracts/contracts.controller';
import { MaintenanceContractsService } from './contracts/contracts.service';
import { ContractSweep } from './contracts/contract-sweep';
import { MeterAlertsService } from './energy/alerts.service';
import { ConsumptionService } from './energy/consumption.service';
import { MeasuresService } from './energy/measures.service';
import { TariffsService } from './energy/tariffs.service';
import { OutageSweep } from './outages/outage-sweep';
import {
  MyOutagesController,
  OutagesController,
} from './outages/outages.controller';
import { OutagesService } from './outages/outages.service';
import {
  OwnReadinessItemsController,
  ReadinessItemsController,
  ReadinessProgramsController,
} from './readiness/readiness.controller';
import { ReadinessService } from './readiness/readiness.service';
import { CampaignsService } from './readiness/campaigns.service';
import {
  AssetTypeHazardsController,
  CategorySafetyController,
  TechnicianSafetyController,
  TicketPermitsController,
  WorkPermitsController,
} from './field-safety/field-safety.controller';
import { WorkHazardsService } from './field-safety/hazards.service';
import { SafetyInstructionsService } from './field-safety/safety-instructions.service';
import { WorkPermitsService } from './field-safety/work-permits.service';
import { ReadinessSweep } from './readiness/readiness-sweep';
import {
  EnergyController,
  EnergySettingsController,
  MeterAlertsController,
  MeterReadingImportsController,
  MetersController,
  TechnicianMetersController,
} from './energy/energy.controller';
import { EnergySettingsService } from './energy/energy-settings.service';
import { MeterReadingImportsService } from './energy/reading-imports.service';
import { ReadingsService } from './energy/readings.service';
import { MetersService } from './energy/meters.service';
import { EconomicsController } from './economics/economics.controller';
import { EconomicsService } from './economics/economics.service';
import {
  MyTechnicianStatsController,
  TechnicianStatsController,
} from './economics/technician-stats.controller';
import { TechnicianStatsService } from './economics/technician-stats.service';

/**
 * The maintenance domain (ADR 0032). It imports core freely and the
 * community domain only through src/community/index.ts (ADR 0015); never
 * the gate.
 */
@Module({
  imports: [AccountsModule, CommunityMaintenancePortModule, FilesModule],
  controllers: [
    CategoriesController,
    CategoryOptionsController,
    PreventiveServicesController,
    PreventiveServiceOptionsController,
    PreventiveRequestsController,
    SpecialtiesController,
    CategorySpecialtiesController,
    MaintenanceSettingsController,
    ResidentTicketsController,
    DispatchTicketsController,
    DispatchUnitsController,
    TechnicianTicketsController,
    TechniciansController,
    TechnicianAvailabilityController,
    DispatchAvailabilityController,
    DispatchSettingsController,
    SlaSettingsController,
    CategorySlaTargetsController,
    ResidentVisitsController,
    TechnicianVisitsController,
    DispatchVisitsController,
    UnitVisitsController,
    ResidentQuotesController,
    DispatchQuotesController,
    CommonAreasController,
    AssetTypesController,
    AssetsController,
    DocumentsController,
    AssetImportsController,
    ChecklistsController,
    TechnicianChecklistController,
    DispatchChecklistController,
    PlansController,
    PlanOccurrencesController,
    InspectionRoundsController,
    InspectionsController,
    InspectionReportController,
    MyInspectionsController,
    FieldController,
    ReplacementsController,
    TicketCostsController,
    TechnicianQuoteSuggestionsController,
    DispatchQuoteSuggestionsController,
    StoresController,
    StockController,
    PartRequestsController,
    DispatchTicketPartsController,
    TechnicianPartsController,
    MaintenanceContractsController,
    AssetContractsController,
    EconomicsController,
    MetersController,
    MeterAlertsController,
    EnergySettingsController,
    TechnicianMetersController,
    MeterReadingImportsController,
    EnergyController,
    OutagesController,
    MyOutagesController,
    ReadinessProgramsController,
    ReadinessItemsController,
    OwnReadinessItemsController,
    WorkPermitsController,
    TicketPermitsController,
    TechnicianSafetyController,
    CategorySafetyController,
    AssetTypeHazardsController,
    MyTechnicianStatsController,
    TechnicianStatsController,
  ],
  providers: [
    MaintenanceProvisioning,
    CategoriesService,
    PreventiveServicesService,
    SpecialtiesService,
    AvailabilityService,
    DispatchSettingsService,
    DispatchLimiter,
    DispatchEngine,
    DispatchSweep,
    TechnicianQualification,
    MaintenanceSettingsService,
    TicketAccess,
    TicketLog,
    TicketNotices,
    TicketsService,
    AttachmentsService,
    DispatchService,
    WorkService,
    TechnicianRelease,
    MessagesService,
    ConfirmationService,
    EscalationService,
    SlaSettingsService,
    SlaTargetsService,
    SlaRecorder,
    SlaService,
    SlaSweep,
    VisitAccess,
    VisitLog,
    VisitsService,
    VisitConsentService,
    VisitLifecycle,
    MaintenanceExportSections,
    ResidentTicketFeed,
    ResidentTicketSummary,
    QuotesService,
    ResidentTicketItems,
    CommonAreasService,
    CompoundCalendar,
    AssetTypesService,
    AssetsService,
    DocumentsService,
    AssetImportsService,
    WarrantySweep,
    AssetReadings,
    ChecklistsService,
    ChecklistRuns,
    TicketChecklists,
    PlansService,
    PlanSweep,
    InspectionsService,
    InspectionReports,
    InspectionSweep,
    FieldWorkService,
    ReplacementsService,
    TicketCostsService,
    QuoteSuggestionsService,
    StockLedger,
    StoresService,
    StockItemsService,
    PartRequestsService,
    MaintenanceContractsService,
    ContractSweep,
    EconomicsService,
    MetersService,
    ReadingsService,
    MeterAlertsService,
    EnergySettingsService,
    MeterReadingImportsService,
    ConsumptionService,
    TariffsService,
    MeasuresService,
    OutagesService,
    OutageSweep,
    ReadinessService,
    ReadinessSweep,
    CampaignsService,
    WorkPermitsService,
    SafetyInstructionsService,
    WorkHazardsService,
    TechnicianStatsService,
  ],
  // What the daily brief reads of a resident's tickets (ADR 0040).
  exports: [ResidentTicketSummary],
})
export class MaintenanceModule {}
