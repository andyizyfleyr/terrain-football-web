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

/** Identifiants de ligue FotMob → slug de championnat (convention ESPN). */
export const LEAGUE_SLUG_BY_FOTMOB_ID: Record<number, string> = {
  47: 'eng.1', // Premier League
  89: 'eng.2', // Championship
  87: 'esp.1', // LaLiga
  140: 'esp.2', // LaLiga2
  54: 'deu.1', // Bundesliga
  53: 'ita.1', // Serie A
  55: 'fra.1', // Ligue 1
  61: 'ned.1', // Eredivisie
  130: 'por.1', // Liga Portugal
  42: 'bel.1', // Jupiler Pro League
  22: 'mex.1', // Liga MX
  10: 'usa.1', // MLS
};

/** Slugs connus par leur nom de ligue FotMob (quand l'id manque). */
export const LEAGUE_SLUG_BY_NAME: Record<string, string> = {
  premierleague: 'eng.1',
  championship: 'eng.2',
  laliga: 'esp.1',
  laliga2: 'esp.2',
  bundesliga: 'deu.1',
  seriea: 'ita.1',
  ligue1: 'fra.1',
  eredivisie: 'ned.1',
  ligaportugal: 'por.1',
};

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
  if (country && country.length === 3 && /^[a-z]{3}$/.test(country)) {
    // Repli explicite et lisible : le pays identifie la Division 1.
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
