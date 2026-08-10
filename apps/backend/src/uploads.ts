import { unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { MultipartFile } from '@fastify/multipart';
import { ASSETS_DIR, ASSETS_URL_PREFIX } from './config.ts';
import { randomToken } from './crypto.ts';

/**
 * Image upload handling for dashboard backgrounds and the custom site logo.
 *
 * Both callers route through here so the trust-boundary checks exist in exactly one
 * place: the declared mimetype is never believed on its own, the stored filename is
 * always generated (a client-supplied name is a path-traversal vector), and the
 * extension follows the *detected* type rather than whatever the client claimed.
 */

const MAX_BYTES = 8 * 1024 * 1024;

interface ImageType {
  ext: string;
  mime: string;
}

const startsWith = (buf: Buffer, bytes: number[], offset = 0): boolean =>
  bytes.every((b, i) => buf[offset + i] === b);

/** Identifies an image by its actual content. Returns null for anything unrecognised. */
export function detectImageType(buf: Buffer): ImageType | null {
  if (buf.length < 12) return null;

  if (startsWith(buf, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return { ext: 'png', mime: 'image/png' };
  }
  if (startsWith(buf, [0xff, 0xd8, 0xff])) {
    return { ext: 'jpg', mime: 'image/jpeg' };
  }
  if (buf.subarray(0, 4).toString('latin1') === 'GIF8') {
    return { ext: 'gif', mime: 'image/gif' };
  }
  if (
    buf.subarray(0, 4).toString('latin1') === 'RIFF' &&
    buf.subarray(8, 12).toString('latin1') === 'WEBP'
  ) {
    return { ext: 'webp', mime: 'image/webp' };
  }

  // SVG is text, so there are no magic bytes to match — require it to actually parse
  // as an SVG document rather than merely mention "<svg" somewhere in the middle.
  const head = buf.subarray(0, 1024).toString('utf8').replace(/^﻿/, '').trimStart();
  if (head.startsWith('<') && /<svg[\s>]/i.test(buf.subarray(0, 4096).toString('utf8'))) {
    return { ext: 'svg', mime: 'image/svg+xml' };
  }

  return null;
}

export class UploadError extends Error {
  readonly statusCode: number;
  constructor(message: string, statusCode = 400) {
    super(message);
    this.statusCode = statusCode;
  }
}

/**
 * Validates a multipart image and writes it under `uploads/` with a generated name.
 * Returns the path relative to ASSETS_DIR, which is what gets stored in the database.
 */
export async function saveImageUpload(file: MultipartFile | undefined): Promise<string> {
  if (!file) throw new UploadError('No file was uploaded.');

  const buffer = await file.toBuffer();
  if (file.file.truncated || buffer.length > MAX_BYTES) {
    throw new UploadError('That image is larger than 8 MB.', 413);
  }
  if (buffer.length === 0) throw new UploadError('That file is empty.');

  const detected = detectImageType(buffer);
  if (!detected) {
    throw new UploadError('That file is not a PNG, JPEG, GIF, WebP or SVG image.');
  }

  const relativePath = `uploads/${randomToken(16)}.${detected.ext}`;
  await writeFile(join(ASSETS_DIR, relativePath), buffer);
  return relativePath;
}

/** Best-effort cleanup of a replaced asset. A missing file is not an error worth raising. */
export async function deleteUpload(relativePath: string | null): Promise<void> {
  if (!relativePath) return;
  // Refuse anything that could climb out of the assets directory.
  if (relativePath.includes('..') || relativePath.startsWith('/')) return;
  await unlink(join(ASSETS_DIR, relativePath)).catch(() => undefined);
}

export const assetUrl = (relativePath: string): string =>
  `${ASSETS_URL_PREFIX}/${relativePath}`;
