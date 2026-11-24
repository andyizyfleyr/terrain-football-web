/* ------------------------------------------------------------------ */
/* ABLATION DES MODULES DU MOTEUR                                      */
/* ------------------------------------------------------------------ */
/*
 * Mesure la contribution de chaque module du moteur quantitatif :
 * on rejoue le jeu de données complet en neutralisant un module à la
 * fois, puis on compare la log-loss hors échantillon avec la version
 * complète.
 *
 * Lecture d'un delta (mesuré sur le modèle PUR) :
 *   - delta POSITIF : le module améliore la prévision (log-loss plus
 *     basse sans lui) ;
 *   - delta NÉGATIF : le module DÉTRUIT de l'information (le modèle
 *     fait mieux sans lui) ;
 *   - p-value : significativité de l'écart apparié (test de Student
 *     apparié, approximation normale). Sous 0,05, l'écart est
 *     significatif.
 *
 * Les conclusions sont des PROPOSITIONS : ce script ne retire aucun
 * module. Une simplification ne peut être faite qu'avec l'accord
 * explicite du responsable du projet.
 *
 * La mesure porte sur le modèle PUR (avant mélange avec le marché) :
 * sur cet échantillon, le poids du modèle ajusté vaut 0, si bien que
 * le modèle calibré est presque entièrement déterminé par le marché et
 * que la contribution des modules y serait indétectable. La colonne
 * « calibré » est publiée à titre indicatif.
 *
 * Exécution : npm run check:ablation
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { loadFootballData } from '../app/lib/backtestDatasetFootballData.ts';
import { replayLeague, walkForwardCalibration } from '../app/lib/backtestReplay.ts';
import type { BacktestSample } from '../app/lib/backtest.ts';
import type { OutcomeProbs } from '../app/lib/calibration.ts';
import { logLossOf, pairedDifference } from '../app/lib/backtestMetrics.ts';

const SIMULATION_RUNS = Number(process.env.ABLATION_SIMULATION_RUNS || 200);

type ModuleInfo = {
  id: string;
  name: string;
  /** Rôle du module dans le moteur. */
  role: string;
};

const MODULES: ModuleInfo[] = [
  { id: '01', name: 'ρ, covariance, periods', role: 'Dépendance entre les buts, situations partagées, répartition par période' },
  { id: '02', name: 'référence championnat', role: 'Moyennes de championnat, avantage domicile, force relative des équipes' },
  { id: '03', name: 'finition, gardiens, tirs', role: 'Surperformance de finition, qualité du gardien adverse, qualité des tirs' },
  { id: '04', name: 'absences et onze', role: 'Impact des absents sur la contribution réelle, force du onze titulaire' },
  { id: '05', name: 'confrontation tactique', role: 'Tempo, ajustements de forces selon les profils de jeu' },
  { id: '06', name: 'calibration marché', role: 'Température, mélange avec le marché dé-viggué, détection de valeur' },
  { id: '07', name: 'calendrier, surface, météo', role: 'Fatigue, enjeux, séries, surface, arbitre, météo' },
  { id: '08', name: 'simulation Monte-Carlo', role: 'Pronostics dérivés (mi-temps, premier but, etc.) — sans effet sur le 1X2' },
];

/** Log-loss par échantillon d'un prédicteur donné. */
function logLosses(samples: BacktestSample[], predictor: (sample: BacktestSample) => OutcomeProbs | null): number[] {
  const values: number[] = [];
  for (const sample of samples) {
    const probs = predictor(sample);
    if (!probs) continue;
    values.push(logLossOf(probs, sample.outcome));
  }
  return values;
}

