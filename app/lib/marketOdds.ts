/* ------------------------------------------------------------------ */
/* COTES DE MARCHÉ RÉELLES (source publique)                           */
/* ------------------------------------------------------------------ */
/*
 * Les cotes proviennent des flux publics de marché exposé par la source
 * de données football. Elles sont décimales et réelles (1 / X / 2,
 * plus de 2,5 buts, les deux équipes marquent, nul exclu…).
 *
 * Objectif : alimenter le module 06 du moteur quantitatif (retrait de
 * marge puis calibration bayésienne) au lieu de probabilités de marché
 * génériques. Aucun nom de bookmaker n'est exposé publiquement : la source
 * reste « cotes de marché publiques ».
 */

import { devigThreeWayDecimal, devigTwoWayDecimal } from './devig';

export type MarketProvider = {
  /** Identifiant stable renvoyé par la source (ex. « 1xBet_Spain ») */
  key: string;
  /** Identifiant numérique du fournisseur */
  providerId: string;
  /** Libellé lisible (ex. « 1xBet Espagne ») */
  label: string;
  /** Pays du point de vente des cotes */
  country: string;
  /** Opérateur demandé dans la requête, s'il y en avait un */
  requested: string | null;
  /** true si la source a bien servi l'opérateur demandé */
  honored: boolean;
};

export type MarketOdds = {
  /** Cotes décimales brutes (1 / X / 2) */
  home: number | null;
  draw: number | null;
  away: number | null;
  /** Cotes décimales Over / Under 2,5 buts */
  over25: number | null;
  under25: number | null;
  /** Cotes décimales BTTS Oui / Non */
  bttsYes: number | null;
  bttsNo: number | null;
  /** Nul exclu (cotes domicile / extérieur) */
  drawNoBetHome: number | null;
  drawNoBetAway: number | null;
  /** Lignes de totaux de buts disponibles (1.5, 2.5, 3.5…) */
  goalLines: { line: number; over: number; under: number }[];
  /** Marchés effectivement trouvés */
  markets: string[];
  /** Timestamp de récupération */
  fetchedAt: string;
  /** Fournisseur réellement résolu par la source */
  provider: MarketProvider | null;
};

export type ParsedOdds = {
  available: boolean;
  odds: MarketOdds;
  /** Probabilités de marché après retrait de marge */
  probabilities: {
    home: number;
    draw: number;
    away: number;
    over25: number | null;
    btts: number | null;
  };
  overround: number;
  method: string;
};

const EMPTY_ODDS: MarketOdds = {
  home: null,
  draw: null,
  away: null,
  over25: null,
  under25: null,
  bttsYes: null,
  bttsNo: null,
  drawNoBetHome: null,
  drawNoBetAway: null,
  goalLines: [],
  markets: [],
  fetchedAt: '',
  provider: null,
};

const COUNTRY_LABELS: Record<string, string> = {
  spain: 'Espagne',
  espagne: 'Espagne',
  france: 'France',
  'united kingdom': 'Royaume-Uni',
  uk: 'Royaume-Uni',
  germany: 'Allemagne',
  deutschland: 'Allemagne',
  italy: 'Italie',
  italia: 'Italie',
  portugal: 'Portugal',
  netherlands: 'Pays-Bas',
  belgium: 'Belgique',
  poland: 'Pologne',
  brazil: 'Brésil',
  usa: 'États-Unis',
  'united states': 'États-Unis',
};

/** Transforme « 1xBet_Spain » en « 1xBet Espagne ». */
export function providerLabel(key: string): string {
  const raw = String(key || '').trim();
  if (!raw) return 'Opérateur de marché';
  const [name, ...rest] = raw.split('_');
  const countryRaw = rest.join('_').replace(/\s+/g, ' ').trim().toLowerCase();
  const country = COUNTRY_LABELS[countryRaw] || (countryRaw ? countryRaw.charAt(0).toUpperCase() + countryRaw.slice(1) : '');
  return country ? `${name} ${country}` : name;
}

/**
 * Extrait les métadonnées du fournisseur réellement résolu par la source.
 * Un opérateur demandé peut être ignoré par la source : on le signale
 * alors explicitement au lieu de supposer que la requête a été honorée.
 */
export function extractProvider(payload: any, requested?: string | null): MarketProvider | null {
  const key = String(payload?.persistentKey ?? payload?.providerKey ?? '').trim();
  if (!key) return null;
  const providerId = String(payload?.providerId ?? '');
  const requestedKey = requested ? String(requested).trim() : null;
  const honored = requestedKey ? requestedKey.toLowerCase() === key.toLowerCase() : true;
  const countryRaw = key.includes('_') ? key.slice(key.indexOf('_') + 1).replace(/\s+/g, ' ').trim() : '';
  return {
    key,
    providerId,
    label: providerLabel(key),
    country: COUNTRY_LABELS[countryRaw.toLowerCase()] || countryRaw,
    requested: requestedKey,
    honored,
  };
}

