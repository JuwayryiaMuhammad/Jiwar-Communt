import { Module } from '@nestjs/common';
import { CredentialVault } from './gateway/credential-vault';
import { PaymobClient } from './paymob/paymob-client';
import {
  FetchPaymobTransport,
  PAYMOB_TRANSPORT,
} from './paymob/paymob-transport';

/**
 * Finance (ADR 0046): invoices per unit, recurring billing, payments at the
 * office and online through each compound's own Paymob account, and their
 * receipts. Reads community through its index and nothing else; nothing
 * imports it.
 */
@Module({
  providers: [
    CredentialVault,
    PaymobClient,
    { provide: PAYMOB_TRANSPORT, useClass: FetchPaymobTransport },
  ],
})
export class FinanceModule {}
