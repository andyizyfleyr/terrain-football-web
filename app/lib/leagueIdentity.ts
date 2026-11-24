/* ------------------------------------------------------------------ */
/* IDENTITÉ DE CHAMPIONNAT                                              */
/* ------------------------------------------------------------------ */
/*
 * Le backtest rejoue les matchs LIGUE PAR LIGUE : le classement, les
 * moyennes de buts et les xG ne doivent jamais être mélangés entre deux
 * Divisions (cf. app/lib/backtest.ts). L'étiquette `league` portée par
 * chaque rencontre est donc une donnée structurante, pas un libellé
 * décoratif.
 *
 * La collecte FotMob expose deux identités de ligue : celle de la ligue
 * demandée (`details.id`) et celle que porte chaque match
 * (`leagueId` / `primaryLeagueId`). Un jour où l'API renvoie une autre
 * Division que celle demandée, étiqueter les matchs avec le libellé
 * demandé produirait un jeu de données FAUX : le replaywalk-forward
 * regrouperait alors La Liga et Premier League dans le même groupe et
 * le calibrage serait calibré sur des bases de marché incohérentes.
 *
 * D'où ce module : on déduit le slug (identifiant ESPN, `esp.1`) de
 * l'identité réelle de la ligue, et non d'une constante.
 */

/**
 * Identifiants de ligue FotMob → slug de championnat (convention ESPN).
 *
 * Ces identifiants sont releves sur la source elle-meme
 * (`GET https://www.fotmob.com/api/data/leagues?id=<id>`), qui publie
 * `details.id` et `details.name` pour chaque ligue. Chaque entree de
 * cette table a ete verifiee dans ce payload : une table devinee
 * confond les Divisions (Serie A et Ligue 1, MLS et Liga Portugal)
 * et pollue silencieusement le regroupement du backtest.
 */
export const LEAGUE_SLUG_BY_FOTMOB_ID: Record<number, string> = {
  47: 'eng.1', // Premier League
  48: 'eng.2', // Championship
  87: 'esp.1', // LaLiga
  140: 'esp.2', // LaLiga2
  55: 'ita.1', // Serie A
  86: 'ita.2', // Serie B
  53: 'fra.1', // Ligue 1
  110: 'fra.2', // Ligue 2
  57: 'ned.1', // Eredivisie
  61: 'por.1', // Liga Portugal
  40: 'bel.1', // Jupiler Pro League
  54: 'ger.1', // Bundesliga
  64: 'sco.1', // Scottish Premiership
  71: 'tur.1', // Super Lig
  230: 'mex.1', // Liga MX
  130: 'usa.1', // MLS
  42: 'uefa.champions', // Champions League
  73: 'uefa.europa', // Europa League
  268: 'bra.1', // Serie A (Bresil)
  112: 'arg.1', // Liga Profesional (Argentine)
};

/**
 * Slugs connus par leur nom de ligue FotMob (quand l'id manque).
 * Les noms sont normalises (minuscules, sans accent ni separateur) ;
 * voir `normalizeName`.
 */
export const LEAGUE_SLUG_BY_NAME: Record<string, string> = {
  premierleague: 'eng.1',
  championship: 'eng.2',
  laliga: 'esp.1',
  laliga2: 'esp.2',
  bundesliga: 'ger.1',
  seriea: 'ita.1',
  serieb: 'ita.2',
  ligue1: 'fra.1',
  ligue2: 'fra.2',
  eredivisie: 'ned.1',
  ligaportugal: 'por.1',
  firstdivisiona: 'bel.1',
  premiership: 'sco.1',
  superlig: 'tur.1',
  ligamx: 'mex.1',
  mls: 'usa.1',
  // Coupes d'Europe : le repli par pays ne les atteint jamais (FotMob
  // publie « Europe » ou « World »), le nom est donc la seule issue
  // quand l'identifiant de ligue manque.
  championsleague: 'uefa.champions',
  uefachampionsleague: 'uefa.champions',
  europaleague: 'uefa.europa',
  uefaeuropaleague: 'uefa.europa',
};

