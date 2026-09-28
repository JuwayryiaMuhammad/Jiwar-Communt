import {
  BadRequestException,
  INestApplication,
  ValidationError,
  ValidationPipe,
} from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import helmet from 'helmet';
import { ErrorCode } from './common/errors';

export const API_PREFIX = 'api/v1';

/**
 * Everything main.ts applies to the app besides listening. Shared with the
 * e2e tests so they exercise the same pipes, prefix and headers.
 */
export function configureApp(app: INestApplication): void {
  const isProd = process.env.NODE_ENV === 'production';

  app.use(
    helmet({
      // Allow Swagger UI assets outside production; it is disabled there.
      contentSecurityPolicy: isProd ? undefined : false,
    }),
  );

  const corsOrigins = (process.env.CORS_ORIGINS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  app.enableCors({
    origin: corsOrigins.length ? corsOrigins : false,
    credentials: true,
  });

  app.setGlobalPrefix(API_PREFIX);

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      // Unknown fields are rejected, not stripped. This is what keeps
      // `tenantId` (or anything else the server owns) out of request bodies.
      forbidNonWhitelisted: true,
      transform: true,
      exceptionFactory: (errors) => {
        // Walk `children` too: a @ValidateNested failure has no constraints
        // of its own, so reading only the top level yields an empty message.
        const flatten = (errs: ValidationError[], path = ''): string[] =>
          errs.flatMap((err) => {
            const here = path ? `${path}.${err.property}` : err.property;
            const own = Object.values(err.constraints ?? {}).map((m) =>
              path ? `${here}: ${m}` : m,
            );
            return [...own, ...flatten(err.children ?? [], here)];
          });
        return new BadRequestException({
          message: flatten(errors).join(', '),
          code: ErrorCode.VALIDATION_FAILED,
        });
      },
    }),
  );

  if (!isProd) {
    const config = new DocumentBuilder()
      .setTitle('Jiwar API')
      .setDescription('Jiwar compound-management platform — Phase 0')
      .setVersion('0.1')
      .addBearerAuth()
      .build();
    SwaggerModule.setup('docs', app, SwaggerModule.createDocument(app, config));
  }
}
