/**
 * Contrôles déterministes des étiquettes de match.
 *
 * Aucun réseau : ce script vérifie les règles d'étiquetage, leurs
 * seuils, l'absence de nombre NaN, le comportement quand une donnée
 * manque et le fait qu'aucune étiquette ne contredise le verdict du
 * moteur sur la « valeur ».
 *
 * Exécution : npm run check:tags
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  computeMatchTags,
  pickBadges,
  valueEdgeThreshold,
  MATCH_TAG_CONFIG,
  MATCH_TAG_LABELS,
  type MatchTagReport,
} from '../app/lib/matchTags.ts';

let failures = 0;
function check(label: string, condition: boolean, detail?: string) {
  if (condition) {
    console.log(`  ok   ${label}`);
  } else {
    failures += 1;
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

function ids(tags: { id: string }[]): string[] {
  return tags.map(tag => tag.id);
}

/** Rapport complet type : probabilités calibrées, marché, simulation… */
function fullReport(overrides: Partial<MatchTagReport> = {}): MatchTagReport {
  return {
    homeName: 'Arsenal',
    awayName: 'Manchester City',
    minutesToKickoff: 60,
    market: {
      available: true,
      calibrated: { home: 0.4, draw: 0.3, away: 0.3, over25: 0.55, btts: 0.58 },
      edges: { home: 0, draw: 0, away: 0 },
      odds: { home: 2.3, draw: 3.4, away: 3.1, over25: 1.9 },
    },
    simulation: {
      expectedGoals: { home: 1.6, away: 1.2, total: 2.8 },
      over25: 0.55,
      btts: 0.58,
    },
    confidence: { score: 72, label: 'Modérée' },
    absences: { officialLineup: { available: true, confirmed: true } },
    context: {
      home: { restDays: 5, fatigue: 0.4 },
      away: { restDays: 4, fatigue: 0.5 },
      stakes: { home: 'Course européenne', away: 'Course européenne', homeFactor: 1.035, awayFactor: 1.035 },
    },
    calibration: { valueThresholdDemonstrated: true },
    ...overrides,
  };
}

/** Rapport minimal : calque brut d'un scan de journée. */
function rawReport(overrides: Partial<MatchTagReport> = {}): MatchTagReport {
  return {
    homeName: 'Everton',
    awayName: 'Liverpool',
    market: {
      available: true,
      odds: { home: 4, draw: 4, away: 1.94, over25: 1.77 },
    },
    probabilities: { home: 0.2848, draw: 0.2632, away: 0.4519, over25: 0.4632, bttsYes: 0.5058 },
    expectedGoals: { home: 1.09, away: 1.44 },
    ...overrides,
  };
}

console.log('\nÉtiquettes de match — contrôles\n');

/* --- Serré --------------------------------------------------------- */
{
  const result = computeMatchTags(
    fullReport({ market: { ...fullReport().market, calibrated: { home: 0.36, draw: 0.3, away: 0.34 } } })
  );
  check('un match sans favori est étiqueté « Serré »', ids(result.tags).includes('tight'), ids(result.tags).join(','));
  const tight = result.tags.find(tag => tag.id === 'tight');
  check('la raison de « Serré » est chiffrée', Boolean(tight && tight.reason.includes('36 %') && tight.reason.includes('2 pts')), tight?.reason);
}
{
  const result = computeMatchTags(
    fullReport({ market: { ...fullReport().market, calibrated: { home: 0.5, draw: 0.28, away: 0.22 } } })
  );
  check('un match avec un favori à 50 % n’est pas « Serré »', !ids(result.tags).includes('tight'), ids(result.tags).join(','));
}
{
  // Meilleure probabilité faible mais victoires très écartées : pas « Serré ».
  const result = computeMatchTags(
    fullReport({ market: { ...fullReport().market, calibrated: { home: 0.38, draw: 0.3, away: 0.32 } } })
  );
  const wide = computeMatchTags(
    fullReport({ market: { ...fullReport().market, calibrated: { home: 0.38, draw: 0.05, away: 0.57 } } })
  );
  check(
    '« Serré » exige aussi des victoires proches',
    !ids(wide.tags).includes('tight'),
    ids(wide.tags).join(',')
  );
  void result;
}

