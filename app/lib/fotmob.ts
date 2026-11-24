// Intégration FotMob (flux JSON public non-officiel : https://www.fotmob.com/api/data/...)
// Utilisé pour enrichir l'analyse ESPN avec :
// - Blessés, suspendus & incertains (pondérés par valeur/importance dans les xG Poisson)
// - Vrais xG / xGA de saison et du match (lorsque coverageLevel === 'xG' ou table xG dispo)
// - Arbitre désigné & statistiques disciplinaires (cartons/fautes/penalties par match)
// - Entraîneurs & schémas tactiques
// - Historique multi-saisons des confrontations directes (H2H)
// - Météo & insights FotMob/Opta

import { buildShotProfile, extractShots, mergeShotProfiles } from './shotQuality';
import { buildPitchProfile } from './pitchProfile';
import { readPlayerStat } from './playerImpact';
import { runQuantitativeAnalyst } from './analystEngine';
import type {
  AnalystInput,
  AnalystLineup,
  AnalystRecentMatch,
  AnalystSquadMember,
  AnalystStatEntry,
  AnalystTableRow,
  AnalystTeamInput,
} from './analystEngine';
import { devigMarketOdds, mergeMarketOdds, oddsToMarketPayload, parseMarketOdds } from './marketOdds';
import type { MarketOdds, MarketProvider, ParsedOdds } from './marketOdds';
import { devigThreeWayDecimal } from './devig';

const FOTMOB_BASE = 'https://www.fotmob.com/api/data';
const FOTMOB_HEADERS: Record<string, string> = {
  'User-Agent':
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  Accept: 'application/json, text/plain, */*',
  'Accept-Language': 'fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7',
};

/**
 * Correspondance slug de championnat (convention ESPN) -> identifiants
 * de ligue FotMob.
 *
 * Chaque identifiant est releve sur la source elle-meme :
 * `GET https://www.fotmob.com/api/data/leagues?id=<id>` publie `details.id`,
 * `details.name` et `details.country`. Le premier identifiant de chaque
 * liste est le `primaryId` (la ligue mere) ; les suivants sont les
 * competitions filles (playoffs, qualifications) qui portent des
 * matchs dans la meme division et doivent donc etre reconnues comme
 * telles lors du rapprochement ESPN <-> FotMob.
 *
 * Avertissement : ces identifiants ne se devinent pas. Confondre la
 * Serie A (55) et la Ligue 1 (53), ou le MLS (130) et la Liga Portugal
 * (61), fait apparaitre les matchs d'une Division dans une autre.
 */
export const ESPN_TO_FOTMOB_LEAGUE: Record<string, number[]> = {
  'eng.1': [47],
  'eng.2': [48],
  'esp.1': [87],
  'esp.2': [140],
  'ita.1': [55],
  'ita.2': [86],
  'fra.1': [53],
  'fra.2': [110],
  'ned.1': [57],
  'por.1': [61],
  'bel.1': [40, 41],
  'ger.1': [54],
  'sco.1': [64, 181],
  'tur.1': [71],
  'uefa.champions': [42, 10611],
  'uefa.europa': [73, 10613],
  'usa.1': [130, 957981],
  'mex.1': [230],
  'bra.1': [268],
  'arg.1': [112, 10007],
};

// Cache mémoire court côté serveur (évite de marteler FotMob lors d'un scan de journée)
type CacheEntry<T> = { expiresAt: number; value: T };
const memoryCache = new Map<string, CacheEntry<any>>();
// Le cache est borné en DUREE (ttl) ET en NOMBRE d'entrées : sans purge,
// il grossirait indéfiniment sur une instance qui vit longtemps, chaque
// URL de match ou de journée étant une clé.
const MEMORY_CACHE_MAX_ENTRIES = 500;

function pruneMemoryCache(now: number): void {
  memoryCache.forEach((entry, key) => {
    if (entry.expiresAt <= now) memoryCache.delete(key);
  });
  while (memoryCache.size > MEMORY_CACHE_MAX_ENTRIES) {
    const oldest = memoryCache.keys().next();
    if (oldest.done) break;
    memoryCache.delete(oldest.value);
  }
}

