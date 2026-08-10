import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

/** Uploaded logos/backgrounds and cached badge images. A Docker volume in production. */
export const ASSETS_DIR = process.env.ASSETS_DIR ?? join(here, '..', '..', '..', '.assets');

/** URL prefix the assets directory is served under. */
export const ASSETS_URL_PREFIX = '/assets-store';

/** Built SPA, served by the backend so the stack exposes exactly one port. */
export const SPA_DIR = join(here, '..', '..', 'frontend', 'dist');

/** Full discovery is expensive; the light completion/badge refresh runs far more often (§9.4). */
export const FULL_DISCOVERY_INTERVAL_MS = 15 * 60 * 1000;

export const DEFAULT_POLL_INTERVAL_SECONDS = 60;
