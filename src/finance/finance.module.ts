import { Module } from '@nestjs/common';
import { CommunityFinancePortModule } from '../community';
import { AuthModule } from '../core/auth/auth.module';
import { PlatformModule } from '../core/platform/platform.module';
import { FinanceAccess } from './access';
import { BillingPlansController } from './billing-plans/billing-plans.controller';
import { BillingPlansService } from './billing-plans/billing-plans.service';
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
import { FinanceProvisioning } from './provisioning';
import { InvoiceNoticesSweep } from './invoices/invoice-notices.sweep';
import {
  StaffInvoicesController,
  UnitInvoicesController,
} from './invoices/invoices.controller';
import { InvoicesService } from './invoices/invoices.service';
import { FinanceNotices } from './notices/finance-notices';
import { PaymentSessionsController } from './online/payment-sessions.controller';
import { PaymentSessionsService } from './online/payment-sessions.service';
import {
  StaffPaymentsController,
  UnitPaymentsController,
} from './payments/payments.controller';
import { PaymentsService } from './payments/payments.service';

/**
 * Finance (ADR 0046): invoices per unit, recurring billing, payments at the
 * office and online through each compound's own Paymob account, and their
 * receipts. Reads community through its index and nothing else; nothing
 * imports it.
 */
@Module({
  imports: [AuthModule, PlatformModule, CommunityFinancePortModule],
  controllers: [
    GatewayController,
    PlatformGatewayController,
    StaffInvoicesController,
    UnitInvoicesController,
    BillingPlansController,
    StaffPaymentsController,
    UnitPaymentsController,
    PaymentSessionsController,
  ],
  providers: [
    FinanceProvisioning,
    FinanceAccess,
    FinanceNotices,
    InvoicesService,
    InvoiceNoticesSweep,
    BillingPlansService,
    PaymentsService,
    PaymentSessionsService,
    CredentialVault,
    GatewayService,
    GatewayKeys,
    PlatformGatewayService,
    PaymobClient,
    { provide: PAYMOB_TRANSPORT, useClass: FetchPaymobTransport },
  ],
})
export class FinanceModule {}
