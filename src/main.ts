import 'dotenv/config';
import { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { Server } from 'http';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';
import { configureApp } from './app.setup';

// ============================================================================
// Shutdown budget (same pattern as Jiwar-Hub-backend)
// ============================================================================
//
// Both steps run inside the orchestrator's grace period and are individually
// capped, so one unbounded await cannot spend the whole budget:
//
//   HTTP drain   5.0s
//   app.close()  5.0s  (Prisma pool, pg pool, Redis)
const SHUTDOWN_BUDGET_MS = 11_000;
const HTTP_DRAIN_MS = 5_000;
const APP_CLOSE_MS = 5_000;

/** Resolve either way, but never let one step outlast its slice of the budget. */
async function withTimeout<T>(
  work: Promise<T>,
  timeoutMs: number,
  label: string,
  onTimeout?: () => void,
): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), Math.max(0, timeoutMs));
  });
  try {
    const outcome = await Promise.race([
      work.then(() => 'done' as const),
      expired,
    ]);
    if (outcome === 'timeout') {
      console.warn(
        `Shutdown step "${label}" exceeded ${timeoutMs}ms; moving on.`,
      );
      onTimeout?.();
    }
  } catch (error) {
    console.warn(
      `Shutdown step "${label}" failed: ` +
        (error instanceof Error ? error.message : String(error)),
    );
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function bootstrap() {
  // Signals are wired BEFORE the app is built: under PID 1 a SIGTERM that
  // arrives during DI construction would otherwise be ignored.
  let app: INestApplication | undefined = undefined;
  let shuttingDown = false;

  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;

    if (!app) {
      console.log(`${signal} during boot; nothing started yet, exiting.`);
      process.exit(0);
    }

    const startedAt = Date.now();
    const deadline = startedAt + SHUTDOWN_BUDGET_MS;
    const cap = (ms: number) =>
      Math.min(ms, Math.max(0, deadline - Date.now()));

    let code = 0;
    try {
      // 1. Stop accepting, then drain in-flight requests.
      const httpServer = app.getHttpServer() as Server;
      const httpDrained = new Promise<void>((resolve) => {
        httpServer.close(() => resolve());
      });
      httpServer.closeIdleConnections?.();
      await withTimeout(httpDrained, cap(HTTP_DRAIN_MS), 'http-drain', () =>
        httpServer.closeAllConnections?.(),
      );

      // 2. Lifecycle hooks: database and Redis connections. Deliberately not
      // app.enableShutdownHooks(), which would race this ordering.
      await withTimeout(app.close(), cap(APP_CLOSE_MS), 'app-close');

      console.log(
        `Shutdown after ${signal} completed in ${Date.now() - startedAt}ms.`,
      );
    } catch (error) {
      code = 1;
      console.error(
        `Shutdown after ${signal} failed: ` +
          (error instanceof Error ? error.message : String(error)),
      );
    } finally {
      process.exit(code);
    }
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  const created = await NestFactory.create(AppModule, { bufferLogs: true });
  app = created;
  created.useLogger(created.get(Logger));

  configureApp(created);

  const port = process.env.PORT ?? 3000;
  await created.listen(port, '0.0.0.0');
}

void bootstrap();
