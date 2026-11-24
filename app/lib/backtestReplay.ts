/* ------------------------------------------------------------------ */
/* REJEU WALK-FORWARD PARTAGÉ                                          */
/* ------------------------------------------------------------------ */
/*
 * Rejeu d'un championnat match par match, avec la seule information
 * disponible avant chaque coup d'envoi, et calibration du mélange
 * modèle/marché ajustée EN MARCHE AVANT.
 *
 * Ce module est partagé par :
 *   - `scripts/backtest-strict.ts` (mesures par championnat) ;
 *   - `scripts/module-ablation.ts` (contribution de chaque module).
 *
 * La calibration est réajustée à chaque changement de saison, sur les
 * seules rencontres antérieures du championnat : aucune rencontre n'est
 * donc évaluée avec une calibration qui a vu son avenir.
 */

import { runQuantitativeAnalyst } from './analystEngine';
import { devigThreeWayDecimal } from './devig';
import {
  buildWalkForwardInputs,
  fitBlendParams,
  type BacktestDataset,
  type BacktestSample,
} from './backtest';
import { applyCalibration, type CalibrationParams, type OutcomeProbs } from './calibration';

export const RANDOM_PROBS: OutcomeProbs = { home: 1 / 3, draw: 1 / 3, away: 1 / 3 };

export type ReplayOptions = {
  /** Nombre d'itérations de Monte-Carlo (les probabilités 1X2 n'en dépendent pas). */
  simulationRuns?: number;
  /** Modules à neutraliser (ablation). */
  ablate?: string[];
  /** Nombre minimal de rencontres avant le premier réajustement. */
  minimumSamplesForFit?: number;
};

/** Rejoue un championnat et renvoie un échantillon par rencontre. */
export function replayLeague(
  dataset: BacktestDataset,
  options: ReplayOptions = {}
): BacktestSample[] {
  const { inputs, naive } = buildWalkForwardInputs(dataset, {
    simulationRuns: options.simulationRuns,
  });
  const samples: BacktestSample[] = [];
  const matches = dataset.matches.slice().sort((a, b) => a.date.localeCompare(b.date));

  for (let i = 0; i < matches.length; i++) {
    const match = matches[i];
    const input = inputs[i];
    if (!input) continue;

    let report: ReturnType<typeof runQuantitativeAnalyst>;
    try {
      report = runQuantitativeAnalyst({
        ...input,
        ablate: options.ablate,
      });
    } catch {
      continue;
    }

    const model: OutcomeProbs = {
      home: report.market.pureModel.home,
      draw: report.market.pureModel.draw,
      away: report.market.pureModel.away,
    };
    const outcome: 0 | 1 | 2 =
      match.homeGoals > match.awayGoals ? 0 : match.homeGoals === match.awayGoals ? 1 : 2;

    const markets: Record<string, OutcomeProbs> = {};
    const rawOdds: Record<string, { home: number; draw: number; away: number }> = {};
    for (const [provider, triple] of Object.entries(match.oddsByProvider || {})) {
      const devig = devigThreeWayDecimal(triple);
      if (!devig) continue;
      markets[provider] = {
        home: devig.probs.home,
        draw: devig.probs.draw,
        away: devig.probs.away,
      };
      rawOdds[provider] = { ...triple };
    }

    samples.push({
      matchId: match.id,
      date: match.date,
      league: match.league,
      outcome,
      model,
      market: markets.bet365 ?? null,
      naive: naive[i] ?? RANDOM_PROBS,
      separation: report.confidence.separation,
      agreement: report.confidence.agreement,
      marketPick: 0,
      confidenceScore: report.confidence.score,
      homeGoals: match.homeGoals,
      awayGoals: match.awayGoals,
      odds: match.odds ?? null,
      over25: Number.isFinite(report.market.pureModel.over25) ? report.market.pureModel.over25 : null,
      btts: Number.isFinite(report.market.pureModel.btts) ? report.market.pureModel.btts : null,
      markets,
      rawOdds,
    });
  }
  return samples;
}

/**
 * Renvoie un prédicteur « modèle calibré » dont les paramètres (poids
 * du modèle, température) sont ajustés en marche avant : à chaque
 * changement de saison, on réajuste sur les seules rencontres
 * antérieures.
 */
export function walkForwardCalibration(
  samples: BacktestSample[],
  options: { minimumSamplesForFit?: number } = {}
): (sample: BacktestSample) => OutcomeProbs {
  const minimum = options.minimumSamplesForFit ?? 200;
  const sorted = samples.slice().sort((a, b) => a.date.localeCompare(b.date));
  const calibrations = new Map<string, { weight: number; sharpness: number }>();
  let current: { weight: number; sharpness: number } = { weight: 0, sharpness: 1 };
  let priorSamples: BacktestSample[] = [];
  let currentSeason = '';

  for (const sample of sorted) {
    const season = sample.date.slice(0, 4);
    if (season !== currentSeason) {
      currentSeason = season;
      if (priorSamples.length >= minimum) {
        const best = fitBlendParams(priorSamples);
        if (best) current = { weight: best.weight, sharpness: best.sharpness };
      }
      calibrations.set(season, current);
    }
    priorSamples.push(sample);
  }

  return sample => {
    const season = sample.date.slice(0, 4);
    const calibration = calibrations.get(season) ?? current;
    return applyCalibration(sample.model, sample.market, {
      sharpness: calibration.sharpness,
      modelWeight: calibration.weight,
    } as CalibrationParams).probs;
  };
}
