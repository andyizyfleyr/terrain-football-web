/**
 * Contrôle déterministe des modules de modélisation (v3).
 *
 * Ce script ne dépend d'aucun réseau : il vérifie les propriétés
 * mathématiques et les garde-fous des nouveaux modules :
 *   - Poisson bivarié (marges, covariance, effet sur la probabilité de nul)
 *   - estimation de la covariance, de la répartition par période
 *   - température et intervalles de crédibilité
 *   - qualité de tir (shotmap), contributions individuelles, absences
 *   - séries, profil d'arbitre, surface de jeu
 *   - calibration (mélange, confiance, seuil de valeur)
 *
 * Exécution : npm run check:model
 */
import {
  applySharpness,
  bivariatePmf,
  buildScoreMatrix,
  credibleInterval,
  estimateCovariance,
  estimateFirstHalfShare,
  poissonCdf,
  poissonOver,
  poissonPmf,
  summariseScoreMatrix,
} from '../app/lib/poissonModels.ts';
import {
  buildShotProfile,
  extractShots,
  mergeShotProfiles,
  shotQualityFactor,
} from '../app/lib/shotQuality.ts';
import {
  absenceImpactFromContributions,
  buildPlayerContributions,
} from '../app/lib/playerImpact.ts';
import { analyseSequences, extractPollFacts, sequenceAttackAdjustment } from '../app/lib/sequences.ts';
import { buildRefereeProfile } from '../app/lib/refereeProfile.ts';
import { buildPitchProfile } from '../app/lib/pitchProfile.ts';
import {
  readLeagueIdentity,
  readMatchLeagueSlug,
  resolveLeagueSlug,
} from '../app/lib/leagueIdentity.ts';
import {
  applyCalibration,
  blendProbabilities,
  calibratedConfidence,
  probabilityInterval,
  valueAssessment,
} from '../app/lib/calibration.ts';
import { DEFAULT_CALIBRATION } from '../app/lib/calibrationParams.ts';
import { runQuantitativeAnalyst, shrunkMean, shrunkRatio } from '../app/lib/analystEngine.ts';

