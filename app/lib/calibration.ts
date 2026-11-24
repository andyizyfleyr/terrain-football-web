/* ------------------------------------------------------------------ */
/* CALIBRATION DU MODÈLE                                               */
/* ------------------------------------------------------------------ */
/*
 * La calibration répond à trois questions que le modèle doit trancher
 * avec des MESURES, pas des intuition :
 *
 *  1. Quelle part de la décision vient du modèle, quelle part du marché ?
 *     → poids w ajusté par minimisation de la log-loss sur l'historique.
 *
 *  2. Le modèle est-il trop prudent ou trop affirmatif ?
 *     → paramètre de température γ (p ∝ p^γ), lui aussi ajusté sur
 *     l'historique. γ > 1 accentue, γ < 1 tempère.
 *
 *  3. Que vaut réellement la « confiance » affichée ?
 *     → régression logistique calibrée sur la probabilité que l'issue
 *       retenue par le modèle soit la bonne : le score affiché devient une
 *       probabilité MESURÉE d'avantage du modèle.
 *
 * Les paramètres ajustés sont versionnés dans calibrationParams.ts et
 * recalculables par `npm run check:backtest` : le calibrage est donc
 * reproductible et auditable, jamais une valeur posée à la main.
 */

import { applySharpness, credibleInterval } from './poissonModels';

export type CalibrationMetrics = {
  sampleSize: number;
  league: string;
  period: string;
  /** Log-loss du modèle pur (1X2, 3 classes). */
  modelLogLoss: number;
  /** Log-loss du marché dé-viggué (null si aucune cote disponible). */
  marketLogLoss: number | null;
  /**
   * Log-loss du modèle calibré (mélange + température), évalué HORS
   * ÉCHANTILLON : les paramètres sont ajustés sur k-1 blocs et évalués
   * sur le bloc retenu (validation croisée). C'est le chiffre à
   * regarder : il mesure ce que le calibration fait sur des matchs
   * qu'elle n'a pas vus.
   */
  calibratedLogLoss: number;
  /** Log-loss du modèle calibré ajusté ET évalué sur le même échantillon. */
  calibratedLogLossInSample: number;
  /** Nombre de blocs de validation croisée utilisés. */
  crossValidationFolds: number;
  /** Log-loss d'une référence naïve (moyennes de la league). */
  naiveLogLoss: number;
  brier: number;
  accuracy: number;
  /** ROI du modèle sur les paris où l'écart dépasse le seuil de valeur. */
  valueRoi: number | null;
  valueBets: number;
  valueThreshold: number;
};

export type ConfidenceBin = {
  min: number;
  max: number;
  probability: number;
  samples: number;
};

export type CalibrationParams = {
  version: string;
  /** Poids du modèle dans le mélange avec le marché. */
  modelWeight: number;
  /** Température : p ∝ p^sharpness. */
  sharpness: number;
  /** Écart minimal (points de probabilité) pour parler de « valeur ». */
  valueThreshold: number;
  /**
   * true si l'ajustement a démontré un seuil de valeur rentable sur
   * l'historique. Quand c'est false, aucun seuil n'a été démontré : la
   * détection de valeur doit rester DORMANTE plutôt que de déclarer
   * « valeur » tous les paris dont l'écart est strictement positif.
   */
  valueThresholdDemonstrated?: boolean;
  /** Concentration Beta effective pour les intervalles de crédibilité. */
  effectiveSampleSize: number;
  /**
   * Coefficients de la régression logistique (confiance → probabilité).
   * `marketPick` : probabilité que le marché attribue à l'issue retenue
   * par le modèle (variable la plus informative hors échantillon).
   */
  logistic: { intercept: number; separation: number; agreement: number; marketPick?: number };
  confidenceBins: ConfidenceBin[];
  metrics: CalibrationMetrics;
  dataset: string;
  fittedAt: string;
  /** Limites connues du calibrage (données non recalculables historiquement). */
  limitations?: string[];
};

export type OutcomeProbs = { home: number; draw: number; away: number };

