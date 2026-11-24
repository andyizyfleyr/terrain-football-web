#!/usr/bin/env node
/**
 * TEST DE FUMÉE DE LA PRODUCTION
 * =================================================================
 * Vérifie que le site en ligne sert bien des données complètes.
 *
 * Pourquoi ce script existe : les régressions les plus coûteuses de
 * ce projet n'ont jamais été des erreurs de compilation, mais des
 * ruptures SILENCIEUSES de la chaîne de données — ESPN qui change de
 * format, une limitation de débit qui vide la forme, une route du
 * front qui renvoie 404. Les tests hors réseau ne les voient pas :
 * seul un appel réel à la production les révèle.
 *
 * Contrôles effectués :
 *   1. /api/health      — service vivant, moteur joignable ;
 *   2. /api/meta        — contrat : 16 marchés, 10 000 simulations ;
 *   3. /api/leagues     — catalogue des compétitions ;
 *   4. /api/fixtures    — une journée de calendrier non vide ;
 *   5. /api/analyze     — analyse complète, forme non vide, gd réel ;
 *   6. /api/debug/espn  — chemin de fetch ESPN actif ;
 *   7. accueil web      — calendrier rendu (pas d'erreur) ;
 *   8. page match web   — fiche de match rendue.
 *
 * Usage :
 *   node scripts/smoke-production.mjs
 *   API_BASE=https://... WEB_BASE=https://... node scripts/smoke-production.mjs
 *
 * Code de sortie : 0 si tout va bien, 1 sinon.
 */

const API_BASE = (process.env.API_BASE || 'https://terrain-football-api.vercel.app').replace(/\/$/, '');
const WEB_BASE = (process.env.WEB_BASE || 'https://terrain-football-web.vercel.app').replace(/\/$/, '');

const failures = [];
const warnings = [];
let checks = 0;

function check(label, condition, detail = '') {
  checks += 1;
  if (condition) {
    console.log(`  ok   ${label}`);
  } else {
    failures.push(label);
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

function warn(label, detail = '') {
  warnings.push(label);
  console.log(`  warn ${label}${detail ? ` — ${detail}` : ''}`);
}

async function getJson(url, timeoutMs = 45000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: 'application/json' },
    });
    const text = await response.text();
    let body = null;
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
    return { ok: response.ok, status: response.status, body, text };
  } catch (error) {
    return { ok: false, status: 0, body: null, text: '', error: String(error) };
  } finally {
    clearTimeout(timer);
  }
}

async function getText(url, timeoutMs = 45000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal, redirect: 'follow' });
    const text = await response.text();
    return { ok: response.ok, status: response.status, text };
  } catch (error) {
    return { ok: false, status: 0, text: '', error: String(error) };
  } finally {
    clearTimeout(timer);
  }
}

/** Le jour de la semaine (0 = lundi) pour décaler une date. */
function shiftDays(date, delta) {
  const copy = new Date(date.getTime());
  copy.setUTCDate(copy.getUTCDate() + delta);
  return copy;
}

const compact = (date) =>
  `${date.getUTCFullYear()}${String(date.getUTCMonth() + 1).padStart(2, '0')}${String(
    date.getUTCDate()
  ).padStart(2, '0')}`;
const dashed = (date) =>
  `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(
    date.getUTCDate()
  ).padStart(2, '0')}`;

console.log(`Test de fumée — API ${API_BASE}`);
console.log(`Test de fumée — web ${WEB_BASE}`);
console.log('');

console.log('1. Santé du service');
{
  const res = await getJson(`${API_BASE}/api/health`);
  check('API joignable', res.ok, `HTTP ${res.status} ${res.error || ''}`);
  check('statut "ok"', res.body?.status === 'ok', JSON.stringify(res.body || {}).slice(0, 160));
  check('moteur joignable', res.body?.engine?.reachable === true, JSON.stringify(res.body?.engine || {}));
}

console.log('');
console.log('2. Contrat du moteur');
{
  const res = await getJson(`${API_BASE}/api/meta`);
  check('contrat disponible', res.ok, `HTTP ${res.status}`);
  check('16 marchés annoncés', res.body?.analysis?.markets === 16, JSON.stringify(res.body?.analysis || {}));
  check('10 000 simulations', res.body?.analysis?.simulations === 10000, JSON.stringify(res.body?.analysis || {}));
}

