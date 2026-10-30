import type { Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../../core/config/env.schema';
import { driverChoice } from '../vendors/vendor-call';
import { FACE_DRIVER, OffFaceDriver } from './face-driver';
import { FakeFaceDriver } from './fake-face-driver';

/** The face driver this deployment runs (ADR 0068): the fake, or off. */
export const faceDriverProvider: Provider = {
  provide: FACE_DRIVER,
  inject: [ConfigService],
  useFactory: (config: ConfigService<Env, true>) =>
    driverChoice(config, 'face') === 'fake'
      ? new FakeFaceDriver()
      : new OffFaceDriver(),
};
