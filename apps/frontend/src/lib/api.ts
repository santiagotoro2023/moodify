import { type ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

export class ApiError extends Error {
  readonly status: number;
  readonly details?: unknown;

  constructor(message: string, status: number, details?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.details = details;
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      method,
      credentials: 'include',
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    // Network-level failure: the backend is unreachable, not returning an error.
    throw new ApiError('Could not reach the Moodify server.', 0);
  }
  return handle<T>(response);
}

async function handle<T>(response: Response): Promise<T> {
  const text = await response.text();
  let payload: unknown = null;
  if (text) {
    try {
      payload = JSON.parse(text) as unknown;
    } catch {
      payload = null;
    }
  }

  if (!response.ok) {
    const record = payload as { error?: unknown; details?: unknown } | null;
    const message =
      typeof record?.error === 'string' ? record.error : `Request failed (${response.status})`;
    throw new ApiError(message, response.status, record?.details);
  }

  return payload as T;
}

export const api = {
  get: <T,>(path: string): Promise<T> => request<T>('GET', path),
  post: <T,>(path: string, body?: unknown): Promise<T> => request<T>('POST', path, body),
  patch: <T,>(path: string, body?: unknown): Promise<T> => request<T>('PATCH', path, body),
  put: <T,>(path: string, body?: unknown): Promise<T> => request<T>('PUT', path, body),
  del: <T,>(path: string): Promise<T> => request<T>('DELETE', path),

  async upload<T>(path: string, file: File): Promise<T> {
    const form = new FormData();
    form.append('file', file);
    let response: Response;
    try {
      response = await fetch(path, { method: 'POST', credentials: 'include', body: form });
    } catch {
      throw new ApiError('Could not reach the Moodify server.', 0);
    }
    return handle<T>(response);
  },
};

/** Maps a stored relative asset path to a URL the browser can load. */
export function assetUrl(path: string | null): string | null {
  if (!path) return null;
  if (path.startsWith('/') || path.startsWith('http')) return path;
  return `/assets-store/${path}`;
}

export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error) return err.message;
  return 'Something went wrong.';
}

/** "3 minutes ago" — used by the sync banner and Settings. */
export function relativeTime(iso: string | null): string {
  if (!iso) return 'never';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return 'never';
  const seconds = Math.round((Date.now() - then) / 1000);
  if (seconds < 5) return 'just now';
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}