/* --- Favori net --------------------------------------------------- */
{
  const result = computeMatchTags(
    fullReport({ market: { ...fullReport().market, calibrated: { home: 0.58, draw: 0.3, away: 0.12 } } })
  );
  check('un favori à 58 % avec 28 pts d’avance est « Favori net »', ids(result.tags).includes('clear-favourite'), ids(result.tags).join(','));
  const favourite = result.tags.find(tag => tag.id === 'clear-favourite');
  check('la raison de « Favori net » cite le nom de l’équipe', Boolean(favourite && favourite.reason.includes('Arsenal')), favourite?.reason);
}
{
  const result = computeMatchTags(
    fullReport({ market: { ...fullReport().market, calibrated: { home: 0.58, draw: 0.4, away: 0.02 } } })
  );
  check(
    'un favori à 58 % mais seulement 18 pts d’avance n’est pas « Favori net »',
    !ids(result.tags).includes('clear-favourite'),
    ids(result.tags).join(',')
  );
}
{
  const result = computeMatchTags(
    fullReport({ market: { ...fullReport().market, calibrated: { home: 0.5, draw: 0.3, away: 0.2 } } })
  );
  check('un favori à 50 % n’est pas « Favori net »', !ids(result.tags).includes('clear-favourite'), ids(result.tags).join(','));
}

/* --- Volume de buts ------------------------------------------------ */
{
  const result = computeMatchTags(
    fullReport({ simulation: { expectedGoals: { home: 1.8, away: 1.5, total: 3.3 }, over25: 0.58, btts: 0.6 } })
  );
  check('3,3 buts attendus donnent « Beaucoup de buts »', ids(result.tags).includes('high-scoring'), ids(result.tags).join(','));
  check('et pas « Peu de buts »', !ids(result.tags).includes('low-scoring'), ids(result.tags).join(','));
}
{
  const result = computeMatchTags(
    fullReport({ simulation: { expectedGoals: { home: 1.2, away: 0.9, total: 2.1 }, over25: 0.35, btts: 0.4 } })
  );
  check('2,1 buts attendus donnent « Peu de buts »', ids(result.tags).includes('low-scoring'), ids(result.tags).join(','));
  check('et pas « Beaucoup de buts »', !ids(result.tags).includes('high-scoring'), ids(result.tags).join(','));
}
{
  // Total neutre, la probabilité « +2,5 » tranche.
  const high = computeMatchTags(
    fullReport({ simulation: { expectedGoals: { home: 1.3, away: 1.2, total: 2.5 }, over25: 0.62, btts: 0.5 } })
  );
  const low = computeMatchTags(
    fullReport({ simulation: { expectedGoals: { home: 1.3, away: 1.2, total: 2.5 }, over25: 0.38, btts: 0.5 } })
  );
  check('« +2,5 buts » à 62 % donne « Beaucoup de buts »', ids(high.tags).includes('high-scoring'), ids(high.tags).join(','));
  check('« +2,5 buts » à 38 % donne « Peu de buts »', ids(low.tags).includes('low-scoring'), ids(low.tags).join(','));
}
{
  // Signaux contradictoires : une seule étiquette, jamais les deux.
  const result = computeMatchTags(
    fullReport({ simulation: { expectedGoals: { home: 1.8, away: 1.5, total: 3.3 }, over25: 0.3, btts: 0.5 } })
  );
  const both = ids(result.tags).includes('high-scoring') && ids(result.tags).includes('low-scoring');
  check('des signaux contradictoires ne produisent jamais les deux étiquettes', !both, ids(result.tags).join(','));
  check('et le conflit est signalé', result.warnings.some(w => w.includes('se contredisent')), result.warnings.join(' | '));
}

