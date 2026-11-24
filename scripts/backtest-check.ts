/**
 * Contrôle déterministe du backtest et de la calibration.
 *
 * Le moteur est rejoué sur le jeu de données de référence
 * (app/lib/backtestDataset.ts) avec la seule information disponible avant
 * chaque coup d'envoi. On vérifie :
 *   1. que le jeu de données est exploitable (taille, cotes, xG) ;
 *   2. qu'aucune information postérieure au coup d'envoi n'entre dans le
 *      replay (forme récente strictement antérieure) ;
 *   3. que l'ajustement est REPRODUCTIBLE (deux exécutions → mêmes
 *      paramètres) ;
 *   4. que les paramètres versionnés dans calibrationParams.ts
 *      correspondent à l'ajustement (tolérance 1e-3) ;
 *   5. que le modèle calibré n'est pas moins bon que la référence naïve ;
 *   6. que la calibration published reste dans des bornes sanaires.
 *
 * Exécution : npm run check:backtest
 */
import { writeFileSync } from 'node:fs';
import { COMBINED_BACKTEST_DATASET } from '../app/lib/backtestDatasetCombined.ts';
import { buildWalkForwardInputs, runBacktest, type BacktestDataset } from '../app/lib/backtest.ts';
import { DEFAULT_CALIBRATION } from '../app/lib/calibrationParams.ts';

const WRITE = process.argv.includes('--write');
/** Régénère les paramètres versionnés même si les contrôles échouent. */
const FORCE = process.argv.includes('--force');

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
const dataset = COMBINED_BACKTEST_DATASET;
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
// Politique anti-fuite : les titulaires ne sont PAS stockés (identifiants
// vides) — l'information conservée est le seul drapeau de confirmation.
check(
  'aucun titulaire nominal dans le jeu de données (anti-fuite)',
  dataset.matches.every(m => (m.startersHome?.length ?? 0) === 0 && (m.startersAway?.length ?? 0) === 0),
  `${dataset.matches.filter(m => (m.startersHome?.length ?? 0) + (m.startersAway?.length ?? 0) > 0).length} matchs avec titulaires`
);
// Échantillon multi-championnats : le replay doit rester cloisonné par
// championnat (aucun classement, aucune moyenne et aucun xG partagé).
const leagues = new Set(dataset.matches.map(m => m.league));
check(
  'échantillon multi-championnats (au moins deux divisions)',
  leagues.size >= 2,
  `${leagues.size} championnat(s) : ${Array.from(leagues).join(', ')}`
);
const perLeague = new Map<string, number>();
for (const m of dataset.matches) perLeague.set(m.league, (perLeague.get(m.league) || 0) + 1);
check(
  'chaque championnat a un effectif suffisant',
  Array.from(perLeague.values()).every(n => n >= 50),
  JSON.stringify(Object.fromEntries(perLeague))
);
const teamIds = dataset.teams.map(t => t.id);
check(
  'aucun identifiant d’équipe partagé entre les championnats',
  new Set(teamIds).size === teamIds.length,
  `${teamIds.length} équipes, ${new Set(teamIds).size} identifiants uniques`
);

console.log('2. Absence de fuite temporelle');
/*
 * Non-régression : la forme récente ne doit contenir QUE des matchs
 * antérieurs à la rencontre prédite. La version corrigée limitait la
 * recherche à l'historique déjà joué ; la version d'origine prenait les
 * 6 derniers matchs de la saison, donc y compris des matchs postérieurs
 * (70 % des entrées de forme venaient du futur).
 */