let failures = 0;
function check(label: string, condition: boolean, detail?: string) {
  if (condition) {
    console.log(`  ok   ${label}`);
  } else {
    failures += 1;
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`);
  }
}
const close = (a: number, b: number, tol: number) => Math.abs(a - b) <= tol;

console.log('0. Poisson simple (PMF, CDF, survol)');
{
  const lambda = 1.45;
  check('P(X=0) = e^{−λ}', close(poissonPmf(0, lambda), Math.exp(-lambda), 1e-12));
  check(
    'P(X=1) = λ·e^{−λ}',
    close(poissonPmf(1, lambda), lambda * Math.exp(-lambda), 1e-12)
  );
  check(
    'P(X=2) = λ²/2·e^{−λ}',
    close(poissonPmf(2, lambda), (lambda * lambda * Math.exp(-lambda)) / 2, 1e-12)
  );

  // La masse doit sommer à 1 (le défaut historique inversait k!).
  let mass = 0;
  for (let k = 0; k <= 40; k++) mass += poissonPmf(k, lambda);
  check('somme de la masse = 1', close(mass, 1, 1e-10), `somme=${mass.toFixed(12)}`);

  // La moyenne de la distribution doit valoir λ.
  let mean = 0;
  for (let k = 0; k <= 40; k++) mean += k * poissonPmf(k, lambda);
  check('moyenne de la distribution = λ', close(mean, lambda, 1e-9), `moyenne=${mean.toFixed(9)}`);

  // La CDF et le survol doivent être cohérents.
  check('CDF(0) = P(X=0)', close(poissonCdf(0, lambda), poissonPmf(0, lambda), 1e-12));
  check(
    'survol = 1 − CDF',
    close(poissonOver(lambda, 2), 1 - poissonCdf(2, lambda), 1e-12),
    `survol=${poissonOver(lambda, 2).toFixed(6)}`
  );
  check(
    'survol 2,5 buts cohérent avec λ=1,45',
    close(poissonOver(1.45, 2), 1 - (0.2346 + 0.3401 + 0.2466), 1e-3),
    `survol=${poissonOver(1.45, 2).toFixed(4)}`
  );
  check('PMF nulle pour k négatif', poissonPmf(-1, lambda) === 0);
  check('PMF dégénérée quand λ = 0', poissonPmf(0, 0) === 1 && poissonPmf(3, 0) === 0);
}

console.log('0bis. Rétrécissement empirique (shrinkage)');
{
  check(
    'moyenne rétrécie : sans donnée, référence conservée',
    close(shrunkMean([], 1.35, 4), 1.35, 1e-12)
  );
  check(
    'moyenne rétrécie : forte pondération ⇒ proche de la référence',
    close(shrunkMean([3, 3, 3], 1.35, 40), (9 + 1.35 * 40) / 43, 1e-12),
    `${shrunkMean([3, 3, 3], 1.35, 40).toFixed(6)}`
  );
  check(
    'moyenne rétrécie : sans pondération ⇒ moyenne brute',
    close(shrunkMean([1, 2, 3], 1.35, 0), 2, 1e-12)
  );
  check(
    'ratio rétréci : sans échantillon ⇒ 1',
    close(shrunkRatio(2, 1.3, 0, 4), 1, 1e-12)
  );
  check(
    'ratio rétréci : fortement amorti sur petit échantillon',
    shrunkRatio(3, 1.3, 1, 4) < 1.6,
    `${shrunkRatio(3, 1.3, 1, 4).toFixed(3)}`
  );
  check(
    'ratio rétréci : peu amorti sur grand échantillon',
    shrunkRatio(3, 1.3, 60, 4) > 2.0,
    `${shrunkRatio(3, 1.3, 60, 4).toFixed(3)}`
  );
  check('ratio rétréci : borné', shrunkRatio(99, 1, 100, 4) <= 2.6);
}

console.log('1. Poisson bivarié & covariance');
{
  const muH = 1.5;
  const muA = 1.1;

  // La somme des probabilités jointes vaut 1.
  let total = 0;
  for (let h = 0; h <= 14; h++) for (let a = 0; a <= 14; a++) total += bivariatePmf(h, a, muH, muA, 0.04);
  check('somme des masses = 1', close(total, 1, 1e-9), `somme=${total.toFixed(12)}`);

  // λ₃ = 0 doit reproduire le Poisson indépendant.
  let independent = 0;
  for (let h = 0; h <= 14; h++) for (let a = 0; a <= 14; a++) independent += bivariatePmf(h, a, muH, muA, 0);
  check('λ₃ = 0 ⇒ Poisson indépendant', close(independent, 1, 1e-9), `somme=${independent.toFixed(12)}`);

  // Les marges sont conservées : λ₃ est financée sur les deux équipes.
  let meanHome = 0;
  let meanAway = 0;
  for (let h = 0; h <= 14; h++) for (let a = 0; a <= 14; a++) {
    const p = bivariatePmf(h, a, muH, muA, 0.06);
    meanHome += p * h;
    meanAway += p * a;
  }
  check(
    'marges conservées malgré la covariance',
    close(meanHome, muH, 5e-3) && close(meanAway, muA, 5e-3),
    `E[X]=${meanHome.toFixed(4)} E[Y]=${meanAway.toFixed(4)}`
  );

  const cell = bivariatePmf(1, 1, muH, muA, 0);
  check(
    'λ₃ = 0 ⇒ cellule (1,1) = Poi(h)·Poi(a)',
    close(cell, poissonPmf(1, muH) * poissonPmf(1, muA), 1e-12)
  );

  // La covariance augmente la probabilité de nul (correction attendue).
  const noCov = summariseScoreMatrix(buildScoreMatrix({ lambdaHome: muH, lambdaAway: muA, covariance: 0, rho: 0 }), 0.44);
  const withCov = summariseScoreMatrix(buildScoreMatrix({ lambdaHome: muH, lambdaAway: muA, covariance: 0.06, rho: 0 }), 0.44);
  check(
    'la covariance augmente la probabilité de nul',
    withCov.draw > noCov.draw + 0.005,
    `sans=${noCov.draw.toFixed(4)} avec=${withCov.draw.toFixed(4)}`
  );

  // La matrice est normalisée.
  const matrix = buildScoreMatrix({ lambdaHome: 1.8, lambdaAway: 0.9, covariance: 0.05, rho: -0.06 });
  const matrixSum = matrix.flat().reduce((a, b) => a + b, 0);
  check('matrice de scores normalisée', close(matrixSum, 1, 1e-12), `somme=${matrixSum.toFixed(12)}`);

  // Les issues de la matrice somment à 1.
  const summary = summariseScoreMatrix(matrix, 0.44);
  check(
    'issues 1X2 somment à 1',
    close(summary.home + summary.draw + summary.away, 1, 1e-12),
    `somme=${(summary.home + summary.draw + summary.away).toFixed(12)}`
  );

  // Estimation de la covariance sur un panel synthétique.
  const samples = Array.from({ length: 200 }, (_, i) => ({
    homeGoals: i % 4 === 0 ? 0 : i % 3 === 0 ? 1 : 2,
    awayGoals: i % 4 === 0 ? 0 : i % 5 === 0 ? 1 : 2,
  }));
  const cov = estimateCovariance(samples, 1.4, 1.1);
  check('covariance estimée dans la plage', cov.covariance >= 0 && cov.covariance <= 0.08, `λ₃=${cov.covariance}`);
  check('covariance : échantillon suffisant', cov.samples === 200, `n=${cov.samples}`);
  const tooSmall = estimateCovariance(samples.slice(0, 5), 1.4, 1.1);
  check('covariance refusée sous 12 matchs', tooSmall.covariance === 0 && tooSmall.samples === 5);
}

console.log('2. Répartition des buts par période');
{
  const samples = Array.from({ length: 40 }, () => ({
    htHome: 1,
    htAway: 0,
    homeGoals: 2,
    awayGoals: 1,
  }));
  const fit = estimateFirstHalfShare(samples);
  check('part 1re période estimée', fit.fitted && close(fit.share, 1 / 3, 1e-3), `part=${fit.share}`);
  const tooSmall = estimateFirstHalfShare(samples.slice(0, 5));
  check('repli sur 44 % si échantillon insuffisant', !tooSmall.fitted && tooSmall.share === 0.44);
}

console.log('3. Température & intervalles de crédibilité');
{
  const probs = [0.5, 0.3, 0.2];
  const sharpened = applySharpness(probs, 1.5);
  check('température > 1 accentue', sharpened[0] > probs[0], `${sharpened[0].toFixed(4)}`);
  const flattened = applySharpless(probs, 0.7);
  check('température < 1 tempère', flattened[0] < probs[0], `${flattened[0].toFixed(4)}`);
  check('température conserve la somme 1', close(sharpened.reduce((a, b) => a + b, 0), 1, 1e-12));
  const flat = applySharpness(probs, 0.5);
  check('température extremes bornées', applySharpness(probs, 9)[0] > flat[0]);

  const interval = credibleInterval(0.6, 100, 0.8);
  check('intervalle contient la probabilité', interval.low < 0.6 && interval.high > 0.6, JSON.stringify(interval));
  const wide = credibleInterval(0.6, 20, 0.8);
  check('intervalle plus large quand n_eff est faible', wide.high - wide.low > interval.high - interval.low);
  const tight = credibleInterval(0.98, 500, 0.8);
  check('intervalle borné dans [0,1]', tight.low >= 0 && tight.high <= 1, JSON.stringify(tight));
}

function applySharpless(probs: number[], gamma: number): number[] {
  return applySharpness(probs, gamma);
}

console.log('4. Qualité de tir (shotmap)');
{
  const shotmap = {
    content: {
      shotmap: {
        shots: [
          {
            id: 1,
            teamId: 10,
            isGoal: true,
            isBigChance: true,
            isOnTarget: true,
            expectedGoals: 0.42,
            expectedGoalsOnTarget: 0.55,
            situation: 'OpenPlay',
            shotType: 'LeftFoot',
            period: 'FirstHalf',
            isFromInsideBox: true,
          },
          {
            id: 2,
            teamId: 10,
            isGoal: false,
            isBigChance: false,
            isOnTarget: false,
            expectedGoals: 0.05,
            expectedGoalsOnTarget: 0,
            situation: 'RegularPlay',
            shotType: 'RightFoot',
            period: 'SecondHalf',
            isFromInsideBox: false,
          },
          {
            id: 3,
            teamId: 20,
            isGoal: false,
            isBigChance: false,
            isOnTarget: true,
            expectedGoals: 0.09,
            expectedGoalsOnTarget: 0.12,
            situation: 'SetPiece',
            shotType: 'Head',
            period: 'SecondHalf',
            isFromInsideBox: true,
          },
        ],
      },
    },
  };

  const shots = extractShots(shotmap);
  check('shotmap : 3 tirs extraits', shots.length === 3, `n=${shots.length}`);
  check('shotmap : équipe identifiée', shots.filter(s => s.teamId === 10).length === 2);

  const profile = buildShotProfile(shots.filter(s => s.teamId === 10), 1);
  check('profil : 2 tirs, 1 but, 1 xGOT', profile.shots === 2 && profile.goals === 1 && close(profile.xgot, 0.55, 1e-9));
  check('profil : xG par tir', close(profile.xgPerShot, 0.235, 1e-3), `${profile.xgPerShot}`);

  const merged = mergeShotProfiles([profile, profile]);
  check('fusion de profils : volume doublé', merged.shots === 4 && merged.goals === 2);
  check('fusion de profils : ratios recalculés', close(merged.xgPerShot, profile.xgPerShot, 1e-6));

  const factor = shotQualityFactor(profile, 0.1, 0.12);
  check('facteur de qualité borné', factor.factor >= 0.92 && factor.factor <= 1.08, `×${factor.factor}`);
  const none = shotQualityFactor(null, 0.1, 0.12);
  check('facteur neutre sans données', none.factor === 1);

  // Extraction depuis la forme imbriquée (événements).
  const nested = {
    content: {
      events: {
        events: [
          {
            shotmapEvent: {
              eventType: 'Goal',
              teamId: 10,
              expectedGoals: 0.3,
              expectedGoalsOnTarget: 0.4,
              isOnTarget: true,
              isFromInsideBox: true,
              situation: 'RegularPlay',
              period: 'FirstHalf',
            },
          },
        ],
      },
    },
  };
  const nestedShots = extractShots(nested);
  check('shotmap imbriqué (événements) extrait', nestedShots.length === 1 && nestedShots[0].isGoal);
}

console.log('5. Contributions individuelles & impact des absences');
{
  const contributions = buildPlayerContributions([
    { id: 1, name: 'Attaquant', position: 'ST', goals: 12, assists: 6, xg: 14, xa: 5, minutes: 900, rating: 7.6 },
    { id: 2, name: 'Défenseur', position: 'CB', goals: 1, assists: 0, xg: 1.2, xa: 0.8, minutes: 850, rating: 7.1 },
    { id: 3, name: 'Remplaçant', position: 'ST', goals: 1, assists: 0, xg: 1.5, xa: 0.4, minutes: 180, rating: 6.6 },
  ]);
  check('contributions : 3 joueurs', contributions.length === 3);
  check(
    'contribution offensive du buteur > celle du remplaçant',
    contributions[0].attackIndex > contributions[2].attackIndex,
    `${contributions[0].attackIndex} vs ${contributions[2].attackIndex}`
  );

  const impact = absenceImpactFromContributions({
    absences: [{ id: 1, name: 'Attaquant', type: 'injury', position: 'ST', marketValue: 80_000_000, rating: 7.6 }],
    contributions,
  });
  check('absence : impact mesuré', impact.attackImpact > 0.02, `attaque=${impact.attackImpact}`);
  check('absence : source « contribution »', impact.items[0]?.source === 'contribution');
  check('absence : impact borné', impact.attackImpact <= 0.22);

  const fallback = absenceImpactFromContributions({
    absences: [{ id: 99, name: 'Inconnu', type: 'injury', marketValue: 50_000_000 }],
    contributions: [],
  });
  check('absence sans statistiques : repli valeur de marché', fallback.items[0]?.source === 'valeur');
}

console.log('6. Séries, arbitre et surface');
{
  const matches = [
    { utcTime: '2026-10-01T15:00:00Z', homeId: 1, awayId: 2, homeScore: 2, awayScore: 0 },
    { utcTime: '2026-10-08T15:00:00Z', homeId: 1, awayId: 3, homeScore: 1, awayScore: 1 },
    { utcTime: '2026-10-15T15:00:00Z', homeId: 1, awayId: 4, homeScore: 3, awayScore: 0 },
  ];
  const profile = analyseSequences(matches, 1, 'home');
  check('séries : 3 matchs marqués d’affilée à domicile', profile.scoredStreak === 3, `${profile.scoredStreak}`);
  check('séries : clean sheet à domicile', profile.cleanSheetStreak === 1, `${profile.cleanSheetStreak}`);
  check('séries : 3 matchs à domicile analysés', profile.matches === 3, `${profile.matches}`);
  const adjustment = sequenceAttackAdjustment(profile, 1.3);
  check('ajustement de série borné ±4 %', adjustment.factor >= 0.96 && adjustment.factor <= 1.04, `×${adjustment.factor}`);

  const facts = extractPollFacts({
    Facts: [
      { DefaultTemplate: "{0} haven't drawn in {1} matches.", StatValues: ['away_team', '12'] },
    ],
  });
  check('séries FotMob (oddspoll) lues', facts.length === 1 && facts[0].team === 'away', JSON.stringify(facts));

  const referee = buildRefereeProfile({
    name: 'Test',
    matches: 17,
    yellowPerMatch: 4.8,
    yellowAverage: 3.8,
    foulsPerMatch: 24,
    foulsAverage: 21.9,
    penaltiesPerMatch: 0.45,
  });
  check('arbitre : écart cartes mesuré', referee.yellowDelta !== null && referee.yellowDelta > 0.2, `${referee.yellowDelta}`);
  check('arbitre : effet borné', Math.abs(referee.effect - 1) <= 0.12, `×${referee.effect}`);
  const neutral = buildRefereeProfile(null);
  check('arbitre absent : effet neutre', neutral.effect === 1);

  const pitch = buildPitchProfile({ name: 'Stade X', surface: 'artificial', capacity: 30000 });
  check('surface synthétique : effet appliquée', pitch.isArtificial && pitch.effect > 1.02, `×${pitch.effect}`);
  const grass = buildPitchProfile({ name: 'Stade Y', surface: 'grass' });
  check('gazon naturel : effet neutre', grass.effect === 1);
}

console.log('7. Calibration');
{
  const model = { home: 0.5, draw: 0.28, away: 0.22 };
  const market = { home: 0.45, draw: 0.3, away: 0.25 };
  const blended = blendProbabilities(model, market, 0.5);
  check('mélange : point médian respecté', close(blended.home, 0.475, 1e-9));
  check('mélange : somme conservée', close(blended.home + blended.draw + blended.away, 1, 1e-12));

  const applied = applyCalibration(model, market, DEFAULT_CALIBRATION);
  check('calibration appliquée : somme 1', close(applied.probs.home + applied.probs.draw + applied.probs.away, 1, 1e-12));

  const confidence = calibratedConfidence(DEFAULT_CALIBRATION, 0.8, 0.9);
  check('confiance mesurée dans [0,1]', confidence.probability > 0 && confidence.probability < 1, `${confidence.probability}`);
  const higher = calibratedConfidence(DEFAULT_CALIBRATION, 1, 1);
  check('confiance croissante avec la séparation', higher.probability >= confidence.probability);

  const interval = probabilityInterval(DEFAULT_CALIBRATION, 0.55);
  check('intervalle de crédibilité valide', interval.low < 0.55 && interval.high > 0.55, JSON.stringify(interval));

  const below = valueAssessment(0.01, DEFAULT_CALIBRATION);
  const above = valueAssessment(DEFAULT_CALIBRATION.valueThreshold + 0.01, DEFAULT_CALIBRATION);
  check('seuil de valeur : en deçà = pas de valeur', !below.isValue);
  check('seuil de valeur : au-delà = valeur', above.isValue);
}

console.log('8. Garde-fous du moteur');
{
  const emptyTable = {
    id: 1,
    name: 'Équipe A',
    played: 0,
    goalsScored: 0,
    goalsConceded: 0,
    xg: 0,
    xgConceded: 0,
  };
  const report = runQuantitativeAnalyst({
    baseLambdas: { home: 1.4, away: 1.1 },
    league: { rowsAll: [emptyTable], rowsHome: [], rowsAway: [], xgRows: [], legend: [] },
    home: {
      teamId: 1,
      name: 'Équipe A',
      tableAll: emptyTable,
      recentMatches: [],
      stats: {},
      squad: [],
      absences: [],
    },
    away: {
      teamId: 2,
      name: 'Équipe B',
      tableAll: { ...emptyTable, id: 2, name: 'Équipe B' },
      recentMatches: [],
      stats: {},
      squad: [],
      absences: [],
    },
  });
  check(
    'moteur : issues 1X2 normalisées',
    close(report.market.pureModel.home + report.market.pureModel.draw + report.market.pureModel.away, 1, 2e-4),
    `${(report.market.pureModel.home + report.market.pureModel.draw + report.market.pureModel.away).toFixed(6)}`
  );
  check('moteur : λ dans une plage plausible', report.lambdas.home > 0.2 && report.lambdas.home < 4);
  check('moteur : intervalle de crédibilité fourni', report.uncertainty.home.low < report.uncertainty.home.high);
  check('moteur : confiance mesurée fournie', report.confidence.probability > 0 && report.confidence.probability < 1);
  check('moteur : bloc calibration présent', report.calibration.modelWeight >= 0 && report.calibration.modelWeight <= 1);
}

console.log('9. Pronostics dérivés (lecture de la simulation)');
{
  const emptyTable = {
    id: 1,
    name: 'Équipe A',
    played: 0,
    goalsScored: 0,
    goalsConceded: 0,
    xg: 0,
    xgConceded: 0,
  };
  const buildInput = (shotQuality: any = null) => ({
    matchId: 'prono-check',
    kickoffIso: '2026-11-23T15:00:00.000Z',
    baseLambdas: { home: 1.6, away: 1.2 },
    covarianceSamples: [],
    halfTimeSamples: [],
    market: { home: 2.1, draw: 3.4, away: 3.1, format: 'decimal' as const, source: 'test' },
    referee: null,
    weather: null,
    h2h: null,
    league: { rowsAll: [emptyTable], rowsHome: [], rowsAway: [], xgRows: [], legend: [] },
    home: {
      teamId: 1,
      name: 'Équipe A',
      tableAll: emptyTable,
      recentMatches: [],
      stats: {},
      squad: [],
      absences: [],
    },
    away: {
      teamId: 2,
      name: 'Équipe B',
      tableAll: { ...emptyTable, id: 2, name: 'Équipe B' },
      recentMatches: [],
      stats: {},
      squad: [],
      absences: [],
    },
    shotQuality,
  });

  const report = runQuantitativeAnalyst(buildInput() as any);
  const p = report.pronostics;
  const sum = (o: Record<string, number>) => Object.values(o).reduce((a, b) => a + b, 0);
  const sumArray = (a: number[]) => a.reduce((x, y) => x + y, 0);

  check('pronostics : total impair + pair = 1', close(p.totalOdd + p.totalEven, 1, 1e-9));
  check(
    'pronostics : 1re mi-temps normalisée',
    close(sum(p.halves.first), 1, 1e-9),
    `${sum(p.halves.first).toFixed(6)}`
  );
  check(
    'pronostics : 2e mi-temps normalisée',
    close(sum(p.halves.second), 1, 1e-9),
    `${sum(p.halves.second).toFixed(6)}`
  );
  check(
    'pronostics : matrice mi-temps/fin = 1',
    close(sum(p.halfTimeFullTime), 1, 1e-9),
    `${sum(p.halfTimeFullTime).toFixed(6)}`
  );
  check(
    'pronostics : dernier but normalisé',
    close(p.lastGoal.home + p.lastGoal.away + p.lastGoal.none, 1, 1e-9)
  );
  for (const n of ['one', 'two', 'three'] as const) {
    const bucket = p.firstTo[n];
    check(
      `pronostics : premier à ${n} but(s) normalisé`,
      close(bucket.home + bucket.away + bucket.none, 1, 1e-9),
      `${(bucket.home + bucket.away + bucket.none).toFixed(6)}`
    );
  }
  check(
    'pronostics : répartition des buts équipe 1 = 1',
    close(sumArray(p.teamGoals.home.distribution), 1, 1e-3),
    `${sumArray(p.teamGoals.home.distribution).toFixed(6)}`
  );
  check(
    'pronostics : répartition des buts équipe 2 = 1',
    close(sumArray(p.teamGoals.away.distribution), 1, 1e-3),
    `${sumArray(p.teamGoals.away.distribution).toFixed(6)}`
  );

  // Cohérence interne : la clé de la matrice est « mi-temps / fin de match ».
  // Les lignes (1er caractère) redonnent donc les issues de 1re mi-temps,
  // les colonnes (2e caractère) redonnent le résultat final.
  const htH = p.halfTimeFullTime['H/H'] + p.halfTimeFullTime['H/D'] + p.halfTimeFullTime['H/A'];
  const htD = p.halfTimeFullTime['D/H'] + p.halfTimeFullTime['D/D'] + p.halfTimeFullTime['D/A'];
  const htA = p.halfTimeFullTime['A/H'] + p.halfTimeFullTime['A/D'] + p.halfTimeFullTime['A/A'];
  check(
    'pronostics : lignes MT/Fin = issues de 1re mi-temps',
    close(htH, p.halves.first.home, 1e-3) &&
      close(htD, p.halves.first.draw, 1e-3) &&
      close(htA, p.halves.first.away, 1e-3),
    `${htH.toFixed(4)} / ${htD.toFixed(4)} / ${htA.toFixed(4)} vs ${p.halves.first.home.toFixed(
      4
    )} / ${p.halves.first.draw.toFixed(4)} / ${p.halves.first.away.toFixed(4)}`
  );

  const ftH = p.halfTimeFullTime['H/H'] + p.halfTimeFullTime['D/H'] + p.halfTimeFullTime['A/H'];
  const ftD = p.halfTimeFullTime['H/D'] + p.halfTimeFullTime['D/D'] + p.halfTimeFullTime['A/D'];
  const ftA = p.halfTimeFullTime['H/A'] + p.halfTimeFullTime['D/A'] + p.halfTimeFullTime['A/A'];
  check(
    'pronostics : colonnes MT/Fin = résultat final',
    close(ftH, report.simulation.home, 5e-3) &&
      close(ftD, report.simulation.draw, 5e-3) &&
      close(ftA, report.simulation.away, 5e-3),
    `${ftH.toFixed(4)} / ${ftD.toFixed(4)} / ${ftA.toFixed(4)} vs ${report.simulation.home.toFixed(
      4
    )} / ${report.simulation.draw.toFixed(4)} / ${report.simulation.away.toFixed(4)}`
  );

  // Cohérence interne : « pas de but » = 0-0 (identique pour « dernier but »
  // et « premier à 1 but »). L'égalité avec le produit des marginales n'est
  // qu'approximative : les buts des deux équipes sont corrélés.
  const zeroZero = p.teamGoals.home.distribution[0] * p.teamGoals.away.distribution[0];
  check(
    'pronostics : « pas de but » = 0-0',
    close(p.lastGoal.none, p.firstTo.one.none, 1e-9),
    `${p.lastGoal.none.toFixed(4)} vs ${p.firstTo.one.none.toFixed(4)}`
  );
  check(
    'pronostics : P(0-0) proche du produit des marginales',
    Math.abs(p.lastGoal.none - zeroZero) < 0.02,
    `${p.lastGoal.none.toFixed(4)} vs ${zeroZero.toFixed(4)}`
  );
  check(
    'pronostics : clean sheet cohérent avec les buts encaissés',
    close(p.cleanSheet.home, p.teamGoals.away.distribution[0], 2e-3) &&
      close(p.cleanSheet.away, p.teamGoals.home.distribution[0], 2e-3)
  );
  check(
    'pronostics : deux équipes ne peuvent pas être clean sheet simultanément',
    p.cleanSheet.home + p.cleanSheet.away <= 1 + 1e-9
  );

  // But de tête : données absentes => non estimable (jamais de probabilité fabriquée).
  check(
    'pronostics : but de tête non estimable sans données de tir',
    p.headerGoal.available === false && p.headerGoal.probability === null,
    JSON.stringify(p.headerGoal)
  );

  // But de tête : données présentes => probabilité calculée à partir des buts de tête observés.
  const shotProfile = (matches: number, headers: number, headerGoals: number) => ({
    shots: 120,
    goals: 12,
    onTarget: 45,
    bigChances: 10,
    insideBox: 60,
    penalties: 2,
    setPieces: 30,
    headers,
    headerGoals,
    fastBreaks: 5,
    xg: 11,
    xgot: 9,
    xgPerShot: 0.09,
    xgotPerShot: 0.075,
    conversion: 0.1,
    goalRate: 0.1,
    qualityRatio: 0.82,
    finishingRatio: 1.09,
    matches,
    note: 'Profil de test.',
  });
  const withShots = runQuantitativeAnalyst(
    buildInput({
      home: shotProfile(10, 24, 3),
      away: shotProfile(10, 19, 2),
    }) as any
  );
  const hg = withShots.pronostics.headerGoal;
  check('pronostics : but de tête estimable avec des données de tir', hg.available === true);
  check(
    'pronostics : but de tête = 1 - exp(-λ) sur le rythme observé',
    close(hg.probability ?? -1, 1 - Math.exp(-(5 / 10)), 1e-3),
    `${hg.probability} vs ${(1 - Math.exp(-0.5)).toFixed(4)}`
  );
  check(
    'pronostics : but de tête : volume de tentatives reported',
    hg.attempts > 0 && hg.goals === 5 && hg.matches === 10,
    JSON.stringify(hg)
  );
}

console.log('10. Identité de championnat (collecte)');
{
  // Payload `leagues?id=87` (LaLiga) : identité déduite, jamais codée en dur.
  const laLigaPayload = {
    details: { id: 87, name: 'LaLiga', country: 'ESP', type: 'league' },
    table: [{ data: { leagueId: 87, leagueName: 'LaLiga' } }],
  };
  const laLiga = readLeagueIdentity(laLigaPayload);
  check('ligue : LaLiga (id 87) → esp.1', laLiga.slug === 'esp.1', laLiga.slug);
  check('ligue : nom de ligue conservé', laLiga.name === 'LaLiga', String(laLiga.name));

  const premierLeague = readLeagueIdentity({
    details: { id: 47, name: 'Premier League', country: 'ENG' },
  });
  check('ligue : Premier League (id 47) → eng.1', premierLeague.slug === 'eng.1', premierLeague.slug);

  // Cas du bug : la source renvoie l'esp.1 alors que l'eng.1 était demandé.
  const match = readMatchLeagueSlug({ primaryLeagueId: 87 }, premierLeague);
  check(
    'ligue : le match prime sur la ligue demandée (La Liga dans un flux PL)',
    match === 'esp.1',
    match
  );
  const sameLeague = readMatchLeagueSlug({ leagueId: 47 }, premierLeague);
  check('ligue : match de la ligue demandée conservé', sameLeague === 'eng.1', sameLeague);
  const unknownLeague = readMatchLeagueSlug({}, premierLeague);
  check('ligue : repli sur la ligue de la source', unknownLeague === 'eng.1', unknownLeague);

  // Replis : nom seul, puis pays seul, puis identifiant inconnu.
  check(
    'ligue : repli par nom',
    resolveLeagueSlug({ name: 'LaLiga' }) === 'esp.1',
    resolveLeagueSlug({ name: 'LaLiga' })
  );
  check(
    'ligue : repli par pays',
    resolveLeagueSlug({ fotmobId: 999, name: 'Liga Mystery', country: 'ESP' }) === 'esp.1',
    resolveLeagueSlug({ fotmobId: 999, name: 'Liga Mystery', country: 'ESP' })
  );
  check(
    'ligue : identifiant inconnu conservé de façon lisible',
    resolveLeagueSlug({ fotmobId: 999 }) === 'league-999',
    resolveLeagueSlug({ fotmobId: 999 })
  );
}

console.log('');
if (failures) {
  console.log(`✗ ${failures} contrôle(s) en échec`);
  process.exit(1);
}
console.log('✓ Tous les contrôles du modèle v3 sont passés');
