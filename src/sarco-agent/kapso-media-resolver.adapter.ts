import { Injectable } from '@nestjs/common';
import { KapsoMediaResolverService } from '../kapso/kapso-media-resolver.service';
import type { KapsoMediaReference } from '../kapso/kapso.types';
import type { MediaResolverPort, ResolveImageOptions, ResolveImageResult } from './core/media';

/**
 * Adapta el `KapsoMediaResolverService` ya existente (Kapso module, con su
 * propia lista blanca de hosts) al `MediaResolverPort` que pide Agent Core:
 * descarga los bytes y los convierte a `data:` URL, que es lo único que el
 * core necesita y lo único que puede viajar a OpenAI sin entregarle una
 * credencial de acceso al contenido del cliente.
 *
 * El resultado NUNCA se persiste.
 */
@Injectable()
export class KapsoAgentMediaResolver implements MediaResolverPort {
  constructor(private readonly resolver: KapsoMediaResolverService) {}

  async resolveImage(
    media: KapsoMediaReference,
    _phoneNumberId: string | null,
    _options?: ResolveImageOptions,
  ): Promise<ResolveImageResult> {
    const resolved = await this.resolver.resolve(media);
    if (!resolved.ok) return { ok: false, error: resolved.reason };

    return {
      ok: true,
      dataUrl: `data:${resolved.mimeType};base64,${resolved.bytes.toString('base64')}`,
      source: 'transient_kapso',
      byteSize: resolved.bytes.length,
      mimeType: resolved.mimeType,
    };
  }
}