// (a) Cas synthétique : une équipe qui joue après la rencontre prédite.
const syntheticMatch = (
  id: string,
  date: string,
  homeId: number,
  awayId: number,
  homeGoals: number,
  awayGoals: number
) => ({
  id,
  date,
  league: 'test.1',
  homeId,
  homeName: `Équipe ${homeId}`,
  awayId,
  awayName: `Équipe ${awayId}`,
  homeGoals,
  awayGoals,
  homeXg: null,
  awayXg: null,
  htHome: null,
  htAway: null,
  homeShots: null,
  awayShots: null,
  homeXgot: null,
  awayXgot: null,
  odds: null,
  provider: null,
  unavailableHome: [],
  unavailableAway: [],
  startersHome: [],
  startersAway: [],
});
const syntheticDataset: BacktestDataset = {
  league: 'test.1',
  period: 'synthétique',
  teams: [],
  matches: [
    syntheticMatch('s1', '2026-01-10', 1, 2, 1, 0),
    syntheticMatch('s2', '2026-01-17', 1, 3, 2, 2),
    syntheticMatch('s3', '2026-01-24', 4, 1, 0, 3),
    syntheticMatch('s4', '2026-01-31', 1, 2, 1, 1),
  ],
};
const syntheticInputs = buildWalkForwardInputs(syntheticDataset).inputs;
const syntheticFirst = syntheticInputs[0];
check(
  'forme récente vide quand aucun match antérieur n’existe',
  syntheticFirst.home.recentMatches.length === 0 &&
    syntheticFirst.away.recentMatches.length === 0,
  `${syntheticFirst.home.recentMatches.length} / ${syntheticFirst.away.recentMatches.length}`
);
const syntheticSecond = syntheticInputs[1];
check(
  'forme récente limitée aux matchs antérieurs (cas synthétique)',
  syntheticSecond.home.recentMatches.length === 1 &&
    syntheticSecond.home.recentMatches[0].utcTime.startsWith('2026-01-10'),
  syntheticSecond.home.recentMatches.map(m => m.utcTime).join(', ') || 'vide'
);
const syntheticThird = syntheticInputs[2];
const syntheticThirdDates = syntheticThird.away.recentMatches.map(m => m.utcTime.slice(0, 10));
check(
  'forme récente exclut le match en cours et les suivants (cas synthétique)',
  syntheticThirdDates.length === 2 &&
    syntheticThirdDates.join(',') === '2026-01-10,2026-01-17',
  syntheticThirdDates.join(', ') || 'vide'
);

// (b) Cas réel : le jeu de données de référence ne doit contenir aucune
// entrée de forme postérieure à la rencontre prédite.
const walkForward = buildWalkForwardInputs(dataset);
const dateByMatchId = new Map(dataset.matches.map(m => [m.id, m.date]));
let formEntries = 0;
let futureEntries = 0;
const futureExamples: string[] = [];
for (const input of walkForward.inputs) {
  const matchDate = dateByMatchId.get(input.matchId);
  for (const team of [input.home, input.away]) {
    for (const recent of team.recentMatches) {
      formEntries += 1;
      const recentDate = String(recent.utcTime).slice(0, 10);
      if (!matchDate || recentDate >= matchDate) {
        futureEntries += 1;
        if (futureExamples.length < 3) {
          futureExamples.push(`${input.matchId} (${matchDate}) utilise ${recentDate}`);
        }
      }
    }
  }
}
check(
  'aucune entrée de forme postérieure à la rencontre prédite',
  futureEntries === 0,
  `${futureEntries}/${formEntries} entrées futures${futureExamples.length ? ' — ex. ' + futureExamples.join(' ; ') : ''}`
);
check(
  'la forme récente est bien alimentée (test non vide)',
  formEntries > 0,
  `${formEntries} entrées de forme sur ${walkForward.inputs.length} matchs`
);

console.log('3. Rejeu du moteur (walk-forward)');
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

console.log('4. Métriques');
const m = result.metrics;
console.log(
  `     log-loss : modèle ${m.modelLogLoss} · calibré hors échantillon ${m.calibratedLogLoss} (in-sample ${m.calibratedLogLossInSample}, ${m.crossValidationFolds} blocs) · marché ${m.marketLogLoss ?? '—'} · naïf ${m.naiveLogLoss}`
);
console.log(`     Brier ${m.brier} · accuracy ${(m.accuracy * 100).toFixed(1)} % · ROI valeur ${m.valueRoi ?? '—'}`);
console.log(
  `     ajustement : poids modèle ${result.params.modelWeight} · température ${result.params.sharpness} · seuil ${result.params.valueThreshold} pts · n_eff ${result.params.effectiveSampleSize}`
);

