/**
 * Test d'intégration du pipeline « cotes réelles » :
 *
 *   charge utile réelle du flux de marché
 *     → parseMarketOdds (1X2, BTTS, totaux)
 *     → dé-vig (Shin)
 *     → payload du moteur quantitatif
 *     → rapport analytitique (cotes publiées, probabilités justes, edges)
 *
 * Exécution : npm run check:market:integration
 */
import { readFileSync } from 'node:fs';

import { runQuantitativeAnalyst } from '../app/lib/analystEngine.ts';
import { devigMarketOdds, oddsToMarketPayload, parseMarketOdds } from '../app/lib/marketOdds.ts';

const payload = JSON.parse(readFileSync(new URL('./fixtures/fotmob-odds-1xbet-spain.json', import.meta.url), 'utf8'));

let failures = 0;
function check(label: string, condition: boolean, detail?: string) {
  if (condition) {
    console.log(`  ok   ${label}`);
  } else {
    failures += 1;
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`);
  }
}
function near(a: number | null | undefined, b: number, tolerance = 1e-6): boolean {
  return typeof a === 'number' && Math.abs(a - b) <= tolerance;
}

console.log('1. Extraction des cotes réelles');
const odds = parseMarketOdds(payload, 'Manchester United', 'Brentford');
check('1X2 = 2.02 / 4.09 / 3.62', odds.home === 2.02 && odds.draw === 4.09 && odds.away === 3.62);
check('BTTS = 1.48 / 2.50', odds.bttsYes === 1.48 && odds.bttsNo === 2.5);
check('total 2,5 = 1.55 / 2.45', odds.over25 === 1.55 && odds.under25 === 2.45);
check('3 lignes de totaux', odds.goalLines.length === 3, String(odds.goalLines.length));
check('lignes triées (2.5, 3.5, 4.5)', odds.goalLines.map(l => l.line).join(',') === '2.5,3.5,4.5');
check('double chance ignoré', !odds.markets.includes('Double Chance'));
check('opérateur résolu', odds.provider?.key === '1xBet_Spain');
check('opérateur demandé honoré', odds.provider?.honored === true);
check('libellé du fournisseur', odds.provider?.label === '1xBet Espagne');

console.log('2. Retrait de la marge bookmaker');
const parsed = devigMarketOdds(odds);
check('marché disponible', parsed.available);
check('méthode Shin', parsed.method === 'Shin');
check('surcharge > 1', parsed.overround > 1, String(parsed.overround));
check('somme des probabilités 1X2 = 1', near(parsed.probabilities.home + parsed.probabilities.draw + parsed.probabilities.away, 1, 1e-9));
check('total 2,5 dé-viggué', near(parsed.probabilities.over25, 1 / 1.55 / (1 / 1.55 + 1 / 2.45), 1e-9));
check('BTTS dé-viggué', near(parsed.probabilities.btts, 1 / 1.48 / (1 / 1.48 + 1 / 2.5), 1e-9));

console.log('3. Rapport analytique alimenté par les cotes réelles');
const marketPayload = oddsToMarketPayload(odds);
check('payload moteur non nul', marketPayload !== null);
check('format décimal', marketPayload.format === 'decimal');

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

const report = runQuantitativeAnalyst({
  matchId: '5795532',
  kickoffIso: '2026-11-28T15:00:00.000Z',
  baseLambdas: { home: 1.62, away: 1.05 },
  league: { rowsAll: [], rowsHome: [], rowsAway: [], xgRows: [], legend: [] },
  home: team('100', 'Manchester United'),
  away: team('200', 'Brentford'),
  market: marketPayload,
} as any);

check('marché disponible dans le rapport', report.market.available);
check('cotes publiées', report.market.odds.home === 2.02 && report.market.odds.over25 === 1.55 && report.market.odds.bttsYes === 1.48);
check('opérateur publié', report.market.oddsProvider === '1xBet Espagne');
check('opérateur honoré publié', report.market.oddsProviderHonored === true);
check('heure d\'extraction publiée', typeof report.market.oddsFetchedAt === 'string');
check('probabilités de marché justes', near(report.market.devigged.home + report.market.devigged.draw + report.market.devigged.away, 1, 1e-4));
check('edge domicile = calibré - marché', near(report.market.edges.home, report.market.calibrated.home - report.market.devigged.home, 5e-4));
check('edge total 2,5 disponible', typeof report.market.edges.over25 === 'number');
check('edge BTTS disponible', typeof report.market.edges.btts === 'number');
check('marchés listés', report.market.markets.includes('1X2') && report.market.markets.includes('Total de buts 2,5'));

console.log('');
if (failures) {
  console.log(`${failures} test(s) en échec.`);
  process.exit(1);
}
console.log('Le pipeline des cotes réelles fonctionne de bout en bout.');
