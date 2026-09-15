export interface Coordinates {
  latitude: number;
  longitude: number;
}

export interface DistanceResult {
  meters: number;
  source: 'straight_line' | 'mapbox';
}

export interface DistanceService {
  /** Distancia en metros, en línea recta o por calle según la implementación. */
  metersBetween(from: Coordinates, to: Coordinates): Promise<DistanceResult>;
}

export const DISTANCE_SERVICE = Symbol('DISTANCE_SERVICE');

const EARTH_RADIUS_METERS = 6_371_000;

function toRadians(degrees: number): number {
  return (degrees * Math.PI) / 180;
}

/**
 * Fallback sin Mapbox (y red de seguridad de MapboxDistanceService si la API
 * falla): distancia en línea recta (haversine). Subestima la distancia real
 * de calle.
 */
export class HaversineDistanceService implements DistanceService {
  async metersBetween(from: Coordinates, to: Coordinates): Promise<DistanceResult> {
    const dLat = toRadians(to.latitude - from.latitude);
    const dLon = toRadians(to.longitude - from.longitude);
    const lat1 = toRadians(from.latitude);
    const lat2 = toRadians(to.latitude);

    const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

    return { meters: Math.round(EARTH_RADIUS_METERS * c), source: 'straight_line' };
  }
}