/* --- Value --------------------------------------------------------- */
{
  const result = computeMatchTags(
    fullReport({
      market: {
        available: true,
        calibrated: { home: 0.42, draw: 0.29, away: 0.29 },
        edges: { home: 0.06, draw: 0, away: 0 },
        odds: { home: 2.3, draw: 3.4, away: 3.1 },
      },
    })
  );
  check('un écart de 6 % sur une cote de 2,30 donne « Value »', ids(result.tags).includes('value'), ids(result.tags).join(','));
  const value = result.tags.find(tag => tag.id === 'value');
  check('la raison de « Value » est chiffrée', Boolean(value && value.reason.includes('6 pts') && value.reason.includes('2,30')), value?.reason);
}
{
  // Seuil selon la cote : 2 % ≤ 3, 5 % entre 3 et 6, 8 % au-delà.
  check('le seuil de valeur suit la cote', valueEdgeThreshold(2.3, false) === 0.02 && valueEdgeThreshold(4, false) === 0.05 && valueEdgeThreshold(8, false) === 0.08);
  check('un match serré ajoute 2 points de seuil', valueEdgeThreshold(2.3, true) === 0.04);
}
{
  // Écart de 3 % : suffisant seul, insuffisant sur un match serré.
  const open = computeMatchTags(
    fullReport({
      market: {
        available: true,
        calibrated: { home: 0.5, draw: 0.28, away: 0.22 },
        edges: { home: 0.03, draw: 0, away: 0 },
        odds: { home: 2.3, draw: 3.4, away: 3.1 },
      },
    })
  );
  const tight = computeMatchTags(
    fullReport({
      market: {
        available: true,
        calibrated: { home: 0.36, draw: 0.3, away: 0.34 },
        edges: { home: 0.03, draw: 0, away: 0 },
        odds: { home: 2.3, draw: 3.4, away: 3.1 },
      },
    })
  );
  check('un écart de 3 % est retenu sur un match ouvert', ids(open.tags).includes('value'), ids(open.tags).join(','));
  check('le même écart est écarté sur un match serré', !ids(tight.tags).includes('value'), ids(tight.tags).join(','));
}
{
  // Le moteur refuse d'annoncer une valeur : l'étiquette ne doit pas
  // contredire ce verdict.
  const result = computeMatchTags(
    fullReport({
      calibration: { valueThresholdDemonstrated: false },
      market: {
        available: true,
        calibrated: { home: 0.42, draw: 0.29, away: 0.29 },
        edges: { home: 0.09, draw: 0, away: 0 },
        odds: { home: 2.3, draw: 3.4, away: 3.1 },
      },
    })
  );
  check('aucune étiquette « Value » quand aucun seuil n’est démontré', !ids(result.tags).includes('value'), ids(result.tags).join(','));
  check('et la raison est expliquée', result.warnings.some(w => w.includes('seuil de valeur')), result.warnings.join(' | '));
}
{
  const result = computeMatchTags(
    fullReport({
      market: {
        available: false,
        calibrated: { home: 0.42, draw: 0.29, away: 0.29 },
        edges: { home: 0.09, draw: 0, away: 0 },
        odds: { home: 2.3, draw: 3.4, away: 3.1 },
      },
    })
  );
  check('pas de « Value » sans cote réelle', !ids(result.tags).includes('value'), ids(result.tags).join(','));
  check('et l’absence de cote est signalée', result.warnings.some(w => w.includes('Cotes de marché indisponibles')), result.warnings.join(' | '));
}
{
  const result = computeMatchTags(
    fullReport({
      confidence: { score: 40, label: 'Faible' },
      market: {
        available: true,
        calibrated: { home: 0.42, draw: 0.29, away: 0.29 },
        edges: { home: 0.09, draw: 0, away: 0 },
        odds: { home: 2.3, draw: 3.4, away: 3.1 },
      },
    })
  );
  check('pas de « Value » quand la confiance est basse', !ids(result.tags).includes('value'), ids(result.tags).join(','));
}

