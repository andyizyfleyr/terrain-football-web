/* ------------------------------------------------------------------ */
/* AVERTISSEMENTS « MATCH PIÈGE »                                      */
/* ------------------------------------------------------------------ */
/*
 * Certaines rencontres déjouent les pronostics plus que d'autres :
 * derby, rotation probable, données rares, changement d'entraîneur.
 *
 * Ces avertissements ne changent PAS la probabilité annoncée : ils
 * signalent au lecteur que la confiance doit être réduite. Une donnée
 * absente n'est jamais remplacée par une supposition : si l'information
 * n'est pas disponible (changement d'entraîneur, par exemple), l'avertissement
 * le dit explicitement au lieu d'inventer un signal.
 *
 * Sources de données utilisées :
 *   - calendrier des rencontres (dates disponibles avant le coup d'envoi) ;
 *   - tableau du championnat (nombre de rencontres jouées) ;
 *   - derbies : liste explicite par championnat (documentée, source :
 *     geography of the clubs — les derbies sont rares et/stable).
 */

export type TrapId = 'derby' | 'rotation' | 'sparse-data' | 'new-coach';

export type MatchTrap = {
  id: TrapId;
  label: string;
  severity: 'info' | 'warning';
  detail: string;
};

/**
 * Derbies connus par championnat (paire de noms de clubs).
 * Liste courte et stable : elle sert à signaler un contexte particulier,
 * pas à prédire le résultat.
 */
export const DERBIES: Record<string, string[][]> = {
  'eng.1': [
    ['Liverpool', 'Everton'],
    ['Manchester United', 'Manchester City'],
    ['Arsenal', 'Chelsea'],
    ['Arsenal', 'Tottenham Hotspur'],
    ['Tottenham Hotspur', 'West Ham United'],
    ['Newcastle United', 'Sunderland'],
    ['Brighton & Hove Albion', 'Crystal Palace'],
  ],
  'esp.1': [
    ['Barcelona', 'Espanyol'],
    ['Real Madrid', 'Atletico Madrid'],
    ['Sevilla', 'Real Betis'],
    ['Valencia', 'Villarreal'],
    ['Athletic Bilbao', 'Real Sociedad'],
    ['Real Betis', 'Sevilla'],
  ],
  'ita.1': [
    ['Inter', 'Milan'],
    ['Roma', 'Lazio'],
    ['Juventus', 'Torino'],
    ['Napoli', 'Salernitana'],
  ],
  'deu.1': [
    ['Bayern Munich', 'Borussia Dortmund'],
    ['Borussia Dortmund', 'Schalke 04'],
    ['Bayern Munich', '1860 Munich'],
    ['Hamburger SV', 'Werder Bremen'],
    ['Bayer Leverkusen', 'Fortuna Dusseldorf'],
  ],
  'fra.1': [
    ['Paris Saint-Germain', 'Paris FC'],
    ['Marseille', 'Toulouse'],
    ['Lyon', 'Saint-Etienne'],
    ['Bordeaux', 'Nantes'],
  ],
};

