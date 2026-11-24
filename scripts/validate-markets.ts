/* ------------------------------------------------------------------ */
/* VALIDATION DES MARCHÉS DÉRIVÉS CONTRE DES COTES RÉELLES             */
/* ------------------------------------------------------------------ */
/*
 * Confronte les marchés annoncés par le moteur aux cotes RÉELLES
 * disponibles dans le jeu de données football-data.co.uk.
 *
 * Pour chaque marché comparable :
 *   - probabilité du modèle ;
 *   - probabilité du marché après retrait de marge ;
 *   - écart moyen (points de probabilité) entre les deux ;
 *   - log-loss du modèle et du marché sur ce marché ;
 *   - fréquence observée du résultat.
 *
 * Les marchés sans cote de référence ne sont PAS validés : ils sont
 * simplement listés comme tels (voir app/lib/derivedMarkets.ts).
 *
 * Sortie : data/markets-validation.json
 *
 * Exécution : npm run check:markets
 */

import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { loadFootballData } from '../app/lib/backtestDatasetFootballData.ts';
import { replayLeague } from '../app/lib/backtestReplay.ts';
import { devigTwoWayDecimal } from '../app/lib/devig.ts';
import { logLossOf, summarise } from '../app/lib/backtestMetrics.ts';
import { DERIVED_MARKETS } from '../app/lib/derivedMarkets.ts';

const SIMULATION_RUNS = Number(process.env.MARKETS_SIMULATION_RUNS || 300);

type MarketAccumulator = {
  id: string;
  label: string;
  samples: number;
  gapSum: number;
  modelLosses: number[];
  marketLosses: number[];
  observedHits: number;
};

function accumulator(id: string, label: string): MarketAccumulator {
  return {
    id,
    label,
    samples: 0,
    gapSum: 0,
    modelLosses: [],
    marketLosses: [],
    observedHits: 0,
  };
}

