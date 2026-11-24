/* ------------------------------------------------------------------ */
/* BACKTEST STRICT (multi-championnats, marche avant)                   */
/* ------------------------------------------------------------------ */
/*
 * Backtest de référence du projet : il rejoue le moteur sur le jeu de
 * données football-data.co.uk (5 divisions, 8 saisons, ~14 600
 * rencontres) et compare SIX prédicteurs sur les mêmes rencontres :
 *
 *   1. aléatoire (1/3, 1/3, 1/3) ;
 *   2. modèle brut (Poisson / Dixon-Coles) ;
 *   3. modèle calibré (mélange + température ajustés en marche avant) ;
 *   4. marché Bet365 dé-viggué ;
 *   5. marché Pinnacle dé-viggué ;
 *   6. moyenne du marché dé-vigguée.
 *
 * Pour chaque prédicteur : log-loss, Brier, RPS et exactitude, avec un
 * intervalle de confiance à 95 % (bootstrap). Le ROI du modèle calibré
 * est mesuré sur les paris dont l'écart dépasse le seuil, avec son
 * propre intervalle de confiance.
 *
 * La calibration du modèle est ajustée EN MARCHE AVANT : à chaque
 * changement de saison, on réajuste sur les seules rencontres
 * antérieures de ce championnat. Aucune rencontre n'est donc jamais
 * évaluée avec une calibration qui a vu son avenir.
 *
 * Sortie : `data/backtest-report.json` + résumé sur la sortie standard.
 *
 * Exécution : npm run check:backtest:strict
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { loadFootballData } from '../app/lib/backtestDatasetFootballData.ts';
import { replayLeague, walkForwardCalibration, RANDOM_PROBS } from '../app/lib/backtestReplay.ts';
import type { BacktestSample } from '../app/lib/backtest.ts';
import type { OutcomeProbs } from '../app/lib/calibration.ts';
import {
  brierOf,
  bootstrapMeanInterval,
  logLossOf,
  reliabilityCurve,
  rpsOf,
  summarise,
  topOutcome,
} from '../app/lib/backtestMetrics.ts';

const SIMULATION_RUNS = Number(process.env.BACKTEST_SIMULATION_RUNS || 2000);
const BOOTSTRAP_ITERATIONS = Number(process.env.BACKTEST_BOOTSTRAP || 2000);
const VALUE_THRESHOLD = Number(process.env.BACKTEST_VALUE_THRESHOLD || 0.02);

type Predictor = (sample: BacktestSample) => OutcomeProbs | null;

type PredictorReport = {
  name: string;
  coverage: number;
  logLoss: ReturnType<typeof summarise>;
  brier: ReturnType<typeof summarise>;
  rps: ReturnType<typeof summarise>;
  accuracy: ReturnType<typeof summarise>;
};

const RANDOM = RANDOM_PROBS;

function evaluate(
  name: string,
  samples: BacktestSample[],
  predictor: Predictor
): PredictorReport {
  const logLosses: number[] = [];
  const briers: number[] = [];
  const rpss: number[] = [];
  const accuracies: number[] = [];
  for (const sample of samples) {
    const probs = predictor(sample);
    if (!probs) continue;
    logLosses.push(logLossOf(probs, sample.outcome));
    briers.push(brierOf(probs, sample.outcome));
    rpss.push(rpsOf(probs, sample.outcome));
    accuracies.push(topOutcome(probs) === sample.outcome ? 1 : 0);
  }
  return {
    name,
    coverage: samples.length ? logLosses.length / samples.length : 0,
    logLoss: summarise(logLosses, BOOTSTRAP_ITERATIONS, 11),
    brier: summarise(briers, BOOTSTRAP_ITERATIONS, 12),
    rps: summarise(rpss, BOOTSTRAP_ITERATIONS, 13),
    accuracy: summarise(accuracies, BOOTSTRAP_ITERATIONS, 14),
  };
}

/** ROI du modèle calibré sur les paris dont l'écart dépasse le seuil. */
function evaluateRoi(
  samples: BacktestSample[],
  predictor: Predictor
): { bets: number; roi: number | null; low: number | null; high: number | null } {
  const returns: number[] = [];
  for (const sample of samples) {
    if (!sample.market || !sample.odds) continue;
    const probs = predictor(sample);
    if (!probs) continue;
    const picks = [
      { index: 0 as const, edge: probs.home - sample.market.home, odds: sample.odds.home },
      { index: 1 as const, edge: probs.draw - sample.market.draw, odds: sample.odds.draw },
      { index: 2 as const, edge: probs.away - sample.market.away, odds: sample.odds.away },
    ];
    const best = picks.sort((a, b) => b.edge - a.edge)[0];
    if (!(best.edge > VALUE_THRESHOLD)) continue;
    returns.push(best.index === sample.outcome ? best.odds - 1 : -1);
  }
  if (!returns.length) return { bets: 0, roi: null, low: null, high: null };
  const mean = returns.reduce((sum, value) => sum + value, 0) / returns.length;
  const interval = bootstrapMeanInterval(returns, BOOTSTRAP_ITERATIONS, 15);
  return {
    bets: returns.length,
    roi: Number(mean.toFixed(4)),
    low: Number(interval.low.toFixed(4)),
    high: Number(interval.high.toFixed(4)),
  };
}

