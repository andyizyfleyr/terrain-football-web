import { NextRequest, NextResponse } from 'next/server';
import {
  analysisSources,
  enrichMatches,
  hasCompleteAnalysis,
} from '../../lib/analysisService';
import { buildApiError, classifyNetworkError } from '../../lib/apiErrors';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const BACKEND_ORIGIN = process.env.BACKEND_API_URL || 'https://terrain-football-api.vercel.app';

function sanitizeUpstreamText(text: any): any {
  if (typeof text !== 'string') return text;
  return text
    .replace(/\s*\(?\b(?:ESPN|FotMob|Opta)\b\)?/gi, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function sanitizeDeep(node: any, depth = 0): any {
  if (depth > 6) return node;
  if (typeof node === 'string') return sanitizeUpstreamText(node);
  if (Array.isArray(node)) return node.map(item => sanitizeDeep(item, depth + 1));
  if (node && typeof node === 'object') {
    const out: any = {};
    for (const key of Object.keys(node)) {
      out[key] = sanitizeDeep(node[key], depth + 1);
    }
    return out;
  }
  return node;
}

function sanitizeMatchStrings(match: any): any {
  if (!match || typeof match !== 'object') return match;
  const next = { ...match };
  if (next.analyst) {
    next.analyst = sanitizeDeep(next.analyst);
  }
  if (next.vigilance && Array.isArray(next.vigilance.reasons)) {
    next.vigilance = {
      ...next.vigilance,
      reasons: next.vigilance.reasons.map(sanitizeUpstreamText),
    };
  }
  if (Array.isArray(next.limitations)) {
    next.limitations = next.limitations.map(sanitizeUpstreamText);
  }
  if (next.factors && typeof next.factors === 'object') {
    const f = { ...next.factors };
    for (const key of Object.keys(f)) {
      if (f[key] && typeof f[key] === 'object') {
        const card = { ...f[key] };
        if (typeof card.note === 'string') card.note = sanitizeUpstreamText(card.note);
        if (typeof card.resume === 'string') card.resume = sanitizeUpstreamText(card.resume);
        if (typeof card.home === 'string') card.home = sanitizeUpstreamText(card.home);
        if (typeof card.away === 'string') card.away = sanitizeUpstreamText(card.away);
        if (typeof card.source === 'string') card.source = 'Statistiques publiques';
        f[key] = card;
      }
    }
    next.factors = f;
  }
  return next;
}

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
      signal: AbortSignal.timeout(25_000),
    });

    if (!upstreamRes.ok) {
      // 429 et 5xx sont transitoires : on le dit explicitement pour que
      // l'interface puisse proposer de réessayer.
      const code = upstreamRes.status === 429
        ? 'rate_limited'
        : upstreamRes.status === 404
          ? 'not_found'
          : 'upstream_unavailable';
      return NextResponse.json(
        buildApiError(code, {
          message: `Le service de données a répondu ${upstreamRes.status}.`,
          detail: `HTTP ${upstreamRes.status} sur ${upstreamUrl}`,
          league,
          date,
        }),
        { status: upstreamRes.status === 429 || upstreamRes.status === 404 ? upstreamRes.status : 502 }
      );
    }

    const basePayload = await upstreamRes.json();
    const rawMatches: any[] = Array.isArray(basePayload?.matches) ? basePayload.matches : [];

    if (!rawMatches.length) {
      return NextResponse.json({
        ...basePayload,
        // Aucune rencontre : ce n'est pas une panne, c'est une journée vide
        // ou des données indisponibles. Le contrat le dit explicitement.
        error: buildApiError('no_data', {
          message: 'Aucune rencontre disponible pour cette journée.',
          league,
          date,
          degraded: true,
        }).error,
        code: 'no_data',
        degraded: true,
        sources: ['Données publiques'],
      });
    }

    // Si on analyse un match unique (vue détaillée), on active deepTeamFetch (squad, valeurs, coachs, table xG complète).
    // Si on scanne toute une journée (plusieurs matchs sans paramètre `match`), on allège les requêtes FotMob par équipe
    // pour garantir une réponse rapide tout en conservant blessés/suspendus, arbitre, H2H et table xG de la ligue.
    const isSingleMatch = Boolean(matchId) || rawMatches.length === 1;

    // Le backend sait désormais renvoyer l'analyse COMPLÈTE (moteur v3 +
    // marchés dérivés) : on ne recalcule alors rien localement, la réponse
    // amont fait foi. Sinon on enrichit ici (repli historique, et chemin
    // utilisé tant que le backend n'est pas encore à jour).
    if (hasCompleteAnalysis(rawMatches)) {
      return NextResponse.json({
        ...basePayload,
        degraded: false,
        matches: rawMatches.map(sanitizeMatchStrings),
        sources: analysisSources(rawMatches.some(m => Boolean(m?.fotmob))),
      });
    }

    const { matches: enrichedMatches } = await enrichMatches(rawMatches, {
      leagueSlug: league,
      compactDate: date || String(rawMatches[0]?.date || '').slice(0, 10).replaceAll('-', ''),
      deepTeamFetch: isSingleMatch,
    });

    return NextResponse.json({
      ...basePayload,
      // Réponses partielles : au moins un match n'a pas pu être analysé.
      degraded: !hasCompleteAnalysis(enrichedMatches),
      matches: enrichedMatches.map(sanitizeMatchStrings),
      sources: analysisSources(enrichedMatches.some(m => Boolean(m?.fotmob))),
    });
  } catch (error) {
    const { code, detail } = classifyNetworkError(error);
    return NextResponse.json(
      buildApiError(code, { detail, league, date }),
      { status: code === 'upstream_timeout' ? 504 : 502 }
    );
  }
}
