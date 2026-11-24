/* ------------------------------------------------------------------ */
/* JEU DE DONNÉES FOOTBALL-DATA.CO.UK                                   */
/* ------------------------------------------------------------------ */
/*
 * Chargeur du jeu de données importé par `npm run import:football-data`.
 *
 * Contenu de `data/football-data/` :
 *   - `matches.csv`   : rencontres normalisées (résultat, mi-temps, cotes) ;
 *   - `teams.csv`     : identité stable des équipes ;
 *   - `manifest.json` : provenance et couverture.
 *
 * ANTI-FUITE TEMPORELLE — ce qui est transmis au moteur et ce qui ne
 * l'est pas :
 *   - le RESULTAT et le score à la mi-temps servent à reconstruire les
 *     cumuls des matchs ANTÉRIEURS (fait par le rejeu walk-forward) ;
 *   - les COTES d'ouverture (Bet365, Pinnacle, moyenne du marché) sont
 *     des informations d'avant-match : elles sont transmises ;
 *   - l'ARBITRE et les statistiques de match (tirs, cartons) sont
 *     collectés APRÈS la rencontre : ils ne sont PAS transmis au
 *     moteur. L'arbitre d'un match est connu avant le coup d'envoi, mais
 *     son profil (cartons, fautes par match) ne peut être reconstruit
 *     qu'en connaissant les matchs précédents : le conserver tel quel
 *     reviendrait à faire entrer de l'information future dans le modèle ;
 *   - les totaux de saison (équipes et joueurs) ne sont pas stockés :
 *     ils seraient collectés après coup.
 *
 * Le module est réservé aux scripts Node (il lit le disque) : il n'est
 * jamais importé par l'application web.
 */

import { readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { BacktestDataset, BacktestMatch, BacktestTeamSnapshot } from './backtest';

export type FootballDataManifest = {
  generatedAt: string;
  source: string;
  sources: Record<string, number>;
  seasons: string[];
  divisions: { div: string; league: string; label: string }[];
  matches: number;
  teams: number;
  coverage: Record<string, number>;
  perSeason: Record<string, number>;
  period: string;
};

export type FootballDataBundle = {
  manifest: FootballDataManifest;
  /** Un jeu de données par championnat (rejeu indépendant). */
  byLeague: Map<string, BacktestDataset>;
  /** Tous les championnats réunis. */
  all: BacktestDataset;
};

const DIV_TO_LEAGUE: Record<string, string> = {
  E0: 'eng.1',
  SP1: 'esp.1',
  I1: 'ita.1',
  D1: 'deu.1',
  F1: 'fra.1',
};

function splitCsvLine(line: string): string[] {
  const cells: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (quoted) {
      if (char === '"') {
        if (line[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        field += char;
      }
      continue;
    }
    if (char === '"') {
      quoted = true;
      continue;
    }
    if (char === ',') {
      cells.push(field.trim());
      field = '';
      continue;
    }
    field += char;
  }
  cells.push(field.trim());
  return cells;
}

function num(value: string | undefined): number | null {
  if (value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Charge le jeu de données depuis le disque. */
export function loadFootballData(directory = resolve('data/football-data')): FootballDataBundle {
  const matchesPath = join(directory, 'matches.csv');
  const manifestPath = join(directory, 'manifest.json');
  if (!existsSync(matchesPath) || !existsSync(manifestPath)) {
    throw new Error(
      `Jeu de données absent (${directory}). Lancez : npm run import:football-data`
    );
  }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as FootballDataManifest;
  const lines = readFileSync(matchesPath, 'utf-8').split('\n').filter(Boolean);
  const header = splitCsvLine(lines[0]);
  const index = new Map(header.map((name, position) => [name, position]));

  const matches: BacktestMatch[] = [];
  const teamNames = new Map<number, { league: string; name: string }>();

  for (let lineIndex = 1; lineIndex < lines.length; lineIndex++) {
    const cells = splitCsvLine(lines[lineIndex]);
    const cell = (name: string): string => {
      const position = index.get(name);
      return position === undefined ? '' : (cells[position] ?? '');
    };

    const div = cell('div');
    const league = DIV_TO_LEAGUE[div] || div;
    const homeId = num(cell('homeId'));
    const awayId = num(cell('awayId'));
    const homeGoals = num(cell('homeGoals'));
    const awayGoals = num(cell('awayGoals'));
    const date = cell('date');
    if (homeId === null || awayId === null || homeGoals === null || awayGoals === null || !date) continue;

    const homeName = cell('homeName');
    const awayName = cell('awayName');
    teamNames.set(homeId, { league, name: homeName });
    teamNames.set(awayId, { league, name: awayName });

    const b365 = tripleOf(num(cell('b365Home')), num(cell('b365Draw')), num(cell('b365Away')));
    const pinnacle = tripleOf(num(cell('psHome')), num(cell('psDraw')), num(cell('psAway')));
    const average = tripleOf(num(cell('avHome')), num(cell('avDraw')), num(cell('avAway')));
    const oddsByProvider: Record<string, { home: number; draw: number; away: number }> = {};
    if (b365) oddsByProvider.bet365 = b365;
    if (pinnacle) oddsByProvider.pinnacle = pinnacle;
    if (average) oddsByProvider.marketAverage = average;

    const over = num(cell('over25'));
    const under = num(cell('under25'));
    const ahLine = num(cell('ahLine'));
    const ahHome = num(cell('ahHome'));
    const ahAway = num(cell('ahAway'));
    const derivedOdds: NonNullable<BacktestMatch['derivedOdds']> = {};
    if (over !== null && under !== null) derivedOdds.over25 = { over, under };
    if (ahLine !== null && ahHome !== null && ahAway !== null) {
      derivedOdds.ah = { line: ahLine, home: ahHome, away: ahAway };
    }

    matches.push({
      id: `${div}-${date}-${homeId}-${awayId}`,
      date,
      league,
      homeId,
      homeName,
      awayId,
      awayName,
      homeGoals,
      awayGoals,
      homeXg: null,
      awayXg: null,
      htHome: num(cell('htHome')),
      htAway: num(cell('htAway')),
      homeShots: num(cell('homeShots')),
      awayShots: num(cell('awayShots')),
      homeXgot: null,
      awayXgot: null,
      // Marché de référence de la calibration : Bet365.
      odds: b365,
      oddsByProvider,
      derivedOdds: Object.keys(derivedOdds).length ? derivedOdds : undefined,
      provider: 'Bet365',
      unavailableHome: [],
      unavailableAway: [],
      startersHome: [],
      startersAway: [],
      lineupConfirmedHome: false,
      lineupConfirmedAway: false,
      // L'arbitre et la météo ne sont pas transmis : voir l'en-tête du
      // fichier (anti-fuite temporelle).
      referee: null,
      weather: null,
      pitch: null,
    });
  }

  matches.sort((a, b) => a.date.localeCompare(b.date) || a.homeId - b.homeId);

  const teams: BacktestTeamSnapshot[] = Array.from(teamNames.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([id, info]) => ({
      id,
      name: info.name,
      players: [],
      stats: {},
    }));

  const byLeague = new Map<string, BacktestDataset>();
  for (const division of manifest.divisions) {
    const leagueMatches = matches.filter(match => match.league === division.league);
    if (!leagueMatches.length) continue;
    const leagueTeams = teams.filter(team => {
      const info = teamNames.get(team.id);
      return info ? info.league === division.league : false;
    });
    byLeague.set(division.league, {
      league: division.league,
      period: manifest.period,
      leagues: [division.league],
      teams: leagueTeams,
      matches: leagueMatches,
    });
  }

  const all: BacktestDataset = {
    league: manifest.divisions.map(d => d.league).join(' + '),
    period: manifest.period,
    leagues: manifest.divisions.map(d => d.league),
    teams,
    matches,
  };

  return { manifest, byLeague, all };
}

function tripleOf(
  home: number | null,
  draw: number | null,
  away: number | null
): { home: number; draw: number; away: number } | null {
  if (home === null || draw === null || away === null) return null;
  if (home <= 1 || draw <= 1 || away <= 1) return null;
  return { home, draw, away };
}
