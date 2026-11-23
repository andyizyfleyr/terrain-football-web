import { NextRequest, NextResponse } from 'next/server';
import { enrichEspnMatchWithFotmob } from '../../lib/fotmob';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const BACKEND_ORIGIN = process.env.BACKEND_API_URL || 'https://terrain-football-api.vercel.app';

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const league = searchParams.get('league') || 'eng.1';
  const date = searchParams.get('date') || '';
  const matchId = searchParams.get('match');

  const upstreamParams = new URLSearchParams();
  upstreamParams.set('league', league);
  if (date) upstreamParams.set('date', date);
  if (matchId) upstreamParams.set('match', matchId);

  const upstreamUrl = `${BACKEND_ORIGIN.replace(/\/$/, '')}/api/analyze?${upstreamParams.toString()}`;

  try {
    const upstreamRes = await fetch(upstreamUrl, {
      headers: { Accept: 'application/json' },
      cache: 'no-store',
    });

    if (!upstreamRes.ok) {
      return NextResponse.json(
        { error: `Erreur backend (${upstreamRes.status})`, league, date, matches: [] },
        { status: upstreamRes.status }
      );
    }

    const basePayload = await upstreamRes.json();
    const rawMatches: any[] = Array.isArray(basePayload?.matches) ? basePayload.matches : [];

    if (!rawMatches.length) {
      return NextResponse.json({
        ...basePayload,
        sources: ['ESPN'],
      });
    }

    // Si on analyse un match unique (vue détaillée), on active deepTeamFetch (squad, valeurs, coachs, table xG complète).
    // Si on scanne toute une journée (plusieurs matchs sans paramètre `match`), on allège les requêtes FotMob par équipe
    // pour garantir une réponse rapide tout en conservant blessés/suspendus, arbitre, H2H et table xG de la ligue.
    const isSingleMatch = Boolean(matchId) || rawMatches.length === 1;

    const enrichedMatches = await Promise.all(
      rawMatches.map(async m => {
        try {
          return await enrichEspnMatchWithFotmob({
            espnMatch: m,
            leagueSlug: league,
            compactDate: date || String(m?.date || '').slice(0, 10).replaceAll('-', ''),
            deepTeamFetch: isSingleMatch,
          });
        } catch {
          return m;
        }
      })
    );

    const anyFotmob = enrichedMatches.some(m => Boolean(m?.fotmob));

    return NextResponse.json({
      ...basePayload,
      matches: enrichedMatches,
      sources: anyFotmob ? ['ESPN', 'FotMob'] : ['ESPN'],
    });
  } catch {
    return NextResponse.json(
      { error: 'Analyse momentanément indisponible.', league, date, matches: [] },
      { status: 502 }
    );
  }
}