/** Normalise un nom de club pour la comparaison (accents, casse, espaces). */
function normaliseClub(name: string): string {
  return name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

const DERBY_INDEX = new Map<string, Set<string>>();
for (const [league, pairs] of Object.entries(DERBIES)) {
  const index = new Set<string>();
  for (const [home, away] of pairs) {
    index.add(`${normaliseClub(home)}|${normaliseClub(away)}`);
    index.add(`${normaliseClub(away)}|${normaliseClub(home)}`);
  }
  DERBY_INDEX.set(league, index);
}

/** true si les deux clubs forment un derby du championnat. */
export function isDerby(league: string | null, home: string, away: string): boolean {
  if (!league) return false;
  const index = DERBY_INDEX.get(league);
  if (!index) return false;
  return index.has(`${normaliseClub(home)}|${normaliseClub(away)}`);
}

/**
 * Détecte les avertissements « match piège ».
 *
 * `recentMatches` : les dernières rencontres de l'équipe (dates
 * disponibles avant le coup d'envoi).
 * `played` : nombre de rencontres déjà jouées au classement.
 * `coachChanged` : null quand l'information n'est pas disponible.
 */
export function detectMatchTraps(input: {
  league?: string | null;
  homeName: string;
  awayName: string;
  homeRecentDates?: string[];
  awayRecentDates?: string[];
  homePlayed?: number | null;
  awayPlayed?: number | null;
  kickoffIso?: string | null;
  coachChanged?: boolean | null;
}): MatchTrap[] {
  const traps: MatchTrap[] = [];

  if (isDerby(input.league ?? null, input.homeName, input.awayName)) {
    traps.push({
      id: 'derby',
      label: 'Derby',
      severity: 'warning',
      detail:
        'Les derbys s’écartent souvent des tendances de forme et de classement : ' +
        'la confiance annoncée doit être prise avec prudence.',
    });
  }

  // Repos exprimé en JOURS CALENDAIRES entre la dernière rencontre et le
  // coup d'envoi (convention football usuelle). Un calcul fractionnaire
  // surestimerait le repos des matchs du soir (4 h de plus = +0,17 jour).
  const daysSince = (dates: string[] | undefined, kickoff: string | null): number | null => {
    if (!dates || !dates.length || !kickoff) return null;
    const latest = dates.slice().sort().reverse()[0];
    const kickoffDay = kickoff.slice(0, 10);
    const latestDay = latest.slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(kickoffDay) || !/^\d{4}-\d{2}-\d{2}$/.test(latestDay)) {
      return null;
    }
    const difference =
      (Date.parse(`${kickoffDay}T00:00:00Z`) - Date.parse(`${latestDay}T00:00:00Z`)) / 86_400_000;
    return Number.isFinite(difference) ? difference : null;
  };
  const restHome = daysSince(input.homeRecentDates, input.kickoffIso ?? null);
  const restAway = daysSince(input.awayRecentDates, input.kickoffIso ?? null);
  const shortRest = [restHome, restAway].filter(
    (value): value is number => value !== null && value <= 3
  );
  if (shortRest.length) {
    traps.push({
      id: 'rotation',
      label: 'Rotation probable',
      severity: 'warning',
      detail:
        'Repos très court (' +
        shortRest.map(value => value.toFixed(1)).join(' et ') +
        ' jour(s) depuis la dernière rencontre) : ' +
        "une rotation de l'effectif est plausible et le effectif réel peut différer.",
    });
  }

  const sparse = [
    { name: input.homeName, played: input.homePlayed },
    { name: input.awayName, played: input.awayPlayed },
  ].filter(entry => typeof entry.played === 'number' && entry.played < 6);
  if (sparse.length) {
    traps.push({
      id: 'sparse-data',
      label: 'Données rares',
      severity: 'info',
      detail:
        `Peu de rencontres jouées (${sparse.map(entry => `${entry.name} : ${entry.played}`).join(', ')}) : ` +
        "l'estimation de force repose sur très peu de matchs.",
    });
  }

  if (input.coachChanged === true) {
    traps.push({
      id: 'new-coach',
      label: 'Nouvel entraîneur',
      severity: 'warning',
      detail:
        "Changement d'entraîneur signalé : l'historique de l'équipe ne décrit plus la même équipe " +
        "et les performances récentes sont moins fiables.",
    });
  } else if (input.coachChanged === null || input.coachChanged === undefined) {
    traps.push({
      id: 'new-coach',
      label: 'Nouvel entraîneur : information indisponible',
      severity: 'info',
      detail:
        "Information indisponible : les sources actuelles ne signalent pas les changements d'entraîneur. " +
        'Cette information ne peut être ni confirmée ni écartée.',
    });
  }

  return traps;
}