/* --- Piège --------------------------------------------------------- */
{
  const result = computeMatchTags(
    fullReport({
      absences: { officialLineup: { available: false, confirmed: false } },
      minutesToKickoff: 25,
    })
  );
  check('une composition non publiée à l’approche du match est un « Piège »', ids(result.tags).includes('trap'), ids(result.tags).join(','));
  const trap = result.tags.find(tag => tag.id === 'trap');
  check('la raison du piège cite la composition', Boolean(trap && trap.reason.includes('composition')), trap?.reason);
}
{
  const result = computeMatchTags(
    fullReport({
      absences: { officialLineup: { available: false, confirmed: false } },
      minutesToKickoff: 4000,
    })
  );
  check('une composition non publiée loin du match n’est pas un « Piège »', !ids(result.tags).includes('trap'), ids(result.tags).join(','));
}
{
  const result = computeMatchTags(
    fullReport({
      context: {
        home: { restDays: 2, fatigue: 0.72 },
        away: { restDays: 3, fatigue: 0.4 },
        stakes: { home: 'x', away: 'y', homeFactor: 1.02, awayFactor: 1.02 },
      },
    })
  );
  const trap = result.tags.find(tag => tag.id === 'trap');
  check('une fatigue élevée est un « Piège »', Boolean(trap && trap.reason.includes('fatigue')), trap?.reason);
}
{
  const result = computeMatchTags(
    fullReport({
      context: {
        home: { restDays: 5, fatigue: 0.3 },
        away: { restDays: 5, fatigue: 0.3 },
        stakes: { home: 'Match de milieu de tableau', away: 'y', homeFactor: 0.985, awayFactor: 1.02 },
      },
    })
  );
  const trap = result.tags.find(tag => tag.id === 'trap');
  check('un enjeu faible est un « Piège »', Boolean(trap && trap.reason.includes('enjeu limité')), trap?.reason);
}
{
  const result = computeMatchTags(fullReport({ confidence: { score: 48, label: 'Faible' } }));
  const trap = result.tags.find(tag => tag.id === 'trap');
  check('une confiance basse est un « Piège »', Boolean(trap && trap.reason.includes('confiance faible')), trap?.reason);
}

/* --- Données manquantes -------------------------------------------- */
{
  const empty = computeMatchTags(null);
  check('sans rapport, aucune étiquette', empty.tags.length === 0, ids(empty.tags).join(','));
  check('sans rapport, un avertissement est produit', empty.warnings.length > 0, empty.warnings.join(' | '));

  const partial = computeMatchTags({ market: { available: false } });
  check('sans probabilités, ni « Serré » ni « Favori net »', !ids(partial.tags).includes('tight') && !ids(partial.tags).includes('clear-favourite'), ids(partial.tags).join(','));
  check('et l’absence est expliquée', partial.warnings.some(w => w.includes('Probabilités indisponibles')), partial.warnings.join(' | '));

  // Un match intermédiaire (2,5 buts attendus, +2,5 à 46 %) ne porte
  // aucune étiquette : c'est le comportement attendu.
  const raw = computeMatchTags(rawReport());
  check('un match intermédiaire ne porte aucune étiquette', raw.tags.length === 0, ids(raw.tags).join(','));
  check('le calque brut ne produit jamais de « Value »', !ids(raw.tags).includes('value'), ids(raw.tags).join(','));
  check('le calque brut signale les écarts indisponibles', raw.warnings.some(w => w.includes('Écarts modèle/marché indisponibles')), raw.warnings.join(' | '));

  // Un match fermé du même calque brut porte « Peu de buts ».
  const rawLow = computeMatchTags(rawReport({ expectedGoals: { home: 0.7, away: 0.9 } }));
  check('le calque brut produit les étiquettes de buts', ids(rawLow.tags).includes('low-scoring'), ids(rawLow.tags).join(','));
  const rawHigh = computeMatchTags(rawReport({ expectedGoals: { home: 1.9, away: 1.7 } }));
  check('le calque brut sait aussi dire « Beaucoup de buts »', ids(rawHigh.tags).includes('high-scoring'), ids(rawHigh.tags).join(','));
}

