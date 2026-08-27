import type { FastifyInstance } from 'fastify';
import {
  WIDGET_DEFAULTS,
  WIDGET_TYPES,
  parseWidgetConfig,
  type Dashboard,
  type Widget,
  type WidgetType,
} from '@moodify/shared';
import { z } from 'zod';
import { requireAdmin } from '../auth.ts';
import { randomToken } from '../crypto.ts';
import { sql } from '../db.ts';
import { UploadError, deleteUpload, saveImageUpload } from '../uploads.ts';
import { resolveWidgetData } from '../widgetData.ts';

const idParam = z.object({ id: z.coerce.number().int().positive() });

interface WidgetRow {
  id: number;
  dashboard_id: number;
  type: string;
  title: string | null;
  config: unknown;
  position_x: number;
  position_y: number;
  position_w: number;
  position_h: number;
  is_collapsed: boolean;
}

interface DashboardRow {
  id: number;
  name: string;
  title_left: string | null;
  title_right: string | null;
  title_gap: number | null;
  logo_height: number | null;
  title_size: number | null;
  background_image_path: string | null;
  is_public: boolean;
  public_share_token: string | null;
  anonymize_on_public: boolean;
}

const toWidget = (row: WidgetRow): Widget => ({
  id: row.id,
  dashboardId: row.dashboard_id,
  type: row.type as WidgetType,
  title: row.title,
  config: row.config,
  isCollapsed: row.is_collapsed,
  x: row.position_x,
  y: row.position_y,
  w: row.position_w,
  h: row.position_h,
});

export async function loadWidgets(dashboardId: number): Promise<Widget[]> {
  const { rows } = await sql<WidgetRow>(
    `select id, dashboard_id, type, title, config, position_x, position_y,
            position_w, position_h, is_collapsed
       from widgets where dashboard_id = $1
      order by position_y, position_x, id`,
    [dashboardId],
  );
  return rows.map(toWidget);
}

export async function toDashboard(row: DashboardRow): Promise<Dashboard> {
  return {
    id: row.id,
    name: row.name,
    titleLeft: row.title_left,
    titleRight: row.title_right,
    titleGap: row.title_gap,
    logoHeight: row.logo_height,
    titleSize: row.title_size,
    backgroundImagePath: row.background_image_path,
    isPublic: row.is_public,
    publicShareToken: row.public_share_token,
    anonymizeOnPublic: row.anonymize_on_public,
    widgets: await loadWidgets(row.id),
  };
}

const DASHBOARD_COLUMNS = `id, name, title_left, title_right, title_gap, logo_height,
                           title_size, background_image_path, is_public,
                           public_share_token, anonymize_on_public`;

async function findDashboard(id: number): Promise<DashboardRow | null> {
  const { rows } = await sql<DashboardRow>(
    `select ${DASHBOARD_COLUMNS} from dashboards where id = $1`,
    [id],
  );
  return rows[0] ?? null;
}

async function findWidget(id: number): Promise<WidgetRow | null> {
  const { rows } = await sql<WidgetRow>(
    `select id, dashboard_id, type, title, config, position_x, position_y,
            position_w, position_h, is_collapsed
       from widgets where id = $1`,
    [id],
  );
  return rows[0] ?? null;
}

