/**
 * Resonance Rail Entrypoint
 *
 * Starts the WebSocket-backed Resonance Rail server.
 * Graceful shutdown on SIGTERM/SIGINT.
 */

import { createRailWebSocketServer } from './wsServer.js';
import { railLog } from './logger.js';

const PORT = parseInt(process.env['PORT'] ?? '3100', 10);

// Graceful degradation handlers
process.on('uncaughtException', (err) => {
  railLog.error('rail', 'Uncaught exception', { error: String(err), stack: err.stack });
});

process.on('unhandledRejection', (reason) => {
  railLog.error('rail', 'Unhandled rejection', { reason: String(reason) });
});

async function main(): Promise<void> {
  const server = createRailWebSocketServer({ port: PORT });

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    railLog.info('rail', 'Received shutdown signal', { signal });
    await server.stop();
    railLog.info('rail', 'Shutdown complete');
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  await server.start();

  railLog.info('rail', 'WebSocket server listening', {
    port: PORT,
    healthCheck: `http://localhost:${PORT}/health`
  });
}

main().catch((err) => {
  railLog.error('rail', 'Fatal error', { error: String(err), stack: err.stack });
  process.exit(1);
});
