import { Global, Module } from '@nestjs/common';
import { PayablesBridge } from './payables-bridge';

/**
 * Payables and commitments (ADR 0089): finance registers the commitment
 * keeper, maintenance the contracts, payments and purchase requests.
 */
@Global()
@Module({ providers: [PayablesBridge], exports: [PayablesBridge] })
export class PayablesBridgeModule {}