/**
 * Écart minimal considéré comme significatif. En dessous, l'écart n'est
 * que du bruit de calcul en virgule flottante : sans cette garde, un
 * mélange dont le poids de modèle est nul produit des écarts de l'ordre
 * de 1e-16, qui suffisent à faire passer une rencontre pour un « pari ».
 */
export const MIN_MEANINGFUL_EDGE = 1e-6;

/** Mélange convexe modèle / marché. */
export function blendProbabilities(
  model: OutcomeProbs,
  market: OutcomeProbs | null,
  weight: number
): OutcomeProbs {
  const w = Math.max(0, Math.min(1, weight));
  if (!market) return { ...model };
  return {
    home: w * model.home + (1 - w) * market.home,
    draw: w * model.draw + (1 - w) * market.draw,
    away: w * model.away + (1 - w) * market.away,
  };
}

/**
 * Applique la calibration complète au modèle pur :
 * température → mélange marché → renormalisation.
 */
export function applyCalibration(
  model: OutcomeProbs,
  market: OutcomeProbs | null,
  params: CalibrationParams
): { probs: OutcomeProbs; sharpness: number; modelWeight: number } {
  const sharp = applySharpness([model.home, model.draw, model.away], params.sharpness);
  const tempered: OutcomeProbs = { home: sharp[0], draw: sharp[1], away: sharp[2] };
  const blended = blendProbabilities(tempered, market, params.modelWeight);
  const total = blended.home + blended.draw + blended.away;
  const normalised = total > 0
    ? {
        home: blended.home / total,
        draw: blended.draw / total,
        away: blended.away / total,
      }
    : blended;
  return { probs: normalised, sharpness: params.sharpness, modelWeight: params.modelWeight };
}

/**
 * Probabilité MESURÉE d'avantage du modèle, obtenue par régression
 * logistique calibrée sur l'historique.
 */
export function calibratedConfidence(
  params: CalibrationParams,
  separation: number,
  agreement: number,
  marketPick?: number | null
): { probability: number; label: string } {
  const { intercept, separation: bSep, agreement: bAgr, marketPick: bPick = 0 } = params.logistic;
  const z =
    intercept +
    bSep * separation +
    bAgr * agreement +
    bPick * (typeof marketPick === 'number' && Number.isFinite(marketPick) ? marketPick : 0);
  const probability = 1 / (1 + Math.exp(-z));
  const label =
    probability >= 0.72
      ? 'Très fiable'
      : probability >= 0.62
        ? 'Fiable'
        : probability >= 0.52
          ? 'Modérée'
          : 'Faible';
  return { probability: Number(probability.toFixed(4)), label };
}

/** Intervalle de crédibilité 80 % autour d'une probabilité calibrée. */
export function probabilityInterval(
  params: CalibrationParams,
  probability: number
): { low: number; high: number } {
  return credibleInterval(probability, params.effectiveSampleSize, 0.8);
}

/**
 * Un écart n'est une « valeur » que s'il dépasse le seuil calibré sur
 * l'historique (point d'équilibre found profitability), pas un seuil arbitraire.
 */
export function valueAssessment(
  edge: number,
  params: CalibrationParams
): { isValue: boolean; threshold: number; note: string } {
  const threshold = params.valueThreshold;
  if (params.valueThresholdDemonstrated === false) {
    return {
      isValue: false,
      threshold,
      note:
        'Aucun seuil de valeur n’a été démontré sur l’historique de référence : ' +
        'la détection de valeur reste inactive tant que le seuil n’est pas établi.',
    };
  }
  if (!Number.isFinite(edge) || edge <= MIN_MEANINGFUL_EDGE) {
    return { isValue: false, threshold, note: 'Aucun écart positif significatif.' };
  }
  const isValue = edge >= threshold;
  return {
    isValue,
    threshold,
    note: isValue
      ? `Écart de ${(edge * 100).toFixed(1)} pts au-dessus du seuil calibré de ${(threshold * 100).toFixed(1)} pts.`
      : `Écart de ${(edge * 100).toFixed(1)} pts sous le seuil calibré de ${(threshold * 100).toFixed(1)} pts : aucune valeur statistique.`,
  };
}
