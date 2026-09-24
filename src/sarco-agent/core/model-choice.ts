/**
 * Qué modelo atiende ESTE turno. Puerto directo de sarcoRestaurant
 * (src/lib/agent/core/model-choice.ts): el turno con foto usa el modelo de
 * visión configurado (o el de texto, si no hay ninguno distinto).
 */

export interface TurnModelChoice {
  hasImage: boolean;
  textModel: string;
  /** Vacío o ausente = se usa el de texto. */
  visionModel?: string | null;
}

export function pickTurnModel(choice: TurnModelChoice): string {
  if (!choice.hasImage) return choice.textModel;
  const vision = (choice.visionModel ?? '').trim();
  return vision === '' ? choice.textModel : vision;
}

/** ¿Este turno lleva alguna imagen? Mira el MISMO campo que consulta el resolutor de media. */
export function turnHasImage(burst: readonly { image?: unknown }[] | undefined): boolean {
  return (burst ?? []).some((m) => m.image !== null && m.image !== undefined);
}