function toDecimal(value: any): number | null {
  if (typeof value === 'number' && Number.isFinite(value) && value > 1.001) return value;
  if (typeof value === 'string') {
    const parsed = Number(value.replace(',', '.'));
    if (Number.isFinite(parsed) && parsed > 1.001) return parsed;
  }
  return null;
}

function marketKey(market: any): string {
  const key =
    market?.fotMobMarketTypeId?.translationKey ||
    market?.headerTranslationKey ||
    market?.header ||
    '';
  return String(key).toLowerCase();
}

function selectionOdds(selection: any): number | null {
  return toDecimal(selection?.oddsDecimal ?? selection?.odds ?? selection?.oddsFraction);
}

function goalLineFromHeader(header: string): number | null {
  const match = String(header || '').match(/(\d+(?:[.,]\d+)?)/);
  if (!match) return null;
  const value = Number(match[1].replace(',', '.'));
  return Number.isFinite(value) ? value : null;
}

function normalizeTeamKey(raw: string): string {
  return String(raw || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * Extrait les cotes d'une charge utile de marché (1X2, O/U, BTTS, DNB).
 */
export function parseMarketOdds(payload: any, homeName = '', awayName = '', requestedProvider?: string | null): MarketOdds {
  const odds: MarketOdds = { ...EMPTY_ODDS, goalLines: [], markets: [], fetchedAt: new Date().toISOString() };
  if (!payload || typeof payload !== 'object') return odds;
  odds.provider = extractProvider(payload, requestedProvider ?? null);

  const markets: any[] = [];
  const factMarkets = payload?.odds?.matchfactMarkets;
  if (Array.isArray(factMarkets)) markets.push(...factMarkets);
  const tabMarkets = payload?.odds?.oddsTabMarkets;
  if (Array.isArray(tabMarkets)) {
    for (const group of tabMarkets) {
      if (Array.isArray(group?.markets)) markets.push(...group.markets);
    }
  }

  // Repli : marché déjà résolu (rencontre terminée) — cotes 1 / X / 2
  const resolved = payload?.odds?.resolvedOddsMarket;
  if (!markets.length && resolved?.selections?.length) {
    markets.push({ header: 'Match Result', headerTranslationKey: 'who_will_win', selections: resolved.selections });
  }

  const homeKey = normalizeTeamKey(homeName);
  const awayKey = normalizeTeamKey(awayName);
  const seen = new Set<string>();

  for (const market of markets) {
    const key = marketKey(market);
    const selections = Array.isArray(market?.selections) ? market.selections : [];
    if (!key || !selections.length) continue;

    // --- 1 / X / 2 ---------------------------------------------------
    if (key.includes('who_will_win')) {
      for (const selection of selections) {
        const name = String(selection?.name ?? '').trim().toLowerCase();
        const odd = selectionOdds(selection);
        if (!odd) continue;
        if (name === '1' || name === 'h' || name === 'home') odds.home = odd;
        else if (name === 'x' || name === 'd' || name === 'draw') odds.draw = odd;
        else if (name === '2' || name === 'a' || name === 'away') odds.away = odd;
      }
      if (odds.home && odds.draw && odds.away) {
        seen.add(key);
        if (!odds.markets.includes('1X2')) odds.markets.push('1X2');
      }
      continue;
    }

    // --- Les deux équipes marquent -----------------------------------
    if (key.includes('both_score')) {
      for (const selection of selections) {
        const name = String(selection?.name ?? '').trim().toLowerCase();
        const odd = selectionOdds(selection);
        if (!odd) continue;
        if (name === 'yes' || name === 'oui') odds.bttsYes = odd;
        else if (name === 'no' || name === 'non') odds.bttsNo = odd;
      }
      if (odds.bttsYes && odds.bttsNo) {
        seen.add(key);
        if (!odds.markets.includes('Les deux équipes marquent')) odds.markets.push('Les deux équipes marquent');
      }
      continue;
    }

    // --- Nul exclu ----------------------------------------------------
    if (key.includes('draw_no_bet')) {
      for (const selection of selections) {
        const name = normalizeTeamKey(String(selection?.name ?? ''));
        const odd = selectionOdds(selection);
        if (!odd) continue;
        if (homeKey && name === homeKey) odds.drawNoBetHome = odd;
        else if (awayKey && name === awayKey) odds.drawNoBetAway = odd;
      }
      if (odds.drawNoBetHome && odds.drawNoBetAway) {
        seen.add(key);
        if (!odds.markets.includes('Nul exclu')) odds.markets.push('Nul exclu');
      }
      continue;
    }

    // --- Totaux de buts (Over / Under X.X) -----------------------------
    if (key.includes('odds_goals_over_under') || /over\/?under/i.test(String(market?.header ?? ''))) {
      const line = goalLineFromHeader(market?.header);
      let over: number | null = null;
      let under: number | null = null;
      for (const selection of selections) {
        const name = String(selection?.name ?? '').trim().toLowerCase();
        const odd = selectionOdds(selection);
        if (!odd) continue;
        if (name.startsWith('over') || name === 'o' || name === 'plus') over = odd;
        else if (name.startsWith('under') || name === 'u' || name === 'moins') under = odd;
      }
      if (line !== null && over && under) {
        const existing = odds.goalLines.find(item => Math.abs(item.line - line) < 0.001);
        if (existing) {
          existing.over = over;
          existing.under = under;
        } else {
          odds.goalLines.push({ line, over, under });
        }
        if (Math.abs(line - 2.5) < 0.001) {
          odds.over25 = over;
          odds.under25 = under;
        }
      }
    }
  }

  if (!seen.size && odds.goalLines.length) {
    odds.markets.push('Totaux de buts');
  }
  if (odds.over25 && odds.under25 && !odds.markets.includes('Total de buts 2,5')) {
    odds.markets.push('Total de buts 2,5');
  }
  odds.goalLines.sort((a, b) => a.line - b.line);
  return odds;
}

/**
 * Complète les cotes manquantes d'un provider avec celles d'un autre
 * (1X2 prioritaire, O/U et BTTS complétés si possible).
 */
export function mergeMarketOdds(primary: MarketOdds, secondary: MarketOdds): MarketOdds {
  if (!primary || !secondary) return primary;
  const merged: MarketOdds = {
    ...primary,
    goalLines: [...(primary.goalLines || [])],
    markets: [...(primary.markets || [])],
    // Le fournisseur affiché reste celui qui a fourni le trio 1X2.
    provider: primary.provider ?? secondary.provider ?? null,
  };
  if (!merged.home && secondary.home) {
    merged.home = secondary.home;
    merged.draw = secondary.draw;
    merged.away = secondary.away;
  }
  if (!merged.over25 && secondary.over25) {
    merged.over25 = secondary.over25;
    merged.under25 = secondary.under25;
  }
  if (!merged.bttsYes && secondary.bttsYes) {
    merged.bttsYes = secondary.bttsYes;
    merged.bttsNo = secondary.bttsNo;
  }
  if (!merged.drawNoBetHome && secondary.drawNoBetHome) {
    merged.drawNoBetHome = secondary.drawNoBetHome;
    merged.drawNoBetAway = secondary.drawNoBetAway;
  }
  for (const line of secondary.goalLines || []) {
    if (!merged.goalLines.some(item => Math.abs(item.line - line.line) < 0.001)) merged.goalLines.push(line);
  }
  for (const market of secondary.markets || []) {
    if (!merged.markets.includes(market)) merged.markets.push(market);
  }
  merged.goalLines.sort((a, b) => a.line - b.line);
  return merged;
}

/**
 * Transforme les cotes décimales en probabilités de marché justes
 * (marge bookmaker retirée par la méthode de Shin).
 */
export function devigMarketOdds(odds: MarketOdds): ParsedOdds {
  const empty: ParsedOdds = {
    available: false,
    odds,
    probabilities: { home: 0, draw: 0, away: 0, over25: null, btts: null },
    overround: 0,
    method: 'aucun marché',
  };
  if (!odds || !odds.home || !odds.draw || !odds.away) return empty;

  const main = devigThreeWayDecimal({ home: odds.home, draw: odds.draw, away: odds.away });
  if (!main) return empty;

  const over = odds.over25 && odds.under25 ? devigTwoWayDecimal(odds.over25, odds.under25) : null;
  const btts = odds.bttsYes && odds.bttsNo ? devigTwoWayDecimal(odds.bttsYes, odds.bttsNo) : null;

  return {
    available: true,
    odds,
    probabilities: {
      home: main.probs.home,
      draw: main.probs.draw,
      away: main.probs.away,
      over25: over ? over.prob : null,
      btts: btts ? btts.prob : null,
    },
    overround: main.overround,
    method: main.method,
  };
}

/**
 * Convertit les cotes en charge utile compatible avec le module 06 du
 * moteur quantitatif (cotes décimales explicites + informations de source).
 */
export function oddsToMarketPayload(odds: MarketOdds | null): any | null {
  if (!odds || !odds.home || !odds.draw || !odds.away) return null;
  const provider = odds.provider ?? null;
  return {
    format: 'decimal',
    home: odds.home,
    draw: odds.draw,
    away: odds.away,
    over25: odds.over25,
    under25: odds.under25,
    bttsYes: odds.bttsYes,
    bttsNo: odds.bttsNo,
    drawNoBetHome: odds.drawNoBetHome,
    drawNoBetAway: odds.drawNoBetAway,
    goalLines: odds.goalLines,
    markets: odds.markets,
    source: 'Cotes de marché publiques',
    provider,
    providerLabel: provider?.label ?? null,
    providerHonored: provider?.honored ?? null,
    fetchedAt: odds.fetchedAt,
  };
}
