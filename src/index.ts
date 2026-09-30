/** CLI entry point only. Feature and adapter imports do not start external connections. */
import { config as loadEnvironment } from 'dotenv';
import { createApplication } from './app/application.js';
import { runApplication } from './app/process.js';
import { loadConfig } from './config/env.js';
import { createLogger } from './lib/logger.js';

loadEnvironment({ path: new URL('../.env', import.meta.url), quiet: true });
try {
  const config = loadConfig();
  const logger = createLogger(config.logLevel);
  await runApplication(createApplication(config, logger), logger, config.shutdownTimeoutMs);
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Worker configuration failed');
  process.exitCode = 1;
}
