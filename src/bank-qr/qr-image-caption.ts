import sharp from 'sharp';

export interface QrImageCaptionInput {
  qrImageBase64: string;
  amountBs: number;
  concept: string;
}

const BAND_HEIGHT = 76;
const FALLBACK_SIZE = 400;

/**
 * El QR que devuelve el banco trae quemado su propio texto genérico (monto
 * en 0, glosa fija) — no refleja lo que realmente se cobra. Le agregamos
 * abajo, en una franja blanca que nosotros controlamos, el monto y el
 * concepto reales del pedido, sin tocar el QR en sí (sigue siendo
 * escaneable tal cual lo firmó el banco).
 */
export async function withAmountCaption(input: QrImageCaptionInput): Promise<Buffer> {
  const qrBuffer = Buffer.from(input.qrImageBase64, 'base64');
  const metadata = await sharp(qrBuffer).metadata();
  const width = metadata.width ?? FALLBACK_SIZE;
  const qrHeight = metadata.height ?? width;

  const amountText = `Monto: Bs ${input.amountBs.toFixed(2)}`;
  const conceptText = `Concepto: ${input.concept}`;
  const band = Buffer.from(`
    <svg width="${width}" height="${BAND_HEIGHT}" xmlns="http://www.w3.org/2000/svg">
      <rect width="100%" height="100%" fill="#ffffff"/>
      <text x="50%" y="32" text-anchor="middle" font-family="Arial, sans-serif" font-size="22" font-weight="bold" fill="#000000">${escapeXml(amountText)}</text>
      <text x="50%" y="58" text-anchor="middle" font-family="Arial, sans-serif" font-size="16" fill="#000000">${escapeXml(conceptText)}</text>
    </svg>
  `);

  return sharp({
    create: { width, height: qrHeight + BAND_HEIGHT, channels: 3, background: '#ffffff' },
  })
    .composite([
      { input: qrBuffer, top: 0, left: 0 },
      { input: band, top: qrHeight, left: 0 },
    ])
    .png()
    .toBuffer();
}

function escapeXml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