/**
 * Codes « pays » qui designent une zone continentale, pas une nation.
 * Aucune competition de club n'est identifiee par ces codes : le repli
 * `<code>.1` y fabriquerait un championnat inexistant (voir
 * `resolveLeagueSlug`).
 */
const CONTINENTAL_COUNTRIES = new Set(['eur', 'uef', 'int', 'wld', 'wrl', 'eu']);

export type LeagueIdentity = {
  /** Slug normalisé (`esp.1`) utilisé par le backtest et l'API. */
  slug: string;
  /** Identifiant FotMob de la ligue, quand il est connu. */
  fotmobId: number | null;
  /** Nom de la ligue tel que publié par la source. */
  name: string | null;
  /** Pays de la ligue (code à 3 lettres), quand il est connu. */
  country: string | null;
};

function normalizeName(value: unknown): string {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]/gi, '')
    .toLowerCase();
}

/**
 * Déduit le slug d'une ligue à partir de son identité (id, nom, pays).
 * L'id FotMob est l authorities la plus fiable ; le nom sert de repli.
 */
export function resolveLeagueSlug(input: {
  fotmobId?: number | null;
  name?: string | null;
  country?: string | null;
}): string {
  const id = Number(input.fotmobId);
  if (Number.isFinite(id) && id > 0 && LEAGUE_SLUG_BY_FOTMOB_ID[id]) {
    return LEAGUE_SLUG_BY_FOTMOB_ID[id];
  }

  const byName = LEAGUE_SLUG_BY_NAME[normalizeName(input.name)];
  if (byName) return byName;

  const country = String(input.country ?? '').trim().toLowerCase();
  if (
    country &&
    country.length === 3 &&
    /^[a-z]{3}$/.test(country) &&
    !CONTINENTAL_COUNTRIES.has(country)
  ) {
    // Repli explicite et lisible : le pays identifie la Division 1.
    // Les competitions continentales n'ont pas de pays : « Europe »
    // produirait `eur.1`, un championnat qui n'existe pas, et les
    // matchs de Ligue des Champions seraient rangés dans une Division
    // fantôme du backtest. On préfère un slug inconnu, explicite.
    return `${country}.1`;
  }

  return Number.isFinite(id) && id > 0 ? `league-${id}` : 'league-unknown';
}

/**
 * Extrait l'identité de la ligue depuis un payload `leagues?id=…` de FotMob.
 * Le payload expose l'identité à plusieurs endroits (`details`, `table`),
 * on les combine pour rester robuste aux variations de structure.
 */
export function readLeagueIdentity(payload: any): LeagueIdentity {
  const details = payload?.details ?? {};
  const tableData = payload?.table?.[0]?.data ?? {};

  const fotmobId = Number(details.id ?? tableData.leagueId ?? 0) || null;
  const name = String(details.name ?? tableData.leagueName ?? '') || null;
  const country = String(details.country ?? '') || null;

  return {
    slug: resolveLeagueSlug({ fotmobId, name, country }),
    fotmobId,
    name,
    country,
  };
}

/**
 * Identité d'un match à partir de son propre identifiant de ligue.
 * Priorité à l'identité du match : c'est elle qui détermine le
 * regroupement utilisé par le replay, pas la ligue demandée.
 */
export function readMatchLeagueSlug(
  match: { leagueId?: number | null; primaryLeagueId?: number | null },
  fallback: LeagueIdentity
): string {
  const id = Number(match.leagueId ?? match.primaryLeagueId ?? 0);
  if (Number.isFinite(id) && id > 0 && LEAGUE_SLUG_BY_FOTMOB_ID[id]) {
    return LEAGUE_SLUG_BY_FOTMOB_ID[id];
  }
  if (Number.isFinite(id) && id > 0 && id !== fallback.fotmobId) {
    return resolveLeagueSlug({ fotmobId: id });
  }
  return fallback.slug;
}