/* --- NaN, déterminisme, ordre, badges ------------------------------ */
{
  const broken = computeMatchTags({
    homeName: 'A',
    awayName: 'B',
    market: {
      available: true,
      calibrated: { home: Number.NaN, draw: undefined, away: null },
      edges: { home: Number.NaN, draw: null, away: undefined },
      odds: { home: Number.NaN, draw: null, away: undefined },
    },
    simulation: { expectedGoals: { home: Number.NaN, away: undefined, total: null }, over25: Number.NaN },
    confidence: { score: Number.NaN },
    context: { home: { fatigue: Number.NaN }, away: { fatigue: null }, stakes: { homeFactor: Number.NaN } },
    absences: { officialLineup: { available: true, confirmed: false } },
    minutesToKickoff: Number.NaN,
  });
  const texts = [...broken.tags.map(tag => tag.reason), ...broken.warnings];
  check('aucun NaN dans les raisons ni les avertissements', !texts.some(text => /NaN|undefined|Infinity/.test(text)), texts.join(' | '));
}
{
  const a = computeMatchTags(fullReport());
  const b = computeMatchTags(fullReport());
  check('la fonction est déterministe', JSON.stringify(a) === JSON.stringify(b));
}
{
  const result = computeMatchTags(
    fullReport({
      market: {
        available: true,
        calibrated: { home: 0.58, draw: 0.3, away: 0.12 },
        edges: { home: 0.06, draw: 0, away: 0 },
        odds: { home: 2.3, draw: 3.4, away: 3.1 },
      },
      simulation: { expectedGoals: { home: 1.8, away: 1.5, total: 3.3 }, over25: 0.62, btts: 0.6 },
    })
  );
  const order = MATCH_TAG_CONFIG.order;
  const positions = ids(result.tags).map(id => order.indexOf(id as never));
  const sorted = [...positions].sort((x, y) => x - y);
  check('les étiquettes sont rendues dans l’ordre de priorité', JSON.stringify(positions) === JSON.stringify(sorted), ids(result.tags).join(','));
  check('les six étiquettes de la configuration sont couvertes', MATCH_TAG_CONFIG.order.length === 6 && Object.keys(MATCH_TAG_LABELS).length === 6);
}
{
  const many = computeMatchTags(
    fullReport({
      market: {
        available: true,
        calibrated: { home: 0.36, draw: 0.3, away: 0.34 },
        edges: { home: 0.06, draw: 0, away: 0 },
        odds: { home: 2.3, draw: 3.4, away: 3.1 },
      },
      simulation: { expectedGoals: { home: 1.8, away: 1.5, total: 3.3 }, over25: 0.62, btts: 0.6 },
      confidence: { score: 48 },
      absences: { officialLineup: { available: false, confirmed: false } },
      minutesToKickoff: 20,
    })
  );
  check('une rencontre peut cumuler plusieurs étiquettes', many.tags.length >= 3, ids(many.tags).join(','));
  check('la carte n’affiche que 3 badges', pickBadges(many.tags).length === 3, String(pickBadges(many.tags).length));
  check('pickBadges tolère une valeur absente', pickBadges(null).length === 0 && pickBadges(undefined).length === 0);
}

/* --- Forme réelle de la production --------------------------------- */
{
  // Reprise de la forme exacte du rapport de production (Arsenal –
  // Manchester City) : le mapping des champs réels doit fonctionner.
  const productionLike: MatchTagReport = {
    homeName: 'Arsenal',
    awayName: 'Manchester City',
    minutesToKickoff: 5 * 24 * 60,
    market: {
      available: true,
      calibrated: { home: 0.4802, draw: 0.254, away: 0.2658, over25: 0.5503, btts: 0.5774 },
      edges: { home: 0, draw: 0, away: 0 },
      odds: { home: 2.06, draw: 3.87, away: 3.7, over25: 1.79 },
    },
    simulation: {
      expectedGoals: { home: 1.93, away: 1.39, total: 3.32 },
      over25: 0.6471,
      btts: 0.6718,
    },
    confidence: { score: 87, label: 'Modérée' },
    absences: { officialLineup: { available: false, confirmed: false } },
    context: {
      home: { restDays: 7, fatigue: 0.62 },
      away: { restDays: 8, fatigue: 0.62 },
      stakes: { home: 'Course européenne', away: 'Course européenne', homeFactor: 1.035, awayFactor: 1.035 },
    },
    calibration: { valueThresholdDemonstrated: false },
  };
  const result = computeMatchTags(productionLike);
  check(
    'la forme réelle de la production donne « Beaucoup de buts »',
    ids(result.tags).includes('high-scoring'),
    ids(result.tags).join(',')
  );
  check(
    'la forme réelle de la production n’annonce aucune « Value » (aucun seuil démontré)',
    !ids(result.tags).includes('value'),
    ids(result.tags).join(',')
  );
  check(
    'la forme réelle de la production ne signale pas de piège sans signal',
    !ids(result.tags).includes('trap'),
    ids(result.tags).join(',')
  );
}