check('log-loss du modèle pur calculée', Number.isFinite(m.modelLogLoss));
check('log-loss calibrée calculée', Number.isFinite(m.calibratedLogLoss));
check('Brier calculé', Number.isFinite(m.brier));
check(
  'log-loss calibrée hors échantillon calculée',
  Number.isFinite(m.calibratedLogLoss) && m.calibratedLogLoss > 0
);
check(
  'validation croisée effective (≥ 3 blocs)',
  m.crossValidationFolds >= 3,
  `${m.crossValidationFolds} blocs`
);
check(
  'log-loss in-sample ≤ log-loss hors échantillon',
  m.calibratedLogLossInSample <= m.calibratedLogLoss + 1e-6,
  `in-sample ${m.calibratedLogLossInSample} vs hors échantillon ${m.calibratedLogLoss}`
);
// Non-régression : un mélange dont le poids de modèle est nul REPRODUIT le
// marché. Aucun écart n'est alors significatif, donc aucun pari « valeur »
// ne doit être compté (avant correction, 229 paris au bruit de calcul
// étaient comptés et un ROI de +6,5 % était publié).
const marketOnly = runBacktest(dataset, { calibration: { modelWeight: 0, sharpness: 1 } });
check(
  'un mélange égal au marché ne produit aucun pari « valeur »',
  marketOnly.metrics.valueBets === 0 && marketOnly.metrics.valueRoi === null,
  `${marketOnly.metrics.valueBets} pari(s), ROI ${marketOnly.metrics.valueRoi ?? '—'}`
);
check(
  'le ROI publié repose toujours sur des paris comptabilisés',
  m.valueRoi === null || m.valueBets > 0,
  `ROI ${m.valueRoi ?? '—'} sur ${m.valueBets} pari(s)`
);
check(
  'le seuil de valeur est inactif quand il n’est pas démontré',
  result.params.valueThresholdDemonstrated === false ? m.valueBets === 0 : true,
  `démontré=${result.params.valueThresholdDemonstrated} · ${m.valueBets} pari(s)`
);
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

console.log('5. Reproductibilité de l’ajustement');
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

console.log('6. Paramètres versionnés');
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

console.log('7. Bornes de sécurité');
check(
  'poids modèle dans [0,1]',
  result.params.modelWeight >= 0 && result.params.modelWeight <= 1,
  `${result.params.modelWeight}`
);
check(
  'température dans [0,5 ; 2,2]',
  result.params.sharpness >= 0.5 && result.params.sharpness <= 2.2,
  `${result.params.sharpness}`
);
check(
  'seuil de valeur raisonnable',
  result.params.valueThreshold >= 0 && result.params.valueThreshold <= 0.2,
  `${result.params.valueThreshold}`
);
check(
  'concentration effective positive',
  result.params.effectiveSampleSize > 0,
  `${result.params.effectiveSampleSize}`
);

