import { NextRequest, NextResponse } from 'next/server';
import { analysisSources, enrichMatches, hasCompleteAnalysis } from '../../../lib/analysisService';
import { buildApiError, classifyNetworkError } from '../../../lib/apiErrors';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

/**
 * SERVICE D'ANALYSE (contrat HTTP)
 * ------------------------------------------------------------------
 * Point d'entrée unique du moteur quantitatif v3.
 *
 * Le backend Python possède la couche d'ingestion (ESPN : calendrier,
 * forme, classement, style de jeu) ; il n'implémente PAS le modèle.
 * Il poste ici les matchs bruts qu'il a collectés et reçoit en retour
 * les matchs ENRICHIS : données FotMob, modules d'analyse, simulation
 * Monte-Carlo et marchés dérivés (pronostics).
 *
 * L'implémentation du modèle reste unique : elle vit dans
 * `app/lib/analystEngine.ts` et n'est exposée que par cette route.
 *
 *   POST /api/engine/analyze
 *   {
 *     "league": "eng.1",
 *     "date": "20261122",
 *     "matches": [ { ...match ESPN brut... } ]
 *   }
 *
 * -> { "league", "date", "matches": [ ...match enrichis... ], "sources" }
 *
 * Accès : si `ENGINE_TOKEN` est défini, l'appel doit présenter
 * `Authorization: Bearer <ENGINE_TOKEN>`.
 */
function isAuthorized(request: NextRequest): boolean {
  const token = process.env.ENGINE_TOKEN;
  if (!token) return true;
  const header = request.headers.get('authorization') || '';
  return header.replace(/^Bearer\s+/i, '').trim() === token;
}

export async function POST(request: NextRequest) {
  if (!isAuthorized(request)) {
    return NextResponse.json(buildApiError('unauthorized'), { status: 401 });
  }

  let body: any = {};
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      buildApiError('bad_request', { message: 'Corps JSON invalide.' }),
      { status: 400 }
    );
  }

  const league = String(body?.league || '').trim() || 'eng.1';
  const date = String(body?.date || '').trim();
  const baseMatches = Array.isArray(body?.matches) ? body.matches : [];

  if (!baseMatches.length) {
    return NextResponse.json(
      buildApiError('bad_request', {
        message:
          'Aucun match brut fourni : le service d’analyse n’implémente pas l’ingestion.',
        league,
        date,
      }),
      { status: 400 }
    );
  }

  const compactDate = date || String(baseMatches[0]?.date || '').slice(0, 10).replace(/-/g, '');
  // Vue match unique : on récupère l'effectif, les valeurs et le coach.
  const deepTeamFetch = baseMatches.length === 1;

  try {
    const { matches, anyFotmob } = await enrichMatches(baseMatches, {
      leagueSlug: league,
      compactDate,
      deepTeamFetch,
    });

    const complete = hasCompleteAnalysis(matches);
    return NextResponse.json({
      league,
      date,
      engine: 'v3',
      complete,
      // `degraded` : la réponse est utilisable mais au moins un match
      // n'a pas pu être analysé (source absente, données partielles).
      degraded: !complete,
      matches,
      sources: analysisSources(anyFotmob),
    });
  } catch (error) {
    const { code, detail } = classifyNetworkError(error);
    return NextResponse.json(
      buildApiError(code, { detail, league, date }),
      { status: code === 'upstream_timeout' ? 504 : 502 }
    );
  }
}