export async function dashboardRoutes(app: FastifyInstance): Promise<void> {
  const auth = { preHandler: requireAdmin };

  app.get('/api/dashboards', auth, async () => {
    const { rows } = await sql<DashboardRow>(
      `select ${DASHBOARD_COLUMNS} from dashboards order by created_at, id`,
    );
    return Promise.all(rows.map(toDashboard));
  });

  app.post('/api/dashboards', auth, async (request, reply) => {
    const { name } = z.object({ name: z.string().trim().min(1).max(100) }).parse(request.body);
    const { rows } = await sql<DashboardRow>(
      `insert into dashboards (name) values ($1) returning ${DASHBOARD_COLUMNS}`,
      [name],
    );
    const row = rows[0];
    if (!row) throw new Error('Insert returned no row');
    return reply.code(201).send(await toDashboard(row));
  });

  app.get('/api/dashboards/:id', auth, async (request, reply) => {
    const { id } = idParam.parse(request.params);
    const row = await findDashboard(id);
    if (!row) return reply.code(404).send({ error: 'Dashboard not found' });
    return toDashboard(row);
  });

  app.patch('/api/dashboards/:id', auth, async (request, reply) => {
    const { id } = idParam.parse(request.params);
    const body = z
      .object({
        name: z.string().trim().min(1).max(100).optional(),
        // Trimmed to '' means "no heading"; stored as NULL so the header has one
        // emptiness to test rather than two.
        titleLeft: z.string().trim().max(100).optional(),
        titleRight: z.string().trim().max(100).optional(),
        // Nullable, not just optional: null is how the form says "back to the default".
        titleGap: z.number().int().min(0).max(400).nullable().optional(),
        logoHeight: z.number().int().min(8).max(400).nullable().optional(),
        titleSize: z.number().int().min(8).max(200).nullable().optional(),
        isPublic: z.boolean().optional(),
        anonymizeOnPublic: z.boolean().optional(),
      })
      .parse(request.body);

    const existing = await findDashboard(id);
    if (!existing) return reply.code(404).send({ error: 'Dashboard not found' });

    // Turning sharing on for the first time needs a token to share.
    const needsToken = body.isPublic === true && existing.public_share_token === null;

    const { rows } = await sql<DashboardRow>(
      `update dashboards set
         name                = coalesce($2, name),
         is_public           = coalesce($3, is_public),
         anonymize_on_public = coalesce($4, anonymize_on_public),
         public_share_token  = case when $5 then $6 else public_share_token end,
         title_left          = case when $7 then $8 else title_left end,
         title_right         = case when $9 then $10 else title_right end,
         title_gap           = case when $11 then $12 else title_gap end,
         logo_height         = case when $13 then $14 else logo_height end,
         title_size          = case when $15 then $16 else title_size end,
         updated_at          = now()
       where id = $1
       returning ${DASHBOARD_COLUMNS}`,
      [
        id,
        body.name ?? null,
        body.isPublic ?? null,
        body.anonymizeOnPublic ?? null,
        needsToken,
        needsToken ? randomToken(32) : null,
        // Not coalesce: clearing a heading sends '', which has to reach the column as
        // NULL rather than being read as "leave it alone".
        body.titleLeft !== undefined,
        body.titleLeft || null,
        body.titleRight !== undefined,
        body.titleRight || null,
        body.titleGap !== undefined,
        body.titleGap ?? null,
        body.logoHeight !== undefined,
        body.logoHeight ?? null,
        body.titleSize !== undefined,
        body.titleSize ?? null,
      ],
    );
    const row = rows[0];
    if (!row) return reply.code(404).send({ error: 'Dashboard not found' });
    return toDashboard(row);
  });

  app.delete('/api/dashboards/:id', auth, async (request, reply) => {
    const { id } = idParam.parse(request.params);
    const { rows } = await sql<{ background_image_path: string | null }>(
      'delete from dashboards where id = $1 returning background_image_path',
      [id],
    );
    const row = rows[0];
    if (!row) return reply.code(404).send({ error: 'Dashboard not found' });
    await deleteUpload(row.background_image_path);
    return { ok: true };
  });

  // Overwriting the column IS the invalidation: the old URL stops resolving the
  // instant this commits, because lookups match on the stored token.
  app.post('/api/dashboards/:id/share/regenerate', auth, async (request, reply) => {
    const { id } = idParam.parse(request.params);
    const { rows } = await sql<{ public_share_token: string }>(
      'update dashboards set public_share_token = $2, updated_at = now() where id = $1 returning public_share_token',
      [id, randomToken(32)],
    );
    const row = rows[0];
    if (!row) return reply.code(404).send({ error: 'Dashboard not found' });
    return { publicShareToken: row.public_share_token };
  });

  app.post('/api/dashboards/:id/background', auth, async (request, reply) => {
    const { id } = idParam.parse(request.params);
    const existing = await findDashboard(id);
    if (!existing) return reply.code(404).send({ error: 'Dashboard not found' });

    let stored: string;
    try {
      stored = await saveImageUpload(await request.file());
    } catch (err) {
      if (err instanceof UploadError) return reply.code(err.statusCode).send({ error: err.message });
      throw err;
    }

    await sql('update dashboards set background_image_path = $2, updated_at = now() where id = $1', [
      id,
      stored,
    ]);
    await deleteUpload(existing.background_image_path);
    return { backgroundImagePath: stored };
  });

  app.delete('/api/dashboards/:id/background', auth, async (request, reply) => {
    const { id } = idParam.parse(request.params);
    // RETURNING yields the post-update row, so capture the old path before clearing it.
    const existing = await findDashboard(id);
    if (!existing) return reply.code(404).send({ error: 'Dashboard not found' });

    await sql(
      'update dashboards set background_image_path = null, updated_at = now() where id = $1',
      [id],
    );
    await deleteUpload(existing.background_image_path);
    return { ok: true };
  });

  app.post('/api/dashboards/:id/widgets', auth, async (request, reply) => {
    const { id } = idParam.parse(request.params);
    const body = z
      .object({ type: z.enum(WIDGET_TYPES), config: z.unknown().optional() })
      .parse(request.body);

    if (!(await findDashboard(id))) {
      return reply.code(404).send({ error: 'Dashboard not found' });
    }

    const defaults = WIDGET_DEFAULTS[body.type];
    const config = parseWidgetConfig(body.type, body.config ?? defaults.config);

    const { rows } = await sql<WidgetRow>(
      `insert into widgets (dashboard_id, type, config, position_x, position_y, position_w, position_h)
       select $1, $2, $3::jsonb, 0,
              coalesce((select max(position_y + position_h) from widgets where dashboard_id = $1), 0),
              $4, $5
       returning id, dashboard_id, type, title, config, position_x, position_y,
                 position_w, position_h, is_collapsed`,
      [id, body.type, JSON.stringify(config), defaults.w, defaults.h],
    );
    const row = rows[0];
    if (!row) throw new Error('Insert returned no row');
    return reply.code(201).send(toWidget(row));
  });

  app.patch('/api/widgets/:id', auth, async (request, reply) => {
    const { id } = idParam.parse(request.params);
    const body = z
      .object({
        title: z.string().trim().max(120).nullable().optional(),
        config: z.unknown().optional(),
        isCollapsed: z.boolean().optional(),
        x: z.number().int().min(0).optional(),
        y: z.number().int().min(0).optional(),
        w: z.number().int().min(1).optional(),
        h: z.number().int().min(1).optional(),
      })
      .parse(request.body);

    const existing = await findWidget(id);
    if (!existing) return reply.code(404).send({ error: 'Widget not found' });

    // Type is immutable after creation — changing it would invalidate the stored
    // config, so the UI deletes and re-adds instead.
    const config =
      body.config === undefined
        ? undefined
        : parseWidgetConfig(existing.type as WidgetType, body.config);

    const nothingToDo =
      body.title === undefined &&
      config === undefined &&
      body.isCollapsed === undefined &&
      body.x === undefined &&
      body.y === undefined &&
      body.w === undefined &&
      body.h === undefined;
    if (nothingToDo) return toWidget(existing);

    const { rows } = await sql<WidgetRow>(
      `update widgets set
         title        = case when $2::bool then $3 else title end,
         config       = coalesce($4::jsonb, config),
         is_collapsed = coalesce($5, is_collapsed),
         position_x   = coalesce($6, position_x),
         position_y   = coalesce($7, position_y),
         position_w   = coalesce($8, position_w),
         position_h   = coalesce($9, position_h)
       where id = $1
       returning id, dashboard_id, type, title, config, position_x, position_y,
                 position_w, position_h, is_collapsed`,
      [
        id,
        body.title !== undefined,
        body.title ?? null,
        config === undefined ? null : JSON.stringify(config),
        body.isCollapsed ?? null,
        body.x ?? null,
        body.y ?? null,
        body.w ?? null,
        body.h ?? null,
      ],
    );
    const row = rows[0];
    if (!row) return reply.code(404).send({ error: 'Widget not found' });
    return toWidget(row);
  });

  app.delete('/api/widgets/:id', auth, async (request, reply) => {
    const { id } = idParam.parse(request.params);
    const { rowCount } = await sql('delete from widgets where id = $1', [id]);
    if (!rowCount) return reply.code(404).send({ error: 'Widget not found' });
    return { ok: true };
  });

  app.put('/api/dashboards/:id/layout', auth, async (request, reply) => {
    const { id } = idParam.parse(request.params);
    const { items } = z
      .object({
        items: z
          .array(
            z.object({
              id: z.number().int().positive(),
              x: z.number().int().min(0),
              y: z.number().int().min(0),
              // Minimum 2, matching the grid's own minW/minH. react-grid-layout falls
              // back to a 1×1 item for any child it cannot match to a layout entry, and
              // saving that turns a dashboard into a column of grey slivers that the
              // frontend alone cannot undo. Rejecting it here makes that loud instead:
              // the client shows the error above the grid and the stored layout survives.
              w: z.number().int().min(2),
              h: z.number().int().min(2),
            }),
          )
          .max(200),
      })
      .parse(request.body);

    if (items.length === 0) return { ok: true };

    // One round trip for the whole grid. The dashboard_id predicate is what stops a
    // caller repositioning widgets that belong to somebody else's dashboard.
    const updated = await sql(
      `update widgets as w
          set position_x = v.x, position_y = v.y, position_w = v.w, position_h = v.h
         from (select * from unnest($1::int[], $2::int[], $3::int[], $4::int[], $5::int[])
                 as t(id, x, y, w, h)) as v
        where w.id = v.id and w.dashboard_id = $6`,
      [
        items.map((i) => i.id),
        items.map((i) => i.x),
        items.map((i) => i.y),
        items.map((i) => i.w),
        items.map((i) => i.h),
        id,
      ],
    );

    // A row that matched nothing means the arrangement was only partly saved — the rest
    // silently reverts on the next load, which is indistinguishable from the grid moving
    // things by itself. Say so instead: the client shows it above the grid.
    if (updated.rowCount !== items.length) {
      return reply.code(409).send({
        error: `Saved ${updated.rowCount ?? 0} of ${items.length} widget positions — the dashboard may have changed in another tab. Reload and try again.`,
      });
    }

    await sql('update dashboards set updated_at = now() where id = $1', [id]);
    return { ok: true };
  });

  app.get('/api/widgets/:id/data', auth, async (request, reply) => {
    const { id } = idParam.parse(request.params);
    const widget = await findWidget(id);
    if (!widget) return reply.code(404).send({ error: 'Widget not found' });
    return resolveWidgetData({
      id: widget.id,
      type: widget.type as WidgetType,
      config: widget.config,
    });
  });
}
