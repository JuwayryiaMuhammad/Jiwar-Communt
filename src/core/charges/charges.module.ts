import { Global, Module } from '@nestjs/common';
import { Charges } from './charges';

/**
 * Charges (ADR 0070). Global: finance implements the port and the
 * facilities and the gate raise, cancel and handle their charges, at
 * startup.
 */
@Global()
@Module({ providers: [Charges], exports: [Charges] })
export class ChargesModule {}
