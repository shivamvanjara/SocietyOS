import { app } from './app.js';
import { env } from './config/env.js';
import { prisma } from './config/database.js';

const server = app.listen(env.API_PORT, '0.0.0.0', () => {
  console.info(`SocietyOS API listening on port ${env.API_PORT}`);
});

const shutdown = (signal) => {
  console.info(`${signal} received; closing HTTP server`);
  server.close(async (error) => {
    try {
      await prisma.$disconnect();
      process.exit(error ? 1 : 0);
    } catch {
      process.exit(1);
    }
  });
};

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
