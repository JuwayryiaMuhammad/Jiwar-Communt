import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { normalizeEmail } from '../auth/identifier';
import { newId } from '../common/uuid';
import type { Env } from '../config/env.schema';
import { GlobalDbService } from '../database/global-db.service';
import { hashPassword } from './password';

export type BootstrapOutcome = 'created' | 'exists' | 'not-configured';

/**
 * Creates the first super admin from the environment (ADR 0011):
 * - none exists and SUPERADMIN_EMAIL + SUPERADMIN_PASSWORD are set → create
 *   it with must_change_password;
 * - one exists → nothing; the environment never updates an existing admin;
 * - none exists and nothing is configured → a warning; the app still starts.
 */
@Injectable()
export class PlatformBootstrapService implements OnApplicationBootstrap {
  private readonly logger = new Logger(PlatformBootstrapService.name);

  constructor(
    private readonly config: ConfigService<Env, true>,
    private readonly globalDb: GlobalDbService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.run();
  }

  async run(
    env: { email?: string; password?: string } = {
      email: this.config.get('SUPERADMIN_EMAIL', { infer: true }),
      password: this.config.get('SUPERADMIN_PASSWORD', { infer: true }),
    },
  ): Promise<BootstrapOutcome> {
    if ((await this.globalDb.platformAdmin.count()) > 0) return 'exists';

    const email = env.email ? normalizeEmail(env.email) : null;
    if (!email || !env.password) {
      this.logger.warn(
        'No platform admin exists and SUPERADMIN_EMAIL / SUPERADMIN_PASSWORD are not set.',
      );
      return 'not-configured';
    }
    try {
      await this.globalDb.platformAdmin.create({
        data: {
          id: newId(),
          email,
          passwordHash: await hashPassword(env.password),
          mustChangePassword: true,
        },
      });
    } catch (error) {
      // Another instance won the race; that admin is the one.
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        return 'exists';
      }
      throw error;
    }
    this.logger.log(
      `Platform admin ${email} created; the password must be changed on first login.`,
    );
    return 'created';
  }
}
