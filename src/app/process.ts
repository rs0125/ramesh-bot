/** Process boundary: handles signals and gives resources a bounded graceful shutdown. */
import type { Logger } from 'pino';
import type { Application } from './application.js';

export async function runApplication(
  app: Application,
  logger: Logger,
  timeoutMs: number,
): Promise<void> {
  let stopping: Promise<void> | undefined;
  const stop = (code: number): Promise<void> => {
    process.exitCode = Math.max(Number(process.exitCode ?? 0), code);
    if (stopping) return stopping;
    const deadline = setTimeout(() => {
      logger.error('Graceful shutdown timed out');
      process.exit(1);
    }, timeoutMs);
    stopping = app
      .stop()
      .catch((error) => {
        logger.error({ err: error }, 'Shutdown failed');
        process.exitCode = 1;
      })
      .finally(() => {
        clearTimeout(deadline);
        process.off('SIGINT', onSignal);
        process.off('SIGTERM', onSignal);
        process.off('uncaughtException', onFailure);
        process.off('unhandledRejection', onFailure);
        logger.flush();
      });
    return stopping;
  };
  const onSignal = () => {
    logger.info('Stopping worker');
    void stop(0);
  };
  const onFailure = (error: unknown) => {
    logger.error({ err: error }, 'Worker failed');
    void stop(1);
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  process.on('uncaughtException', onFailure);
  process.on('unhandledRejection', onFailure);
  try {
    await app.start();
  } catch (error) {
    onFailure(error);
    await stopping;
  }
}