async function main(): Promise<void> {
  console.log('Chargement du jeu de données football-data.co.uk…');
  const bundle = loadFootballData();

  const markets = new Map<string, MarketAccumulator>();
  const acc = (id: string, label: string) => {
    if (!markets.has(id)) markets.set(id, accumulator(id, label));
    return markets.get(id)!;
  };

  // --- 1X2 (déjà couvert par le backtest, mais on le rejoue ici pour
  //     garder le même jeu de rencontres que les autres marchés) -------
  const oneXTwo = acc('one-x-two', 'Issue 1 / X / 2');
  const over25 = acc('over-25', 'Plus de 2,5 buts');
  const btts = acc('btts', 'Les deux équipes marquent');
  const ah = acc('asian-handicap', 'Handicap asiatique');

  for (const dataset of Array.from(bundle.byLeague.values())) {
    const samples = replayLeague(dataset, { simulationRuns: SIMULATION_RUNS });
    const matchesById = new Map(dataset.matches.map(match => [match.id, match]));
    for (const sample of samples) {
      const match = matchesById.get(sample.matchId);
      if (!match) continue;

      // 1X2 : modèle contre moyenne de marché dé-vigguée
      const market = sample.markets.marketAverage;
      if (market) {
        const gap = sample.model.home - market.home;
        oneXTwo.samples += 1;
        oneXTwo.gapSum += gap;
        oneXTwo.modelLosses.push(logLossOf(sample.model, sample.outcome));
        oneXTwo.marketLosses.push(logLossOf(market, sample.outcome));
      }

      const derived = match.derivedOdds;
      if (derived?.over25) {
        const devig = devigTwoWayDecimal(derived.over25.over, derived.over25.under);
        if (devig) {
          const over = sample.over25 ?? 0;
          const outcome = sample.homeGoals + sample.awayGoals > 2.5 ? 1 : 0;
          over25.samples += 1;
          over25.gapSum += over - devig.prob;
          over25.modelLosses.push(-Math.log(Math.max(1e-12, outcome === 1 ? over : 1 - over)));
          over25.marketLosses.push(
            -Math.log(Math.max(1e-12, outcome === 1 ? devig.prob : 1 - devig.prob))
          );
          over25.observedHits += outcome === 1 ? 1 : 0;
        }
      }
      if (derived?.btts) {
        const devig = devigTwoWayDecimal(derived.btts.yes, derived.btts.no);
        if (devig) {
          const yes = sample.btts ?? 0;
          const outcome = sample.homeGoals > 0 && sample.awayGoals > 0 ? 1 : 0;
          btts.samples += 1;
          btts.gapSum += yes - devig.prob;
          btts.modelLosses.push(-Math.log(Math.max(1e-12, outcome === 1 ? yes : 1 - yes)));
          btts.marketLosses.push(
            -Math.log(Math.max(1e-12, outcome === 1 ? devig.prob : 1 - devig.prob))
          );
          btts.observedHits += outcome === 1 ? 1 : 0;
        }
      }
      if (derived?.ah) {
        // Le moteur ne prédit PAS le handicap asiatique : il n'annonce
        // que l'issue 1/X/2 et les marchés dérivés (total de buts,
        // but de la tête, etc.). La cote existe mais il n'y a RIEN à
        // lui confronter : on compte la présence de la cote sans
        // enregistrer de mesure, et le marché reste « non validé ».
        ah.samples += 1;
      }
    }
    console.log(`  ${dataset.league} traité`);
  }

  const results: Record<string, unknown> = {};
  console.log('');
  console.log('marché'.padEnd(34) + 'n'.padEnd(10) + 'écart moyen'.padEnd(14) + 'log-loss modèle / marché');
  console.log('-'.repeat(84));
  for (const [id, market] of Array.from(markets.entries())) {
    if (!market.samples) {
      console.log(`${market.label.padEnd(34)}0${' '.repeat(8)}aucune cote disponible`);
      continue;
    }
    // Un marché sans prédiction du modèle ne peut pas être « validé » :
    // on ne publie pas de mesure vide (écart 0, log-loss 0) qui ferait
    // croire à une confrontation réussie.
    if (!market.modelLosses.length) {
      console.log(`${market.label.padEnd(34)}${String(market.samples).padEnd(10)}cote présente, aucune prédiction du modèle`);
      continue;
    }
    const averageGap = market.gapSum / market.samples;
    const modelLoss = summarise(market.modelLosses, 1000, 21);
    const marketLoss = summarise(market.marketLosses, 1000, 22);
    results[id] = {
      label: market.label,
      samples: market.samples,
      averageGap: Number(averageGap.toFixed(4)),
      logLoss: modelLoss.value,
      marketLogLoss: marketLoss.value,
      logLossLow: modelLoss.low,
      logLossHigh: modelLoss.high,
      observedRate: market.observedHits / market.samples,
    };
    console.log(
      market.label.padEnd(34) +
        String(market.samples).padEnd(10) +
        `${(averageGap * 100).toFixed(2)} pts`.padEnd(14) +
        `${modelLoss.value.toFixed(4)} / ${marketLoss.value.toFixed(4)}`
    );
  }

  const unvalidated = DERIVED_MARKETS.filter(market => !results[market.id]);
  console.log('');
  console.log(`Marchés SANS cote de référence (${unvalidated.length}) : ${unvalidated.map(m => m.label).join(', ')}`);

  mkdirSync('data', { recursive: true });
  writeFileSync(
    'data/markets-validation.json',
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        dataset: bundle.manifest,
        markets: results,
        unvalidated: unvalidated.map(market => ({
          id: market.id,
          label: market.label,
          reason: market.hasRealOdds
            ? 'aucune cote exploitable dans le jeu de données de référence'
            : 'ce marché n’a pas de cote de référence dans les sources publiques',
        })),
      },
      null,
      2
    ) + '\n',
    'utf-8'
  );
  console.log('');
  console.log('→ data/markets-validation.json');
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
