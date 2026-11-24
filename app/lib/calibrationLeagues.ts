/* ------------------------------------------------------------------ */
/* CALIBRATION PAR CHAMPIONNAT (avec rétrécissement)                   */
/* ------------------------------------------------------------------ */
/*
 * Les paramètres de calibration (poids du modèle, température) sont
 * ajustés par championnat, puis RÉTRÉCIS vers une valeur commune.
 *
 * Pourquoi un rétrécissement : un championnat qui n'a fourni que
 * quelques centaines de rencontres produirait une estimation très
 * instable (le poids ajusté peut tomber à 0 ou monter à 1 selon deux
 * rencontres). On mélange donc l'estimation propre du championnat avec
 * l'estimation commune (tous championnats confondus) :
 *
 *     paramètre(championnat) = w · paramètre(championnat)
 *                            + (1 − w) · paramètre(commun)
 *
 * avec un poids w qui dépend de l'effectif :
 *
 *     w = n / (n + n₀)
 *
 * n₀ est le nombre de rencontres « fictives » qui represents la valeur
 * commune (50 par défaut). Un championnat de 3 000 rencontres est donc
 * presque entièrement piloté par sa propre estimation (w ≈ 0,98), un
 * championnat de 200 rencontres l'est à 80 % par la valeur commune
 * (w = 0,80).
 *
 * Rien n'est inventé : toutes les valeurs proviennent d'ajustements
 * réels sur le jeu de données de référence.
 */

export type CalibrationCore = {
  modelWeight: number;
  sharpness: number;
  valueThreshold: number;
};

export type LeagueCalibration = CalibrationCore & {
  league: string;
  /** Nombre de rencontres du championnat. */
  samples: number;
  /** Poids de l'estimation propre (1 = tout le sien, 0 = valeur commune). */
  shrinkage: number;
  /** Estimation brute du championnat (avant rétrécissement). */
  raw: CalibrationCore;
  /** Estimation commune utilisée pour le rétrécissement. */
  common: CalibrationCore;
};

export type ShrinkageOptions = {
  /** Nombre de rencontres fictives valant la valeur commune. */
  priorMatches?: number;
};

const DEFAULT_PRIOR = 50;

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, value));
}

/**
 * Rétrécit une estimation de championnat vers la valeur commune.
 *
 * Le rétrécissement est appliqué à l'échelle des écarts : l'estimation
 * commune est ramenée vers l'estimation du championnat d'un facteur
 * égal au poids propre. Les bornes restent inchangées.
 */
export function shrinkCore(
  raw: CalibrationCore,
  common: CalibrationCore,
  samples: number,
  options: ShrinkageOptions = {}
): { core: CalibrationCore; weight: number } {
  const prior = Math.max(1, options.priorMatches ?? DEFAULT_PRIOR);
  const weight = samples > 0 ? samples / (samples + prior) : 0;
  return {
    weight,
    core: {
      modelWeight: clamp(weight * raw.modelWeight + (1 - weight) * common.modelWeight, 0, 1),
      sharpness: clamp(weight * raw.sharpness + (1 - weight) * common.sharpness, 0.5, 2.2),
      valueThreshold: clamp(
        weight * raw.valueThreshold + (1 - weight) * common.valueThreshold,
        0,
        0.2
      ),
    },
  };
}

/**
 * Construit les calibrations par championnat à partir des ajustements
 * bruts et d'un ajustement commun.
 */
export function buildLeagueCalibrations(
  raw: { league: string; samples: number; core: CalibrationCore }[],
  common: CalibrationCore,
  options: ShrinkageOptions = {}
): LeagueCalibration[] {
  return raw.map(entry => {
    const { core, weight } = shrinkCore(entry.core, common, entry.samples, options);
    return {
      league: entry.league,
      samples: entry.samples,
      shrinkage: Number(weight.toFixed(4)),
      raw: entry.core,
      common,
      ...core,
    };
  });
}

/**
 * Extrait le noyau de calibration d'un objet qui porte les paramètres
 * (utilisé par les scripts de backtest).
 */
export function coreOf(params: {
  modelWeight: number;
  sharpness: number;
  valueThreshold: number;
}): CalibrationCore {
  return {
    modelWeight: params.modelWeight,
    sharpness: params.sharpness,
    valueThreshold: params.valueThreshold,
  };
}
