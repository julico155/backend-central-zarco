import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppConfig } from '../config/configuration';
import { KapsoMediaReference } from './kapso.types';

const ALLOWED_MEDIA_HOSTS = new Set([
  'app.kapso.ai',
  'lookaside.fbsbx.com',
  'kapso-ai-prod.d77f1e59818b5ed2ec009d1a9116b255.r2.cloudflarestorage.com',
]);
const MAX_REDIRECTS = 3;
const MAX_MEDIA_BYTES = 10 * 1024 * 1024;
const MEDIA_TIMEOUT_MS = 10_000;

export type ResolveKapsoMediaResult =
  | { ok: true; bytes: Buffer; mimeType: string }
  | {
      ok: false;
      reason: 'unavailable' | 'blocked_url' | 'timeout' | 'too_large' | 'unsupported_mime';
    };

function allowedMediaUrl(raw: string): URL | null {
  try {
    const url = new URL(raw);
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      !['', '443'].includes(url.port)
    )
      return null;
    return ALLOWED_MEDIA_HOSTS.has(url.hostname.toLowerCase()) ? url : null;
  } catch {
    return null;
  }
}

/** Private, redirect-safe media download. It is not invoked by this phase's dispatcher. */
@Injectable()
export class KapsoMediaResolverService {
  constructor(private readonly config: ConfigService<AppConfig, true>) {}

  async resolve(media: KapsoMediaReference): Promise<ResolveKapsoMediaResult> {
    if (!media.url) return { ok: false, reason: 'unavailable' };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), MEDIA_TIMEOUT_MS);
    try {
      let nextUrl = media.url;
      for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
        const url = allowedMediaUrl(nextUrl);
        if (!url) return { ok: false, reason: 'blocked_url' };
        const apiKey = this.config.get('kapso', { infer: true }).apiKey;
        const headers =
          url.hostname === 'app.kapso.ai' && apiKey ? { 'X-API-Key': apiKey } : undefined;
        const response = await fetch(url, {
          headers,
          redirect: 'manual',
          signal: controller.signal,
        });
        if (response.status >= 300 && response.status < 400) {
          const location = response.headers.get('location');
          if (!location) return { ok: false, reason: 'unavailable' };
          nextUrl = new URL(location, url).toString();
          continue;
        }
        if (!response.ok) return { ok: false, reason: 'unavailable' };
        const contentLength = Number(response.headers.get('content-length') ?? '');
        if (Number.isFinite(contentLength) && contentLength > MAX_MEDIA_BYTES)
          return { ok: false, reason: 'too_large' };
        const mimeType = (response.headers.get('content-type') ?? media.mimeType ?? '')
          .split(';')[0]
          .trim()
          .toLowerCase();
        if (!mimeType.startsWith('image/') && !mimeType.startsWith('audio/'))
          return { ok: false, reason: 'unsupported_mime' };
        const bytes = Buffer.from(await response.arrayBuffer());
        if (bytes.length === 0) return { ok: false, reason: 'unavailable' };
        if (bytes.length > MAX_MEDIA_BYTES) return { ok: false, reason: 'too_large' };
        return { ok: true, bytes, mimeType };
      }
      return { ok: false, reason: 'unavailable' };
    } catch {
      return { ok: false, reason: controller.signal.aborted ? 'timeout' : 'unavailable' };
    } finally {
      clearTimeout(timer);
    }
  }
}