// ---------------------------------------------------------------------------
// PAGE PRONOSTICS : invariants de transparence
// ---------------------------------------------------------------------------
{
  const pagePath = join(process.cwd(), 'app', 'pronostics', 'page.tsx');
  const cssPath = join(process.cwd(), 'app', 'globals.css');
  const pageSource = readFileSync(pagePath, 'utf-8');
  const cssSource = readFileSync(cssPath, 'utf-8');

  // La page SportHub met en avant un SCORE EXACT (« Merseyside 1-2 City »).
  // C'est le chiffre le plus visible et le moins fiable : la carte Terrain
  // affiche les λ, sortie réelle du modèle.
  check(
    'pronostics : la carte affiche les λ, jamais un score exact prédit',
    pageSource.includes('predLambda') && !/score\s*[α-ω]?prédit/i.test(pageSource),
    'recherche de « score prédit »'
  );
  check(
    'pronostics : la distribution est une barre à trois segments nommés',
    ['predSegHome', 'predSegDraw', 'predSegAway'].every(cls => pageSource.includes(cls)),
    'segments dom/nul/ext'
  );
  check(
    'pronostics : le score de confiance est mesuré, pas décoratif',
    pageSource.includes('confidence.probability') &&
      pageSource.includes('confidence.interval'),
    'probabilité mesurée + intervalle'
  );
  check(
    'pronostics : aucun taux de réussite écrit à la main',
    !/\b\d{2}\s*%\s*(de\s+)?(réussite|correct|accuracy)/i.test(pageSource),
    'taux en dur'
  );
  check(
    'pronostics : charte Terrain conservée (vert maison, pas la palette du modèle)',
    cssSource.includes('--green') && !cssSource.includes('#097a41'),
    'absence du vert #097a41 du template'
  );
  check(
    'pronostics : le tableau de confiance ne repose pas sur la couleur seule',
    pageSource.includes('TIER_LABEL') && pageSource.includes('aria-label'),
    'libellés + rôles ARIA'
  );
}

// ---------------------------------------------------------------------------
// BANDEAU DE SCORES : accessible, respectueux de la réduction de mouvement
// ---------------------------------------------------------------------------
{
  const tickerPath = join(process.cwd(), 'app', 'components', 'ScoreTicker.tsx');
  const tickerSource = readFileSync(tickerPath, 'utf-8');
  const cssSource = readFileSync(join(process.cwd(), 'app', 'globals.css'), 'utf-8');

  check(
    'ticker : défilement coupé si l’utilisateur réduit les animations',
    cssSource.includes('prefers-reduced-motion') &&
      /\.tickerRail\{animation:none\}/.test(cssSource.replace(/\s+/g, '')),
    'règle reduced-motion'
  );
  check(
    'ticker : le bandeau est masquable et correctement étiqueté',
    tickerSource.includes('aria-label="Masquer le bandeau des scores"') &&
      tickerSource.includes('aria-label="Scores du jour"'),
    'rôles ARIA'
  );
  check(
    'ticker : la seconde copie n’est pas dans l’ordre de tabulation',
    tickerSource.includes("tabIndex={index < rows.length ? 0 : -1}"),
    'tabindex conditionnel'
  );
  check(
    'ticker : il disparaît quand aucune rencontre n’est disponible',
    tickerSource.includes("status === 'empty'") && tickerSource.includes('return null'),
    'état vide'
  );
  check(
    'pronostics : un renversement de marché est signalé, pas masqué',
    readFileSync(join(process.cwd(), 'app', 'pronostics', 'page.tsx'), 'utf-8').includes('predDiverge'),
    'mention de divergence'
  );
  check(
    'ticker : les états ESPN sont traduits (pre / in / post)',
    tickerSource.includes("=== 'in'") && tickerSource.includes("=== 'post'"),
    'mapping des états'
  );
}

console.log('');
if (failures) {
  console.log(`✗ ${failures} contrôle(s) en échec\n`);
  process.exit(1);
}
console.log('✓ Tous les contrôles des étiquettes sont passés\n');
