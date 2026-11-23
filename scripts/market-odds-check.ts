/**
 * Contrôle du pipeline "cotes de marché réelles" :
 *  - parsing des charges utiles de marché (1X2, O/U 2,5, BTTS, DNB)
 *  - retrait de marge (Shin / normalisation binaire)
 *  - calibration du moteur quantitatif sur ces cotes
 *
 * Exécution : node --experimental-strip-types scripts/market-odds-check.ts
 */

import {
  devigMarketOdds,
  extractProvider,
  mergeMarketOdds,
  oddsToMarketPayload,
  parseMarketOdds,
  providerLabel,
} from '../app/lib/marketOdds.ts';
import { runQuantitativeAnalyst } from '../app/lib/analystEngine.ts';

let failures = 0;
function check(label: string, condition: boolean, detail?: string) {
  if (condition) {
    console.log(`  ok   ${label}`);
  } else {
    failures += 1;
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

function near(a: number | null, b: number, tolerance = 0.01): boolean {
  return typeof a === 'number' && Math.abs(a - b) <= tolerance;
}

/* ------------------------------------------------------------------ */
/* 1. Payload réel 1xBet (Espagne) — 1X2, BTTS, O/U 2,5, O/U 3,5        */
/* ------------------------------------------------------------------ */
const payload1xBet = {
  persistentKey: '1xBet_Spain',
  providerId: '449',
  ongoing: false,
  odds: {
    matchfactMarkets: [
      {
        header: 'Match Result',
        headerTranslationKey: 'who_will_win',
        selections: [
          { name: '1', oddsDecimal: '1.58' },
          { name: 'x', oddsDecimal: '4.58' },
          { name: '2', oddsDecimal: '6.16' },
        ],
        fotMobMarketTypeId: { translationKey: 'who_will_win' },
      },
    ],
    oddsTabMarkets: [
      {
        category: 'Bets',
        markets: [
          {
            header: 'Both Teams To Score',
            headerTranslationKey: 'both_score',
            selections: [
              { name: 'Yes', oddsDecimal: '1.78' },
              { name: 'No', oddsDecimal: '1.95' },
            ],
            fotMobMarketTypeId: { translationKey: 'both_score' },
          },
          {
            header: 'Over/Under 2.5',
            headerTranslationKey: 'odds_goals_over_under',
            selections: [
              { name: 'Over', oddsDecimal: '1.78' },
              { name: 'Under', oddsDecimal: '2.21' },
            ],
            fotMobMarketTypeId: { translationKey: 'odds_goals_over_under' },
          },
          {
            header: 'Over/Under 3.5',
            headerTranslationKey: 'odds_goals_over_under',
            selections: [
              { name: 'Over', oddsDecimal: '2.78' },
              { name: 'Under', oddsDecimal: '1.45' },
            ],
            fotMobMarketTypeId: { translationKey: 'odds_goals_over_under' },
          },
          {
            header: 'Double Chance',
            headerTranslationKey: 'double_chance',
            selections: [
              { name: '1X', oddsDecimal: '1.16' },
              { name: '12', oddsDecimal: '1.24' },
              { name: '2X', oddsDecimal: '2.56' },
            ],
            fotMobMarketTypeId: { translationKey: 'double_chance' },
          },
        ],
      },
    ],
  },
};

console.log('1. Parsing du payload 1X2 + BTTS + O/U');
const odds1xBet = parseMarketOdds(payload1xBet, 'Leeds United', 'Coventry City');
check('cote domicile 1.58', odds1xBet.home === 1.58, String(odds1xBet.home));
check('cote nul 4.58', odds1xBet.draw === 4.58, String(odds1xBet.draw));
check('cote extérieur 6.16', odds1xBet.away === 6.16, String(odds1xBet.away));
check('BTTS oui 1.78', odds1xBet.bttsYes === 1.78, String(odds1xBet.bttsYes));
check('BTTS non 1.95', odds1xBet.bttsNo === 1.95, String(odds1xBet.bttsNo));
check('over 2.5 = 1.78', odds1xBet.over25 === 1.78, String(odds1xBet.over25));
check('under 2.5 = 2.21', odds1xBet.under25 === 2.21, String(odds1xBet.under25));
check('2 lignes de totaux détectées', odds1xBet.goalLines.length === 2, String(odds1xBet.goalLines.length));
check('aucune pollution par le double chance', !odds1xBet.markets.some(m => /chance/i.test(m)));

console.log('2. Retrait de marge');
const devig1xBet = devigMarketOdds(odds1xBet);
check('marché disponible', devig1xBet.available);
check('somme des probabilités 1X2 = 1', near(devig1xBet.probabilities.home + devig1xBet.probabilities.draw + devig1xBet.probabilities.away, 1, 0.0001));
check('marge > 1 (surcharge bookmaker)', devig1xBet.overround > 1, String(devig1xBet.overround));
check('méthode Shin appliquée', devig1xBet.method === 'Shin', devig1xBet.method);
check('proba domicile la plus forte', devig1xBet.probabilities.home > devig1xBet.probabilities.draw);
check(
  'marge retirée : la proba juste est sous l\'implicite brut',
  devig1xBet.probabilities.home < 1 / 1.58 && devig1xBet.probabilities.home > 1 / 1.58 / devig1xBet.overround - 0.001
);
check('over 2.5 dé-viggué', near(devig1xBet.probabilities.over25, 1 / 1.78 / (1 / 1.78 + 1 / 2.21), 0.0001), String(devig1xBet.probabilities.over25));
check('BTTS dé-viggué', near(devig1xBet.probabilities.btts, 1 / 1.78 / (1 / 1.78 + 1 / 1.95), 0.0001), String(devig1xBet.probabilities.btts));

/* ------------------------------------------------------------------ */
/* 3. Payload réel Bet365 (Espagne) — 1X2 + DNB par nom d'équipe      */
/* ------------------------------------------------------------------ */
const payloadBet365 = {
  odds: {
    matchfactMarkets: [
      {
        header: 'Full Time Result',
        headerTranslationKey: 'who_will_win',
        selections: [
          { name: '1', oddsDecimal: '1.91' },
          { name: 'x', oddsDecimal: '3.70' },
          { name: '2', oddsDecimal: '3.60' },
        ],
        fotMobMarketTypeId: { translationKey: 'who_will_win' },
      },
    ],
    oddsTabMarkets: [
      {
        category: 'Bets',
        markets: [
          {
            header: 'Draw No Bet',
            headerTranslationKey: 'odds_draw_no_bet',
            selections: [
              { name: 'Manchester United', oddsDecimal: '1.44' },
              { name: 'Brentford', oddsDecimal: '2.63' },
            ],
            fotMobMarketTypeId: { translationKey: 'odds_draw_no_bet' },
          },
          {
            header: 'Both Teams to Score',
            headerTranslationKey: 'both_score',
            selections: [
              { name: 'Yes', oddsDecimal: '1.53' },
              { name: 'No', oddsDecimal: '2.38' },
            ],
            fotMobMarketTypeId: { translationKey: 'both_score' },
          },
        ],
      },
    ],
  },
};

console.log('3. Parsing du payload 1X2 + nul exclu (noms d\'équipes)');
const oddsBet365 = parseMarketOdds(payloadBet365, 'Manchester United', 'Brentford');
check('cote domicile 1.91', oddsBet365.home === 1.91, String(oddsBet365.home));
check('DNB domicile 1.44', oddsBet365.drawNoBetHome === 1.44, String(oddsBet365.drawNoBetHome));
check('DNB extérieur 2.63', oddsBet365.drawNoBetAway === 2.63, String(oddsBet365.drawNoBetAway));
check('BTTS 1.53 / 2.38', oddsBet365.bttsYes === 1.53 && oddsBet365.bttsNo === 2.38);
check('aucun over 2.5 sans cote', oddsBet365.over25 === null, String(oddsBet365.over25));

console.log('4. Fusion de deux sources (1X2 + O/U + BTTS)');
const merged = mergeMarketOdds(oddsBet365, odds1xBet);
check('1X2 conservé de la source prioritaire', merged.home === 1.91);
check('BTTS de la source prioritaire conservé', merged.bttsYes === 1.53);
check('O/U 2.5 complété depuis la source secondaire', merged.over25 === 1.78);
check('DNB conservé', merged.drawNoBetHome === 1.44);
const mergedReverse = mergeMarketOdds(odds1xBet, oddsBet365);
check('BTTS complété quand la source prioritaire n\'en a pas', mergeMarketOdds(
  { ...odds1xBet, bttsYes: null, bttsNo: null },
  oddsBet365
).bttsYes === 1.53);
check('O/U 2.5 conservé quand la source prioritaire en a', mergedReverse.over25 === 1.78);

console.log('5. Payload de rencontre terminée (marché résolu)');
const payloadResolved = {
  odds: {
    resolvedOddsMarket: {
      selections: [
        { name: '1', oddsDecimal: '1.80', team: 'H' },
        { name: 'X', oddsDecimal: '4.00', team: 'D' },
        { name: '2', oddsDecimal: '3.90', team: 'A' },
      ],
      resolvedWinnerIndex: 0,
    },
  },
};
const oddsResolved = parseMarketOdds(payloadResolved, 'Liverpool', 'Manchester United');
check('1X2 extrait du marché résolu', oddsResolved.home === 1.8 && oddsResolved.draw === 4 && oddsResolved.away === 3.9);
check('marché résolu exploitable', devigMarketOdds(oddsResolved).available);

console.log('6. Cas dégradés');
const emptyOdds = parseMarketOdds(null, 'A', 'B');
check('payload null -> pas de marché', !devigMarketOdds(emptyOdds).available);
const partialOdds = parseMarketOdds(
  { odds: { matchfactMarkets: [{ headerTranslationKey: 'who_will_win', selections: [{ name: '1', oddsDecimal: '2.00' }] }] } },
  'A',
  'B'
);
check('1X2 incomplet -> pas de marché', !devigMarketOdds(partialOdds).available);
check('charge utile moteur nulle si pas de cotes', oddsToMarketPayload(null) === null);
const payloadOdds = oddsToMarketPayload(odds1xBet);
check('charge utile moteur en format décimal', payloadOdds.format === 'decimal' && payloadOdds.home === 1.58);
check('charge utile moteur porte les marchés', Array.isArray(payloadOdds.markets) && payloadOdds.markets.length > 0);

/* ------------------------------------------------------------------ */
/* 7. Calibration du moteur quantitatif sur les cotes réelles           */
/* ------------------------------------------------------------------ */
console.log('7. Métadonnées de fournisseur (opérateur réellement servi)');
{
  // Cas nominal : l'opérateur demandé est servi.
  const honored = extractProvider({ persistentKey: '1xBet_Spain', providerId: '449' }, '1xBet_Spain');
  check('opérateur demandé honoré', honored?.honored === true);
  check('clé du fournisseur conservée', honored?.key === '1xBet_Spain');
  check('libellé lisible', honored?.label === '1xBet Espagne', honored?.label);
  check('identifiant fournisseur', honored?.providerId === '449');

  // Cas d'alias non honoré : la source sert un autre opérateur.
  const redirected = extractProvider({ persistentKey: 'Bwin_France', providerId: '77' }, '1xBet_France');
  check('alias non honoré détecté', redirected?.honored === false);
  check('opérateur réellement servi conservé', redirected?.key === 'Bwin_France');
  check('opérateur demandé mémorisé', redirected?.requested === '1xBet_France');

  // Aucune métadonnée : pas d'invention de fournisseur.
  check('payload sans métadonnées -> fournisseur null', extractProvider({ odds: {} }, '1xBet_Spain') === null);
  check('libellé générique sans pays', providerLabel('Betfair') === 'Betfair');
  check('libellé avec pays inconnu', providerLabel('Bwin_France') === 'Bwin France', providerLabel('Bwin_France'));
}

console.log('8. Calibration du moteur quantitatif');
const team = (id: string, name: string) => ({
  teamId: id,
  name,
  league: { name: 'Premier League', tier: 1, country: 'Angleterre', averageAge: 26 },
  recentMatches: [],
  form: { last5: { w: 3, d: 1, l: 1 }, last10: { w: 6, d: 2, l: 2 }, pointsPerGame: 2.0, goalsFor: 1.8, goalsAgainst: 0.9 },
  attack: { goalsPerMatch: 1.9, xgPerMatch: 1.7, shotsPerMatch: 14, bigChances: 2.1 },
  defence: { goalsConcededPerMatch: 0.9, xgAgainstPerMatch: 1.1, cleanSheetRate: 0.42 },
  absences: [],
  squad: [],
  stats: { home: [], away: [] },
});

const baseInput = {
  matchId: '5795531',
  kickoffIso: '2026-11-28T15:00:00.000Z',
  baseLambdas: { home: 1.55, away: 0.95 },
  league: { rowsAll: [], rowsHome: [], rowsAway: [], xgRows: [], legend: [] },
  home: team('100', 'Leeds United'),
  away: team('200', 'Coventry City'),
};

const reportWithMarket = runQuantitativeAnalyst({ ...baseInput, market: payloadOdds } as any);
const reportWithoutMarket = runQuantitativeAnalyst({ ...baseInput } as any);

check('marché détecté par le moteur', reportWithMarket.market.available);
check('marché absent sans cotes', !reportWithoutMarket.market.available);
check('probabilités de marché dé-vigguées (somme 1)',
  near(reportWithMarket.market.devigged.home + reportWithMarket.market.devigged.draw + reportWithMarket.market.devigged.away, 1, 0.0001));
check('marge retirée > 0', reportWithMarket.market.overround > 1, String(reportWithMarket.market.overround));
check('cotes publiées dans le rapport',
  reportWithMarket.market.odds.home === 1.58 && reportWithMarket.market.odds.over25 === 1.78 && reportWithMarket.market.odds.bttsYes === 1.78);
check('marchés listés dans le rapport', reportWithMarket.market.markets.includes('1X2'));
check('calibration appliquée (poids marché > 0)', reportWithMarket.market.weights.market > 0);
check(
  'probabilité calibrée entre modèle pur et marché',
  (() => {
    const pure = reportWithMarket.market.pureModel.home;
    const cal = reportWithMarket.market.calibrated.home;
    const mkt = reportWithMarket.market.devigged.home;
    return cal >= Math.min(pure, mkt) - 1e-9 && cal <= Math.max(pure, mkt) + 1e-9;
  })()
);
check('edge domicile = calibré - marché',
  near(reportWithMarket.market.edges.home, reportWithMarket.market.calibrated.home - reportWithMarket.market.devigged.home, 0.0002));
check('edge BTTS disponible', typeof reportWithMarket.market.edges.btts === 'number');
check('edge O/U 2.5 disponible', typeof reportWithMarket.market.edges.over25 === 'number');
check('confiance impactée par l\'accord marché',
  reportWithMarket.confidence.agreement !== reportWithoutMarket.confidence.agreement);
check('source du marché générique (pas de marque)', reportWithMarket.market.source === 'Cotes de marché publiques');
check('synthèse mentionne le marché', reportWithMarket.synthesis.bullets.some(b => /Marché/.test(b)));
check('opérateur des cotes publié', reportWithMarket.market.oddsProvider === '1xBet Espagne', reportWithMarket.market.oddsProvider);
check('opérateur demandé honoré publié', reportWithMarket.market.oddsProviderHonored === true);
check('heure d\'extraction publiée', typeof reportWithMarket.market.oddsFetchedAt === 'string' && reportWithMarket.market.oddsFetchedAt.length > 0);
check(
  'note du marché cite la source des cotes',
  /Source des cotes : 1xBet Espagne/.test(reportWithMarket.market.note),
  reportWithMarket.market.note
);

console.log('');
if (failures) {
  console.log(`${failures} test(s) en échec.`);
  process.exit(1);
}
console.log('Tous les contrôles sont passés.');
