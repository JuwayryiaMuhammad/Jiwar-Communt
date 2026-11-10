import {
  ClearancesController,
  PublicClearancesController,
  StaffClearancesController,
} from './clearances/clearances.controller';
import { ClearancePageService } from './clearances/clearance-page.service';
import { ClearancesService } from './clearances/clearances.service';
import {
  DepositsController,
  StaffDepositsController,
} from './deposits/deposits.controller';
import { DepositsService } from './deposits/deposits.service';
import { LateNoticesController } from './late-notices/late-notices.controller';
import { LateNoticesService } from './late-notices/late-notices.service';
import { ResidentFinanceItems } from './invoices/resident-finance-items';
import { Module } from '@nestjs/common';
import { CommunityFinancePortModule } from '../community';
import { FilesModule } from '../core/files/files.module';
import { AccountsModule } from '../core/accounts/accounts.module';
import { AuthModule } from '../core/auth/auth.module';
import { PlatformModule } from '../core/platform/platform.module';
import { FinanceAccess } from './access';
import { BoardAuthority } from './budgets/board-authority';
import { FinanceCompensationCredits } from './invoices/compensation-credits';
import { BoardAuthorizationsController } from './budgets/board-authorizations.controller';
import { BudgetMatters } from './budgets/budget-matters';
import { BudgetReportController } from './budgets/budget-report.controller';
import { BudgetReportService } from './budgets/budget-report.service';
import { BudgetsController } from './budgets/budgets.controller';
import { BudgetsService } from './budgets/budgets.service';
import { ExpensesService } from './budgets/expenses.service';
import { FinanceOverview } from './budgets/finance-overview';
import { FinanceDashboardSection } from './reports/finance-dashboard';
import { CandidacyDues } from './invoices/candidacy-dues';
import { BudgetHandover } from './budgets/budget-handover';
import { DisputeBoardAppeals } from './disputes/dispute-board-appeals';
import { BillingPlansController } from './billing-plans/billing-plans.controller';
import { BillingPlansService } from './billing-plans/billing-plans.service';
import { FeesController } from './fees/fees.controller';
import { FeesService } from './fees/fees.service';
import {
  CollectorController,
  CollectorVisitsController,
  StaffCollectorVisitsController,
} from './collector/collector-visits.controller';
import { CollectorSettingsService } from './collector/collector-settings.service';
import { CollectorVisitsService } from './collector/collector-visits.service';
import { ResidentCollectorItems } from './collector/resident-collector-items';
import { UpcomingDuesController } from './forecast/upcoming-dues.controller';
import { UpcomingDuesService } from './forecast/upcoming-dues.service';
import { UpcomingDuesSweep } from './forecast/upcoming-dues.sweep';
import {
  PlanRequestsController,
  StaffPlanRequestsController,
} from './plan-requests/plan-requests.controller';
import { PlanRequestsService } from './plan-requests/plan-requests.service';
import { PlanSettingsService } from './plan-requests/plan-settings.service';
import { ResidentPlanItems } from './plan-requests/resident-plan-items';
import { ReceiptPdfService } from './payments/receipt-pdf.service';
import {
  SpendingReportsController,
  StaffSpendingReportsController,
} from './spending/spending-reports.controller';
import { SpendingReportsService } from './spending/spending-reports.service';
import { CredentialVault } from './gateway/credential-vault';
import { GatewayController } from './gateway/gateway.controller';
import { GatewayKeys } from './gateway/gateway-keys';
import { GatewayService } from './gateway/gateway.service';
import { PlatformGatewayController } from './gateway/platform-gateway.controller';
import { PlatformGatewayService } from './gateway/platform-gateway.service';
import { PaymobClient } from './paymob/paymob-client';
import {
  FetchPaymobTransport,
  PAYMOB_TRANSPORT,
} from './paymob/paymob-transport';
import { FinanceExportSections } from './export/export-sections';
import { FinanceLifecycle } from './privacy/finance-lifecycle';
import { FinanceProvisioning } from './provisioning';
import { ReceiptPageController } from './receipts-public/receipt-page.controller';
import { ReceiptPageService } from './receipts-public/receipt-page.service';
import { InvoiceNoticesSweep } from './invoices/invoice-notices.sweep';
import { InvoiceRemindersSweep } from './invoices/invoice-reminders.sweep';
import {
  StaffInvoicesController,
  UnitInvoicesController,
} from './invoices/invoices.controller';
import { InvoicesService } from './invoices/invoices.service';
import { ChargeSettler } from './charges/charge-settler';
import { FinanceChargesService } from './charges/finance-charges.service';
import {
  StaffInstalmentsController,
  UnitInstalmentsController,
} from './instalments/instalments.controller';
import { InstalmentsService } from './instalments/instalments.service';
import {
  StaffDisputesController,
  UnitDisputesController,
} from './disputes/disputes.controller';
import { DisputesService } from './disputes/disputes.service';
import { RefundsController } from './refunds/refunds.controller';
import { RefundsService } from './refunds/refunds.service';
import { ExportLimit } from '../core/common/csv';
import { LedgerService } from './reports/ledger.service';
import { ReportsController } from './reports/reports.controller';
import { ReportsService } from './reports/reports.service';
import { FinanceNotices } from './notices/finance-notices';
import { PaymentSessionsController } from './online/payment-sessions.controller';
import { GatewayEventsController } from './online/gateway-events.controller';
import { PaymobWebhookController } from './online/paymob-webhook.controller';
import { PaymobWebhookService } from './online/paymob-webhook.service';
import { PaymentSessionsService } from './online/payment-sessions.service';
import {
  StaffPaymentsController,
  UnitPaymentsController,
} from './payments/payments.controller';
import { PaymentsService } from './payments/payments.service';
import { FinanceMoveSteps } from './clearances/finance-move-steps';
import { FinanceUnitDues } from './clearances/finance-unit-dues';
import { FinanceInboxItems } from './finance-inbox-items';
import { CashAccountsService } from './treasury/cash-accounts.service';
import { ChequesService } from './treasury/cheques.service';
import { CustodyService } from './treasury/custody.service';
import { StatementsService } from './treasury/statements.service';
import { TreasuryCommon } from './treasury/treasury-common';
import {
  ChequesController,
  CollectorCustodyController,
  CustodyController,
  TreasuryController,
} from './treasury/treasury.controller';
import { TreasuryInboxItems } from './treasury/treasury-inbox-items';
import { FinanceReports } from './reports/finance-reports';
import { CashFlowController } from './cashflow/cash-flow.controller';
import { CashFlowSections } from './cashflow/cash-flow-sections';
import { CashFlowService } from './cashflow/cash-flow.service';
import { CashFlowSweep } from './cashflow/cash-flow.sweep';
import { GlController } from './gl/gl.controller';
import { GlEntriesService } from './gl/gl-entries.service';
import { GlLedgerService } from './gl/gl-ledger.service';
import { GlSections } from './gl/gl-sections';
import { GlYearsService } from './gl/gl-years.service';
import { TaxController } from './tax/tax.controller';
import { TaxSections } from './tax/tax-sections';
import { TaxSettingsService } from './tax/tax-settings.service';
import { TaxService } from './tax/tax.service';

