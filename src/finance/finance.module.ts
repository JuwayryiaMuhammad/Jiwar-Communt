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
import { BudgetMatters } from './budgets/budget-matters';
import { BudgetReportController } from './budgets/budget-report.controller';
import { BudgetReportService } from './budgets/budget-report.service';
import { BudgetsController } from './budgets/budgets.controller';
import { BudgetsService } from './budgets/budgets.service';
import { ExpensesService } from './budgets/expenses.service';
import { FinanceOverview } from './budgets/finance-overview';
import { DisputeBoardAppeals } from './disputes/dispute-board-appeals';
import { BillingPlansController } from './billing-plans/billing-plans.controller';
import { BillingPlansService } from './billing-plans/billing-plans.service';
import { FeesController } from './fees/fees.controller';
import { FeesService } from './fees/fees.service';
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

/**
 * Finance (ADR 0046, 0048, 0055): invoices per unit, recurring billing,
 * payments at the office and online through each compound's own Paymob
 * account, and their receipts; the annual budget and expenses. Reads
 * community through its index and nothing else; nothing imports it. What
 * the board's decisions do here is registered with core's BoardMatters.
 */
@Module({
  imports: [
    AccountsModule,
    AuthModule,
    PlatformModule,
    FilesModule,
    CommunityFinancePortModule,
  ],
  controllers: [
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
    StaffPaymentsController,
    UnitPaymentsController,
    PaymentSessionsController,
    PaymobWebhookController,
    GatewayEventsController,
    ReceiptPageController,
    BudgetsController,
    BudgetReportController,
  ],
  providers: [
    ClearancesService,
    ClearancePageService,
    DepositsService,
    FinanceMoveSteps,
    FinanceProvisioning,
    FinanceAccess,
    FeesService,
    BudgetsService,
    BudgetMatters,
    ExpensesService,
    BudgetReportService,
    DisputeBoardAppeals,
    FinanceOverview,
    FinanceNotices,
    InvoicesService,
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
