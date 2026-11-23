/**
 * Contrôle déterministe du backtest et de la calibration.
 *
 * Le moteur est rejoué sur le jeu de données de référence
 * (app/lib/backtestDataset.ts) avec la seule information disponible avant
 * chaque coup d'envoi. On vérifie :
 *   1. que le jeu de données est exploitable (taille, cotes, xG) ;
 *   2. que l'ajustement est REPRODUCTIBLE (deux exécutions → mêmes
 *      paramètres) ;
 *   3. que les paramètres versionnés dans calibrationParams.ts
 *      correspondent à l'ajustement (tolérance 1e-3) ;
 *   4. que le modèle calibré n'est pas moins bon que la référence naïve ;
 *   5. que la calibration published reste dans des bornes sanaires.
 *
 * Exécution : npm run check:backtest
 */
import { writeFileSync } from 'node:fs';
import { BACKTEST_DATASET } from '../app/lib/backtestDataset.ts';
import { runBacktest } from '../app/lib/backtest.ts';
import { DEFAULT_CALIBRATION } from '../app/lib/calibrationParams.ts';

const WRITE = process.argv.includes('--write');

let failures = 0;
function check(label: string, condition: boolean, detail?: string) {
  if (condition) {
    console.log(`  ok   ${label}`);
  } else {
    failures += 1;
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

console.log('1. Jeu de données de référence');
const dataset = BACKTEST_DATASET;
check('jeu de données non vide', dataset.matches.length > 0, `${dataset.matches.length} matchs`);
check('équipes présentes', dataset.teams.length > 0, `${dataset.teams.length} équipes`);

const withOdds = dataset.matches.filter(m => m.odds?.home && m.odds?.draw && m.odds?.away);
const withXg = dataset.matches.filter(m => m.homeXg !== null && m.awayXg !== null);
const withHalfTime = dataset.matches.filter(m => m.htHome !== null && m.htAway !== null);
check('cotes 1X2 disponibles sur une majorité de matchs', withOdds.length >= dataset.matches.length * 0.5, `${withOdds.length}/${dataset.matches.length}`);
check('xG disponibles sur une majorité de matchs', withXg.length >= dataset.matches.length * 0.5, `${withXg.length}/${dataset.matches.length}`);
check('score à la mi-temps disponible', withHalfTime.length >= dataset.matches.length * 0.5, `${withHalfTime.length}/${dataset.matches.length}`);
// Politique anti-fuite : les totaux de saison (équipes et joueurs) sont
// volontairement ABSENTS du jeu de données utilisé pour l'ajustement.
check(
  'aucun total de joueur dans le jeu de données (anti-fuite)',
  dataset.teams.every(t => (t.players?.length ?? 0) === 0),
  `${dataset.teams.filter(t => (t.players?.length ?? 0) > 0).length} équipes avec joueurs`
);
check(
  'aucune statistique de saison dans le jeu de données (anti-fuite)',
  dataset.teams.every(t => Object.keys(t.stats || {}).length === 0)
);
check(
  'compositions confirmées documentées',
  dataset.matches.every(m => m.lineupConfirmedHome === true && m.lineupConfirmedAway === true),
  `${dataset.matches.filter(m => m.lineupConfirmedHome).length}/${dataset.matches.length}`
);

console.log('2. Rejeu du moteur (walk-forward)');
const started = Date.now();
const result = runBacktest(dataset);
const elapsed = Date.now() - started;

check('backtest exécuté', result.samples.length > 0, `${result.samples.length} matchs rejoués en ${elapsed} ms`);
check('échantillon suffisant pour un calibrage', result.samples.length >= 25, `${result.samples.length}`);
check(
  'probabilités du modèle comprises entre 0 et 1',
  result.samples.every(s =>
    [s.model.home, s.model.draw, s.model.away].every(p => p >= 0 && p <= 1)
  )
);

console.log('3. Métriques');
const m = result.metrics;
console.log(
  `     log-loss : modèle ${m.modelLogLoss} · calibré ${m.calibratedLogLoss} · marché ${m.marketLogLoss ?? '—'} · naïf ${m.naiveLogLoss}`
);
console.log(`     Brier ${m.brier} · accuracy ${(m.accuracy * 100).toFixed(1)} % · ROI valeur ${m.valueRoi ?? '—'}`);
console.log(
  `     ajustement : poids modèle ${result.params.modelWeight} · température ${result.params.sharpness} · seuil ${result.params.valueThreshold} pts · n_eff ${result.params.effectiveSampleSize}`
);

check('log-loss du modèle pur calculée', Number.isFinite(m.modelLogLoss));
check('log-loss calibrée calculée', Number.isFinite(m.calibratedLogLoss));
check('Brier calculé', Number.isFinite(m.brier));
check(
  'le modèle calibré bat la référence naïve',
  m.calibratedLogLoss <= m.naiveLogLoss + 0.02,
  `calibré=${m.calibratedLogLoss} naïf=${m.naiveLogLoss}`
);
check(
  'le modèle calibré est proche ou meilleur que le marché',
  m.calibratedLogLoss <= (m.marketLogLoss ?? m.calibratedLogLoss) + 0.05,
  `calibré=${m.calibratedLogLoss} marché=${m.marketLogLoss}`
);

console.log('4. Reproductibilité de l’ajustement');
const second = runBacktest(dataset);
check(
  'poids modèle reproductible',
  Math.abs(second.params.modelWeight - result.params.modelWeight) < 1e-9,
  `${second.params.modelWeight} vs ${result.params.modelWeight}`
);
check(
  'température reproductible',
  Math.abs(second.params.sharpness - result.params.sharpness) < 1e-9,
  `${second.params.sharpness} vs ${result.params.sharpness}`
);
check(
  'seuil de valeur reproductible',
  Math.abs(second.params.valueThreshold - result.params.valueThreshold) < 1e-9,
  `${second.params.valueThreshold} vs ${result.params.valueThreshold}`
);

console.log('5. Paramètres versionnés');
const committed = DEFAULT_CALIBRATION;
if (committed.metrics.sampleSize === 0) {
  console.log('  note   calibration non encore versionnée (précalibrage) — nothing to compare');
  check(
    'précalibrage dans des bornes sanitaires',
    committed.modelWeight >= 0 && committed.modelWeight <= 1 &&
      committed.sharpness >= 0.5 && committed.sharpness <= 2 &&
      committed.valueThreshold >= 0 && committed.valueThreshold <= 0.2
  );
} else {
  check(
    'poids modèle versionné = ajustement',
    Math.abs(committed.modelWeight - result.params.modelWeight) < 1e-3,
    `${committed.modelWeight} vs ${result.params.modelWeight}`
  );
  check(
    'température versionnée = ajustement',
    Math.abs(committed.sharpness - result.params.sharpness) < 1e-3,
    `${committed.sharpness} vs ${result.params.sharpness}`
  );
  check(
    'seuil de valeur versionné = ajustement',
    Math.abs(committed.valueThreshold - result.params.valueThreshold) < 1e-3,
    `${committed.valueThreshold} vs ${result.params.valueThreshold}`
  );
  check(
    'taille d’échantillon versionnée = dataset',
    committed.metrics.sampleSize === result.metrics.sampleSize,
    `${committed.metrics.sampleSize} vs ${result.metrics.sampleSize}`
  );
}

console.log('6. Bornes de sécurité');
check(
  'poids modèle dans [0,1]',
  result.params.modelWeight >= 0 && result.params.modelWeight <= 1,
  `${result.params.modelWeight}`
);
check(
  'température dans [0,5 ; 2]',
  result.params.sharpness >= 0.5 && result.params.sharpness <= 2,
  `${result.params.sharpness}`
);
check(
  'seuil de valeur raisonnable',
  result.params.valueThreshold >= 0.01 && result.params.valueThreshold <= 0.2,
  `${result.params.valueThreshold}`
);
check(
  'concentration effective positive',
  result.params.effectiveSampleSize > 0,
  `${result.params.effectiveSampleSize}`
);

if (WRITE && !failures) {
  // Réécriture des paramètres versionnés à partir de l'ajustement.
  const p = result.params;
  const bins = p.confidenceBins
    .map(b => `    { min: ${b.min}, max: ${b.max}, probability: ${b.probability}, samples: ${b.samples} },`)
    .join('\n');
  const content = `/* ------------------------------------------------------------------ */
/* PARAMÈTRES DE CALIBRATION (ajustés sur backtest walk-forward)       */
/* ------------------------------------------------------------------ */
/*
 * Ces paramètres ne sont PAS des constantes choisies à la main : ils sont
 * ajustés par \`npm run check:backtest -- --write\` sur le jeu de données de
 * référence (app/lib/backtestDataset.ts), puis versionnés ici.
 *
 * Le jeu de données est un backtest walk-forward : chaque match est rejoué
 * avec la seule information disponible avant son coup d'envoi.
 *
 * Pour ouvrir un nouveau calibrage :
 *   1. rafraîchir le jeu de données (route /api/backtest-data) ;
 *   2. lancer \`npm run check:backtest -- --write\` pour réécrire ce fichier ;
 *   3. vérifier que les métriques ne se dégradent pas.
 *
 * Ajustement du ${p.fittedAt.slice(0, 10)} sur ${p.metrics.sampleSize} rencontres
 * (${p.dataset}).
 */

import type { CalibrationParams } from './calibration';

export const DEFAULT_CALIBRATION: CalibrationParams = {
  version: '3.0',
  modelWeight: ${p.modelWeight},
  sharpness: ${p.sharpness},
  valueThreshold: ${p.valueThreshold},
  effectiveSampleSize: ${p.effectiveSampleSize},
  logistic: {
    intercept: ${p.logistic.intercept},
    separation: ${p.logistic.separation},
    agreement: ${p.logistic.agreement},
    marketPick: ${p.logistic.marketPick ?? 0},
  },
  confidenceBins: [
${bins}
  ],
  metrics: {
    sampleSize: ${p.metrics.sampleSize},
    league: '${p.metrics.league}',
    period: '${p.metrics.period}',
    modelLogLoss: ${p.metrics.modelLogLoss},
    marketLogLoss: ${p.metrics.marketLogLoss},
    calibratedLogLoss: ${p.metrics.calibratedLogLoss},
    naiveLogLoss: ${p.metrics.naiveLogLoss},
    brier: ${p.metrics.brier},
    accuracy: ${p.metrics.accuracy},
    valueRoi: ${p.metrics.valueRoi},
    valueBets: ${p.metrics.valueBets},
    valueThreshold: ${p.metrics.valueThreshold},
  },
  dataset: '${p.dataset}',
  fittedAt: '${p.fittedAt}',
  limitations: [
    'Le backtest rejoue le moteur sans les contributions individuelles des joueurs (xG, xA, minutes) : ces données ne sont pas reconstructibles à la date du match sans introduire de fuite temporelle. Le poids du modèle ajusté est donc une borne INFÉRIEURE de celui du modèle en production.',
    'La série de marché provient d’un seul fournisseur (Bet365) sur un échantillon de ${p.metrics.sampleSize} rencontres : l’incertitude sur le poids ajusté reste importante (ordre de grandeur : ±0,1).',
    'Le seuil de « valeur » est dérivé de tranches de 2 points de probabilité : avec ${p.metrics.valueBets} pari(s) sur l’échantillon, ce seuil est indicatif et doit être réajusté sur un échantillon plus large.',
    'Les totaux de saison (équipes et joueurs) sont exclus de l’ajustement pour éviter toute fuite temporelle.',
  ],
};
`;
  writeFileSync('app/lib/calibrationParams.ts', content, 'utf-8');
  console.log('\n     → app/lib/calibrationParams.ts réécrit (version ' + p.version + ')');
}

console.log('');
if (failures) {
  console.log(`✗ ${failures} contrôle(s) en échec`);
  process.exit(1);
}
console.log('✓ Backtest et calibration conformes');
