import type { FastifyInstance } from 'fastify';
import type { Dashboard } from '@moodify/shared';
import { z } from 'zod';
import { anonymizeWidgetData, globalStudentLabels } from '../anonymize.ts';
import { requireAdmin } from '../auth.ts';
import { sql } from '../db.ts';
import { UploadError, assetUrl, deleteUpload, saveImageUpload } from '../uploads.ts';
import { resolveWidgetData } from '../widgetData.ts';
import { loadWidgets } from './dashboards.ts';

const DEFAULT_LOGO_URL = '/brand/moodify-logo.svg';
const LOGO_SETTING_KEY = 'custom_logo_path';

interface PublicDashboardRow {
  id: number;
  name: string;
  background_image_path: string | null;
  anonymize_on_public: boolean;
}

/**
 * Resolves a share token to a dashboard, or null.
 *
 * Requires is_public as well as a token match: a dashboard whose sharing was switched
 * off keeps its token in the column, and matching on the token alone would leave every
 * previously-shared link live forever.
 */
async function dashboardForToken(token: string): Promise<PublicDashboardRow | null> {
  const { rows } = await sql<PublicDashboardRow>(
    `select id, name, background_image_path, anonymize_on_public
       from dashboards
      where public_share_token = $1 and is_public = true`,
    [token],
  );
  return rows[0] ?? null;
}

const tokenParams = z.object({ token: z.string().min(16).max(128) });
const widgetParams = tokenParams.extend({
  widgetId: z.coerce.number().int().positive(),
});

export async function publicRoutes(app: FastifyInstance): Promise<void> {
  // -------------------------------------------------------------------------
  // Public share routes — the only routes in the app reachable without a session.
  // -------------------------------------------------------------------------

  app.get('/api/public/:token', async (request, reply) => {
    const { token } = tokenParams.parse(request.params);
    reply.header('cache-control', 'no-store');

    const row = await dashboardForToken(token);
    // Deliberately identical response for "no such token" and "sharing switched off":
    // distinguishing them would confirm a token exists.
    if (!row) return reply.code(404).send({ error: 'Dashboard not found' });

    const dashboard: Dashboard = {
      id: row.id,
      name: row.name,
      backgroundImagePath: row.background_image_path,
      isPublic: true,
      // Never echo the secret back into a page that gets screenshotted or embedded.
      publicShareToken: null,
      anonymizeOnPublic: row.anonymize_on_public,
      widgets: await loadWidgets(row.id),
    };

    return { dashboard, anonymized: row.anonymize_on_public };
  });

  app.get('/api/public/:token/widgets/:widgetId/data', async (request, reply) => {
    const { token, widgetId } = widgetParams.parse(request.params);
    reply.header('cache-control', 'no-store');

    const row = await dashboardForToken(token);
    if (!row) return reply.code(404).send({ error: 'Dashboard not found' });

    // THE important line in this file: the widget must belong to the dashboard the
    // token names. Without this predicate any valid share token would expose every
    // widget in the entire installation by id enumeration.
    const { rows } = await sql<{ id: number; type: string; config: unknown }>(
      'select id, type, config from widgets where id = $1 and dashboard_id = $2',
      [widgetId, row.id],
    );
    const widget = rows[0];
    if (!widget) return reply.code(404).send({ error: 'Widget not found' });

    const data = await resolveWidgetData({
      id: widget.id,
      type: widget.type as Parameters<typeof resolveWidgetData>[0]['type'],
      config: widget.config,
    });

    if (!row.anonymize_on_public || data.type === 'error') return data;

    // Anonymisation happens here, server-side: real names must never reach a public
    // client, not even to be hidden by the frontend.
    return anonymizeWidgetData(data, await globalStudentLabels());
  });

  // -------------------------------------------------------------------------
  // Site logo (admin only). Kept beside the public routes because the resolved
  // logo URL is part of the unauthenticated bootstrap payload.
  // -------------------------------------------------------------------------

  const auth = { preHandler: requireAdmin };

  async function currentLogoPath(): Promise<string | null> {
    const { rows } = await sql<{ value: string | null }>(
      'select value from app_settings where key = $1',
      [LOGO_SETTING_KEY],
    );
    return rows[0]?.value ?? null;
  }

  app.post('/api/settings/logo', auth, async (request, reply) => {
    const previous = await currentLogoPath();

    let stored: string;
    try {
      stored = await saveImageUpload(await request.file());
    } catch (err) {
      if (err instanceof UploadError) return reply.code(err.statusCode).send({ error: err.message });
      throw err;
    }

    await sql(
      `insert into app_settings (key, value) values ($1, $2)
       on conflict (key) do update set value = excluded.value`,
      [LOGO_SETTING_KEY, stored],
    );
    await deleteUpload(previous);
    return { logoUrl: assetUrl(stored) };
  });

  /**
   * Free-form app settings. Only these keys are writable — the logo path is managed
   * by the upload routes above and must not be settable as raw text.
   */
  app.patch('/api/settings', auth, async (request) => {
    const body = z
      .object({
        // Empty string means "fall back to the browser's origin".
        publicBaseUrl: z
          .string()
          .trim()
          .max(300)
          .refine((v) => v === '' || /^https?:\/\/[^\s/]+/i.test(v), {
            message: 'Enter a full URL starting with https:// or http://, or leave it blank.',
          })
          .optional(),
        logoHeight: z.number().int().min(16).max(160).optional(),
      })
      .parse(request.body);

    for (const [key, value] of Object.entries(body)) {
      if (value === undefined) continue;
      await sql(
        `insert into app_settings (key, value) values ($1, $2)
         on conflict (key) do update set value = excluded.value`,
        [key === 'publicBaseUrl' ? 'public_base_url' : 'logo_height', String(value).replace(/\/+$/, '')],
      );
    }
    return { ok: true };
  });

  app.delete('/api/settings/logo', auth, async () => {
    const previous = await currentLogoPath();
    await sql('delete from app_settings where key = $1', [LOGO_SETTING_KEY]);
    await deleteUpload(previous);
    // The bundled default is a static file in the SPA build. It is never written to
    // or deleted — a custom logo only ever takes precedence over it (§11).
    return { logoUrl: DEFAULT_LOGO_URL };
  });
}
