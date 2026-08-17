import type { FastifyInstance } from 'fastify';
import { connectionRoutes } from './connection.ts';
import { dashboardRoutes } from './dashboards.ts';
import { deadlineRoutes } from './deadlines.ts';
import { notificationRoutes } from './notifications.ts';
import { publicRoutes } from './public.ts';
import { setupRoutes } from './setup.ts';

/**
 * Every HTTP route except /api/health (declared in index.ts before the database
 * is guaranteed to be up) is registered here.
 *
 * Each module is a plain Fastify plugin declaring its own full `/api/...` paths —
 * no prefixes — so the URL of a route is always greppable from its own file.
 * Registration order is the pre-login surface first (§8: bootstrap/wizard/login),
 * then the authenticated admin surface, then the unauthenticated public share
 * routes (§12), which is also roughly the order a first-run user meets them.
 */
export async function registerRoutes(app: FastifyInstance): Promise<void> {
  await app.register(setupRoutes);
  await app.register(connectionRoutes);
  await app.register(dashboardRoutes);
  await app.register(deadlineRoutes);
  await app.register(notificationRoutes);
  await app.register(publicRoutes);
}
