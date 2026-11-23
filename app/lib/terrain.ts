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
export const monthLabel = (value: string) =>
  new Intl.DateTimeFormat('fr-FR', { month: 'long', year: 'numeric' }).format(new Date(`${value}-01T12:00:00`));
export const longDate = (value: string) =>
  value
    ? new Intl.DateTimeFormat('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(
        new Date(`${value}T12:00:00`)
      )
    : '';
export const shortDate = (value: string) =>
  value ? new Intl.DateTimeFormat('fr-FR', { weekday: 'short', day: 'numeric', month: 'short' }).format(new Date(`${value}T12:00:00`)) : '';
export const timeOf = (value: string) =>
  value
    ? new Intl.DateTimeFormat('fr-FR', { hour: '2-digit', minute: '2-digit', timeZone: 'Africa/Porto-Novo' }).format(new Date(value))
    : 'Heure à confirmer';
export const pct = (value: any) => (typeof value === 'number' ? `${Math.round(value * 100)}%` : '—');

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
