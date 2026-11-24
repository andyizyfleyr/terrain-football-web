/* ------------------------------------------------------------------ */
/* IMPORTATEUR FOOTBALL-DATA.CO.UK                                     */
/* ------------------------------------------------------------------ */
/*
 * Ce script télécharge les archives CSV de football-data.co.uk, les
 * normalise et les écrit dans `data/football-data/` :
 *
 *   - `matches.csv`  : une ligne par rencontre, colonnes normalisées ;
 *   - `teams.csv`    : une ligne par équipe (identité stable) ;
 *   - `manifest.json` : provenance, couverture et compteurs.
 *
 * SOURCES (dans cet ordre) :
 *   1. football-data.co.uk (source canonique) ;
 *   2. miroir GitHub `kokosing/autobet` (API GitHub, contenu en base64) ;
 *   3. cache local `--cache <dossier>`.
 *
 * Le miroir n'est PAS la source de référence : il sert de secours quand
 * la source canonique est injoignable (réseau restreint, CI). Les deux
 * exposent le même contenu.
 *
 * ANTI-FUITE TEMPORELLE :
 *   - le fichier contient des DONNÉES DE MATCH (résultat, composition
 *     d'avant-match, cotes d'avant-match) : le rejeu walk-forward
 *     reconstruit tous les cumuls à partir des seules rencontres
 *     antérieures ;
 *   - l'identité des équipes (nom → identifiant) est une table de
 *     correspondance, pas une statistique : elle ne transporte aucune
 *     information sur les résultats ;
 *   - l'arbitre et les statistiques de match (tirs, cartons) sont
 *     collectés APRÈS la rencontre : ils ne sont pas transmis au
 *     moteur par le script de rejeu (voir app/lib/backtestDatasetFootballData.ts).
 *
 * Exécution :
 *   npm run import:football-data
 *   npm run import:football-data -- --seasons 1213,1314,1415,1516
 *   npm run import:football-data -- --source github --cache .cache/football-data
 */

import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

type Csv = Record<string, string>;

type DivisionConfig = {
  /** Code football-data.co.uk (E0, SP1…). */
  div: string;
  /** Identifiant de championnat utilisé par le moteur. */
  league: string;
  /** Libellé lisible. */
  label: string;
};

/* Divisions retenues : 5 divisions majeures, 8 saisons (2008-09 → 2015-16). */
const DIVISIONS: DivisionConfig[] = [
  { div: 'E0', league: 'eng.1', label: 'Premier League' },
  { div: 'SP1', league: 'esp.1', label: 'La Liga' },
  { div: 'I1', league: 'ita.1', label: 'Serie A' },
  { div: 'D1', league: 'deu.1', label: 'Bundesliga' },
  { div: 'F1', league: 'fra.1', label: 'Ligue 1' },
];

const DEFAULT_SEASONS = ['0809', '0910', '1011', '1112', '1213', '1314', '1415', '1516'];

const CANONICAL_BASE = 'https://www.football-data.co.uk/mmz4281';
const MIRROR_API = 'https://api.github.com/repos/kokosing/autobet/contents/data/www.football-data.co.uk/mmz4281';

const OUT_DIR = resolve('data/football-data');

/* ------------------------------------------------------------------ */
/* Utilitaires                                                         */
/* ------------------------------------------------------------------ */

/** Parseur CSV minimal mais correct (guillemets, virgules dans un champ). */
export function parseCsv(text: string): { header: string[]; rows: string[][] } {
  const rows: string[][] = [];
  let field = '';
  let row: string[] = [];
  let quoted = false;
  const clean = (value: string) => value.replace(/^\uFEFF/, '').trim();

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quoted) {
      if (char === '"') {
        if (text[i + 1] === '"') {
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
      row.push(clean(field));
      field = '';
      continue;
    }
    if (char === '\r') continue;
    if (char === '\n') {
      row.push(clean(field));
      if (row.some(cell => cell !== '')) rows.push(row);
      row = [];
      field = '';
      continue;
    }
    field += char;
  }
  if (field !== '' || row.length) {
    row.push(clean(field));
    if (row.some(cell => cell !== '')) rows.push(row);
  }
  if (!rows.length) return { header: [], rows: [] };
  const header = rows[0];
  return { header, rows: rows.slice(1) };
}