async function fetchFotmobJson<T = any>(pathWithQuery: string, ttlSeconds = 300, timeoutMs = 4500): Promise<T | null> {
  const now = Date.now();
  const cached = memoryCache.get(pathWithQuery);
  if (cached && cached.expiresAt > now) {
    return cached.value as T;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${FOTMOB_BASE}/${pathWithQuery}`, {
      headers: FOTMOB_HEADERS,
      signal: controller.signal,
      next: { revalidate: ttlSeconds },
    });
    if (!res.ok) return null;
    const contentType = res.headers.get('content-type') || '';
    if (!contentType.includes('json')) return null;
    const data = (await res.json()) as T;
    pruneMemoryCache(now);
    memoryCache.set(pathWithQuery, { expiresAt: now + ttlSeconds * 1000, value: data });
    return data;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// Normalisation souple des noms d'équipes entre ESPN et FotMob
const STOP_WORDS = new Set([
  'fc',
  'cf',
  'sc',
  'ac',
  'afc',
  'ssc',
  'ud',
  'cd',
  'rc',
  'rcd',
  'as',
  'us',
  'ss',
  'sv',
  'vfb',
  'vfl',
  'fsv',
  'tsg',
  'bsc',
  'fk',
  'sk',
  'bk',
  'kv',
  'krc',
  'rsc',
  'club',
  'deportivo',
  'de',
  'del',
  'la',
  'el',
  'los',
  'las',
  'and',
  'et',
  'the',
  'calcio',
  'football',
  'soccer',
  'sporting',
]);

const ALIAS_TOKENS: Record<string, string> = {
  utd: 'united',
  man: 'manchester',
  st: 'saint',
  ste: 'sainte',
  psg: 'paris saint germain',
  om: 'marseille',
  ol: 'lyon',
  ath: 'athletic',
  atletico: 'atletico',
  inter: 'internazionale inter',
  ny: 'new york',
  la: 'los angeles',
  dc: 'dc',
  gladbach: 'monchengladbach',
  mgladbach: 'monchengladbach',
  wolves: 'wolverhampton',
  spurs: 'tottenham',
  forest: 'nottingham',
  brighton: 'brighton',
  bournemouth: 'bournemouth',
  alaves: 'alaves',
  betis: 'betis',
  celta: 'celta',
  sociedad: 'sociedad',
  bilbao: 'athletic',
  bayern: 'bayern munchen munich',
  munich: 'munchen',
  cologne: 'koln',
  mainz: 'mainz',
  psv: 'psv eindhoven',
  az: 'alkmaar',
  vitória: 'vitoria',
  sportingcp: 'sporting',
};

export function normalizeTeamName(raw?: string | null): string {
  if (!raw) return '';
  const ascii = raw
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/&/g, ' ')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return ascii;
}

function teamTokens(raw?: string | null): string[] {
  const norm = normalizeTeamName(raw);
  if (!norm) return [];
  const expanded: string[] = [];
  for (const part of norm.split(' ')) {
    if (!part) continue;
    if (ALIAS_TOKENS[part]) {
      for (const sub of ALIAS_TOKENS[part].split(' ')) {
        if (sub && !STOP_WORDS.has(sub)) expanded.push(sub);
      }
    } else if (!STOP_WORDS.has(part) && !/^\d+$/.test(part)) {
      expanded.push(part);
    }
  }
  return expanded.length ? expanded : norm.split(' ').filter(Boolean);
}

export function teamSimilarity(nameA?: string | null, nameB?: string | null): number {
  const normA = normalizeTeamName(nameA);
  const normB = normalizeTeamName(nameB);
  if (!normA || !normB) return 0;
  if (normA === normB) return 1;
  if (normA.includes(normB) || normB.includes(normA)) return 0.92;

  const tokAList = Array.from(new Set(teamTokens(nameA)));
  const tokBList = Array.from(new Set(teamTokens(nameB)));
  const tokB = new Set(tokBList);
  if (!tokAList.length || !tokBList.length) return 0;

  let inter = 0;
  for (const t of tokAList) {
    if (tokB.has(t)) inter += 1;
    else {
      for (const b of tokBList) {
        if (t.length >= 4 && b.length >= 4 && (t.startsWith(b) || b.startsWith(t))) {
          inter += 0.8;
          break;
        }
      }
    }
  }
  const union = new Set(tokAList.concat(tokBList)).size;
  return (inter / Math.max(1, Math.min(tokAList.length, tokBList.length))) * 0.7 + (inter / Math.max(1, union)) * 0.3;
}

function shiftCompactDate(compactDate: string, deltaDays: number): string {
  if (!/^\d{8}$/.test(compactDate)) return compactDate;
  const y = Number(compactDate.slice(0, 4));
  const m = Number(compactDate.slice(4, 6));
  const d = Number(compactDate.slice(6, 8));
  const dt = new Date(Date.UTC(y, m - 1, d + deltaDays, 12, 0, 0));
  const yy = dt.getUTCFullYear();
  const mm = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(dt.getUTCDate()).padStart(2, '0');
  return `${yy}${mm}${dd}`;
}

export type FotmobDayMatch = {
  id: number;
  leagueId: number;
  primaryLeagueId?: number;
  leagueName?: string;
  utcTime?: string;
  home: { id: number; name: string; shortName?: string; longName?: string; score?: number };
  away: { id: number; name: string; shortName?: string; longName?: string; score?: number };
  status?: { started?: boolean; finished?: boolean; cancelled?: boolean; utcTime?: string };
};

export async function getFotmobMatchesForDate(compactDate: string): Promise<FotmobDayMatch[]> {
  const data = await fetchFotmobJson<{ leagues?: any[] }>(`matches?date=${encodeURIComponent(compactDate)}`, 120);
  if (!data?.leagues || !Array.isArray(data.leagues)) return [];

  const out: FotmobDayMatch[] = [];
  for (const lg of data.leagues) {
    const primaryId = Number(lg.primaryId ?? lg.parentLeagueId ?? lg.id);
    const leagueId = Number(lg.id);
    const leagueName = lg.name;
    for (const m of lg.matches || []) {
      if (!m?.id || !m?.home || !m?.away) continue;
      out.push({
        id: Number(m.id),
        leagueId,
        primaryLeagueId: primaryId,
        leagueName,
        utcTime: m.status?.utcTime,
        home: m.home,
        away: m.away,
        status: m.status,
      });
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* COTES DE MARCHÉ RÉELLES                                             */
/* ------------------------------------------------------------------ */
/*
 * Les cotes sont récupérées depuis le flux public de marché de la source
 * de données football. On interroge plusieurs variantes (pays + opérateur)
 * afin de maximiser la couverture :
 *   1. le marché qui expose le plus de marchés (1X2, O/U 2,5, BTTS, DNB),
 *   2. les marchés de repli lorsque le premier ne renvoie pas de cotes.
 * Les résultats sont fusionnés pour disposer, si possible, du trio
 * 1X2 + total de buts 2,5 + les deux équipes marquent.
 */
const ODDS_ENDPOINTS: { country: string; provider?: string }[] = [
  { country: 'ESP', provider: '1xBet_Spain' },
  { country: 'ESP' },
  { country: 'FRA' },
  { country: 'GBR' },
  { country: 'DEU' },
];

export type FotmobMarketOdds = {
  available: boolean;
  odds: MarketOdds | null;
  parsed: ParsedOdds | null;
  payload: any | null;
  /** Opérateur réellement servi pour le trio 1X2 (source des cotes affichées) */
  provider: MarketProvider | null;
  /** Journal des points de vente consultés et de leur résolution */
  sources: {
    country: string;
    requested: string | null;
    resolved: string | null;
    honored: boolean;
    used: boolean;
  }[];
  /** Timestamp de la dernière extraction */
  fetchedAt: string | null;
};

export async function fetchFotmobMarketOdds(params: {
  fotmobMatchId: number | string;
  homeName?: string;
  awayName?: string;
}): Promise<FotmobMarketOdds> {
  const matchId = Number(params.fotmobMatchId);
  const empty: FotmobMarketOdds = {
    available: false,
    odds: null,
    parsed: null,
    payload: null,
    provider: null,
    sources: [],
    fetchedAt: null,
  };
  if (!Number.isFinite(matchId) || matchId <= 0) return empty;

  const homeName = params.homeName || '';
  const awayName = params.awayName || '';

  const buildQuery = (endpoint: { country: string; provider?: string }): string =>
    endpoint.provider
      ? `matchOdds?matchId=${matchId}&ccode3=${endpoint.country}&bettingProvider=${encodeURIComponent(endpoint.provider)}`
      : `matchOdds?matchId=${matchId}&ccode3=${endpoint.country}`;

  const sources: FotmobMarketOdds['sources'] = [];
  let merged: MarketOdds | null = null;
  let mergedPayload: any = null;

  /**
   * Intègre une réponse dans le cumul et journalise le point de vente.
   * L'opérateur ayant fourni le trio 1X2 reste celui qui est affiché.
   */
  const integrate = (endpoint: { country: string; provider?: string }, payload: any) => {
    const parsed = parseMarketOdds(payload, homeName, awayName, endpoint.provider ?? null);
    const source = {
      country: endpoint.country,
      requested: endpoint.provider ?? null,
      resolved: parsed.provider?.key ?? null,
      honored: parsed.provider?.honored ?? false,
      used: false,
    };
    sources.push(source);
    if (!parsed.home || !parsed.draw || !parsed.away) return;
    const isPrimary = merged === null;
    merged = merged ? mergeMarketOdds(merged, parsed) : parsed;
    if (isPrimary) source.used = true;
    mergedPayload = mergedPayload ?? payload;
  };

  const hasFullCoverage = (): boolean =>
    !!merged && !!merged.over25 && !!merged.under25 && !!merged.bttsYes && !!merged.bttsNo;

  // 1. Point de vente prioritaire : une seule requête dans le cas nominal.
  const primaryPayload = await fetchFotmobJson<any>(buildQuery(ODDS_ENDPOINTS[0]), 120, 4000);
  if (primaryPayload) integrate(ODDS_ENDPOINTS[0], primaryPayload);

  // 2. Points de vente de repli : interrogés en parallèle pour ne pas
  //    cumuler les temps d'attente, puis fusionnés par ordre de priorité.
  if (!hasFullCoverage()) {
    const fallbacks = ODDS_ENDPOINTS.slice(1);
    const payloads = await Promise.all(fallbacks.map(endpoint => fetchFotmobJson<any>(buildQuery(endpoint), 120, 4000)));
    fallbacks.forEach((endpoint, index) => {
      const payload = payloads[index];
      if (payload) integrate(endpoint, payload);
    });
  }

  if (!merged) return { ...empty, sources, fetchedAt: null };

  const parsed = devigMarketOdds(merged);
  return {
    available: parsed.available,
    odds: merged,
    parsed,
    payload: mergedPayload,
    provider: merged.provider ?? null,
    sources,
    fetchedAt: merged.fetchedAt || null,
  };
}

/**
 * Résolution du marché de référence utilisé par l'analyse et la vigilance.
 *
 * Priorité aux cotes bookmaker réelles. Si le flux de marché est injoignable,
 * on retombe sur le marché amont (cotes décimales ou probabilités) afin de
 * ne jamais laisser l'analyse sans repère de marché — mais en conservant
 * une source unique pour les deux chemins de calcul.
 */
function resolveMarketSource(
  marketOdds: FotmobMarketOdds,
  upstreamMarket: any
): {
  payload: any | null;
  probs: { home: number; draw: number; away: number; over25: number | null } | null;
  provider: MarketProvider | null;
  fetchedAt: string | null;
  origin: 'public' | 'upstream' | null;
} {
  // 1. Cotes bookmaker réelles
  const payload = oddsToMarketPayload(marketOdds.odds);
  if (payload && marketOdds.parsed?.available) {
    return {
      payload,
      probs: {
        home: marketOdds.parsed.probabilities.home,
        draw: marketOdds.parsed.probabilities.draw,
        away: marketOdds.parsed.probabilities.away,
        over25: marketOdds.parsed.probabilities.over25,
      },
      provider: marketOdds.provider ?? null,
      fetchedAt: marketOdds.fetchedAt || marketOdds.odds?.fetchedAt || null,
      origin: 'public',
    };
  }

  // 2. Repli sur le marché amont
  const home = Number(upstreamMarket?.home);
  const draw = Number(upstreamMarket?.draw);
  const away = Number(upstreamMarket?.away);
  if (!Number.isFinite(home) || !Number.isFinite(draw) || !Number.isFinite(away)) {
    return { payload: null, probs: null, provider: null, fetchedAt: null, origin: null };
  }
  if (home <= 0 || draw <= 0 || away <= 0) {
    return { payload: null, probs: null, provider: null, fetchedAt: null, origin: null };
  }

  const looksDecimal = home > 1.5 || draw > 1.5 || away > 1.5;
  if (looksDecimal) {
    const devig = devigThreeWayDecimal({ home, draw, away });
    return {
      payload: { format: 'decimal', home, draw, away, source: 'Cotes de marché publiques' },
      probs: devig
        ? { home: devig.probs.home, draw: devig.probs.draw, away: devig.probs.away, over25: null }
        : null,
      provider: null,
      fetchedAt: null,
      origin: 'upstream',
    };
  }

  // Probabilités pures : on les normalise pour disposer d'un repère comparable.
  const total = home + draw + away;
  if (!(total > 0)) {
    return { payload: null, probs: null, provider: null, fetchedAt: null, origin: null };
  }
  return {
    payload: { format: 'probability', home, draw, away, source: 'Cotes de marché publiques' },
    probs: { home: home / total, draw: draw / total, away: away / total, over25: null },
    provider: null,
    fetchedAt: null,
    origin: 'upstream',
  };
}

export async function findFotmobMatchForEspn(params: {
  leagueSlug: string;
  compactDate: string;
  homeName: string;
  awayName: string;
  kickoffIso?: string;
}): Promise<FotmobDayMatch | null> {
  const { leagueSlug, compactDate, homeName, awayName, kickoffIso } = params;
  const preferredLeagueIds = new Set(ESPN_TO_FOTMOB_LEAGUE[leagueSlug] || []);

  // Chercher d'abord à la date exacte, puis +-1 jour si décalage de fuseau horaire (ex: MLS / Liga MX / Argentine)
  const datesToTry = [compactDate];
  if (kickoffIso) {
    const kickUtcDay = kickoffIso.slice(0, 10).replaceAll('-', '');
    if (/^\d{8}$/.test(kickUtcDay) && !datesToTry.includes(kickUtcDay)) {
      datesToTry.unshift(kickUtcDay);
    }
  }

  const pickBest = (candidates: FotmobDayMatch[]): { match: FotmobDayMatch; score: number } | null => {
    let best: { match: FotmobDayMatch; score: number } | null = null;
    const kickMs = kickoffIso ? Date.parse(kickoffIso) : NaN;

    for (const cand of candidates) {
      const simHome = Math.max(
        teamSimilarity(homeName, cand.home.name),
        teamSimilarity(homeName, cand.home.longName),
        teamSimilarity(homeName, cand.home.shortName)
      );
      const simAway = Math.max(
        teamSimilarity(awayName, cand.away.name),
        teamSimilarity(awayName, cand.away.longName),
        teamSimilarity(awayName, cand.away.shortName)
      );

      if (simHome < 0.45 || simAway < 0.45) continue;

      let score = simHome * 0.45 + simAway * 0.45;
      if (
        preferredLeagueIds.size > 0 &&
        (preferredLeagueIds.has(cand.leagueId) || (cand.primaryLeagueId && preferredLeagueIds.has(cand.primaryLeagueId)))
      ) {
        score += 0.1;
      }

      if (Number.isFinite(kickMs) && cand.utcTime) {
        const diffHours = Math.abs(kickMs - Date.parse(cand.utcTime)) / 3_600_000;
        if (diffHours <= 2) score += 0.04;
        else if (diffHours > 36) score -= 0.15;
      }

      if (!best || score > best.score) {
        best = { match: cand, score };
      }
    }
    return best;
  };

  for (const dt of datesToTry) {
    const list = await getFotmobMatchesForDate(dt);
    const found = pickBest(list);
    if (found && found.score >= 0.65) return found.match;
  }

  // Fallback +- 1 jour
  const neighbors = await Promise.all([
    getFotmobMatchesForDate(shiftCompactDate(compactDate, -1)),
    getFotmobMatchesForDate(shiftCompactDate(compactDate, 1)),
  ]);
  const foundNeighbor = pickBest([...neighbors[0], ...neighbors[1]]);
  if (foundNeighbor && foundNeighbor.score >= 0.68) return foundNeighbor.match;

  return null;
}

export type UnavailablePlayerInfo = {
  id: number;
  name: string;
  type: 'injury' | 'suspension' | 'doubtful' | 'other';
  labelFr: string;
  expectedReturn?: string;
  marketValue?: number;
  rating?: number | null;
  goals?: number;
  assists?: number;
  position?: string;
  isKeyPlayer?: boolean;
};

export type TeamXgSeasonStats = {
  teamId: number;
  played: number;
  xg: number;
  xgConceded: number;
  xgPerMatch: number;
  xgaPerMatch: number;
  xPoints: number;
  xgDiff: number;
};

export type RefereeInfo = {
  name: string;
  country?: string;
  matches?: number;
  yellowPerMatch?: number;
  /** Moyenne de la league pour la même statistique (mesure du biais). */
  yellowAverage?: number;
  yellowAverageType?: string;
  redCardsTotal?: number;
  penaltiesTotal?: number;
  penaltiesPerMatch?: number;
  foulsPerMatch?: number;
  foulsAverage?: number;
  foulsAverageType?: string;
};

export type H2HItem = {
  date: string;
  competition?: string;
  homeName: string;
  awayName: string;
  homeScore: number;
  awayScore: number;
};

// Modèle mathématique Poisson identique au backend mais enrichi
function factorial(n: number): number {
  let r = 1;
  for (let i = 2; i <= n; i++) r *= i;
  return r;
}

function poissonPmf(k: number, lambda: number): number {
  if (lambda <= 0) return k === 0 ? 1 : 0;
  return (Math.exp(-lambda) * Math.pow(lambda, k)) / factorial(k);
}

export function computeProbabilitiesFromLambdas(lambdaHome: number, lambdaAway: number) {
  const lh = Math.max(0.18, Math.min(4.8, lambdaHome));
  const la = Math.max(0.18, Math.min(4.8, lambdaAway));
  const maxGoals = 10;

  let pHome = 0;
  let pDraw = 0;
  let pAway = 0;
  let bttsYes = 0;
  let over15 = 0;
  let over25 = 0;
  let over35 = 0;

  const scores: { h: number; a: number; p: number }[] = [];

  for (let h = 0; h <= maxGoals; h++) {
    const ph = poissonPmf(h, lh);
    for (let a = 0; a <= maxGoals; a++) {
      const p = ph * poissonPmf(a, la);
      if (h > a) pHome += p;
      else if (h === a) pDraw += p;
      else pAway += p;

      if (h >= 1 && a >= 1) bttsYes += p;
      if (h + a >= 2) over15 += p;
      if (h + a >= 3) over25 += p;
      if (h + a >= 4) over35 += p;

      if (h <= 6 && a <= 6) {
        scores.push({ h, a, p: Number(p.toFixed(4)) });
      }
    }
  }

  // Normalisation légère de la troncature à maxGoals
  const sum = pHome + pDraw + pAway || 1;
  pHome /= sum;
  pDraw /= sum;
  pAway /= sum;

  scores.sort((x, y) => y.p - x.p);

  const totalLambda = lh + la;
  const noGoal = Math.exp(-totalLambda);
  const firstHome = totalLambda > 0 ? (1 - noGoal) * (lh / totalLambda) : 0;
  const firstAway = totalLambda > 0 ? (1 - noGoal) * (la / totalLambda) : 0;

  // Répartition empirique football : ~44% des buts en 1re période, ~56% en 2e période
  const lH1 = totalLambda * 0.44;
  const lH2 = totalLambda * 0.56;
  const lhH1 = lh * 0.44;
  const laH1 = la * 0.44;

  const overK = (lam: number, threshold: number) => {
    let cdf = 0;
    for (let k = 0; k <= threshold; k++) cdf += poissonPmf(k, lam);
    return Math.max(0, Math.min(1, 1 - cdf));
  };

  const noGoalH1 = Math.exp(-lH1);
  const round4 = (v: number) => Number(Math.max(0, Math.min(1, v)).toFixed(4));

  return {
    expectedGoals: {
      home: Number(lh.toFixed(2)),
      away: Number(la.toFixed(2)),
    },
    probabilities: {
      home: round4(pHome),
      draw: round4(pDraw),
      away: round4(pAway),
      bttsYes: round4(bttsYes),
      bttsNo: round4(1 - bttsYes),
      over15: round4(over15),
      under15: round4(1 - over15),
      over25: round4(over25),
      under25: round4(1 - over25),
      over35: round4(over35),
      under35: round4(1 - over35),
      firstHome: round4(firstHome),
      firstAway: round4(firstAway),
      noGoal: round4(noGoal),
      firstHalf: {
        over05: round4(overK(lH1, 0)),
        over15: round4(overK(lH1, 1)),
        over25: round4(overK(lH1, 2)),
      },
      secondHalf: {
        over05: round4(overK(lH2, 0)),
        over15: round4(overK(lH2, 1)),
        over25: round4(overK(lH2, 2)),
      },
      firstHomeH1: round4(lH1 > 0 ? (1 - noGoalH1) * (lhH1 / lH1) : 0),
      firstAwayH1: round4(lH1 > 0 ? (1 - noGoalH1) * (laH1 / lH1) : 0),
    },
    topScores: scores.slice(0, 5),
  };
}

function parseUnavailableList(rawUnavailable: any[], squadMembersById: Map<number, any>, totalSquadValue: number): UnavailablePlayerInfo[] {
  if (!Array.isArray(rawUnavailable)) return [];
  const items: UnavailablePlayerInfo[] = [];

  for (const p of rawUnavailable) {
    if (!p?.name) continue;
    const pid = Number(p.id);
    const squadInfo = squadMembersById.get(pid);
    const unav = p.unavailability || {};
    const expectedReturn: string | undefined = unav.expectedReturn || squadInfo?.injury?.expectedReturn || undefined;
    const rawType = String(unav.type || '').toLowerCase();
    const isDoubtful = Boolean(expectedReturn && /doubtful|incertain|questionable/i.test(expectedReturn));

    let type: UnavailablePlayerInfo['type'] = 'other';
    let labelFr = 'Absent';
    if (rawType === 'suspension' || /red card|yellow|suspend/i.test(rawType)) {
      type = 'suspension';
      labelFr = 'Suspendu';
    } else if (isDoubtful) {
      type = 'doubtful';
      labelFr = 'Incertain';
    } else if (rawType === 'injury' || unav.injuryId) {
      type = 'injury';
      labelFr = 'Blessé';
    } else if (/international|national/i.test(rawType)) {
      type = 'other';
      labelFr = 'Sélection';
    }

    const marketValue = Number(p.marketValue || squadInfo?.transferValue || 0) || undefined;
    const rating = typeof squadInfo?.rating === 'number' ? Number(squadInfo.rating.toFixed(2)) : null;
    const goals = typeof squadInfo?.goals === 'number' ? squadInfo.goals : undefined;
    const assists = typeof squadInfo?.assists === 'number' ? squadInfo.assists : undefined;
    const position = squadInfo?.positionIdsDesc ? String(squadInfo.positionIdsDesc).split(',')[0] : undefined;

    const valueShare = totalSquadValue > 0 && marketValue ? marketValue / totalSquadValue : 0;
    const isKeyPlayer =
      valueShare >= 0.065 ||
      (rating !== null && rating >= 7.15) ||
      (typeof goals === 'number' && goals >= 3) ||
      (typeof assists === 'number' && assists >= 3);

    items.push({
      id: pid,
      name: p.name,
      type,
      labelFr,
      expectedReturn: expectedReturn && !/doubtful/i.test(expectedReturn) ? expectedReturn : undefined,
      marketValue,
      rating,
      goals,
      assists,
      position,
      isKeyPlayer,
    });
  }

  // Trier par importance (titulaires/joueurs clés puis valeur marchande décroissante)
  items.sort((a, b) => {
    if (Boolean(a.isKeyPlayer) !== Boolean(b.isKeyPlayer)) return a.isKeyPlayer ? -1 : 1;
    if ((a.type === 'doubtful') !== (b.type === 'doubtful')) return a.type === 'doubtful' ? 1 : -1;
    return (b.marketValue || 0) - (a.marketValue || 0);
  });

  return items;
}

function computeAbsencePenalty(players: UnavailablePlayerInfo[], totalSquadValue: number): {
  attackMultiplier: number;
  defenseConcedeMultiplier: number;
  severityScore: number;
} {
  if (!players.length) {
    return { attackMultiplier: 1, defenseConcedeMultiplier: 1, severityScore: 0 };
  }

  let attDrop = 0;
  let defVuln = 0;
  const refSquadVal = totalSquadValue > 0 ? totalSquadValue : 250_000_000;

  for (const p of players) {
    const certainty = p.type === 'doubtful' ? 0.4 : 1.0;
    const valShare = p.marketValue ? Math.min(0.16, p.marketValue / refSquadVal) : p.isKeyPlayer ? 0.07 : 0.025;
    const ratingBoost = p.rating && p.rating >= 7.1 ? 1.25 : 1.0;
    const impact = certainty * valShare * ratingBoost;

    const pos = (p.position || '').toUpperCase();
    if (/ST|CF|LW|RW|CAM|AM|FW/.test(pos) || (p.goals && p.goals >= 2)) {
      attDrop += impact * 1.15;
      defVuln += impact * 0.2;
    } else if (/GK|CB|LB|RB|LWB|RWB/.test(pos)) {
      attDrop += impact * 0.25;
      defVuln += impact * 1.15;
    } else {
      // Milieu ou poste inconnu : impact mixte attaque/défense
      attDrop += impact * 0.7;
      defVuln += impact * 0.7;
    }
  }

  // Plafonner l'impact pour éviter de déformer excessivement le modèle (max -22% en attaque, +18% buts encaissés)
  const clampedAttDrop = Math.min(0.22, attDrop);
  const clampedDefVuln = Math.min(0.18, defVuln);
  const severityScore = Math.round((clampedAttDrop + clampedDefVuln) * 100);

  return {
    attackMultiplier: 1 - clampedAttDrop,
    defenseConcedeMultiplier: 1 + clampedDefVuln,
    severityScore,
  };
}

function formatAbsenceSummaryFr(players: UnavailablePlayerInfo[]): string {
  if (!players.length) {
    return 'Aucun blessé ni suspendu signalé';
  }
  const confirmed = players.filter(p => p.type !== 'doubtful');
  const doubtful = players.filter(p => p.type === 'doubtful');
  const suspensions = players.filter(p => p.type === 'suspension');

  const countParts: string[] = [];
  const injuredCount = confirmed.filter(p => p.type !== 'suspension').length;
  if (injuredCount > 0) countParts.push(`${injuredCount} blessé${injuredCount > 1 ? 's' : ''}`);
  if (suspensions.length > 0) countParts.push(`${suspensions.length} suspendu${suspensions.length > 1 ? 's' : ''}`);
  if (doubtful.length > 0) countParts.push(`${doubtful.length} incertain${doubtful.length > 1 ? 's' : ''}`);

  const previewNames = players.slice(0, 5).map(p => {
    const tags: string[] = [];
    if (p.position) tags.push(p.position);
    if (p.type === 'suspension') tags.push('susp.');
    else if (p.type === 'doubtful') tags.push('incert.');
    if (typeof p.goals === 'number' && p.goals >= 2) tags.push(`${p.goals} b.`);
    return `${p.name}${tags.length ? ` (${tags.join(', ')})` : ''}`;
  });

  const more = players.length > 5 ? ` +${players.length - 5}` : '';
  return `${countParts.join(', ')} : ${previewNames.join(' · ')}${more}`;
}

function extractMatchStatsXg(statsRoot: any): {
  homeXg?: number;
  awayXg?: number;
  homeXgot?: number;
  awayXgot?: number;
  homeBigChances?: number;
  awayBigChances?: number;
} | null {
  const groups = statsRoot?.Periods?.All?.stats;
  if (!Array.isArray(groups)) return null;

  const result: {
    homeXg?: number;
    awayXg?: number;
    homeXgot?: number;
    awayXgot?: number;
    homeBigChances?: number;
    awayBigChances?: number;
  } = {};

  for (const grp of groups) {
    for (const row of grp?.stats || []) {
      if (!row?.key || !Array.isArray(row.stats) || row.stats.length < 2) continue;
      const hVal = Number(row.rawStats?.[0]?.value ?? row.stats[0]);
      const aVal = Number(row.rawStats?.[1]?.value ?? row.stats[1]);
      if (!Number.isFinite(hVal) || !Number.isFinite(aVal)) continue;

      if (row.key === 'expected_goals' && result.homeXg === undefined) {
        result.homeXg = Number(hVal.toFixed(2));
        result.awayXg = Number(aVal.toFixed(2));
      } else if (row.key === 'expected_goals_on_target') {
        result.homeXgot = Number(hVal.toFixed(2));
        result.awayXgot = Number(aVal.toFixed(2));
      } else if (row.key === 'big_chance') {
        result.homeBigChances = hVal;
        result.awayBigChances = aVal;
      }
    }
  }

  return result.homeXg !== undefined ? result : null;
}

function extractXgTableMap(tablePayload: any): Map<number, TeamXgSeasonStats> {
  const map = new Map<number, TeamXgSeasonStats>();
  if (!Array.isArray(tablePayload)) return map;

  const scanXgRows = (xgRows: any[]) => {
    if (!Array.isArray(xgRows)) return;
    for (const row of xgRows) {
      const tid = Number(row.id ?? row.teamId);
      const played = Number(row.played || 0);
      const xg = Number(row.xg);
      const xgConceded = Number(row.xgConceded);
      if (!tid || played <= 0 || !Number.isFinite(xg) || !Number.isFinite(xgConceded)) continue;
      map.set(tid, {
        teamId: tid,
        played,
        xg: Number(xg.toFixed(2)),
        xgConceded: Number(xgConceded.toFixed(2)),
        xgPerMatch: Number((xg / played).toFixed(2)),
        xgaPerMatch: Number((xgConceded / played).toFixed(2)),
        xPoints: Number(Number(row.xPoints || 0).toFixed(1)),
        xgDiff: Number(Number(row.xgDiff || 0).toFixed(2)),
      });
    }
  };

  for (const entry of tablePayload) {
    const data = entry?.data || entry;
    if (data?.table?.xg) scanXgRows(data.table.xg);
    if (Array.isArray(data?.tables)) {
      for (const sub of data.tables) {
        if (sub?.table?.xg) scanXgRows(sub.table.xg);
      }
    }
  }
  return map;
}

function extractSquadInfo(teamPayload: any): {
  coachName: string | null;
  membersById: Map<number, any>;
  totalSquadValue: number;
  xgMapFromTeamTable: Map<number, TeamXgSeasonStats>;
} {
  const membersById = new Map<number, any>();
  let coachName: string | null = null;
  let totalSquadValue = 0;

  const squadGroups = teamPayload?.squad?.squad;
  if (Array.isArray(squadGroups)) {
    for (const grp of squadGroups) {
      const title = String(grp?.title || '').toLowerCase();
      const members = Array.isArray(grp?.members) ? grp.members : [];
      if (title === 'coach' || title === 'coaches') {
        if (members[0]?.name) coachName = String(members[0].name);
        continue;
      }
      for (const m of members) {
        if (!m?.id) continue;
        membersById.set(Number(m.id), m);
        if (typeof m.transferValue === 'number' && m.transferValue > 0) {
          totalSquadValue += m.transferValue;
        }
      }
    }
  }

  const xgMapFromTeamTable = extractXgTableMap(teamPayload?.table);
  return { coachName, membersById, totalSquadValue, xgMapFromTeamTable };
}

function extractReferee(infoBox: any): RefereeInfo | null {
  const ref = infoBox?.Referee;
  if (!ref || !ref.text || !String(ref.text).trim()) return null;

  const info: RefereeInfo = {
    name: String(ref.text).trim(),
    country: ref.country || undefined,
  };

  if (Array.isArray(ref.stats)) {
    for (const st of ref.stats) {
      if (st?.type === 'matches' && typeof st.value === 'number') info.matches = st.value;
      else if (st?.type === 'yellowCards' && typeof st.value === 'number') {
        info.yellowPerMatch = Number(st.value.toFixed(2));
        if (typeof st.average === 'number') info.yellowAverage = Number(st.average.toFixed(2));
        if (typeof st.averageType === 'string') info.yellowAverageType = st.averageType;
      }
      else if (st?.type === 'redCards' && typeof st.value === 'number') info.redCardsTotal = st.value;
      else if (st?.type === 'penalties' && typeof st.value === 'number') info.penaltiesTotal = st.value;
      else if (st?.type === 'fouls' && typeof st.value === 'number') {
        info.foulsPerMatch = Number(st.value.toFixed(1));
        if (typeof st.average === 'number') info.foulsAverage = Number(st.average.toFixed(2));
        if (typeof st.averageType === 'string') info.foulsAverageType = st.averageType;
      }
    }
    if (info.matches && info.matches > 0 && typeof info.penaltiesTotal === 'number') {
      info.penaltiesPerMatch = Number((info.penaltiesTotal / info.matches).toFixed(2));
    }
  }
  return info;
}

function extractH2H(h2hRoot: any, homeTeamId: number, awayTeamId: number, homeTeamName: string, awayTeamName: string) {
  if (!h2hRoot || !Array.isArray(h2hRoot.matches)) return null;

  let homeWins = 0;
  let draws = 0;
  let awayWins = 0;
  let totalGoalsHome = 0;
  let totalGoalsAway = 0;
  const completed: H2HItem[] = [];

  for (const m of h2hRoot.matches) {
    const scoreStr: string | undefined = m?.status?.scoreStr;
    const isFinished = Boolean(m?.status?.finished) && Boolean(scoreStr && scoreStr.includes('-'));
    if (!isFinished || !scoreStr) continue;

    const parts = scoreStr.split('-').map(s => Number(s.trim()));
    if (parts.length !== 2 || !Number.isFinite(parts[0]) || !Number.isFinite(parts[1])) continue;

    const [sH, sA] = parts;
    const mHomeId = Number(m?.home?.id);
    const mHomeName = String(m?.home?.name || '');
    const mAwayName = String(m?.away?.name || '');

    const sameOrientation =
      mHomeId === homeTeamId ||
      (mHomeId !== awayTeamId && teamSimilarity(mHomeName, homeTeamName) >= teamSimilarity(mHomeName, awayTeamName));

    const gfHome = sameOrientation ? sH : sA;
    const gfAway = sameOrientation ? sA : sH;

    totalGoalsHome += gfHome;
    totalGoalsAway += gfAway;
    if (gfHome > gfAway) homeWins += 1;
    else if (gfHome === gfAway) draws += 1;
    else awayWins += 1;

    completed.push({
      date: String(m?.time?.utcTime || m?.status?.utcTime || '').slice(0, 10),
      competition: m?.league?.name || undefined,
      homeName: mHomeName,
      awayName: mAwayName,
      homeScore: sH,
      awayScore: sA,
    });
  }

  if (!completed.length) return null;

  const n = completed.length;
  const avgGoals = ((totalGoalsHome + totalGoalsAway) / n).toFixed(2);
  const last3 = completed
    .slice(0, 3)
    .map(item => `${item.homeName} ${item.homeScore}–${item.awayScore} ${item.awayName}${item.date ? ` (${item.date.slice(0, 4)})` : ''}`)
    .join(' · ');

  return {
    count: n,
    homeWins,
    draws,
    awayWins,
    avgGoalsPerMatch: Number(avgGoals),
    homeGoalsAvg: Number((totalGoalsHome / n).toFixed(2)),
    awayGoalsAvg: Number((totalGoalsAway / n).toFixed(2)),
    resume: `${n} confrontations : ${homeWins}V ${homeTeamName} · ${draws}N · ${awayWins}V ${awayTeamName} (${avgGoals} buts/m)`,
    note: `Derniers duels : ${last3}.`,
    detail: completed.slice(0, 8),
  };
}

/* ================================================================== */
/* ANALYSE QUANTITATIVE v2 — extraction & assemblage                  */
/* ================================================================== */

/** Statistiques d'équipe dont la valeur brute est un cumul de saison */
const TEAM_STAT_SEASON_TOTALS = new Set([
  'expected_goals_team',
  'expected_goals_conceded_team',
  '_xg_diff_team',
  'penalty_won_team',
  'penalty_conceded_team',
  'big_chance_team',
  'big_chance_missed_team',
  'touches_in_opp_box_team',
  'corner_taken_team',
  '_set_piece_goals_team',
  '_set_piece_goals_conceded_team',
]);

function toAnalystTableRow(raw: any): AnalystTableRow | null {
  if (!raw || !raw.id) return null;
  const played = Number(raw.played || 0);
  const scores = String(raw.scoresStr || '')
    .split('-')
    .map(v => Number(String(v).trim()));
  const goalsScored =
    typeof raw.goalsScored === 'number' ? raw.goalsScored : Number.isFinite(scores[0]) ? scores[0] : 0;
  const goalsConceded =
    typeof raw.goalsConceded === 'number'
      ? raw.goalsConceded
      : Number.isFinite(scores[1])
      ? scores[1]
      : 0;

  return {
    id: Number(raw.id),
    name: String(raw.name || ''),
    played,
    pts: Number(raw.pts || 0),
    idx: Number(raw.idx || 0),
    goalsScored,
    goalsConceded,
    xg: typeof raw.xg === 'number' ? raw.xg : undefined,
    xgConceded: typeof raw.xgConceded === 'number' ? raw.xgConceded : undefined,
    xPoints: typeof raw.xPoints === 'number' ? raw.xPoints : undefined,
    xgDiff: typeof raw.xgDiff === 'number' ? raw.xgDiff : undefined,
  };
}

type LeagueContext = {
  rowsAll: AnalystTableRow[];
  rowsHome: AnalystTableRow[];
  rowsAway: AnalystTableRow[];
  xgRows: AnalystTableRow[];
  legend: { title: string; indices: number[] }[];
  tableAll: AnalystTableRow | null;
  tableHome: AnalystTableRow | null;
  tableAway: AnalystTableRow | null;
  xgRow: AnalystTableRow | null;
};

function extractLeagueContext(teamPayload: any, teamId: number): LeagueContext {
  const empty: LeagueContext = {
    rowsAll: [],
    rowsHome: [],
    rowsAway: [],
    xgRows: [],
    legend: [],
    tableAll: null,
    tableHome: null,
    tableAway: null,
    xgRow: null,
  };
  if (!teamPayload) return empty;

  const primaryLeagueId = Number(teamPayload?.details?.primaryLeagueId || 0);
  const tables: any[] = Array.isArray(teamPayload?.table) ? teamPayload.table : [];
  if (!tables.length && Array.isArray(teamPayload?.overview?.table)) {
    tables.push(...teamPayload.overview.table);
  }
  if (!tables.length) return empty;

  let entry =
    tables.find(t => Number(t?.data?.leagueId) === primaryLeagueId && primaryLeagueId) || tables[0];
  let data = entry?.data || entry || {};
  if (!data?.table) {
    const alt = tables.find(t => t?.data?.table);
    data = alt?.data || alt || {};
  }

  const table = data?.table || {};
  const rowsAll = (Array.isArray(table.all) ? table.all : [])
    .map(toAnalystTableRow)
    .filter((r): r is AnalystTableRow => Boolean(r));
  const rowsHome = (Array.isArray(table.home) ? table.home : [])
    .map(toAnalystTableRow)
    .filter((r): r is AnalystTableRow => Boolean(r));
  const rowsAway = (Array.isArray(table.away) ? table.away : [])
    .map(toAnalystTableRow)
    .filter((r): r is AnalystTableRow => Boolean(r));
  const xgRows = (Array.isArray(table.xg) ? table.xg : [])
    .map(toAnalystTableRow)
    .filter((r): r is AnalystTableRow => Boolean(r));

  const legend = (Array.isArray(data?.legend) ? data.legend : [])
    .map((z: any) => ({ title: String(z?.title || ''), indices: Array.isArray(z?.indices) ? z.indices : [] }))
    .filter((z: any) => z.indices.length);

  const findRow = (rows: AnalystTableRow[]) => rows.find(r => r.id === teamId) || null;

  return {
    rowsAll,
    rowsHome,
    rowsAway,
    xgRows,
    legend,
    tableAll: findRow(rowsAll),
    tableHome: findRow(rowsHome),
    tableAway: findRow(rowsAway),
    xgRow: xgRows.find(r => r.id === teamId) || null,
  };
}

function extractTeamStatEntries(
  teamPayload: any,
  played: number
): { stats: Record<string, AnalystStatEntry>; playerStats: Record<string, any> } {
  const stats: Record<string, AnalystStatEntry> = {};
  const playerStats: Record<string, any> = {};

  const teams = teamPayload?.stats?.teams;
  if (Array.isArray(teams)) {
    for (const entry of teams) {
      const key = typeof entry?.stat === 'string' ? entry.stat : entry?.stat?.name;
      const participant = entry?.participant;
      if (!key || !participant) continue;
      const value = Number(participant.value);
      if (!Number.isFinite(value)) continue;
      const format = entry?.stat?.format || participant?.stat?.format || 'fraction';
      const perMatch = TEAM_STAT_SEASON_TOTALS.has(key) && played > 0 ? value / played : value;
      stats[key] = { value, format, perMatch };
    }
  }

  const players = teamPayload?.stats?.players;
  if (Array.isArray(players)) {
    for (const entry of players) {
      const key = typeof entry?.name === 'string' ? entry.name : entry?.stat?.name;
      const participant = entry?.participant;
      if (!key || !participant) continue;
      const value = Number(participant.value);
      if (!Number.isFinite(value)) continue;
      playerStats[key] = {
        value,
        name: String(participant.name || ''),
        stat: participant.stat || null,
      };
    }
  }

  return { stats, playerStats };
}

function extractSquadMembers(teamPayload: any): AnalystSquadMember[] {
  const out: AnalystSquadMember[] = [];
  const groups = teamPayload?.squad?.squad;
  if (!Array.isArray(groups)) return out;

  for (const group of groups) {
    const members = Array.isArray(group?.members) ? group.members : [];
    for (const m of members) {
      if (!m?.id) continue;
      out.push({
        id: Number(m.id),
        name: String(m.name || ''),
        position: m.positionIdsDesc ? String(m.positionIdsDesc).split(',')[0] : undefined,
        rating: typeof m.rating === 'number' ? m.rating : null,
        goals: typeof m.goals === 'number' ? m.goals : undefined,
        assists: typeof m.assists === 'number' ? m.assists : undefined,
        marketValue: typeof m.transferValue === 'number' ? m.transferValue : undefined,
        excludeFromRanking: typeof m.excludeFromRanking === 'boolean' ? m.excludeFromRanking : undefined,
        injured: Boolean(m.injured),
        expectedReturn: m.injury?.expectedReturn ? String(m.injury.expectedReturn) : undefined,
        xg: readPlayerStat(m.stats, /expected goals$|^xg$/i)?.value ?? undefined,
        xa: readPlayerStat(m.stats, /expected assists?$/i)?.value ?? undefined,
        minutes: readPlayerStat(m.stats, /minutes played$|total minutes$/i)?.value ?? undefined,
      });
    }
  }
  return out;
}

function findFixturesArray(payload: any): any[] {
  const candidates = [
    payload?.fixtures?.allFixtures?.fixtures,
    payload?.overview?.fixtures?.allFixtures?.fixtures,
    payload?.fixtures?.fixtures,
    payload?.overview?.fixtures?.fixtures,
  ];
  for (const c of candidates) {
    if (Array.isArray(c) && c.length) return c;
  }
  // Recherche récursive de secours
  const seen = new Set<any>();
  const walk = (node: any, depth: number): any[] | null => {
    if (!node || typeof node !== 'object' || depth > 5 || seen.has(node)) return null;
    seen.add(node);
    if (Array.isArray(node)) {
      const hit = node.find(item => item && typeof item === 'object' && item.status?.utcTime && item.tournament);
      return hit ? node : null;
    }
    for (const key of Object.keys(node)) {
      const found = walk(node[key], depth + 1);
      if (found) return found;
    }
    return null;
  };
  return walk(payload, 0) || [];
}

function extractTeamFixtures(teamPayload: any): AnalystRecentMatch[] {
  const list = findFixturesArray(teamPayload);
  const out: AnalystRecentMatch[] = [];
  if (!Array.isArray(list)) return out;

  for (const f of list) {
    const utcTime = f?.status?.utcTime;
    if (!utcTime) continue;
    const scoreStr = String(f?.status?.scoreStr || '');
    const parts = scoreStr.split('-').map(v => Number(String(v).trim()));
    const homeScore = Number.isFinite(f?.home?.score) && f?.home?.score !== null ? Number(f.home.score) : Number.isFinite(parts[0]) ? parts[0] : 0;
    const awayScore = Number.isFinite(f?.away?.score) && f?.away?.score !== null ? Number(f.away.score) : Number.isFinite(parts[1]) ? parts[1] : 0;

    out.push({
      utcTime: String(utcTime),
      homeId: Number(f?.home?.id || 0),
      awayId: Number(f?.away?.id || 0),
      homeName: String(f?.home?.name || ''),
      awayName: String(f?.away?.name || ''),
      homeScore,
      awayScore,
      competition: f?.tournament?.name ? String(f.tournament.name) : undefined,
      matchId: typeof f?.id === 'number' ? f.id : undefined,
    });
  }
  return out;
}

function extractTeamFormMatches(teamPayload: any, teamId: number): AnalystRecentMatch[] {
  const out: AnalystRecentMatch[] = [];
  const tables: any[] = Array.isArray(teamPayload?.table) ? teamPayload.table : [];
  if (Array.isArray(teamPayload?.overview?.table)) tables.push(...teamPayload.overview.table);

  for (const entry of tables) {
    const teamForm = entry?.teamForm || entry?.data?.teamForm;
    if (!teamForm || typeof teamForm !== 'object') continue;
    const list = Array.isArray(teamForm[String(teamId)]) ? teamForm[String(teamId)] : [];
    for (const item of list) {
      const tt = item?.tooltipText;
      if (!tt?.utcTime) continue;
      out.push({
        utcTime: String(tt.utcTime),
        homeId: Number(tt.homeTeamId || 0),
        awayId: Number(tt.awayTeamId || 0),
        homeName: String(tt.homeTeam || ''),
        awayName: String(tt.awayTeam || ''),
        homeScore: Number(tt.homeScore || 0),
        awayScore: Number(tt.awayScore || 0),
        competition: undefined,
      });
    }
    if (out.length) break;
  }
  return out;
}

function extractLineupTeam(lineupTeam: any, confirmed?: boolean): AnalystLineup | null {
  if (!lineupTeam) return null;
  const starters = Array.isArray(lineupTeam?.starters) ? lineupTeam.starters : [];
  if (!starters.length) return null;
  return {
    formation: lineupTeam?.formation ? String(lineupTeam.formation) : null,
    confirmed: confirmed !== false,
    starters: starters.map((p: any) => ({
      id: Number(p?.id || 0),
      name: String(p?.name || ''),
      marketValue: typeof p?.marketValue === 'number' ? p.marketValue : undefined,
      rating: typeof p?.performance?.rating === 'number' ? p.performance.rating : typeof p?.rating === 'number' ? p.rating : null,
      position: p?.positionId !== undefined ? String(p.positionId) : undefined,
    })),
  };
}


/* ------------------------------------------------------------------ */
/* ENRICHISSEMENT « QUALITÉ DE TIR » (shotmap historique)               */
/* ------------------------------------------------------------------ */
/*
 * La qualité de tir (xG par tir, xGOT par tir) n'existe que dans le
 * shotmap, qui n'est disponible que pour les matchs DISPUTÉS. Pour estimer
 * la qualité d'une équipe avant son match, on recharge donc ses derniers
 * matchs terminés et on agrège leurs tirs.
 *
 * Le même chargement sert à trois choses :
 *   - le profil de qualité de tir (module 03 bis),
 *   - la répartition des buts par période (score à la mi-temps),
 *   - la covariance entre buts des deux équipes (module 01 bis).
 */

type ShotEnrichment = {
  shotQuality: {
    home: ReturnType<typeof buildShotProfile> | null;
    away: ReturnType<typeof buildShotProfile> | null;
    league: { xgPerShot: number; xgotPerShot: number };
  } | null;
  halfTimeSamples: { htHome: number; htAway: number; homeGoals: number; awayGoals: number }[];
  covarianceSamples: { homeGoals: number; awayGoals: number }[];
};

function readHalfTimeScore(details: any): { htHome: number; htAway: number } | null {
  const halfs = details?.header?.status?.halfs;
  if (!halfs || typeof halfs !== 'object') return null;
  const first = halfs['1'] ?? halfs[1];
  const second = halfs['2'] ?? halfs[2];
  if (!first || !second) return null;
  const htHome = Number(first.score ?? first.goals);
  const htAway = Number(second.score ?? second.goals);
  if (!Number.isFinite(htHome) || !Number.isFinite(htAway)) return null;
  return { htHome, htAway };
}

function readFinalScore(details: any): { homeGoals: number; awayGoals: number } | null {
  const teams = details?.header?.teams;
  if (!Array.isArray(teams) || teams.length < 2) return null;
  const homeGoals = Number(teams[0]?.score);
  const awayGoals = Number(teams[1]?.score);
  if (!Number.isFinite(homeGoals) || !Number.isFinite(awayGoals)) return null;
  return { homeGoals, awayGoals };
}

async function enrichShotQuality(params: {
  homeTeam: AnalystTeamInput;
  awayTeam: AnalystTeamInput;
  perTeam?: number;
}): Promise<ShotEnrichment> {
  const perTeam = params.perTeam ?? 3;
  const empty: ShotEnrichment = {
    shotQuality: null,
    halfTimeSamples: [],
    covarianceSamples: [],
  };

  const pickMatches = (team: AnalystTeamInput) =>
    (team.recentMatches || [])
      .filter(m => typeof m.matchId === 'number' && m.matchId > 0)
      .slice(0, perTeam);

  const homeMatches = pickMatches(params.homeTeam);
  const awayMatches = pickMatches(params.awayTeam);
  if (!homeMatches.length && !awayMatches.length) return empty;

  const ids = Array.from(
    new Set([...homeMatches, ...awayMatches].map(m => m.matchId as number))
  ).slice(0, perTeam * 2 + 2);

  const detailsList = await Promise.all(
    ids.map(id => fetchFotmobJson<any>(`matchDetails?matchId=${id}`, 1800))
  );

  const profilesHome: ReturnType<typeof buildShotProfile>[] = [];
  const profilesAway: ReturnType<typeof buildShotProfile>[] = [];
  const halfTimeSamples: ShotEnrichment['halfTimeSamples'] = [];
  const covarianceSamples: ShotEnrichment['covarianceSamples'] = [];
  let allShots = 0;
  let allXg = 0;
  let allXgot = 0;

  for (const details of detailsList) {
    if (!details?.content) continue;
    const shots = extractShots(details);
    const homeId = Number(details?.general?.homeTeam?.id);
    const awayId = Number(details?.general?.awayTeam?.id);

    const homeShots = shots.filter(s => s.teamId !== null && s.teamId === homeId);
    const awayShots = shots.filter(s => s.teamId !== null && s.teamId === awayId);
    if (homeShots.length) profilesHome.push(buildShotProfile(homeShots, 1));
    if (awayShots.length) profilesAway.push(buildShotProfile(awayShots, 1));

    for (const shot of shots) {
      allShots += 1;
      allXg += shot.xg;
      allXgot += shot.xgot;
    }

    const halfTime = readHalfTimeScore(details);
    const finalScore = readFinalScore(details);
    if (halfTime && finalScore) {
      halfTimeSamples.push({ ...halfTime, ...finalScore });
      covarianceSamples.push(finalScore);
    }
  }

  if (!profilesHome.length && !profilesAway.length && !halfTimeSamples.length) return empty;

  const homeProfile = profilesHome.length ? mergeShotProfiles(profilesHome) : null;
  const awayProfile = profilesAway.length ? mergeShotProfiles(profilesAway) : null;

  return {
    shotQuality: {
      home: homeProfile,
      away: awayProfile,
      league: {
        xgPerShot: allShots ? allXg / allShots : 0,
        xgotPerShot: allShots ? allXgot / allShots : 0,
      },
    },
    halfTimeSamples,
    covarianceSamples,
  };
}

function buildAnalystTeamInput(params: {
  teamPayload: any;
  teamId: number;
  teamName: string;
  league: LeagueContext;
  absences: UnavailablePlayerInfo[];
  lineupTeam: any;
  lineupConfirmed?: boolean;
  formation?: string | null;
  kickoffIso: string;
}): AnalystTeamInput {
  const { teamPayload, teamId, teamName, league, absences, lineupTeam, formation } = params;

  const played = league.tableAll?.played || league.xgRow?.played || 1;
  const { stats, playerStats } = extractTeamStatEntries(teamPayload, played);
  const squad = extractSquadMembers(teamPayload);

  let recentMatches = extractTeamFixtures(teamPayload).filter(
    m => m.homeId === teamId || m.awayId === teamId
  );
  if (recentMatches.length < 5) {
    const form = extractTeamFormMatches(teamPayload, teamId);
    if (form.length > recentMatches.length) recentMatches = form;
  }

  const squadById = new Map<number, AnalystSquadMember>();
  for (const m of squad) squadById.set(m.id, m);

  const absencesMapped = absences.map(a => {
    const member = squadById.get(a.id);
    return {
      id: a.id,
      name: a.name,
      type: a.type,
      position: a.position || member?.position,
      marketValue: a.marketValue ?? member?.marketValue,
      rating: a.rating ?? member?.rating ?? null,
      goals: a.goals ?? member?.goals,
      assists: a.assists ?? member?.assists,
      isKeyPlayer: a.isKeyPlayer,
      excludeFromRanking: member?.excludeFromRanking,
      expectedReturn: member?.expectedReturn,
    };
  });

  return {
    teamId,
    name: teamName,
    tableAll: league.tableAll,
    tableHome: league.tableHome,
    tableAway: league.tableAway,
    xgRow: league.xgRow,
    recentMatches,
    stats,
    squad,
    absences: absencesMapped,
    lineup: extractLineupTeam(lineupTeam, params.lineupConfirmed),
    formation: formation || null,
    playerStats,
  } as AnalystTeamInput;
}

export function buildAnalystReportV2(params: {
  homeTeamPayload: any;
  awayTeamPayload: any;
  homeTeamId: number;
  awayTeamId: number;
  homeName: string;
  awayName: string;
  kickoffIso: string;
  matchId: string;
  baseLambdas: { home: number; away: number };
  market?: any;
  referee?: any;
  weather?: any;
  h2h?: { count: number; homeGoalsAvg: number; awayGoalsAvg: number } | null;
  homeAbsences: UnavailablePlayerInfo[];
  awayAbsences: UnavailablePlayerInfo[];
  homeLineup: any;
  awayLineup: any;
  homeFormation?: string | null;
  awayFormation?: string | null;
  lineupConfirmed?: boolean;
  shotQuality?: ShotEnrichment['shotQuality'];
  pitch?: ReturnType<typeof buildPitchProfile> | null;
  halfTimeSamples?: ShotEnrichment['halfTimeSamples'];
  covarianceSamples?: ShotEnrichment['covarianceSamples'];
}) {
  const homeLeague = extractLeagueContext(params.homeTeamPayload, params.homeTeamId);
  const awayLeague = extractLeagueContext(params.awayTeamPayload, params.awayTeamId);

  const homeTeam = buildAnalystTeamInput({
    teamPayload: params.homeTeamPayload,
    teamId: params.homeTeamId,
    teamName: params.homeName,
    league: homeLeague,
    absences: params.homeAbsences,
    lineupTeam: params.homeLineup,
    lineupConfirmed: params.lineupConfirmed,
    formation: params.homeFormation,
    kickoffIso: params.kickoffIso,
  });

  const awayTeam = buildAnalystTeamInput({
    teamPayload: params.awayTeamPayload,
    teamId: params.awayTeamId,
    teamName: params.awayName,
    league: awayLeague,
    absences: params.awayAbsences,
    lineupTeam: params.awayLineup,
    lineupConfirmed: params.lineupConfirmed,
    formation: params.awayFormation,
    kickoffIso: params.kickoffIso,
  });

  const input: AnalystInput = {
    matchId: params.matchId,
    kickoffIso: params.kickoffIso,
    baseLambdas: params.baseLambdas,
    market: params.market,
    referee: params.referee,
    weather: params.weather,
    h2h: params.h2h,
    league: {
      rowsAll: homeLeague.rowsAll.length ? homeLeague.rowsAll : awayLeague.rowsAll,
      rowsHome: homeLeague.rowsHome.length ? homeLeague.rowsHome : awayLeague.rowsHome,
      rowsAway: homeLeague.rowsAway.length ? homeLeague.rowsAway : awayLeague.rowsAway,
      xgRows: homeLeague.xgRows.length ? homeLeague.xgRows : awayLeague.xgRows,
      legend: homeLeague.legend.length ? homeLeague.legend : awayLeague.legend,
    },
    home: homeTeam,
    away: awayTeam,
    shotQuality: params.shotQuality || null,
    pitch: params.pitch || null,
    halfTimeSamples: params.halfTimeSamples || [],
    covarianceSamples: params.covarianceSamples || [],
  };

  return runQuantitativeAnalyst(input);
}

export async function enrichEspnMatchWithFotmob(params: {
  espnMatch: any;
  leagueSlug: string;
  compactDate: string;
  deepTeamFetch?: boolean;
}): Promise<any> {
  const { espnMatch, leagueSlug, compactDate, deepTeamFetch = true } = params;
  if (!espnMatch || espnMatch.error || !espnMatch.home?.name || !espnMatch.away?.name) {
    return espnMatch;
  }

  const matchedDayItem = await findFotmobMatchForEspn({
    leagueSlug,
    compactDate,
    homeName: espnMatch.home.name,
    awayName: espnMatch.away.name,
    kickoffIso: espnMatch.date,
  });

  if (!matchedDayItem) {
    return espnMatch;
  }

  const isFinished = Boolean(matchedDayItem.status?.finished);
  const detailsTtl = isFinished ? 1800 : 300;
  const details = await fetchFotmobJson<any>(`matchDetails?matchId=${matchedDayItem.id}`, detailsTtl);
  if (!details?.content) {
    return espnMatch;
  }

  const homeTeamId = Number(details.general?.homeTeam?.id ?? matchedDayItem.home.id);
  const awayTeamId = Number(details.general?.awayTeam?.id ?? matchedDayItem.away.id);
  const parentLeagueId = Number(details.general?.parentLeagueId ?? details.general?.leagueId ?? matchedDayItem.primaryLeagueId ?? matchedDayItem.leagueId);

  // Récupération parallèle des fiches équipes (entraîneurs, notes/valeurs joueurs, table xG) + table ligue si nécessaire
  let homeTeamPayload: any = null;
  let awayTeamPayload: any = null;
  let leagueTablePayload: any = null;

  // Cotes de marché réelles (1X2, O/U 2,5, BTTS) — source de marché du moteur quantitatif
  const marketOddsPromise = fetchFotmobMarketOdds({
    fotmobMatchId: matchedDayItem.id,
    homeName: espnMatch.home.name,
    awayName: espnMatch.away.name,
  });

  if (deepTeamFetch) {
    [homeTeamPayload, awayTeamPayload, leagueTablePayload] = await Promise.all([
      homeTeamId ? fetchFotmobJson<any>(`teams?id=${homeTeamId}`, 600) : Promise.resolve(null),
      awayTeamId ? fetchFotmobJson<any>(`teams?id=${awayTeamId}`, 600) : Promise.resolve(null),
      parentLeagueId ? fetchFotmobJson<any>(`tltable?leagueId=${parentLeagueId}`, 600) : Promise.resolve(null),
    ]);
  } else if (parentLeagueId) {
    leagueTablePayload = await fetchFotmobJson<any>(`tltable?leagueId=${parentLeagueId}`, 600);
  }

  const marketOdds = await marketOddsPromise;
  // Résolution du marché : une source unique pour l'analyse ET la vigilance.
  //  1. cotes bookmaker réelles (source publique) quand elles sont disponibles,
  //  2. repli sur le marché amont si le flux de cotes est injoignable.
  const marketSource = resolveMarketSource(marketOdds, espnMatch.market);
  const marketPayload = marketSource.payload;
  // Probabilités de marché déjà dé-vigguées (utilisées pour la vigilance).
  const marketProbs = marketSource.probs;
  // Provenance des cotes : opérateur réellement servi et heure d'extraction.
  const marketProvider = marketSource.provider;
  const marketFetchedAt = marketSource.fetchedAt;

  const homeSquad = extractSquadInfo(homeTeamPayload);
  const awaySquad = extractSquadInfo(awayTeamPayload);

  // Table xG consolidée (ligue ou fiche équipe)
  const xgMap = extractXgTableMap(leagueTablePayload);
  homeSquad.xgMapFromTeamTable.forEach((v, k) => {
    if (!xgMap.has(k)) xgMap.set(k, v);
  });
  awaySquad.xgMapFromTeamTable.forEach((v, k) => {
    if (!xgMap.has(k)) xgMap.set(k, v);
  });

  const homeXgSeason = xgMap.get(homeTeamId) || null;
  const awayXgSeason = xgMap.get(awayTeamId) || null;

  // 1. Blessés / suspendus / incertains
  const lineup = details.content?.lineup;
  const rawHomeUnav = lineup?.homeTeam?.unavailable || [];
  const rawAwayUnav = lineup?.awayTeam?.unavailable || [];

  // Composition CONFIRMÉE ou seulement PRÉDITE par la source ? FotMob
  // publie `lineupType: "predicted"` (Enetpulse) avant l'annonce officielle :
  // traiter une composition prédite comme un onze officiel serait faux.
  const lineupType = String(details.content?.lineup?.lineupType || '').toLowerCase();
  const lineupConfirmed = lineupType ? lineupType !== 'predicted' : Boolean(details.general?.started || isFinished);

  const homeAbsences = parseUnavailableList(rawHomeUnav, homeSquad.membersById, homeSquad.totalSquadValue);
  const awayAbsences = parseUnavailableList(rawAwayUnav, awaySquad.membersById, awaySquad.totalSquadValue);

  const homePenalty = computeAbsencePenalty(homeAbsences, homeSquad.totalSquadValue);
  const awayPenalty = computeAbsencePenalty(awayAbsences, awaySquad.totalSquadValue);

  // Entraîneurs & formations (depuis lineup si match joué/compos publiées, sinon depuis squad)
  const homeCoach = lineup?.homeTeam?.coach?.name || homeSquad.coachName || null;
  const awayCoach = lineup?.awayTeam?.coach?.name || awaySquad.coachName || null;
  const homeFormation = lineup?.homeTeam?.formation || null;
  const awayFormation = lineup?.awayTeam?.formation || null;

  // 2. Arbitre & Stade & Météo FotMob
  const infoBox = details.content?.matchFacts?.infoBox;
  const referee = extractReferee(infoBox);
  const fotmobWeather = details.content?.weather || null;

  // 3. Confrontations directes multi-saisons (H2H)
  const h2hEnriched = extractH2H(
    details.content?.h2h,
    homeTeamId,
    awayTeamId,
    espnMatch.home.name,
    espnMatch.away.name
  );

  // 4. xG réel du match (si match en cours / terminé avec couverture xG)
  const liveOrFinalMatchXg = extractMatchStatsXg(details.content?.stats);

  // 5. Insights FotMob / Opta
  const rawInsights: any[] = Array.isArray(details.content?.matchFacts?.insights)
    ? details.content.matchFacts.insights
    : [];
  const insights = rawInsights
    .map(ins => (typeof ins?.text === 'string' ? ins.text.trim() : ''))
    .filter(Boolean)
    .slice(0, 6);

  // 6. Recalibrage intelligent du modèle Poisson (λ_dom, λ_ext) avec xG FotMob + absences + H2H
  const baseLambdaHome = Number(espnMatch.expectedGoals?.home || 1.35);
  const baseLambdaAway = Number(espnMatch.expectedGoals?.away || 1.15);

  let adjLambdaHome = baseLambdaHome;
  let adjLambdaAway = baseLambdaAway;

  // Intégration des vrais xG/match et xGA/match de la saison (poids 35% si au moins 3 matchs joués)
  if (homeXgSeason && awayXgSeason && homeXgSeason.played >= 3 && awayXgSeason.played >= 3) {
    // Attendu offensif croisé : moyenne géométrique/arithmétique entre xG produit et xGA concédé par l'adversaire (+ léger bonus domicile ~6%)
    const xgBasedHome = ((homeXgSeason.xgPerMatch + awayXgSeason.xgaPerMatch) / 2) * 1.06;
    const xgBasedAway = ((awayXgSeason.xgPerMatch + homeXgSeason.xgaPerMatch) / 2) * 0.94;
    adjLambdaHome = adjLambdaHome * 0.62 + xgBasedHome * 0.38;
    adjLambdaAway = adjLambdaAway * 0.62 + xgBasedAway * 0.38;
  }

  // Léger ajustement H2H si échantillon >= 4 confrontations récentes (poids prudent de 8%)
  if (h2hEnriched && h2hEnriched.count >= 4) {
    adjLambdaHome = adjLambdaHome * 0.92 + h2hEnriched.homeGoalsAvg * 0.08;
    adjLambdaAway = adjLambdaAway * 0.92 + h2hEnriched.awayGoalsAvg * 0.08;
  }

  // λ AVANT la pénalité d'effectif : c'est le moteur v3 qui applique
  // l'impact des absences (une seule fois, sur contributions mesurées).
  // On conserve ici la version pénalisée pour le chemin « vue journée ».
  const lambdaHomeNoAbsence = adjLambdaHome;
  const lambdaAwayNoAbsence = adjLambdaAway;

  // Pondération des blessés & suspendus (baisse de l'attaque propre + hausse des buts concédés si défense décimée)
  adjLambdaHome = adjLambdaHome * homePenalty.attackMultiplier * awayPenalty.defenseConcedeMultiplier;
  adjLambdaAway = adjLambdaAway * awayPenalty.attackMultiplier * homePenalty.defenseConcedeMultiplier;

  const recomputed = computeProbabilitiesFromLambdas(adjLambdaHome, adjLambdaAway);

  // 6bis. MOTEUR D'ANALYSE QUANTITATIVE v3 — 8 modules (score bivarié,
  // calendrier, qualité de tir, absences mesurées, tactique, calibration
  // marché calibrée, contexte, Monte-Carlo 10 000 itérations).
  let analystReport: any = null;

  // Enrichissement « qualité de tir » : on recharge les derniers matchs
  // terminés des deux équipes pour obtenir le shotmap (xG/xGOT par tir), le
  // score à la mi-temps et la covariance. Budget volontairement borné.
  let shotEnrichment: ShotEnrichment = {
    shotQuality: null,
    halfTimeSamples: [],
    covarianceSamples: [],
  };
  if (deepTeamFetch && homeTeamPayload && awayTeamPayload) {
    const homeInput = buildAnalystTeamInput({
      teamPayload: homeTeamPayload,
      teamId: homeTeamId,
      teamName: espnMatch.home.name,
      league: extractLeagueContext(homeTeamPayload, homeTeamId),
      absences: homeAbsences,
      lineupTeam: lineup?.homeTeam,
      lineupConfirmed,
      formation: homeFormation,
      kickoffIso: espnMatch.date || new Date().toISOString(),
    });
    const awayInput = buildAnalystTeamInput({
      teamPayload: awayTeamPayload,
      teamId: awayTeamId,
      teamName: espnMatch.away.name,
      league: extractLeagueContext(awayTeamPayload, awayTeamId),
      absences: awayAbsences,
      lineupTeam: lineup?.awayTeam,
      lineupConfirmed,
      formation: awayFormation,
      kickoffIso: espnMatch.date || new Date().toISOString(),
    });
    try {
      shotEnrichment = await enrichShotQuality({ homeTeam: homeInput, awayTeam: awayInput, perTeam: 3 });
    } catch {
      shotEnrichment = { shotQuality: null, halfTimeSamples: [], covarianceSamples: [] };
    }
  }

  if (deepTeamFetch && homeTeamPayload && awayTeamPayload) {
    try {
      analystReport = buildAnalystReportV2({
        homeTeamPayload,
        awayTeamPayload,
        homeTeamId,
        awayTeamId,
        homeName: espnMatch.home.name,
        awayName: espnMatch.away.name,
        kickoffIso: espnMatch.date || new Date().toISOString(),
        matchId: String(matchedDayItem.id),
        baseLambdas: { home: lambdaHomeNoAbsence, away: lambdaAwayNoAbsence },
        market: marketPayload,
        referee,
        weather: fotmobWeather,
        h2h: h2hEnriched
          ? {
              count: h2hEnriched.count,
              homeGoalsAvg: h2hEnriched.homeGoalsAvg,
              awayGoalsAvg: h2hEnriched.awayGoalsAvg,
            }
          : null,
        homeAbsences,
        awayAbsences,
        homeLineup: lineup?.homeTeam,
        awayLineup: lineup?.awayTeam,
        homeFormation,
        awayFormation,
        lineupConfirmed,
        shotQuality: shotEnrichment.shotQuality,
        pitch: buildPitchProfile(infoBox?.Stadium),
        halfTimeSamples: shotEnrichment.halfTimeSamples,
        covarianceSamples: shotEnrichment.covarianceSamples,
      });
    } catch {
      analystReport = null;
    }
  }

  // Probabilités finales : modèle bivarié calibré sur le marché lorsqu'il est disponible
  let finalExpectedGoals = recomputed.expectedGoals;
  let finalProbabilities: any = recomputed.probabilities;
  let finalTopScores = recomputed.topScores;

  if (analystReport) {
    const total = analystReport.lambdas.total;
    const lH1 = total * 0.44;
    const noGoalH1 = Math.exp(-lH1);
    const shareHome = total > 0 ? analystReport.lambdas.home / total : 0.5;

    finalExpectedGoals = { home: analystReport.lambdas.home, away: analystReport.lambdas.away };
    // BTTS : probabilité calibrée sur les cotes de marché réelles quand elles sont disponibles.
    const bttsCalibrated = analystReport.market.calibrated.btts ?? analystReport.model.btts;
    finalProbabilities = {
      home: analystReport.market.calibrated.home,
      draw: analystReport.market.calibrated.draw,
      away: analystReport.market.calibrated.away,
      bttsYes: bttsCalibrated,
      bttsNo: Number((1 - bttsCalibrated).toFixed(4)),
      over15: analystReport.model.over15,
      under15: Number((1 - analystReport.model.over15).toFixed(4)),
      over25: analystReport.market.calibrated.over25,
      under25: Number((1 - analystReport.market.calibrated.over25).toFixed(4)),
      over35: analystReport.model.over35,
      under35: Number((1 - analystReport.model.over35).toFixed(4)),
      firstHome: analystReport.model.firstHome,
      firstAway: analystReport.model.firstAway,
      noGoal: analystReport.model.noGoal,
      firstHalf: analystReport.model.firstHalf,
      secondHalf: analystReport.model.secondHalf,
      firstHomeH1: Number(((1 - noGoalH1) * shareHome).toFixed(4)),
      firstAwayH1: Number(((1 - noGoalH1) * (1 - shareHome)).toFixed(4)),
    };
    finalTopScores = analystReport.model.topScores.slice(0, 5);
  }

  // 7. Mise à jour du score de vigilance avec les signaux d'effectif et d'écart marché/modèle
  // Le marché de référence est désormais constitué des cotes bookmaker réelles,
  // dont la marge a été retirée (probabilités justes).
  const market = marketProbs;
  const reasons: string[] = [];
  let vigilanceScore = 0;

  if (!market) {
    vigilanceScore += 10;
    reasons.push('Cotes indisponibles ou suspendues : impossible de comparer au marché.');
  } else {
    const diff1x2 = Math.max(
      Math.abs((recomputed.probabilities.home || 0) - (market.home || 0)),
      Math.abs((recomputed.probabilities.draw || 0) - (market.draw || 0)),
      Math.abs((recomputed.probabilities.away || 0) - (market.away || 0))
    );
    if (diff1x2 >= 0.14) {
      vigilanceScore += 25;
      reasons.push(
        `Divergence modèle/marché (${Math.round(diff1x2 * 100)}%) après prise en compte des xG et des absences.`
      );
    }
    if (typeof market.over25 === 'number') {
      const diffOver = Math.abs((recomputed.probabilities.over25 || 0) - market.over25);
      if (diffOver >= 0.18) {
        vigilanceScore += 10;
        reasons.push(
          `Écart sur le total de buts (+2,5 : modèle ${Math.round(recomputed.probabilities.over25 * 100)}% vs marché ${Math.round(
            market.over25 * 100
          )}%).`
        );
      }
    }
  }

  if (homePenalty.severityScore >= 12 || awayPenalty.severityScore >= 12) {
    vigilanceScore += 12;
    const impacted =
      homePenalty.severityScore >= 12 && awayPenalty.severityScore >= 12
        ? `${espnMatch.home.short || espnMatch.home.name} & ${espnMatch.away.short || espnMatch.away.name}`
        : homePenalty.severityScore >= 12
        ? espnMatch.home.name
        : espnMatch.away.name;
    reasons.push(
      `Absences notables détectées (${impacted}) : impact significatif sur les onze probables.`
    );
  }

  const freshCountH = espnMatch.factors?.forme?.fraicheurHome?.count ?? 5;
  const freshCountA = espnMatch.factors?.forme?.fraicheurAway?.count ?? 5;
  if (freshCountH < 3 || freshCountA < 3) {
    vigilanceScore += 15;
    reasons.push('Échantillon récent réduit (< 3 matchs sur 60 jours) : incertitude statistique accrue.');
  }

  if (analystReport) {
    const edgeMax = Math.max(
      Math.abs(analystReport.market.edges.home || 0),
      Math.abs(analystReport.market.edges.draw || 0),
      Math.abs(analystReport.market.edges.away || 0)
    );
    if (edgeMax >= 0.05) {
      vigilanceScore += 8;
      reasons.push(
        `Écart significatif entre le modèle quantitatif (8 modules) et le marché : ${Math.round(edgeMax * 100)} points.`
      );
    }
    const maxFatigue = Math.max(
      analystReport.context.home.fatigue || 0,
      analystReport.context.away.fatigue || 0
    );
    if (maxFatigue >= 0.55) {
      vigilanceScore += 8;
      reasons.push(
        `Charge de calendrier élevée sur les 14 derniers jours (indice ${Math.round(maxFatigue * 100)} %) : performances possibles en baisse.`
      );
    }
    if (analystReport.absences.officialLineup.available) {
      const rot = Math.min(
        analystReport.absences.officialLineup.home?.rotation ?? 1,
        analystReport.absences.officialLineup.away?.rotation ?? 1
      );
      if (rot < 0.93) {
        vigilanceScore += 8;
        reasons.push('Composition officielle publiée : rotation ou changement de onze important par rapport au noyau habitual.');
      }
    }
  }

  if (referee && typeof referee.yellowPerMatch === 'number' && referee.yellowPerMatch >= 4.6) {
    vigilanceScore += 5;
    reasons.push(
      `Arbitre sévère désigné (${referee.name} : ${referee.yellowPerMatch} cartons jaunes/match) — volatilité disciplinaire.`
    );
  }

  vigilanceScore = Math.min(100, vigilanceScore);
  const vigilanceLevel = vigilanceScore >= 55 ? 'Élevé' : vigilanceScore >= 30 ? 'Modéré' : 'Faible';

  // 8. Enrichissement structuré des 8 facteurs tout en préservant 100% de la compatibilité existante
  const nextFactors = { ...(espnMatch.factors || {}) };

  // Facteur 03 : Confrontations directes (H2H)
  if (h2hEnriched) {
    nextFactors.h2h = {
      ...(nextFactors.h2h || {}),
      resume: h2hEnriched.resume,
      note: h2hEnriched.note,
      detail: h2hEnriched.detail,
      source: 'Statistiques publiques',
    };
  }

  // Facteur 04 : Blessés / suspendus
  const hasLineupOrUnav = Boolean(lineup);
  if (hasLineupOrUnav) {
    const impactParts: string[] = [];
    if (homePenalty.attackMultiplier < 0.99 || homePenalty.defenseConcedeMultiplier > 1.01) {
      impactParts.push(
        `${espnMatch.home.short || espnMatch.home.name} (att. ${Math.round((homePenalty.attackMultiplier - 1) * 100)}%, déf. +${Math.round(
          (homePenalty.defenseConcedeMultiplier - 1) * 100
        )}% bc)`
      );
    }
    if (awayPenalty.attackMultiplier < 0.99 || awayPenalty.defenseConcedeMultiplier > 1.01) {
      impactParts.push(
        `${espnMatch.away.short || espnMatch.away.name} (att. ${Math.round((awayPenalty.attackMultiplier - 1) * 100)}%, déf. +${Math.round(
          (awayPenalty.defenseConcedeMultiplier - 1) * 100
        )}% bc)`
      );
    }

    nextFactors.blessures = {
      home: formatAbsenceSummaryFr(homeAbsences),
      away: formatAbsenceSummaryFr(awayAbsences),
      homePlayers: homeAbsences,
      awayPlayers: awayAbsences,
      impact: {
        home: homePenalty,
        away: awayPenalty,
      },
      note: impactParts.length
        ? `Pondération xG appliquée : ${impactParts.join(' · ')}.`
        : 'Effectifs quasi complets, aucun malus majeur appliqué au modèle.',
    };
  }

  // Facteur 07 : Statistiques attaque / défense + vrais xG
  if (homeXgSeason || awayXgSeason || liveOrFinalMatchXg) {
    const prevStats = nextFactors.stats || {};
    nextFactors.stats = {
      ...prevStats,
      xgSaison: {
        home: homeXgSeason,
        away: awayXgSeason,
      },
      xgMatchReel: liveOrFinalMatchXg,
      note:
        homeXgSeason && awayXgSeason
          ? `Modèle calibré avec les xG/xGA de la saison (${espnMatch.home.short || 'Dom.'} : ${homeXgSeason.xgPerMatch} xG/m, ${homeXgSeason.xgaPerMatch} xGA/m · ${espnMatch.away.short || 'Ext.'} : ${awayXgSeason.xgPerMatch} xG/m, ${awayXgSeason.xgaPerMatch} xGA/m) combinés à la forme récente.`
          : liveOrFinalMatchXg
          ? `xG réels du match : ${liveOrFinalMatchXg.homeXg} – ${liveOrFinalMatchXg.awayXg}.`
          : prevStats.note,
    };
  }

  // Facteur 08 : Météo, repos, arbitre & entraîneurs
  const prevAutres = nextFactors.autres || {};
  const extraNotes: string[] = [];
  if (referee) {
    const refStatsParts: string[] = [];
    if (typeof referee.yellowPerMatch === 'number') refStatsParts.push(`${referee.yellowPerMatch} j./m`);
    if (typeof referee.foulsPerMatch === 'number') refStatsParts.push(`${referee.foulsPerMatch} fautes/m`);
    if (typeof referee.penaltiesTotal === 'number' && referee.matches) {
      refStatsParts.push(`${referee.penaltiesTotal} pen. en ${referee.matches} m.`);
    }
    extraNotes.push(`Arbitre : ${referee.name}${refStatsParts.length ? ` (${refStatsParts.join(', ')})` : ''}.`);
  } else {
    extraNotes.push('Arbitre : non encore désigné.');
  }

  if (homeCoach || awayCoach) {
    extraNotes.push(
      `Bancs : ${homeCoach || 'n.c.'}${homeFormation ? ` (${homeFormation})` : ''} vs ${awayCoach || 'n.c.'}${
        awayFormation ? ` (${awayFormation})` : ''
      }.`
    );
  }

  const mergedMeteo = prevAutres.meteo
    ? {
        ...prevAutres.meteo,
        description:
          prevAutres.meteo.description ||
          fotmobWeather?.defaultTitle ||
          (typeof prevAutres.meteo.temp === 'number'
            ? `${prevAutres.meteo.temp}°C${
                typeof prevAutres.meteo.precipProb === 'number' ? `, pluie ${prevAutres.meteo.precipProb}%` : ''
              }`
            : undefined),
      }
    : fotmobWeather && typeof fotmobWeather.temperature === 'number'
    ? {
        temp: fotmobWeather.temperature,
        precipProb: fotmobWeather.precipChance,
        description: `${fotmobWeather.temperature}°C · ${fotmobWeather.defaultTitle || fotmobWeather.description || ''}`.trim(),
      }
    : null;

  nextFactors.autres = {
    ...prevAutres,
    meteo: mergedMeteo,
    arbitre: referee,
    entraineurs: {
      home: homeCoach,
      away: awayCoach,
      formationHome: homeFormation,
      formationAway: awayFormation,
    },
    note: extraNotes.join(' '),
  };

  // Limitations mises à jour honnêtement
  const updatedLimitations = [
    'Probabilités estimées par un modèle statistique hybride (Poisson + xG/absences + forme récente) : jamais garanties.',
    'Le score de vigilance signale une divergence ou un aléa d’effectif, jamais une preuve de manipulation.',
    homeXgSeason && awayXgSeason
      ? 'xG/xGA de saison, blessés/suspendus, confrontations multi-saisons et arbitre intégrés au modèle.'
      : 'Blessés/suspendus, confrontations multi-saisons et arbitre intégrés au modèle (couverture xG selon compétition).',
  ];

  return {
    ...espnMatch,
    expectedGoals: finalExpectedGoals,
    baseExpectedGoalsEspn: espnMatch.expectedGoals,
    realMatchXg: liveOrFinalMatchXg,
    probabilities: finalProbabilities,
    topScores: finalTopScores,
    analyst: analystReport,
    vigilance: {
      score: vigilanceScore,
      level: vigilanceLevel,
      reasons: reasons.length ? reasons : espnMatch.vigilance?.reasons || [],
    },
    factors: nextFactors,
    limitations: updatedLimitations,
    market: marketPayload,
    fotmob: {
      matchId: matchedDayItem.id,
      coverageLevel: details.general?.coverageLevel || null,
      homeTeamId,
      awayTeamId,
      coaches: { home: homeCoach, away: awayCoach },
      formations: { home: homeFormation, away: awayFormation },
      referee,
      insights,
    },
    marketSource: marketPayload
      ? {
          origin: marketSource.origin,
          provider: marketProvider?.label ?? null,
          providerKey: marketProvider?.key ?? null,
          requested: marketProvider?.requested ?? null,
          honored: marketProvider?.honored ?? null,
          fetchedAt: marketFetchedAt,
          markets: marketOdds.odds?.markets ?? [],
          overround: marketOdds.parsed?.overround ?? null,
          method: marketOdds.parsed?.method ?? null,
        }
      : null,
  };
}