/**
 * Finance (ADR 0046, 0048, 0055): invoices per unit, recurring billing,
 * payments at the office and online through each compound's own Paymob
 * account, and their receipts; the annual budget and expenses. Reads
 * community through its index and nothing else; nothing imports it. What
 * the board's decisions do here is registered with core's BoardMatters.
 */
import {
  BudgetPlanningController,
  PayablesReportsController,
} from './payables/budget-planning.controller';
import { BudgetPlanningService } from './payables/budget-planning.service';
import { CommitmentsService } from './payables/commitments.service';
import { ContractMoneyService } from './payables/contract-money.service';
import { GuaranteeSweep } from './payables/guarantee-sweep';
import { PayablesController } from './payables/payables.controller';
import { ContractorInvoicesController } from './payables/contractor-invoices.controller';
import { PayablesInboxItems } from './payables/payables-inbox-items';
import { PayablesReportsService } from './payables/payables-reports.service';
import { VendorInvoicesService } from './payables/vendor-invoices.service';
@Module({
  imports: [
    AccountsModule,
    AuthModule,
    PlatformModule,
    FilesModule,
    CommunityFinancePortModule,
  ],
  controllers: [
    BoardAuthorizationsController,
    ClearancesController,
    StaffClearancesController,
    PublicClearancesController,
    DepositsController,
    StaffDepositsController,
    LateNoticesController,
    GatewayController,
    PlatformGatewayController,
    StaffInvoicesController,
    UnitInvoicesController,
    StaffInstalmentsController,
    UnitInstalmentsController,
    StaffDisputesController,
    UnitDisputesController,
    RefundsController,
    ReportsController,
    BillingPlansController,
    FeesController,
    CollectorVisitsController,
    StaffCollectorVisitsController,
    CollectorController,
    // Treasury and custody (ADR 0085).
    TreasuryController,
    CustodyController,
    CollectorCustodyController,
    ChequesController,
    UpcomingDuesController,
    PlanRequestsController,
    StaffPlanRequestsController,
    StaffSpendingReportsController,
    SpendingReportsController,
    StaffPaymentsController,
    UnitPaymentsController,
    PaymentSessionsController,
    PaymobWebhookController,
    GatewayEventsController,
    ReceiptPageController,
    BudgetsController,
    BudgetReportController,
    // Payables and commitments (ADR 0089).
    BudgetPlanningController,
    PayablesReportsController,
    PayablesController,
    ContractorInvoicesController,
    // Cash flow and liquidity (ADR 0091).
    CashFlowController,
    // The general ledger (ADR 0092).
    GlController,
    // Taxes and the year-end close (ADR 0093).
    TaxController,
  ],
  providers: [
    FinanceCompensationCredits,
    FinanceReports,
    ClearancesService,
    ClearancePageService,
    DepositsService,
    FinanceInboxItems,
    TreasuryCommon,
    CashAccountsService,
    CustodyService,
    ChequesService,
    StatementsService,
    TreasuryInboxItems,
    FinanceMoveSteps,
    FinanceUnitDues,
    FinanceProvisioning,
    FinanceAccess,
    FeesService,
    CollectorVisitsService,
    CollectorSettingsService,
    ResidentCollectorItems,
    UpcomingDuesService,
    UpcomingDuesSweep,
    PlanRequestsService,
    PlanSettingsService,
    ResidentPlanItems,
    ReceiptPdfService,
    SpendingReportsService,
    BudgetsService,
    BudgetMatters,
    BoardAuthority,
    ExpensesService,
    BudgetReportService,
    CommitmentsService,
    BudgetPlanningService,
    VendorInvoicesService,
    ContractMoneyService,
    PayablesReportsService,
    PayablesInboxItems,
    GuaranteeSweep,
    CashFlowService,
    CashFlowSections,
    CashFlowSweep,
    GlLedgerService,
    GlEntriesService,
    GlSections,
    GlYearsService,
    TaxSettingsService,
    TaxService,
    TaxSections,
    DisputeBoardAppeals,
    FinanceOverview,
    FinanceDashboardSection,
    CandidacyDues,
    BudgetHandover,
    FinanceNotices,
    InvoicesService,
    ChargeSettler,
    FinanceChargesService,
    ResidentFinanceItems,
    LateNoticesService,
    InstalmentsService,
    DisputesService,
    RefundsService,
    LedgerService,
    ReportsService,
    ExportLimit,
    InvoiceNoticesSweep,
    InvoiceRemindersSweep,
    BillingPlansService,
    PaymentsService,
    PaymentSessionsService,
    PaymobWebhookService,
    ReceiptPageService,
    FinanceLifecycle,
    FinanceExportSections,
    CredentialVault,
    GatewayService,
    GatewayKeys,
    PlatformGatewayService,
    PaymobClient,
    { provide: PAYMOB_TRANSPORT, useClass: FetchPaymobTransport },
  ],
})
export class FinanceModule {}
