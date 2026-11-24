/**
 * Contrôles déterministes des modules de l'étape 3.
 *
 * Aucun réseau : ce script vérifie les propriétés des modules ajoutés
 * pour le passage à l'échelle (jeu football-data.co.uk), la calibration
 * par championnat avec rétrécissement, les avertissements « match
 * piège », le contrat d'erreur de l'API et la disclosure transparente.
 *
 * Exécution : npm run check:step3
 */
import {
  shrinkCore,
  buildLeagueCalibrations,
  coreOf,
} from '../app/lib/calibrationLeagues.ts';
import { detectMatchTraps, isDerby } from '../app/lib/matchTraps.ts';
import { buildDisclosure, DISCLOSURE_THRESHOLD } from '../app/lib/disclosure.ts';
import {
  buildApiError,
  classifyNetworkError,
  API_ERROR_STATUS,
  type ApiErrorCode,
} from '../app/lib/apiErrors.ts';
import {
  buildMarketStatuses,
  marketStatusBadge,
  DERIVED_MARKETS,
} from '../app/lib/derivedMarkets.ts';
import { logLossOf, pairedDifference, summarise } from '../app/lib/backtestMetrics.ts';
import { hasTacticalData } from '../app/lib/analystEngine.ts';
import { normaliseOutcomeSet } from '../app/lib/probabilities.ts';

