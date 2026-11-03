import {
  StaffHelpController,
  TechnicianHelpController,
} from './help/help-requests.controller';
import { HelpRequestsService } from './help/help-requests.service';
import { HelpExportSections } from './help/help-export-sections';
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
import { WorkOrdersController } from './tickets/work-orders.controller';
import { WorkOrdersService } from './tickets/work-orders.service';
import { TicketExport } from './tickets/ticket-export';
import { SlaAtRisk } from './sla/sla-at-risk';
import { SlaReports } from './sla/sla-report';
import { SlaReportController } from './sla/sla-report.controller';
import { WarrantyClaimsController } from './assets/warranty-claims.controller';
import { WarrantyClaimsService } from './assets/warranty-claims.service';
import { AssetTimeline } from './assets/asset-timeline';
import { PlanCalendar } from './plans/plan-calendar';
import { ResidentTicketFeed } from './tickets/resident-ticket-feed';
import { ResidentTicketSummary } from './tickets/resident-ticket-summary';
import { ResidentTicketItems } from './tickets/resident-ticket-items';
import { MaintenanceStaffSearchSources } from './tickets/staff-search-sources';
import { MaintenanceDashboardSections } from './dashboard/maintenance-dashboard';
import { ServicePressure } from './dispatch/service-pressure';
import { ServicePressureController } from './dispatch/service-pressure.controller';
import { ResidentTicketsController } from './tickets/resident-tickets.controller';
import { TicketAccess } from './tickets/ticket-access';
import { SensitiveTickets } from './tickets/sensitive-tickets';
import { SensitivityService } from './tickets/sensitivity.service';
import { SensitivityController } from './tickets/sensitivity.controller';
import { TicketLanding } from './analytics/ticket-landing';
import { AnalyticsSettingsService } from './analytics/analytics-settings.service';
import { AnalyticsSettingsController } from './analytics/analytics-settings.controller';
import { RecurrenceReports } from './analytics/recurrence';
import { ComplaintsMap } from './analytics/complaints-map';
import { AnalyticsController } from './analytics/analytics.controller';
import { PlanSuggestionsService } from './analytics/plan-suggestions.service';
import { PlanSuggestionsController } from './analytics/plan-suggestions.controller';
import { CasesService } from './analytics/cases.service';
import { CasesController } from './analytics/cases.controller';
import { PlanSuggestionInboxItems } from './analytics/plan-suggestion-inbox-items';
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
  PlanCalendarController,
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
  ContractPaymentsDueController,
  MaintenanceContractsController,
} from './contracts/contracts.controller';
import { MaintenanceContractsService } from './contracts/contracts.service';
import { ContractSweep } from './contracts/contract-sweep';
import { PurchaseInboxItems } from './purchases/purchase-inbox-items';
import { PayableSources } from './contracts/payable-sources';
import { PurchasesController } from './purchases/purchases.controller';
import { PurchasesService } from './purchases/purchases.service';
import { VendorDocumentSweep } from './vendors/vendor-sweep';
import { VendorsController } from './vendors/vendors.controller';
import { VendorsService } from './vendors/vendors.service';
import { ComplianceController } from './compliance/compliance.controller';
import { ComplianceOverview } from './compliance/compliance-overview';
import { ComplianceService } from './compliance/compliance.service';
import { ComplianceSweep } from './compliance/compliance-sweep';
import { ContractHandover } from './contracts/contract-handover';
import { MeterAlertsService } from './energy/alerts.service';
import { ConsumptionService } from './energy/consumption.service';
import { HouseholdConsumptionController } from './energy/household-consumption.controller';
import { HouseholdConsumptionService } from './energy/household-consumption.service';
import { MeasuresService } from './energy/measures.service';
import { TariffsService } from './energy/tariffs.service';
import { OutageSweep } from './outages/outage-sweep';
import {
  MyOutagesController,
  OutagesController,
} from './outages/outages.controller';
import { OutagesService } from './outages/outages.service';
import { ResidentOutageSummary } from './outages/resident-outage-summary';
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
import { WorkPermitInboxItems } from './field-safety/work-permit-inbox-items';
import { TicketExperience } from './tickets/ticket-experience';

/**
 * The maintenance domain (ADR 0032). It imports core freely and the
 * community domain only through src/community/index.ts (ADR 0015); never
 * the gate.
 */
import { MaintenanceManagementPort } from './management-port';
import { TicketCorrespondence } from './tickets/ticket-correspondence';
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
    WorkOrdersController,
    SlaReportController,
    // ADR 0081.
    SensitivityController,
    AnalyticsSettingsController,
    AnalyticsController,
    PlanSuggestionsController,
    CasesController,
    WarrantyClaimsController,
    DispatchUnitsController,
    TechnicianTicketsController,
    TechniciansController,
    TechnicianAvailabilityController,
    DispatchAvailabilityController,
    DispatchSettingsController,
    ServicePressureController,
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
    PlanCalendarController,
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
    ContractPaymentsDueController,
    VendorsController,
    PurchasesController,
    ComplianceController,
    EconomicsController,
    MetersController,
    MeterAlertsController,
    EnergySettingsController,
    TechnicianMetersController,
    MeterReadingImportsController,
    EnergyController,
    HouseholdConsumptionController,
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
    TechnicianHelpController,
    StaffHelpController,
  ],
  providers: [
    TicketCorrespondence,
    MaintenanceManagementPort,
    TicketExperience,
    MaintenanceProvisioning,
    CategoriesService,
    PreventiveServicesService,
    SpecialtiesService,
    AvailabilityService,
    HelpRequestsService,
    HelpExportSections,
    DispatchSettingsService,
    DispatchLimiter,
    DispatchEngine,
    DispatchSweep,
    TechnicianQualification,
    MaintenanceSettingsService,
    TicketAccess,
    SensitiveTickets,
    // ADR 0081.
    SensitivityService,
    TicketLanding,
    AnalyticsSettingsService,
    RecurrenceReports,
    ComplaintsMap,
    PlanSuggestionsService,
    CasesService,
    PlanSuggestionInboxItems,
    TicketLog,
    TicketNotices,
    TicketsService,
    AttachmentsService,
    DispatchService,
    WorkService,
    WorkOrdersService,
    TicketExport,
    SlaAtRisk,
    SlaReports,
    WarrantyClaimsService,
    AssetTimeline,
    PlanCalendar,
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
    MaintenanceStaffSearchSources,
    ServicePressure,
    MaintenanceDashboardSections,
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
    VendorsService,
    VendorDocumentSweep,
    PurchasesService,
    PurchaseInboxItems,
    ComplianceService,
    ComplianceSweep,
    ComplianceOverview,
    ContractHandover,
    // Payables' sources (ADR 0089).
    PayableSources,
    EconomicsService,
    MetersService,
    ReadingsService,
    MeterAlertsService,
    EnergySettingsService,
    MeterReadingImportsService,
    ConsumptionService,
    HouseholdConsumptionService,
    TariffsService,
    MeasuresService,
    OutagesService,
    OutageSweep,
    ReadinessService,
    ReadinessSweep,
    CampaignsService,
    WorkPermitsService,
    WorkPermitInboxItems,
    SafetyInstructionsService,
    WorkHazardsService,
    ResidentOutageSummary,
    TechnicianStatsService,
  ],
  // What the daily brief reads of a resident's tickets (ADR 0040).
  exports: [
    ResidentTicketSummary,
    ResidentOutageSummary,
    MaintenanceManagementPort,
  ],
})
export class MaintenanceModule {}