/** Normalise un nom d'équipe :minuscules, sans accents ni ponctuation. */
export function normaliseTeamName(name: string): string {
  return name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[.'`]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Date football-data (dd/mm/yy) → date ISO (aaaa-mm-jj). */
export function toIsoDate(raw: string, season: string): string | null {
  const match = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/.exec(raw.trim());
  if (!match) return null;
  const day = Number(match[1]);
  const month = Number(match[2]);
  let year = Number(match[3]);
  if (year < 100) {
    // Saison « 0809 » : l'année dépend du mois (août à mai).
    const seasonStart = 2000 + Number(String(season).slice(0, 2));
    year = month >= 7 ? seasonStart : seasonStart + 1;
  }
  if (!Number.isFinite(day) || !Number.isFinite(month) || !Number.isFinite(year)) return null;
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function toNumber(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  const trimmed = String(raw).trim();
  if (!trimmed) return null;
  const value = Number(trimmed);
  return Number.isFinite(value) ? value : null;
}

/* ------------------------------------------------------------------ */
/* Téléchargement                                                      */
/* ------------------------------------------------------------------ */

type Download = { text: string; origin: string };

async function download(season: string, div: string, cacheDir: string | null): Promise<Download | null> {
  if (cacheDir) {
    const cached = join(cacheDir, `${div}_${season}.csv`);
    if (existsSync(cached)) {
      return { text: readFileSync(cached, 'utf-8'), origin: 'cache' };
    }
  }

  // 1. Source canonique.
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20_000);
    const response = await fetch(`${CANONICAL_BASE}/${season}/${div}.csv`, {
      headers: { 'user-agent': 'terrain-football-importer/1.0' },
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (response.ok) {
      const text = await response.text();
      if (text.includes(',')) return { text, origin: 'football-data.co.uk' };
    }
  } catch {
    /* source canonique injoignable : on passe au miroir */
  }

  // 2. Miroir GitHub (contenu en base64).
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 25_000);
    const response = await fetch(`${MIRROR_API}/${season}/${div}.csv`, {
      headers: {
        accept: 'application/vnd.github+json',
        'user-agent': 'terrain-football-importer/1.0',
      },
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (response.ok) {
      const payload = (await response.json()) as { content?: string; encoding?: string };
      if (payload.content && payload.encoding === 'base64') {
        const text = Buffer.from(payload.content, 'base64').toString('utf-8');
        if (cacheDir) {
          mkdirSync(cacheDir, { recursive: true });
          writeFileSync(join(cacheDir, `${div}_${season}.csv`), text, 'utf-8');
        }
        return { text, origin: 'miroir GitHub (kokosing/autobet)' };
      }
    }
  } catch {
    /* miroir injoignable */
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Normalisation                                                       */
/* ------------------------------------------------------------------ */

export type NormalisedMatch = {
  div: string;
  season: string;
  date: string;
  time: string;
  homeId: number;
  homeName: string;
  awayId: number;
  awayName: string;
  homeGoals: number;
  awayGoals: number;
  htHome: number | null;
  htAway: number | null;
  referee: string;
  homeShots: number | null;
  awayShots: number | null;
  homeShotsOnTarget: number | null;
  awayShotsOnTarget: number | null;
  homeCorners: number | null;
  awayCorners: number | null;
  homeYellow: number | null;
  awayYellow: number | null;
  b365: { home: number; draw: number; away: number } | null;
  pinnacle: { home: number; draw: number; away: number } | null;
  marketAverage: { home: number; draw: number; away: number } | null;
  over25: { over: number; under: number } | null;
  ahLine: number | null;
  ahHome: number | null;
  ahAway: number | null;
};

const OUT_COLUMNS = [
  'div', 'season', 'date', 'time',
  'homeId', 'homeName', 'awayId', 'awayName',
  'homeGoals', 'awayGoals', 'htHome', 'htAway',
  'referee', 'homeShots', 'awayShots', 'homeShotsOnTarget', 'awayShotsOnTarget',
  'homeCorners', 'awayCorners', 'homeYellow', 'awayYellow',
  'b365Home', 'b365Draw', 'b365Away',
  'psHome', 'psDraw', 'psAway',
  'avHome', 'avDraw', 'avAway',
  'over25', 'under25', 'ahLine', 'ahHome', 'ahAway',
];

function triple(row: Csv, h: string, d: string, a: string) {
  const home = toNumber(row[h]);
  const draw = toNumber(row[d]);
  const away = toNumber(row[a]);
  if (home === null || draw === null || away === null) return null;
  if (home <= 1 || draw <= 1 || away <= 1) return null;
  return { home, draw, away };
}

/* ------------------------------------------------------------------ */
/* Programme principal                                                 */
/* ------------------------------------------------------------------ */

function parseArgs(): { seasons: string[]; cacheDir: string | null; outDir: string } {
  const args = process.argv.slice(2);
  let seasons = DEFAULT_SEASONS;
  let cacheDir: string | null = null;
  let outDir = OUT_DIR;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--seasons' && args[i + 1]) {
      seasons = args[i + 1].split(',').map(s => s.trim()).filter(Boolean);
      i += 1;
    } else if (args[i] === '--cache' && args[i + 1]) {
      cacheDir = resolve(args[i + 1]);
      i += 1;
    } else if (args[i] === '--out' && args[i + 1]) {
      outDir = resolve(args[i + 1]);
      i += 1;
    }
  }
  return { seasons, cacheDir, outDir };
}

async function main(): Promise<void> {
  const { seasons, cacheDir, outDir } = parseArgs();
  mkdirSync(outDir, { recursive: true });

  const matches: NormalisedMatch[] = [];
  const teamIds = new Map<string, number>(); // « div|nom normalisé » → id
  const teamNames = new Map<number, { div: string; name: string }>();
  const origins = new Map<string, number>();
  const perSeason: Record<string, number> = {};
  let nextId = 1;

  const idFor = (div: string, name: string): number => {
    const key = `${div}|${normaliseTeamName(name)}`;
    const existing = teamIds.get(key);
    if (existing !== undefined) return existing;
    const id = nextId++;
    teamIds.set(key, id);
    teamNames.set(id, { div, name });
    return id;
  };

  for (const division of DIVISIONS) {
    for (const season of seasons) {
      const file = await download(season, division.div, cacheDir);
      if (!file) {
        console.log(`  ! ${division.div} ${season} : source injoignable`);
        continue;
      }
      origins.set(file.origin, (origins.get(file.origin) || 0) + 1);
      const { header, rows } = parseCsv(file.text);
      if (!header.length) {
        console.log(`  ! ${division.div} ${season} : fichier illisible`);
        continue;
      }
      const index = new Map(header.map((name, position) => [name, position]));
      const cell = (row: string[], name: string): string =>
        index.has(name) ? (row[index.get(name)!] ?? '') : '';
      const asObject = (row: string[]): Csv => {
        const object: Csv = {};
        header.forEach((name, position) => {
          object[name] = row[position] ?? '';
        });
        return object;
      };

      let kept = 0;
      for (const row of rows) {
        const asRow = asObject(row);
        const date = toIsoDate(cell(row, 'Date'), season);
        const homeGoals = toNumber(cell(row, 'FTHG'));
        const awayGoals = toNumber(cell(row, 'FTAG'));
        const homeName = cell(row, 'HomeTeam');
        const awayName = cell(row, 'AwayTeam');
        if (!date || homeGoals === null || awayGoals === null || !homeName || !awayName) continue;

        const b365 = triple(asRow, 'B365H', 'B365D', 'B365A');
        const pinnacle = triple(asRow, 'PSH', 'PSD', 'PSA');
        const marketAverage = triple(asRow, 'BbAvH', 'BbAvD', 'BbAvA');
        const over = toNumber(cell(row, 'BbAv>2.5'));
        const under = toNumber(cell(row, 'BbAv<2.5'));
        const ahLine = toNumber(cell(row, 'BbAHh'));
        const ahHome = toNumber(cell(row, 'BbAvAHH'));
        const ahAway = toNumber(cell(row, 'BbAvAHA'));

        matches.push({
          div: division.div,
          season,
          date,
          time: cell(row, 'Time'),
          homeId: idFor(division.div, homeName),
          homeName,
          awayId: idFor(division.div, awayName),
          awayName,
          homeGoals,
          awayGoals,
          htHome: toNumber(cell(row, 'HTHG')),
          htAway: toNumber(cell(row, 'HTAG')),
          referee: cell(row, 'Referee'),
          homeShots: toNumber(cell(row, 'HS')),
          awayShots: toNumber(cell(row, 'AS')),
          homeShotsOnTarget: toNumber(cell(row, 'HST')),
          awayShotsOnTarget: toNumber(cell(row, 'AST')),
          homeCorners: toNumber(cell(row, 'HC')),
          awayCorners: toNumber(cell(row, 'AC')),
          homeYellow: toNumber(cell(row, 'HY')),
          awayYellow: toNumber(cell(row, 'AY')),
          b365,
          pinnacle,
          marketAverage,
          over25: over !== null && under !== null ? { over, under } : null,
          ahLine,
          ahHome,
          ahAway,
        });
        kept += 1;
      }
      perSeason[`${division.div}-${season}`] = kept;
      console.log(`  ok ${division.div} ${season} : ${kept} rencontres (${file.origin})`);
    }
  }

  if (!matches.length) {
    console.error('Aucune rencontre importée : vérifiez la source ou le cache.');
    process.exit(1);
  }

  matches.sort((a, b) => a.date.localeCompare(b.date) || a.homeId - b.homeId);

  const lines = [OUT_COLUMNS.join(',')];
  for (const match of matches) {
    lines.push(
      [
        match.div, match.season, match.date, match.time,
        match.homeId, csvCell(match.homeName), match.awayId, csvCell(match.awayName),
        match.homeGoals, match.awayGoals, match.htHome ?? '', match.htAway ?? '',
        csvCell(match.referee), match.homeShots ?? '', match.awayShots ?? '',
        match.homeShotsOnTarget ?? '', match.awayShotsOnTarget ?? '',
        match.homeCorners ?? '', match.awayCorners ?? '',
        match.homeYellow ?? '', match.awayYellow ?? '',
        match.b365?.home ?? '', match.b365?.draw ?? '', match.b365?.away ?? '',
        match.pinnacle?.home ?? '', match.pinnacle?.draw ?? '', match.pinnacle?.away ?? '',
        match.marketAverage?.home ?? '', match.marketAverage?.draw ?? '', match.marketAverage?.away ?? '',
        match.over25?.over ?? '', match.over25?.under ?? '',
        match.ahLine ?? '', match.ahHome ?? '', match.ahAway ?? '',
      ].join(',')
    );
  }
  writeFileSync(join(outDir, 'matches.csv'), lines.join('\n') + '\n', 'utf-8');

  const teamLines = ['id,div,name,normalised'];
  for (const [id, info] of Array.from(teamNames.entries()).sort((a, b) => a[0] - b[0])) {
    teamLines.push(`${id},${info.div},${csvCell(info.name)},${normaliseTeamName(info.name)}`);
  }
  writeFileSync(join(outDir, 'teams.csv'), teamLines.join('\n') + '\n', 'utf-8');

  const withB365 = matches.filter(m => m.b365).length;
  const withPinnacle = matches.filter(m => m.pinnacle).length;
  const withAverage = matches.filter(m => m.marketAverage).length;
  const withOver25 = matches.filter(m => m.over25).length;
  const manifest = {
    generatedAt: new Date().toISOString(),
    source: 'football-data.co.uk',
    sources: Object.fromEntries(origins),
    mirror: 'https://github.com/kokosing/autobet (secours)',
    seasons,
    divisions: DIVISIONS.map(d => ({ div: d.div, league: d.league, label: d.label })),
    matches: matches.length,
    teams: teamNames.size,
    coverage: {
      bet365: withB365,
      pinnacle: withPinnacle,
      marketAverage: withAverage,
      overUnder25: withOver25,
      referee: matches.filter(m => m.referee).length,
      halfTime: matches.filter(m => m.htHome !== null).length,
    },
    perSeason,
    period: `${matches[0].date} → ${matches[matches.length - 1].date}`,
    // Nature des cotes : ce sont des cotes d'OUVERTURE (pre-match,
    // publiées avant le coup d'envoi), pas des cotes de clôture.
    // L'archive football-data.co.uk ne publie pas de cotes de clôture
    // pour les saisons 0809 à 1516 : toute interprétation de ces
    // colonnes comme un prix de clôture serait fausse.
    oddsNature: {
      type: 'ouverture (pre-match)',
      isClosing: false,
      providers: {
        bet365: 'colonnes B365H / B365D / B365A / B365>2.5 / B365<2.5',
        pinnacle: 'colonnes PSH / PSD / PSA',
        average: 'moyenne arithmétique des cotes dé-vigguées disponibles',
      },
      note:
        'Ces cotes ne reflètent donc pas le prix auquel le marché a finalement équilibré le match : ' +
        "toute conclusion sur la marge de/bookmaker ou sur la 'valeur' doit être formulée " +
        'en référence à des cotes d’ouverture, et non de clôture.',
    },
  };
  writeFileSync(join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf-8');

  console.log('');
  console.log(`→ ${matches.length} rencontres, ${teamNames.size} équipes`);
  console.log(`→ Bet365 ${withB365} · Pinnacle ${withPinnacle} · moyenne marché ${withAverage} · O/U 2,5 ${withOver25}`);
  console.log(`→ ${join(outDir, 'matches.csv')}`);
}

/** Cellule CSV : guillemets si nécessaire. */
function csvCell(value: string): string {
  const text = String(value ?? '');
  if (/[",\n]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
