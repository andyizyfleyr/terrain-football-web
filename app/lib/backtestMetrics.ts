/* ------------------------------------------------------------------ */
/* MÉTRIQUES DE PRÉVISION (3 issues : 1 / X / 2)                         */
/* ------------------------------------------------------------------ */
/*
 * Boîte à outils de mesure commune aux backtests :
 *
 *   - log-loss      : pénalité moyenne des probabilités annoncé ;
 *   - Brier         : erreur quadratique moyenne sur les 3 issues ;
 *   - RPS           : score de probabilité ordonnée (1 / X / 2) ;
 *   - exactitude    : part des issues correctement classées ;
 *   - IC bootstrap  : intervalle de confiance à 95 % par rééchantillonage ;
 *   - courbe de fiabilité : probabilité annoncée contre fréquence observée.
 *
 * Le RPS est la métrique de référence pour un marché à trois issues :
 * elle tient compte de l'ordre (se tromper de nul coûte moins que se
 * tromper de côté), là où la log-loss ne le fait pas.
 *
 * Toutes les fonctions sont pures et déterministes (le bootstrap utilise
 * un générateur à graine fixe) : deux exécutions donnent le même
 * résultat, ce qui permet de les versionner.
 */

import type { OutcomeProbs } from './calibration';

export type MetricSummary = {
  value: number;
  /** Borne basse de l'intervalle de confiance à 95 % (bootstrap). */
  low: number;
  /** Borne haute de l'intervalle de confiance à 95 % (bootstrap). */
  high: number;
  samples: number;
};

export type ReliabilityBin = {
  min: number;
  max: number;
  predicted: number;
  observed: number;
  samples: number;
};

/** Log-loss d'un triplet de probabilités pour un résultat observé. */
export function logLossOf(probs: OutcomeProbs, outcome: 0 | 1 | 2): number {
  const p = outcome === 0 ? probs.home : outcome === 1 ? probs.draw : probs.away;
  return -Math.log(Math.max(1e-12, p));
}

/** Score de Brier (moyenne sur les 3 issues). */
export function brierOf(probs: OutcomeProbs, outcome: 0 | 1 | 2): number {
  const home = probs.home - (outcome === 0 ? 1 : 0);
  const draw = probs.draw - (outcome === 1 ? 1 : 0);
  const away = probs.away - (outcome === 2 ? 1 : 0);
  return (home * home + draw * draw + away * away) / 3;
}

/**
 * Ranked Probability Score pour trois issues ordonnées (1, X, 2).
 * RPS = (1/6) · [ (p₁−o₁)² + (p₁+p₂−o₁−o₂)² ].
 */
export function rpsOf(probs: OutcomeProbs, outcome: 0 | 1 | 2): number {
  const observed: number[] = outcome === 0 ? [1, 0, 0] : outcome === 1 ? [0, 1, 0] : [0, 0, 1];
  const predicted: number[] = [probs.home, probs.draw, probs.away];
  let cumulativePredicted = 0;
  let cumulativeObserved = 0;
  let total = 0;
  for (let i = 0; i < 2; i++) {
    cumulativePredicted += predicted[i];
    cumulativeObserved += observed[i];
    total += Math.pow(cumulativePredicted - cumulativeObserved, 2);
  }
  return total / 6;
}

/** Issue la plus probable selon un triplet (1 = domicile, X = nul, 2 = extérieur). */
export function topOutcome(probs: OutcomeProbs): 0 | 1 | 2 {
  if (probs.home >= probs.draw && probs.home >= probs.away) return 0;
  if (probs.draw >= probs.away) return 1;
  return 2;
}

/* ------------------------------------------------------------------ */
/* Agrégation et intervalles de confiance                               */
/* ------------------------------------------------------------------ */

/** Générateur pseudo-aléatoire déterministe (mulberry32). */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Intervalle de confiance bootstrap à 95 % de la moyenne d'une série.
 * On rééchantillonne les observations AVEC REMPLACEMENT.
 */
