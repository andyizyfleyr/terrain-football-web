import { NextResponse } from 'next/server';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildMarketStatuses } from '../../../lib/derivedMarkets';
import { buildApiError } from '../../../lib/apiErrors';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * STATUT DE VALIDATION DES MARCHÉS DÉRIVÉS
 * ------------------------------------------------------------------
 * Le moteur annonce 16 marchés dérivés. Cette route indique, pour
 * chacun, s'il a été CONFRONTÉ à des cotes réelles sur un échantillon
 * suffisant, ou s'il s'agit d'une estimation non validée.
 *
 *   GET /api/markets/validation
 *
 * -> { "generatedAt", "markets": [ { id, label, status, samples, note } ] }
 *
 * Sans rapport de validation, la route répond 404 avec le contrat
 * d'erreur normal : aucun marché n'est alors présenté comme validé.
 */
export async function GET() {
  const reportPath = join(process.cwd(), 'data', 'markets-validation.json');

  if (!existsSync(reportPath)) {
    return NextResponse.json(
      buildApiError('not_found', {
        message:
          'Aucun rapport de validation des marchés n’est disponible : aucun marché ne peut être présenté comme validé.',
        detail: 'data/markets-validation.json absent',
      }),
      { status: 404 }
    );
  }

  try {
    const raw = JSON.parse(readFileSync(reportPath, 'utf-8'));
    const statuses = buildMarketStatuses(raw);
    return NextResponse.json({
      generatedAt: raw.generatedAt ?? null,
      dataset: raw.dataset ?? null,
      markets: statuses,
      summary: {
        total: statuses.length,
        validated: statuses.filter(status => status.status === 'validé').length,
        toWatch: statuses.filter(status => status.status === 'à surveiller').length,
        notValidated: statuses.filter(status => status.status === 'non validé').length,
      },
    });
  } catch (error) {
    return NextResponse.json(
      buildApiError('internal_error', {
        message: 'Le rapport de validation des marchés est illisible.',
        detail: error instanceof Error ? error.message : String(error),
      }),
      { status: 500 }
    );
  }
}
