/**
 * DATOS DUROS del negocio (Don Zarco). Puerto directo de sarcoRestaurant
 * (src/lib/agent/business/facts.ts): lo único del negocio que el agente
 * puede afirmar de memoria, sin consultar una herramienta.
 */

export const BUSINESS_NAME = 'Don Zarco';

export const BUSINESS_DESCRIPTION = 'un local de trancapechos cochabambinos en Santa Cruz, Bolivia';

export const BUSINESS_HOURS = 'todos los días, de siete de la tarde a cuatro de la madrugada';

export const BUSINESS_OPENS_HOUR = 19;
export const BUSINESS_CLOSES_HOUR = 4;

export function businessHoursClock(): string {
  const dosDigitos = (h: number) => String(h).padStart(2, '0');
  return `${dosDigitos(BUSINESS_OPENS_HOUR)}:00 a ${dosDigitos(BUSINESS_CLOSES_HOUR)}:00`;
}

export const BUSINESS_MAPS_URL = 'https://maps.app.goo.gl/NL8foBoiySELVKMr8?g_st=ic';

export const BUSINESS_ADDRESS: string | null =
  'sobre la avenida Doble Vía La Guardia, frente al Hipermaxi Las Palmas';

/** Bloque de "hechos del negocio" que se inyecta en el system prompt. */
export function businessFactsBlock(): string {
  const ubicacion =
    BUSINESS_ADDRESS === null
      ? `- Dónde están: no tienes la dirección escrita, así que no la inventes ni la describas. Cuando pregunten por la ubicación, pasa el enlace de Google Maps tal cual, escrito entero dentro del mensaje: ${BUSINESS_MAPS_URL}`
      : `- Dónde están: ${BUSINESS_ADDRESS}. Cuando pregunten por la ubicación, responde SIEMPRE con las dos cosas en el mismo mensaje: esa dirección en palabras y el enlace de Google Maps ${BUSINESS_MAPS_URL} escrito entero. Nunca una sin la otra.`;

  return [
    'Lo único que sabes de memoria (y puedes decir sin consultar nada):',
    `- Horario de atención: ${BUSINESS_HOURS}.`,
    ubicacion,
    '- Es su ÚNICO local: no hay sucursales ni otro punto de venta. Si preguntan si están en otra zona, en otro barrio o si tienen otra sede, contesta que no, que solo atienden en esa dirección. Eso lo sabes: no es un dato que te falte, así que no respondas que no tienes la información.',
    '- Hacen delivery en moto a domicilio. El costo lo calcula el sistema con la ubicación del cliente, en el momento; tú nunca lo estimas.',
    '- Fuera de lo anterior, no tienes ningún dato del negocio en la cabeza.',
  ].join('\n');
}