console.log('');
console.log('3. Catalogue des compétitions');
{
  const res = await getJson(`${API_BASE}/api/leagues`);
  const leagues = res.body?.leagues || [];
  check('catalogue servi', res.ok && leagues.length >= 10, `${leagues.length} compétitions`);
  check('Premier League présente', leagues.some((l) => l.slug === 'eng.1'), '');
  check('LaLiga présente', leagues.some((l) => l.slug === 'esp.1'), '');
  check(
    'Bundesliga présente sous son slug ESPN',
    leagues.some((l) => l.slug === 'ger.1'),
    leagues.map((l) => l.slug).join(',')
  );
}

console.log('');
console.log('3b. Couverture de chaque compétition cataloguée');
{
  // Regression corrigee : la Bundesliga etait cataloguee sous le slug
  // `deu.1`, inconnu d'ESPN (qui ne publie que `ger.1`). ESPN repondait
  // HTTP 400 et le calendrier restait vide - sans aucune erreur visible.
  //
  // On verifie donc que TOUTE competition annoncee sert un calendrier :
  // un slug ESPN invalide se voit immediatement.
  const res = await getJson(`${API_BASE}/api/leagues`);
  const leagues = res.body?.leagues || [];

  // Un catalogue vide ne doit pas passer pour une couverture complete :
  // sans competition a tester, la boucle ne testerait rien.
  check('catalogue exploitable pour la couverture', leagues.length > 0, `${leagues.length} competitions`);

  // Une ligue peut etre en pause (coupe du monde, treve) et ne servir
  // aucun match pendant plusieurs semaines : il faut donc une journee
  // REELLEMENT jouee, pas une simple fenetre de dates.
  //
  // ESPN publie le calendrier de la saison dans le scoreboard, et l'API
  // le relaie : on s'en sert pour retrouver la derniere journee jouee.
  const today = new Date();
  const todayCompact = compact(today);

  const empty = [];
  const withCalendar = [];
  for (const league of leagues) {
    const probe = await getJson(`${API_BASE}/api/fixtures?league=${league.slug}&date=${todayCompact}`);
    const calendar = probe.body?.calendar || [];

    // Journees deja jouees, de la plus recente a la plus ancienne.
    const played = calendar.filter((day) => day < todayCompact).sort().reverse();

    let served = false;
    for (const day of played.slice(0, 3)) {
      const dayRes = await getJson(`${API_BASE}/api/fixtures?league=${league.slug}&date=${day}`);
      if (dayRes.ok && (dayRes.body?.events || []).length) {
        served = true;
        break;
      }
    }

    // Repli : si l'API ne renvoie pas de calendrier, on balaie une
    // fenetre de dates (au cas ou le champ viendrait a manquer).
    if (!served && !calendar.length) {
      for (let back = 1; back <= 14; back += 1) {
        const date = compact(shiftDays(today, -back));
        const dayRes = await getJson(`${API_BASE}/api/fixtures?league=${league.slug}&date=${date}`);
        if (dayRes.ok && (dayRes.body?.events || []).length) {
          served = true;
          break;
        }
      }
    }

    if (!served) empty.push(league.slug);
    if (calendar.length) withCalendar.push(league.slug);
  }
  check(
    'toutes les competitions cataloguees servent un calendrier',
    leagues.length > 0 && empty.length === 0,
    `sans match : ${empty.join(', ')}`
  );
  check(
    'chaque competition publie les journees de sa saison',
    leagues.length > 0 && withCalendar.length === leagues.length,
    `${withCalendar.length}/${leagues.length} competitions avec calendrier`
  );
}

console.log('');
console.log('4. Calendrier (journées ESPN)');
let sampleFixture = null;
let sampleDate = null;
{
  // On remonte le temps : une journée passée a forcément des matchs.
  const today = new Date();
  for (let back = 1; back <= 10 && !sampleFixture; back += 1) {
    const day = shiftDays(today, -back);
    const res = await getJson(`${API_BASE}/api/fixtures?league=eng.1&date=${compact(day)}`);
    const events = res.body?.events || [];
    if (res.ok && events.length) {
      sampleFixture = events[0];
      sampleDate = day;
    }
  }
  check('une journée de calendrier est servie', Boolean(sampleFixture), 'aucun match sur les 10 derniers jours');
  if (sampleFixture) {
    check(
      'fixture au format du front',
      ['id', 'date', 'home', 'away'].every((key) => key in sampleFixture),
      JSON.stringify(sampleFixture).slice(0, 160)
    );
  }
}

