import { NextResponse } from 'next/server';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildApiError } from '../../lib/apiErrors';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * QUALITÉ MESURÉE DU MODÈLE
 * ------------------------------------------------------------------
 * Bloc « ce que le modèle vaut » de la page Pronostics.
 *
 * Les chiffres viennent du rapport de backtest réel
 * (`data/backtest-report.json`, produit par `npm run check:backtest`),
 * jamais d'une constante écrite à la main : un site qui affiche
 * « 73 % de réussite » sans pouvoir le mesurer publie une promesse.
 *
 *   GET /api/model-quality
 *
 * -> { available, sample, seasons, divisions, metrics: [...] }
 *
 * Sans rapport, la route répond 404 avec le contrat d'erreur normal :
 * la page n'affiche alors AUCUN chiffre de précision.
 */

type Metric = {
  name: string;
  accuracy: number;
  logLoss: number;
  samples: number;
  /** Repère de lecture : le marché est la référence à battre. */
  reference: boolean;
};

const LABELS: Record<string, string> = {
  aléatoire: 'Hasard',
  'modèle brut': 'Modèle brut',
  'modèle calibré': 'Modèle calibré',
  'moyenne marché': 'Marché (dé-viggué)',
  'Bet365 dé-viggué': 'Bet365 (dé-viggué)',
  'Pinnacle dé-viggué': 'Pinnacle (dé-viggué)',
};

export async function GET() {
  const reportPath = join(process.cwd(), 'data', 'backtest-report.json');

  if (!existsSync(reportPath)) {
    return NextResponse.json(
      buildApiError('not_found', {
        message:
          'Aucun rapport de backtest n’est disponible : aucune précision ne peut être affichée.',
        detail: 'data/backtest-report.json absent',
      }),
      { status: 404 }
    );
  }

  try {
    const report = JSON.parse(readFileSync(reportPath, 'utf-8'));
    const rawReports: any[] = report?.global?.reports || [];

    const metrics: Metric[] = rawReports
      .map(entry => ({
        // Un nom non listé est affiché tel quel : mieux vaut un libellé
        // brut qu'une étiquette inventée.
        name: LABELS[entry.name] || String(entry.name || ''),
        accuracy: Number(entry?.accuracy?.value),
        logLoss: Number(entry?.logLoss?.value),
        samples: Number(entry?.accuracy?.samples || 0),
        reference: String(entry.name).includes('marché') || String(entry.name).includes('Pinnacle'),
      }))
      .filter(
        metric =>
          metric.name && Number.isFinite(metric.accuracy) && Number.isFinite(metric.logLoss)
      )
      // Le hasard sert de plancher de lecture : il reste utile, mais en
      // dernier. Le modèle et le marché passent devant.
      .sort((a, b) => {
        if (a.name === 'Hasard') return 1;
        if (b.name === 'Hasard') return -1;
        return b.accuracy - a.accuracy;
      });

    if (!metrics.length) {
      return NextResponse.json(
        buildApiError('no_data', {
          message: 'Le rapport de backtest ne contient aucune métrique exploitable.',
          detail: 'global.reports vide ou malformé',
        }),
        { status: 404 }
      );
    }

    return NextResponse.json({
      available: true,
      generatedAt: report?.generatedAt || null,
      sample: Number(report?.dataset?.matches || 0),
      seasons: (report?.dataset?.seasons || []).length,
      divisions: (report?.dataset?.divisions || []).length,
      source: report?.dataset?.source || '',
      metrics,
    });
  } catch (error: any) {
    return NextResponse.json(
      buildApiError('internal_error', {
        message: 'Le rapport de backtest est illisible.',
        detail: String(error?.message || error),
      }),
      { status: 500 }
    );
  }
}
