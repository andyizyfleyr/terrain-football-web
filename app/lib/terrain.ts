export type League = { slug: string; name: string; country: string; tier: number };
export type Team = { id: string; name: string; short: string; logo?: string; score: number | null };
export type Fixture = { id: string; date: string; name: string; home: Team; away: Team; venue?: string; city?: string; odds?: any };
export type MonthFixture = Fixture & { dayKey: string };
export type DayEvents = Record<string, Fixture[]>;
export type StatusTab = 'upcoming' | 'finished';

export const pad = (n: number) => String(n).padStart(2, '0');
export const todayKey = () => {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
export const keyFor = (year: number, month: number, day: number) => `${year}-${pad(month)}-${pad(day)}`;
/**
 * Normalise une cle de jour : `2026-11-22` comme `20261122`.
 * Sans cette normalisation, `new Date('20261122T12:00:00')` est une date
 * invalide et `Intl.DateTimeFormat.format()` leve une RangeError — ce qui
 * faisait tomber la page entiere sur une URL de date compacte.
 */
export function parseDayKey(value: string): Date | null {
  if (!value) return null;
  const digits = value.replace(/\D/g, '');
  let iso = '';
  if (digits.length === 8) {
    iso = `${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6, 8)}`;
  } else if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    iso = value;
  }
  if (!iso) return null;
  const parsed = new Date(`${iso}T12:00:00`);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export const monthLabel = (value: string) => {
  const parsed = parseDayKey(`${value}-01`);
  return parsed ? new Intl.DateTimeFormat('fr-FR', { month: 'long', year: 'numeric' }).format(parsed) : '';
};
export const longDate = (value: string) => {
  const parsed = parseDayKey(value);
  return parsed
    ? new Intl.DateTimeFormat('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(parsed)
    : '';
};
export const shortDate = (value: string) => {
  const parsed = parseDayKey(value);
  return parsed ? new Intl.DateTimeFormat('fr-FR', { weekday: 'short', day: 'numeric', month: 'short' }).format(parsed) : '';
};
export const dayHeading = (value: string) => {
  const parsed = parseDayKey(value);
  return parsed ? new Intl.DateTimeFormat('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' }).format(parsed) : '';
};
export const dayHeadingShort = (value: string) => {
  const parsed = parseDayKey(value);
  return parsed ? new Intl.DateTimeFormat('fr-FR', { weekday: 'short', day: 'numeric', month: 'short' }).format(parsed) : '';
};

export const timeOf = (value: string) =>
  value
    ? new Intl.DateTimeFormat('fr-FR', { hour: '2-digit', minute: '2-digit', timeZone: 'Africa/Porto-Novo' }).format(new Date(value))
    : 'Heure à confirmer';
export const pct = (value: any) => (typeof value === 'number' ? `${Math.round(value * 100)}%` : '—');

/** Distance en jours avant le coup d'envoi, pour un libellé compact sur les cartes. */
export function countdownLabel(date: string): string {
  const kick = Date.parse(date);
  if (!Number.isFinite(kick)) return '';
  const diff = kick - Date.now();
  if (diff <= 0) return 'EN COURS';
  const days = Math.floor(diff / 86400000);
  if (days <= 0) return "AUJOURD'HUI";
  if (days === 1) return 'DEMAIN';
  return `J-${days}`;
}

export function isFixtureFinished(item: Fixture): boolean {
  const kickOff = Date.parse(item.date);
  if (!Number.isFinite(kickOff)) return false;
  const hasScores = item.home?.score !== null && item.home?.score !== undefined && item.away?.score !== null && item.away?.score !== undefined;
  return kickOff <= Date.now() && hasScores;
}

export function buildMatchUrl(league: string, dayKey: string, matchId: string): string {
  return `/match/${encodeURIComponent(league)}/${encodeURIComponent(dayKey)}/${encodeURIComponent(matchId)}`;
}

// Cache mémoire côté client pour reprise instantanée lors d'un retour navigateur
export const monthFixturesCache = new Map<string, DayEvents>();
export let cachedLeagues: League[] | null = null;
export function setCachedLeagues(list: League[]) {
  cachedLeagues = list;
}

export type ResumeSnapshot = {
  league: string;
  month: string;
  statusTab: StatusTab;
  search: string;
  scrollY: number;
  lastMatchId: string;
  lastMatchDayKey: string;
  timestamp: number;
};

const RESUME_KEY = 'terrain_resume_state_v1';

export function saveResumeSnapshot(snapshot: ResumeSnapshot) {
  if (typeof window === 'undefined') return;
  try {
    sessionStorage.setItem(RESUME_KEY, JSON.stringify(snapshot));
  } catch {
    // ignore storage errors
  }
}

export function readResumeSnapshot(): ResumeSnapshot | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = sessionStorage.getItem(RESUME_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as ResumeSnapshot;
  } catch {
    return null;
  }
}

export function clearResumeScrollOnly() {
  const current = readResumeSnapshot();
  if (!current) return;
  saveResumeSnapshot({ ...current, scrollY: -1 });
}