export function bootstrapMeanInterval(
  values: number[],
  iterations = 2000,
  seed = 20260101
): { low: number; high: number } {
  if (!values.length) return { low: 0, high: 0 };
  if (values.length === 1) return { low: values[0], high: values[0] };
  const random = mulberry32(seed);
  const means: number[] = [];
  for (let iteration = 0; iteration < iterations; iteration++) {
    let total = 0;
    for (let i = 0; i < values.length; i++) {
      total += values[Math.floor(random() * values.length)];
    }
    means.push(total / values.length);
  }
  means.sort((a, b) => a - b);
  const index = Math.min(means.length - 1, Math.floor(0.025 * means.length));
  const high = Math.min(means.length - 1, Math.floor(0.975 * means.length));
  return { low: means[index], high: means[high] };
}

/** Résumé d'une métrique (moyenne + intervalle de confiance bootstrap). */
export function summarise(
  perSample: number[],
  iterations = 2000,
  seed = 20260101
): MetricSummary {
  const value = perSample.length
    ? perSample.reduce((sum, item) => sum + item, 0) / perSample.length
    : 0;
  const { low, high } = bootstrapMeanInterval(perSample, iterations, seed);
  return {
    value: Number(value.toFixed(4)),
    low: Number(low.toFixed(4)),
    high: Number(high.toFixed(4)),
    samples: perSample.length,
  };
}

/**
 * Courbe de fiabilité : probabilité annoncée pour l'issue retenue
 * contre fréquence observée. Les bins sont d'effectif FIXE (10 bins de
 * 0,1) : une tranche vide est renvoyée avec `samples: 0` et une
 * observation `null` (aucune mesure, donc aucune valeur inventée).
 */
export function reliabilityCurve(
  probabilities: number[],
  hits: number[],
  binCount = 10
): ReliabilityBin[] {
  const bins: ReliabilityBin[] = [];
  for (let i = 0; i < binCount; i++) {
    bins.push({
      min: Number((i / binCount).toFixed(2)),
      max: Number(((i + 1) / binCount).toFixed(2)),
      predicted: 0,
      observed: 0,
      samples: 0,
    });
  }
  let predictedSum = 0;
  let hitsSum = 0;
  for (let i = 0; i < probabilities.length; i++) {
    const p = probabilities[i];
    const h = hits[i];
    if (!Number.isFinite(p)) continue;
    const position = Math.min(binCount - 1, Math.max(0, Math.floor(p * binCount)));
    const bin = bins[position];
    bin.predicted += p;
    bin.samples += 1;
    bin.observed += h ? 1 : 0;
    predictedSum += p;
    hitsSum += h ? 1 : 0;
  }
  for (const bin of bins) {
    bin.predicted = bin.samples ? Number((bin.predicted / bin.samples).toFixed(4)) : 0;
    bin.observed = bin.samples ? Number((bin.observed / bin.samples).toFixed(4)) : 0;
  }
  return bins;
}

/**
 * Écart-type d'une série (écart-type échantillon).
 */
export function standardDeviation(values: number[]): number {
  if (values.length < 2) return 0;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance);
}

/**
 * Comparaison de deux séries appariées (test de Student apparié,
 * approximation normale). Sert à mesurer la significativité d'un écart
 * de log-loss (ablation de module, calibration par championnat).
 */
export function pairedDifference(
  first: number[],
  second: number[]
): { mean: number; z: number; pValue: number; samples: number } {
  const n = Math.min(first.length, second.length);
  if (n < 2) return { mean: 0, z: 0, pValue: 1, samples: n };
  const diffs: number[] = [];
  for (let i = 0; i < n; i++) diffs.push(first[i] - second[i]);
  const mean = diffs.reduce((sum, value) => sum + value, 0) / n;
  const std = standardDeviation(diffs);
  if (std === 0) return { mean, z: 0, pValue: mean === 0 ? 1 : 0, samples: n };
  const z = mean / (std / Math.sqrt(n));
  // Approximation de la loi normale : P(|Z| > |z|) via la fonction d'erreur.
  const pValue = 2 * (1 - normalCdf(Math.abs(z)));
  return { mean: Number(mean.toFixed(6)), z: Number(z.toFixed(3)), pValue: Number(pValue.toFixed(6)), samples: n };
}

/** Fonction de répartition normale centrée réduite (approximation d'Abramowitz). */
export function normalCdf(z: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989423 * Math.exp((-z * z) / 2);
  const probability =
    d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return z > 0 ? 1 - probability : probability;
}
