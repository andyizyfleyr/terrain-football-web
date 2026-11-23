import { NextRequest, NextResponse } from 'next/server';
import { parseMarketOdds } from '../../lib/marketOdds';
import { extractShots } from '../../lib/shotQuality';
import { readPlayerStat } from '../../lib/playerImpact';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

const FOTMOB_BASE = 'https://www.fotmob.com/api/data';
const FOTMOB_HEADERS: Record<string, string> = {
  accept: 'application/json',
  'accept-language': 'en-US,en;q=0.9',
  referer: 'https://www.fotmob.com/',
  'user-agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
};

async function getJson(path: string, timeoutMs = 9000): Promise<any | null> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const res = await fetch(`${FOTMOB_BASE}/${path}`, {
      headers: FOTMOB_HEADERS,
      signal: controller.signal,
      cache: 'no-store',
    });
    clearTimeout(timer);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

/** Exécute les tâches par lots (concurrence bornée). */
async function pool<T, R>(items: T[], size: number, worker: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(size, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await worker(items[index]);
    }
  });
  await Promise.all(runners);
  return results;
}

/**
 * Recherche défensive de la liste des matchs dans un payload de ligue :
 * la structure varie selon les saisons et les onglets.
 */
function collectMatches(payload: any): any[] {
  const out: any[] = [];
  const seen = new Set<number>();

  const visit = (node: any, depth: number) => {
    if (!node || depth > 6 || out.length > 4000) return;
    if (Array.isArray(node)) {
      for (const item of node) {
        if (
          item &&
          typeof item === 'object' &&
          item.home &&
          item.away &&
          (item.status || item.statusId !== undefined || item.id)
        ) {
          const id = Number(item.id);
          if (Number.isFinite(id) && !seen.has(id)) {
            seen.add(id);
            out.push(item);
          }
        }
      }
      return;
    }
    if (typeof node === 'object') {
      for (const key of Object.keys(node)) visit(node[key], depth + 1);
    }
  };

  visit(payload, 0);
  return out;
}

