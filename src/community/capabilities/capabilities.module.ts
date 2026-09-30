import { Module } from '@nestjs/common';
import { CapabilitiesService } from './capabilities.service';

/** capabilitiesFor and its loader (ADR 0020). */
@Module({
  providers: [CapabilitiesService],
  exports: [CapabilitiesService],
})
export class CapabilitiesModule {}