function mean(values: number[]): number {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

async function main(): Promise<void> {
  console.log('Chargement du jeu de données football-data.co.uk…');
  const bundle = loadFootballData();

  console.log('Rejeu de référence (tous modules)…');
  const baselineSamples: BacktestSample[] = [];
  for (const dataset of Array.from(bundle.byLeague.values())) {
    baselineSamples.push(...replayLeague(dataset, { simulationRuns: SIMULATION_RUNS }));
  }
  const baselinePredictor = walkForwardCalibration(baselineSamples);
  const baseline = logLosses(baselineSamples, baselinePredictor);
  // Le modèle PUR est également mesuré : la calibration mélange le
  // modèle avec le marché dé-viggué et, sur cet échantillon, le poids
  // du modèle ajusté est nul — le modèle calibré est donc presque
  // entièrement déterminé par le marché. Mesurer la contribution des
  // modules sur le seul modèle calibré ne détecterait rien, alors que
  // la contribution réelle d'un module se lit dans le modèle pur.
  const baselinePure = logLosses(baselineSamples, sample => sample.model);
  console.log(
    `  ${baselineSamples.length} rencontres · calibré ${mean(baseline).toFixed(4)} · pur ${mean(baselinePure).toFixed(4)}`
  );

  const rows: Record<string, unknown>[] = [];
  console.log('');
  console.log(
    'module'.padEnd(26) +
      'pur'.padEnd(10) +
      'delta pur'.padEnd(12) +
      'p-value'.padEnd(10) +
      'calibré'.padEnd(10) +
      'verdict'
  );
  console.log('-'.repeat(92));

  for (const module of MODULES) {
    const started = Date.now();
    const samples: BacktestSample[] = [];
    for (const dataset of Array.from(bundle.byLeague.values())) {
      samples.push(
        ...replayLeague(dataset, { simulationRuns: SIMULATION_RUNS, ablate: [module.id] })
      );
    }
    const predictor = walkForwardCalibration(samples);
    const values = logLosses(samples, predictor);
    const pure = logLosses(samples, sample => sample.model);
    const comparison = pairedDifference(pure, baselinePure);
    const delta = comparison.mean;
    const calibratedComparison = pairedDifference(values, baseline);
    const calibratedDelta = calibratedComparison.mean;

    let verdict: string;
    if (module.id === '08') {
      verdict = 'sans effet sur le 1X2 (pronostics dérivés uniquement)';
    } else if (comparison.pValue > 0.05) {
      verdict = delta > 0
        ? 'contribution positive mais NON significative'
        : 'contribution NULLE (écart non significatif)';
    } else {
      verdict = delta > 0
        ? `CONTRIBUTION SIGNIFICATIVE (+${delta.toFixed(4)})`
        : `DÉTRUIT DE L'INFORMATION (${delta.toFixed(4)})`;
    }

    console.log(
      module.name.padEnd(26) +
        mean(pure).toFixed(4).padEnd(10) +
        `${delta >= 0 ? '+' : ''}${delta.toFixed(4)}`.padEnd(12) +
        comparison.pValue.toFixed(4).padEnd(10) +
        mean(values).toFixed(4).padEnd(10) +
        verdict
    );
    rows.push({
      module: module.id,
      nom: module.name,
      role: module.role,
      logLossPur: Number(mean(pure).toFixed(4)),
      deltaPur: Number(delta.toFixed(4)),
      pValuePur: comparison.pValue,
      zPur: comparison.z,
      logLossCalibre: Number(mean(values).toFixed(4)),
      deltaCalibre: Number(calibratedDelta.toFixed(4)),
      pValueCalibre: calibratedComparison.pValue,
      samples: comparison.samples,
      verdict,
      dureeMs: Date.now() - started,
    });
  }

  // Le marché sert de référence externe : un module qui « améliore » le
  // modèle au point de battre le marché est noteworthy.
  const marketValues: number[] = [];
  for (const sample of baselineSamples) {
    const market = sample.markets.bet365;
    if (!market) continue;
    marketValues.push(logLossOf(market, sample.outcome));
  }
  console.log('');
  console.log(`Référence marché (Bet365 dé-viggué) : log-loss ${mean(marketValues).toFixed(4)}`);
  console.log(`Modèle complet                      : log-loss ${mean(baseline).toFixed(4)}`);

  mkdirSync('data', { recursive: true });
  writeFileSync(
    'data/ablation-report.json',
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        dataset: bundle.manifest,
        baseline: {
          logLossCalibre: Number(mean(baseline).toFixed(4)),
          logLossPur: Number(mean(baselinePure).toFixed(4)),
          samples: baseline.length,
        },
        marketLogLoss: Number(mean(marketValues).toFixed(4)),
        modules: rows,
        note: 'Aucune suppression n’est effectuée par ce script : les conclusions sont des propositions.',
      },
      null,
      2
    ) + '\n',
    'utf-8'
  );
  console.log('');
  console.log('→ data/ablation-report.json');
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