function readHalfTime(details: any): { htHome: number; htAway: number } | null {
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

function readXg(details: any): { homeXg: number | null; awayXg: number | null; homeXgot: number | null; awayXgot: number | null } {
  const out = { homeXg: null as number | null, awayXg: null as number | null, homeXgot: null as number | null, awayXgot: null as number | null };
  const groups = details?.content?.stats?.Periods?.All?.stats;
  if (!Array.isArray(groups)) return out;
  for (const grp of groups) {
    for (const row of grp?.stats || []) {
      if (!row?.key || !Array.isArray(row.stats) || row.stats.length < 2) continue;
      const hVal = Number(row.rawStats?.[0]?.value ?? row.stats[0]);
      const aVal = Number(row.rawStats?.[1]?.value ?? row.stats[1]);
      if (!Number.isFinite(hVal) || !Number.isFinite(aVal)) continue;
      if (row.key === 'expected_goals' && out.homeXg === null) {
        out.homeXg = Number(hVal.toFixed(2));
        out.awayXg = Number(aVal.toFixed(2));
      } else if (row.key === 'expected_goals_on_target') {
        out.homeXgot = Number(hVal.toFixed(2));
        out.awayXgot = Number(aVal.toFixed(2));
      }
    }
  }
  return out;
}

function readReferee(details: any) {
  const stats = details?.content?.matchFacts?.infoBox?.Referee?.stats;
  if (!Array.isArray(stats)) return null;
  const out: any = {};
  for (const st of stats) {
    if (st?.type === 'matches') out.matches = Number(st.value);
    else if (st?.type === 'yellowCards') {
      out.yellowPerMatch = Number(st.value);
      if (typeof st.average === 'number') out.yellowAverage = Number(st.average);
    } else if (st?.type === 'fouls') {
      out.foulsPerMatch = Number(st.value);
      if (typeof st.average === 'number') out.foulsAverage = Number(st.average);
    } else if (st?.type === 'penalties') out.penaltiesTotal = Number(st.value);
  }
  if (out.matches && out.penaltiesTotal) out.penaltiesPerMatch = Number((out.penaltiesTotal / out.matches).toFixed(2));
  return Object.keys(out).length ? out : null;
}

function readTeamSnapshot(payload: any, teamId: number) {
  const stats: Record<string, number> = {};
  const entries = payload?.stats?.teams;
  if (Array.isArray(entries)) {
    for (const entry of entries) {
      const key = typeof entry?.stat === 'string' ? entry.stat : entry?.stat?.name;
      const value = Number(entry?.participant?.value);
      if (!key || !Number.isFinite(value)) continue;
      stats[key] = value;
    }
  }

  const players: any[] = [];
  const groups = payload?.squad?.squad;
  if (Array.isArray(groups)) {
    for (const group of groups) {
      const members = Array.isArray(group?.members) ? group.members : [];
      for (const m of members) {
        if (!m?.id) continue;
        players.push({
          id: Number(m.id),
          name: String(m.name || ''),
          position: m.positionIdsDesc ? String(m.positionIdsDesc).split(',')[0] : undefined,
          rating: typeof m.rating === 'number' ? m.rating : null,
          goals: typeof m.goals === 'number' ? m.goals : 0,
          assists: typeof m.assists === 'number' ? m.assists : 0,
          marketValue: typeof m.transferValue === 'number' ? Math.round(m.transferValue) : 0,
          minutes: readPlayerStat(m.stats, /minutes played$|total minutes$/i)?.value ?? 0,
          xg: readPlayerStat(m.stats, /expected goals$|^xg$/i)?.value ?? 0,
          xa: readPlayerStat(m.stats, /expected assists?$/i)?.value ?? 0,
        });
      }
    }
  }

  return { id: teamId, name: '', stats, players };
}

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const leagueId = Number(searchParams.get('leagueId') || 47);
  const season = searchParams.get('season') || '2026/2027';
  const limit = Math.min(150, Math.max(5, Number(searchParams.get('limit') || 60)));
  const offset = Math.max(0, Number(searchParams.get('offset') || 0));
  const format = String(searchParams.get('format') || 'json');
  const since = searchParams.get('since') || '';
  const probeMatchId = Number(searchParams.get('probeMatchId') || 0);

  try {
    if (probeMatchId) {
      const details = await getJson(`matchDetails?matchId=${probeMatchId}`, 15000);
      const found: string[] = [];
      const walk = (node: any, path: string, depth: number) => {
        if (!node || depth > 8 || found.length > 60) return;
        if (Array.isArray(node)) {
          node.slice(0, 3).forEach((item, i) => walk(item, `${path}[${i}]`, depth + 1));
          return;
        }
        if (typeof node !== 'object') return;
        for (const key of Object.keys(node)) {
          const value = node[key];
          const next = path ? `${path}.${key}` : key;
          if (/half|period/i.test(key)) {
            found.push(`${next} = ${JSON.stringify(value).slice(0, 160)}`);
          }
          walk(value, next, depth + 1);
        }
      };
      walk(details, '', 0);
      return NextResponse.json({
        probeMatchId,
        headerStatusKeys: Object.keys(details?.header?.status || {}),
        headerStatusUtctime: details?.header?.status?.utcTime ?? null,
        teamsScore: details?.header?.teams?.map((t: any) => ({ name: t?.name, score: t?.score })) ?? null,
        contentKeys: Object.keys(details?.content || {}),
        found,
      });
    }

    const leaguePayload = await getJson(
      `leagues?id=${leagueId}&ccode3=USA_MA&season=${encodeURIComponent(season)}`,
      20000
    );
    if (!leaguePayload) {
      return NextResponse.json({ error: 'Payload de ligue indisponible.' }, { status: 502 });
    }

    const rawMatches = collectMatches(leaguePayload)
      .map(m => ({
        id: Number(m.id),
        homeId: Number(m.home?.id),
        awayId: Number(m.away?.id),
        homeName: String(m.home?.name || ''),
        awayName: String(m.away?.name || ''),
        homeScore: Number(m.home?.score),
        awayScore: Number(m.away?.score),
        utcTime: String(m.status?.utcTime || ''),
        finished: Boolean(m.status?.finished ?? m.status?.id === 6),
        leagueId: Number(m.leagueId ?? m.primaryLeagueId ?? 0),
      }))
      .filter(m => m.id && m.homeId && m.awayId && m.finished && Number.isFinite(m.homeScore))
      .sort((a, b) => a.utcTime.localeCompare(b.utcTime));

    const filtered = since ? rawMatches.filter(m => m.utcTime.slice(0, 10) >= since) : rawMatches;
    const end = Math.max(0, filtered.length - offset);
    const start = Math.max(0, end - limit);
    const selected = filtered.slice(start, end);

    // --- Détails + cotes (concurrence bornée) --------------------------
    const enriched = await pool(selected, 6, async match => {
      const details = await getJson(`matchDetails?matchId=${match.id}`, 12000);
      if (!details?.content) return null;

      const shots = extractShots(details);
      const homeShots = shots.filter(s => s.teamId === match.homeId);
      const awayShots = shots.filter(s => s.teamId === match.awayId);
      const sum = (list: typeof shots, key: 'xg' | 'xgot') =>
        Number(list.reduce((acc, s) => acc + (s[key] || 0), 0).toFixed(2));

      const xg = readXg(details);
      const halfTime = readHalfTime(details);
      const referee = readReferee(details);
      const weather = details?.content?.weather || null;
      const stadium = details?.content?.matchFacts?.infoBox?.Stadium || null;
      const lineup = details?.content?.lineup || {};
      const lineupType = String(lineup.lineupType || '').toLowerCase();
      const confirmed = lineupType ? lineupType !== 'predicted' : true;

      const unavailableHome = Array.isArray(lineup.homeTeam?.unavailable)
        ? lineup.homeTeam.unavailable.map((p: any) => Number(p?.id)).filter(Boolean)
        : [];
      const unavailableAway = Array.isArray(lineup.awayTeam?.unavailable)
        ? lineup.awayTeam.unavailable.map((p: any) => Number(p?.id)).filter(Boolean)
        : [];
      const startersHome = confirmed && Array.isArray(lineup.homeTeam?.starters)
        ? lineup.homeTeam.starters.map((p: any) => Number(p?.id)).filter(Boolean)
        : [];
      const startersAway = confirmed && Array.isArray(lineup.awayTeam?.starters)
        ? lineup.awayTeam.starters.map((p: any) => Number(p?.id)).filter(Boolean)
        : [];

      // Cotes 1X2 : une seule requête par match (point de vente principal).
      const oddsPayload = await getJson(`matchOdds?matchId=${match.id}&ccode3=ESP`, 8000);
      const parsed = oddsPayload ? parseMarketOdds(oddsPayload, match.homeName, match.awayName, null) : null;
      const odds =
        parsed && parsed.home && parsed.draw && parsed.away
          ? { home: parsed.home, draw: parsed.draw, away: parsed.away }
          : null;

      return {
        id: String(match.id),
        date: match.utcTime.slice(0, 10),
        league: 'eng.1',
        homeId: match.homeId,
        homeName: match.homeName,
        awayId: match.awayId,
        awayName: match.awayName,
        homeGoals: match.homeScore,
        awayGoals: match.awayScore,
        homeXg: xg.homeXg,
        awayXg: xg.awayXg,
        htHome: halfTime?.htHome ?? null,
        htAway: halfTime?.htAway ?? null,
        homeShots: homeShots.length || null,
        awayShots: awayShots.length || null,
        homeXgot: sum(homeShots, 'xgot'),
        awayXgot: sum(awayShots, 'xgot'),
        odds,
        provider: parsed?.provider?.label ?? null,
        unavailableHome,
        unavailableAway,
        startersHome,
        startersAway,
        referee,
        weather: weather
          ? {
              temperature: weather.temperature ?? null,
              windSpeed: weather.windSpeed ?? null,
              precipitation: weather.precipitation ?? null,
            }
          : null,
        pitch: stadium ? { surface: stadium.surface ?? null } : null,
      };
    });

    const matches = enriched.filter(Boolean) as any[];

    // --- Instantanés d'équipe (effectif + statistiques) -----------------
    const teamIds = Array.from(new Set(matches.flatMap(m => [m.homeId, m.awayId])));
    const snapshots = await pool(teamIds, 5, async teamId => {
      const payload = await getJson(`teams?id=${teamId}`, 15000);
      if (!payload) return null;
      const snapshot = readTeamSnapshot(payload, teamId);
      const name =
        payload?.name ||
        payload?.overview?.teamName ||
        matches.find(m => m.homeId === teamId)?.homeName ||
        matches.find(m => m.awayId === teamId)?.awayName ||
        '';
      snapshot.name = name;
      return snapshot;
    });

    const teams = snapshots.filter(Boolean) as any[];

    // On ne conserve que les joueurs utiles : titulaires, absents et noyau.
    const relevantPlayers = new Set<number>();
    for (const m of matches) {
      m.startersHome?.forEach((id: number) => relevantPlayers.add(id));
      m.startersAway?.forEach((id: number) => relevantPlayers.add(id));
      m.unavailableHome?.forEach((id: number) => relevantPlayers.add(id));
      m.unavailableAway?.forEach((id: number) => relevantPlayers.add(id));
    }
    for (const team of teams) {
      const core = [...team.players]
        .sort((a: any, b: any) => (b.rating ?? 0) - (a.rating ?? 0))
        .slice(0, 14);
      team.players = core.filter((p: any) => relevantPlayers.has(p.id));
    }

    const dates = matches.map(m => m.date).sort();

    if (format === 'summary') {
      const datesAll = rawMatches.map(m => m.utcTime.slice(0, 10)).sort();
      return NextResponse.json({
        league: 'eng.1',
        leagueId,
        season,
        totalFinished: rawMatches.length,
        firstDate: datesAll[0] ?? null,
        lastDate: datesAll[datesAll.length - 1] ?? null,
        counts: {
          matches: matches.length,
          teams: teams.length,
          withOdds: matches.filter(m => m.odds).length,
          withXg: matches.filter(m => m.homeXg !== null).length,
          withHalfTime: matches.filter(m => m.htHome !== null).length,
          withLineups: matches.filter(m => m.startersHome?.length).length,
          withAbsences: matches.filter(m => m.unavailableHome?.length || m.unavailableAway?.length).length,
        },
      });
    }

    if (format === 'packed') {
      return NextResponse.json({
        format: 'packed-v1',
        league: 'eng.1',
        leagueId,
        season,
        period: dates.length ? `${dates[0]} → ${dates[dates.length - 1]}` : '',
        counts: {
          matches: matches.length,
          teams: teams.length,
          withOdds: matches.filter(m => m.odds).length,
          withXg: matches.filter(m => m.homeXg !== null).length,
          withHalfTime: matches.filter(m => m.htHome !== null).length,
          withLineups: matches.filter(m => m.startersHome?.length).length,
        },
        matchColumns: [
          'id', 'date', 'homeId', 'homeName', 'awayId', 'awayName',
          'homeGoals', 'awayGoals', 'homeXg', 'awayXg', 'htHome', 'htAway',
          'homeShots', 'awayShots', 'homeXgot', 'awayXgot',
          'odds', 'provider',
          'unavailableHome', 'unavailableAway', 'startersHome', 'startersAway',
          'referee', 'weather', 'pitch',
        ],
        matches: matches.map(m => [
          m.id, m.date, m.homeId, m.homeName, m.awayId, m.awayName,
          m.homeGoals, m.awayGoals, m.homeXg, m.awayXg, m.htHome, m.htAway,
          m.homeShots, m.awayShots, m.homeXgot, m.awayXgot,
          m.odds ? [m.odds.home, m.odds.draw, m.odds.away] : null, m.provider,
          m.unavailableHome, m.unavailableAway, m.startersHome, m.startersAway,
          m.referee, m.weather, m.pitch,
        ]),
        teamColumns: ['id', 'name', 'players'],
        teams: teams.map(t => [
          t.id,
          t.name,
          (t.players || []).map(p => [p.id, p.name, p.position ?? null]),
        ]),
      });
    }

    return NextResponse.json({
      league: 'eng.1',
      leagueId,
      season,
      period: dates.length ? `${dates[0]} → ${dates[dates.length - 1]}` : '',
      generatedAt: new Date().toISOString(),
      counts: {
        matches: matches.length,
        teams: teams.length,
        withOdds: matches.filter(m => m.odds).length,
        withXg: matches.filter(m => m.homeXg !== null).length,
        withHalfTime: matches.filter(m => m.htHome !== null).length,
        withLineups: matches.filter(m => m.startersHome?.length).length,
      },
      teams,
      matches,
    });
  } catch (error) {
    return NextResponse.json(
      { error: 'Récolte impossible.', detail: String(error).slice(0, 200) },
      { status: 500 }
    );
  }
}