function printTable(reports: PredictorReport[]): void {
  const header = [
    'prédicteur'.padEnd(22),
    'log-loss'.padEnd(22),
    'Brier'.padEnd(18),
    'RPS'.padEnd(18),
    'exactitude'.padEnd(16),
    'n',
  ];
  console.log(header.join(' · '));
  for (const report of reports) {
    console.log(
      [
        report.name.padEnd(22),
        `${report.logLoss.value.toFixed(4)} [${report.logLoss.low.toFixed(3)}, ${report.logLoss.high.toFixed(3)}]`.padEnd(22),
        `${report.brier.value.toFixed(4)}`.padEnd(18),
        `${report.rps.value.toFixed(4)}`.padEnd(18),
        `${(report.accuracy.value * 100).toFixed(1)} %`.padEnd(16),
        String(report.logLoss.samples),
      ].join(' · ')
    );
  }
}

async function main(): Promise<void> {
  console.log('Chargement du jeu de données football-data.co.uk…');
  const bundle = loadFootballData();
  console.log(
    `  ${bundle.manifest.matches} rencontres · ${bundle.manifest.teams} équipes · ${bundle.manifest.period}`
  );

  const perLeague: Record<string, unknown> = {};
  const allSamples: BacktestSample[] = [];

  for (const [league, dataset] of Array.from(bundle.byLeague.entries())) {
    const started = Date.now();
    const samples = replayLeague(dataset, { simulationRuns: SIMULATION_RUNS });
    allSamples.push(...samples);
    const calibrated = walkForwardCalibration(samples);
    const reports: PredictorReport[] = [
      evaluate('aléatoire', samples, () => RANDOM),
      evaluate('modèle brut', samples, sample => sample.model),
      evaluate('modèle calibré', samples, calibrated),
      evaluate('Bet365 dé-viggué', samples, sample => sample.markets.bet365 ?? null),
      evaluate('Pinnacle dé-viggué', samples, sample => sample.markets.pinnacle ?? null),
      evaluate('moyenne marché', samples, sample => sample.markets.marketAverage ?? null),
    ];
    const roi = evaluateRoi(samples, calibrated);
    console.log('');
    console.log(`=== ${league} (${samples.length} rencontres, ${Date.now() - started} ms) ===`);
    printTable(reports);
    console.log(
      `  ROI calibré (seuil ${(VALUE_THRESHOLD * 100).toFixed(1)} pts) : ${
        roi.roi === null ? 'aucun pari' : `${(roi.roi * 100).toFixed(2)} % [${(roi.low! * 100).toFixed(2)}, ${(roi.high! * 100).toFixed(2)}] sur ${roi.bets} paris`
      }`
    );
    perLeague[league] = { reports, roi };
  }

  const globalCalibrated = walkForwardCalibration(allSamples);
  const globalReports: PredictorReport[] = [
    evaluate('aléatoire', allSamples, () => RANDOM),
    evaluate('modèle brut', allSamples, sample => sample.model),
    evaluate('modèle calibré', allSamples, globalCalibrated),
    evaluate('Bet365 dé-viggué', allSamples, sample => sample.markets.bet365 ?? null),
    evaluate('Pinnacle dé-viggué', allSamples, sample => sample.markets.pinnacle ?? null),
    evaluate('moyenne marché', allSamples, sample => sample.markets.marketAverage ?? null),
  ];
  const globalRoi = evaluateRoi(allSamples, globalCalibrated);

  // Courbe de fiabilité du modèle calibré (probabilité annoncée contre
  // fréquence observée, tous championnats confondus).
  const reliabilitySamples: { p: number; hit: number }[] = [];
  for (const sample of allSamples) {
    const probs = globalCalibrated(sample);
    const pick = topOutcome(probs);
    const probability = pick === 0 ? probs.home : pick === 1 ? probs.draw : probs.away;
    reliabilitySamples.push({ p: probability, hit: pick === sample.outcome ? 1 : 0 });
  }
  const reliability = reliabilityCurve(
    reliabilitySamples.map(row => row.p),
    reliabilitySamples.map(row => row.hit)
  );

  console.log('');
  console.log('=== TOUS LES CHAMPIONNATS ===');
  printTable(globalReports);
  console.log(
    `  ROI calibré (seuil ${(VALUE_THRESHOLD * 100).toFixed(1)} pts) : ${
      globalRoi.roi === null
        ? 'aucun pari'
        : `${(globalRoi.roi * 100).toFixed(2)} % [${(globalRoi.low! * 100).toFixed(2)}, ${(globalRoi.high! * 100).toFixed(2)}] sur ${globalRoi.bets} paris`
    }`
  );
  console.log('');
  console.log('  Courbe de fiabilité du modèle calibré (annoncé → observé) :');
  for (const bin of reliability) {
    if (!bin.samples) continue;
    const flag = bin.observed > bin.predicted + 0.05 ? '  (sur-confiance)' : '';
    console.log(
      `    [${bin.min.toFixed(2)} ; ${bin.max.toFixed(2)}) : annoncé ${(bin.predicted * 100).toFixed(1)} % · observé ${(bin.observed * 100).toFixed(1)} % · n=${bin.samples}${flag}`
    );
  }

  mkdirSync('data', { recursive: true });
  writeFileSync(
    'data/backtest-report.json',
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        dataset: bundle.manifest,
        parameters: {
          simulationRuns: SIMULATION_RUNS,
          bootstrapIterations: BOOTSTRAP_ITERATIONS,
          valueThreshold: VALUE_THRESHOLD,
        },
        global: { reports: globalReports, roi: globalRoi, reliability },
        perLeague,
      },
      null,
      2
    ) + '\n',
    'utf-8'
  );
  console.log('');
  console.log('→ data/backtest-report.json');
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