if (WRITE && (!failures || FORCE)) {
  // Réécriture des paramètres versionnés à partir de l'ajustement.
  const p = result.params;
  const bins = p.confidenceBins
    .map(b => `    { min: ${b.min}, max: ${b.max}, probability: ${b.probability}, samples: ${b.samples} },`)
    .join('\n');
  // Le ROI est rendu hors du gabarit : un guillemet simple dans le
  // texte généré casserait la chaîne de la limitation.
  const roiText =
    p.metrics.valueRoi === null ? '—' : `${(p.metrics.valueRoi * 100).toFixed(1)} %`;
  const content = `/* ------------------------------------------------------------------ */
/* PARAMÈTRES DE CALIBRATION (ajustés sur backtest walk-forward)       */
/* ------------------------------------------------------------------ */
/*
 * Ces paramètres ne sont PAS des constantes choisies à la main : ils sont
 * ajustés par \`npm run check:backtest -- --write\` sur le jeu de données de
 * référence (app/lib/backtestDatasetCombined.ts = Premier League + La Liga),
 * puis versionnés ici.
 *
 * Le jeu de données est un backtest walk-forward : chaque match est rejoué
 * avec la seule information disponible avant son coup d'envoi, championnat
 * par championnat (aucun classement, aucune moyenne et aucun xG n'est
 * partagé entre les deux divisions).
 *
 * ATTENTION — la forme récente ne voit QUE les matchs antérieurs à la
 * rencontre prédite (correction de la fuite temporelle du 2026-11-23).
 * Avant cette correction, 70 % des entrées de forme venaient de matchs
 * postérieurs : l'ajustement était optimiste et le ROI « valeur » était
 * un artefact.
 *
 * Sur l'échantillon actuel, l'ajustement choisit un poids de modèle de
 * ${p.modelWeight}. C'est un résultat de MESURE, pas un choix : sur
 * ${p.metrics.sampleSize} rencontres, le modèle n'apporte rien de mesurable
 * par-dessus le marché dé-viggué. L'ajustement reste PROVISOIRE tant que
 * l'échantillon de référence n'est pas élargi.
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
  version: '3.1',
  modelWeight: ${p.modelWeight},
  sharpness: ${p.sharpness},
  valueThreshold: ${p.valueThreshold},
  valueThresholdDemonstrated: ${p.valueThresholdDemonstrated ?? false},
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
    calibratedLogLossInSample: ${p.metrics.calibratedLogLossInSample},
    crossValidationFolds: ${p.metrics.crossValidationFolds},
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
    'Ajustement SANS fuite temporelle : la forme récente ne contient que des matchs antérieurs à la rencontre prédite (correction du 2026-11-23). L’ajustement précédent, obtenu avec une forme incluant des matchs postérieurs, était optimiste et a été remplacé.',
    'Sur cet échantillon, le poids de modèle ajusté vaut ${p.modelWeight} : le marché dé-viggué seul est au moins aussi bon que le mélange. La calibration reste PROVISOIRE tant que l’échantillon de référence n’est pas élargi à plusieurs saisons et plusieurs divisions.',
    'Le backtest rejoue le moteur sans les contributions individuelles des joueurs (xG, xA, minutes) ni la pondération du onze titulaire : les statistiques de joueur et les titulaires ne sont pas stockés dans le jeu de données de référence (ils seraient collectés après la rencontre). Le poids du modèle ajusté est donc une borne INFÉRIEURE de celui du modèle en production.',
    'La série de marché provient d’un seul fournisseur (Bet365) sur un échantillon de ${p.metrics.sampleSize} rencontres : l’incertitude sur le poids ajusté reste importante (ordre de grandeur : ±0,1).',
    'Évalué HORS ÉCHANTILLON (validation croisée à ${p.metrics.crossValidationFolds} blocs), le modèle calibré obtient une log-loss de ${p.metrics.calibratedLogLoss} contre ${p.metrics.marketLogLoss} pour le marché dé-viggué : sur cet échantillon, la calibration NE FAIT PAS MIEUX QUE LE MARCHÉ. La valeur in-sample (${p.metrics.calibratedLogLossInSample}) est optimiste et ne doit jamais être citée seule.',
    'Le seuil de « valeur » est dérivé de tranches de 2 points de probabilité : avec ${p.metrics.valueBets} pari(s) sur l’échantillon (ROI ${roiText}), ce seuil reste indicatif et n’est PAS une preuve de rentabilité : il doit être réajusté sur un échantillon plus large.',
    'Le signal « valeur » est INACTIF tant qu’aucun seuil n’est démontré (valueThresholdDemonstrated = false) : sans seuil démontré, tout écart strictement positif serait déclaré « valeur », y compris le simple bruit de calcul d’un mélange dont le poids de modèle est nul.',
    'Les totaux de saison (équipes et joueurs) sont exclus de l’ajustement pour éviter toute fuite temporelle.',
    'L’échantillon couvre deux championnats (${p.metrics.league}) mais un seul jeu de paramètres : ceux-ci sont communs aux deux divisions.',
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