console.log('');
console.log('5. Analyse complète (données ESPN)');
if (sampleFixture && sampleDate) {
  const matchId = sampleFixture.id;
  const res = await getJson(
    `${API_BASE}/api/analyze?league=eng.1&date=${compact(sampleDate)}&match=${matchId}`
  );
  const match = res.body?.matches?.[0];
  check('analyse servie', res.ok, `HTTP ${res.status}`);
  check('analyse marquée "complete"', res.body?.analysis === 'complete', String(res.body?.analysis));
  check('forme domicile non vide', Boolean(match?.factors?.forme?.home?.trim()), String(match?.factors?.forme?.home));
  check('forme extérieure non vide', Boolean(match?.factors?.forme?.away?.trim()), String(match?.factors?.forme?.away));
  check(
    'historique de forme alimenté',
    Array.isArray(match?.factors?.forme?.detailHome) && match.factors.forme.detailHome.length > 0,
    `${match?.factors?.forme?.detailHome?.length || 0} matchs`
  );
  const gdHome = match?.factors?.enjeu?.classementHome?.gd;
  const gdAway = match?.factors?.enjeu?.classementAway?.gd;
  check('différence de buts réelle (dom)', typeof gdHome === 'number' && gdHome !== 0, String(gdHome));
  check('différence de buts réelle (ext)', typeof gdAway === 'number' && gdAway !== 0, String(gdAway));
  check('classement renseigné', Boolean(match?.factors?.enjeu?.classementHome?.name), '');
  check('style de jeu disponible', Boolean(match?.factors?.style?.home), JSON.stringify(match?.factors?.style || {}));
  check('bloc analyst présent', Boolean(match?.analyst?.pronostics), '');
  check('simulation à 10 000 itérations', match?.analyst?.simulation?.runs === 10000, String(match?.analyst?.simulation?.runs));
} else {
  warn('analyse complète non vérifiée (aucun match de référence)');
}

console.log('');
console.log('6. Diagnostic ESPN');
{
  const res = await getJson(`${API_BASE}/api/debug/espn?league=eng.1&team=306`);
  check('diagnostic accessible', res.ok, `HTTP ${res.status}`);
  check('calendrier d\'équipe terminé', (res.body?.schedule?.completed || 0) > 0, `${res.body?.schedule?.completed} matchs`);
  check('historique d\'équipe non vide', (res.body?.team_history?.count || 0) > 0, `${res.body?.team_history?.count} matchs`);
  check('chemin de fetch explicite', Boolean(res.body?.fetch_path?.source), '');
  const errors = (res.body?.fetch_log || []).filter((entry) => entry.error || (entry.status && entry.status >= 400));
  check('aucune erreur ESPN dans le journal', errors.length === 0, `${errors.length} erreur(s) : ${JSON.stringify(errors.slice(0, 2))}`);
}

console.log('');
console.log('7. Accueil du site');
{
  const res = await getText(`${WEB_BASE}/`);
  check('accueil servi', res.ok, `HTTP ${res.status}`);
  check('calendrier rendu', /matchs/i.test(res.text) && !/calendrier est temporairement indisponible/i.test(res.text), '');
  check('sélecteur de compétition', /Premier League|eng\.1/i.test(res.text), '');
}

console.log('');
console.log('8. Fiche de match');
if (sampleFixture && sampleDate) {
  const res = await getText(`${WEB_BASE}/match/eng.1/${dashed(sampleDate)}/${sampleFixture.id}`);
  check('fiche de match servie', res.ok, `HTTP ${res.status}`);
  check('pas d\'écran d\'erreur Next.js', !/This page couldn.t load/i.test(res.text), '');
  check('analyse affichée', /xG|MOTEUR QUANTITATIF|MOD/i.test(res.text), '');
} else {
  warn('fiche de match non vérifiée (aucun match de référence)');
}

console.log('');
console.log('─'.repeat(60));
if (warnings.length) console.log(`${warnings.length} avertissement(s) : ${warnings.join(' · ')}`);
if (failures.length) {
  console.log(`✗ ${failures.length} contrôle(s) en échec sur ${checks} :`);
  for (const label of failures) console.log(`   - ${label}`);
  process.exit(1);
}
console.log(`✓ Tous les contrôles de production sont passés (${checks} contrôles)`);