let failures = 0;
function check(label: string, condition: boolean, detail?: string) {
  if (condition) {
    console.log(`  ok   ${label}`);
  } else {
    failures += 1;
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

console.log('1. Calibration par championnat avec rétrécissement');
{
  const common = { modelWeight: 0.4, sharpness: 1.0, valueThreshold: 0.02 };
  const raw = { modelWeight: 1, sharpness: 1.5, valueThreshold: 0.05 };

  const small = shrinkCore(raw, common, 100, { priorMatches: 50 });
  const large = shrinkCore(raw, common, 3000, { priorMatches: 50 });
  // Le rétrécissement rapproche l'estimation de la valeur commune :
  // l'écart à la valeur commune doit être plus faible pour le petit
  // championnat que pour le grand.
  const smallDistance = Math.abs(small.core.modelWeight - common.modelWeight);
  const largeDistance = Math.abs(large.core.modelWeight - common.modelWeight);
  check('un petit championnat est surtout piloté par la valeur commune',
    smallDistance < largeDistance && small.weight < 0.7, `poids ${small.weight}`);
  check('un grand championnat est piloté par son estimation propre',
    large.core.modelWeight > 0.95 && large.weight > 0.97, `poids ${large.weight}`);
  check('le rétrécissement reste dans les bornes', 
    small.core.modelWeight >= 0 && small.core.modelWeight <= 1 &&
    large.core.sharpness >= 0.5 && large.core.sharpness <= 2.2);
  check('un effectif nul donne la valeur commune',
    shrinkCore(raw, common, 0).core.modelWeight === common.modelWeight);

  const leagues = buildLeagueCalibrations(
    [
      { league: 'eng.1', samples: 3040, core: raw },
      { league: 'fra.1', samples: 300, core: raw },
    ],
    common
  );
  check('deux championnats produisent deux calibrations distinctes',
    leagues.length === 2 && leagues[0].modelWeight > leagues[1].modelWeight);
  check('chaque calibration expose son effectif et son poids',
    leagues.every(entry => entry.samples > 0 && entry.shrinkage > 0));
  check('coreOf extrait le noyau', coreOf({ modelWeight: 0.3, sharpness: 1.1, valueThreshold: 0.01 }).sharpness === 1.1);
}

console.log('1bis. Absence de données tactiques : jamais une preuve');
{
  check('aucune statistique tactique ⇒ aucune donnée',
    hasTacticalData({}) === false);
  check('une seule statistique tactique suffit',
    hasTacticalData({ possession_percentage_team: { value: 52 } }) === true);
  check('une statistique non finie ne compte pas',
    hasTacticalData({ possession_percentage_team: { value: Number.NaN } }) === false);
  check('les statistiques sans rapport avec le style ne comptent pas',
    hasTacticalData({ some_other_stat: { value: 12 } }) === false);
}

console.log('2. Avertissements « match piège »');
{
  check('le derby Liverpool-Everton est détecté', isDerby('eng.1', 'Liverpool', 'Everton'));
  check('le derby est détecté dans l’ordre inverse', isDerby('eng.1', 'Everton', 'Liverpool'));
  check('un match ordinaire n’est pas un derby', !isDerby('eng.1', 'Arsenal', 'Chelsea'.replace('Chelsea', 'Brighton')));
  check('un derby inconnu du championnat n’est pas détecté', !isDerby('deu.1', 'Liverpool', 'Everton'));

  const traps = detectMatchTraps({
    league: 'eng.1',
    homeName: 'Liverpool',
    awayName: 'Everton',
    homeRecentDates: ['2026-11-18'],
    awayRecentDates: ['2026-11-19'],
    homePlayed: 3,
    awayPlayed: 2,
    kickoffIso: '2026-11-22T15:00:00Z',
    coachChanged: null,
  });
  const ids = traps.map(trap => trap.id);
  check('le derby est signalé', ids.includes('derby'));
  check('la rotation probable est signalée', ids.includes('rotation'));
  check('les données rares sont signalées', ids.includes('sparse-data'));
  check('l’absence d’information sur l’entraîneur est dite explicitement',
    ids.includes('new-coach') &&
    (traps.find(t => t.id === 'new-coach')?.detail.includes('indisponible') ||
      traps.find(t => t.id === 'new-coach')?.label.includes('indisponible')));

  const clean = detectMatchTraps({
    league: 'esp.1',
    homeName: 'Real Madrid',
    awayName: 'Sevilla',
    homeRecentDates: ['2026-11-10'],
    awayRecentDates: ['2026-11-11'],
    homePlayed: 12,
    awayPlayed: 12,
    kickoffIso: '2026-11-22T15:00:00Z',
    coachChanged: false,
  });
  check('une rencontre normale ne déclenche aucun avertissement', clean.length === 0,
    JSON.stringify(clean.map(t => t.id)));
}

console.log('3. Disclosure transparente');
{
  const equal = buildDisclosure({
    calibratedLogLoss: 0.97,
    marketLogLoss: 0.97,
    sampleSize: 3040,
    valueDemonstrated: false,
    valueBets: 0,
  });
  check('un modèle à égalité avec le marché est annoncé comme tel',
    equal.verdict === 'équivalent' && equal.headline.includes('ne fait pas mieux'));
  check('les paris à valeur sont désactivés sans seuil démontré', equal.valueBetsDisabled);
  check('une réserve est affichée', equal.caveats.length > 0);

  const better = buildDisclosure({
    calibratedLogLoss: 0.9,
    marketLogLoss: 1.0,
    sampleSize: 3040,
    valueDemonstrated: true,
    valueBets: 100,
    valueRoi: 0.05,
  });
  check('un modèle nettement meilleur est reconnu', better.verdict === 'outperform');
  check('la supériorité n’est pas revendiquée sans preuve de valeur',
    buildDisclosure({
      calibratedLogLoss: 0.9,
      marketLogLoss: 1.0,
      valueDemonstrated: false,
    }).caveats.length > 0);

  const worse = buildDisclosure({
    calibratedLogLoss: 1.1,
    marketLogLoss: 1.0,
    sampleSize: 3040,
    valueDemonstrated: false,
  });
  check('un modèle moins bon que le marché est reconnu', worse.verdict === 'sous le marché');
  check('le seuil de significance est de 1 %', DISCLOSURE_THRESHOLD === 0.01);

  const boundary = buildDisclosure({
    calibratedLogLoss: 1.005,
    marketLogLoss: 1.0,
    valueDemonstrated: false,
  });
  check('un écart sous le seuil reste « équivalent »', boundary.verdict === 'équivalent');
}

console.log('4. Contrat d’erreur de l’API');
{
  const codes: ApiErrorCode[] = [
    'bad_request', 'unauthorized', 'not_found', 'rate_limited',
    'upstream_unavailable', 'upstream_timeout', 'no_data', 'internal_error',
  ];
  check('chaque code a un statut HTTP', codes.every(code => API_ERROR_STATUS[code] >= 200));
  check('les erreurs transitoires sont marquées réessayables',
    buildApiError('rate_limited').retryable === true &&
    buildApiError('upstream_timeout').retryable === true);
  check('les erreurs de requête ne sont pas réessayables',
    buildApiError('bad_request').retryable === false &&
    buildApiError('unauthorized').retryable === false);
  check('une absence de données n’est pas une panne',
    buildApiError('no_data').retryable === false);

  check('un délai dépassé est classé en timeout',
    classifyNetworkError(new Error('ETIMEDOUT')).code === 'upstream_timeout');
  check('une erreur réseau est classée en indisponibilité',
    classifyNetworkError(new Error('ECONNREFUSED')).code === 'upstream_unavailable');
}

console.log('5. Registre des marchés dérivés');
{
  const statuses = buildMarketStatuses(null);
  check('tous les marchés sont listés', statuses.length === DERIVED_MARKETS.length);
  check('aucun marché n’est « validé » sans mesure',
    statuses.every(status => status.status !== 'validé'));
  check('un marché sans cote est « non validé »',
    statuses.find(s => s.id === 'total-odd')?.status === 'non validé');
  check('un marché avec cote mais sans mesure est « à surveiller »',
    statuses.find(s => s.id === 'over-25')?.status === 'à surveiller');

  const measured = buildMarketStatuses({
    markets: {
      'over-25': { samples: 14000, averageGap: 0.012, logLoss: 0.69, marketLogLoss: 0.679 },
    },
  });
  const over = measured.find(s => s.id === 'over-25')!;
  check('un marché confronté avec un grand effectif et une performance proche est validé',
    over.status === 'validé', over.status);
  const badge = marketStatusBadge(over);
  check('le badge indique l’effectif', badge.includes('14000'));

  const smallSample = buildMarketStatuses({
    markets: {
      'over-25': { samples: 120, averageGap: 0.012, logLoss: 0.69, marketLogLoss: 0.679 },
    },
  }).find(s => s.id === 'over-25')!;
  check('un échantillon insuffisant reste à surveiller', smallSample.status === 'à surveiller');

  const farFromMarket = buildMarketStatuses({
    markets: {
      'over-25': { samples: 14000, averageGap: 0.09, logLoss: 0.9, marketLogLoss: 0.679 },
    },
  }).find(s => s.id === 'over-25')!;
  check('un modèle trop éloigné du marché reste à surveiller',
    farFromMarket.status === 'à surveiller', farFromMarket.status);
}

console.log('6. Métriques de backtest');
{
  check('la log-loss d’une prédiction certaine vaut 0',
    logLossOf({ home: 1, draw: 0, away: 0 }, 0) === 0);
  check('la log-loss d’une prédiction fausse est grande',
    logLossOf({ home: 0, draw: 1, away: 0 }, 0) > 10);
  check('la log-loss d’un match nul vaut log(3)',
    Math.abs(logLossOf({ home: 1 / 3, draw: 1 / 3, away: 1 / 3 }, 1) - Math.log(3)) < 1e-12);

  const paired = pairedDifference([0.9, 1.0, 0.8], [1.0, 1.1, 0.9]);
  check('la différence appariée est négative quand le premier est meilleur',
    paired.mean < 0);
  check('la p-value est dans [0, 1]', paired.pValue >= 0 && paired.pValue <= 1);

  const summary = summarise([0.9, 0.95, 1.0, 1.05], 200);
  check('le résumé contient une valeur et des bornes',
    Number.isFinite(summary.value) && summary.low <= summary.value && summary.value <= summary.high);
}

console.log('7. Normalisation des probabilités');
{
  const fallback = { home: 1 / 3, draw: 1 / 3, away: 1 / 3 };
  const set = normaliseOutcomeSet({ home: 0.5, draw: 0.3, away: 0.2 }, fallback);
  check('un ensemble exhaustif est conservé',
    Math.abs(set.home + set.draw + set.away - 1) < 1e-9);
  const repaired = normaliseOutcomeSet({ home: 0.5, draw: 0.3, away: 0.2 }, fallback);
  check('la normalisation est idempotente',
    Math.abs(repaired.home - set.home) < 1e-12);
  const broken = normaliseOutcomeSet({ home: Number.NaN, draw: 0.3, away: 0.2 }, fallback);
  check('un ensemble invalide retombe sur la valeur de repli',
    Math.abs(broken.home - 1 / 3) < 1e-12);
  const rescaled = normaliseOutcomeSet({ home: 0.6, draw: 0.6, away: 0.6 }, fallback);
  check('un ensemble mal sommé est renormalisé',
    Math.abs(rescaled.home + rescaled.draw + rescaled.away - 1) < 1e-9);
}

console.log('');
if (failures > 0) {
  console.log(`✗ ${failures} contrôle(s) en échec`);
  process.exit(1);
}
console.log('✓ Tous les contrôles de l’étape 3 sont passés');
