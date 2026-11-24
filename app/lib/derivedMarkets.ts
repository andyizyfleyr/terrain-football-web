/* ------------------------------------------------------------------ */
/* MARCHÉS DÉRIVÉS : REGISTRE ET STATUT DE VALIDATION                   */
/* ------------------------------------------------------------------ */
/*
 * Le moteur annonce 16 marchés dérivés (total impair, but de la tête,
 * score à la mi-temps, premier but, etc.). Tous ne sont pas des
 * marchés de bookmaker : certains n'ont pas de cote de référence
 * exploitable dans les sources publiques.
 *
 * Ce registre distingue trois statuts :
 *
 *   - « validé »     : le marché a été comparé à des cotes RÉELLES sur
 *                      un échantillon suffisant, et l'écart entre la
 *                      probabilité du modèle et celle du marché a été
 *                      mesuré (voir data/markets-validation.json) ;
 *   - « non validé » : le marché n'a pas pu être comparé à des cotes
 *                      réelles (aucune cote disponible, ou échantillon
 *                      trop faible). L'interface et l'API l'indiquent
 *                      explicitement : ce n'est PAS une mesure ;
 *   - « à surveiller »: la comparaison existe mais l'échantillon est
 *                      trop faible pour conclure.
 *
 * Rien n'est marqué « validé » sans mesure réelle : le registre est
 * produit par `npm run check:markets`, qui lit le rapport de validation.
 */

export type MarketValidationStatus = 'validé' | 'non validé' | 'à surveiller';

export type DerivedMarketDefinition = {
  id: string;
  label: string;
  /** Ce que le moteur annonce pour ce marché. */
  description: string;
  /** true si une cote de marché réelle existe dans les sources publiques. */
  hasRealOdds: boolean;
};

export const DERIVED_MARKETS: DerivedMarketDefinition[] = [
  {
    id: 'total-odd',
    label: 'Total impair',
    description: 'Nombre total de buts impair sur le match.',
    hasRealOdds: false,
  },
  {
    id: 'header-goal',
    label: 'But de la tête',
    description: 'Au moins un but de la tête sur le match.',
    hasRealOdds: false,
  },
  {
    id: 'first-half-score',
    label: 'Score à la mi-temps',
    description: 'Issue (1 / X / 2) à la mi-temps.',
    hasRealOdds: false,
  },
  {
    id: 'second-half-score',
    label: 'Score à la fin de la seconde période',
    description: 'Issue (1 / X / 2) sur la seconde période.',
    hasRealOdds: false,
  },
  {
    id: 'at-least-one-half',
    label: 'Au moins une mi-temps avec un but',
    description: 'Quart, mi-temps ou seconde période marque au moins un but.',
    hasRealOdds: false,
  },
  {
    id: 'first-goal-1',
    label: 'Premier but (1re équipe)',
    description: 'La première équipe marque en premier.',
    hasRealOdds: false,
  },
  {
    id: 'first-goal-2',
    label: 'Deuxième but',
    description: 'La deuxième équipe marque en premier.',
    hasRealOdds: false,
  },
  {
    id: 'first-goal-3',
    label: 'Premier but (3e équipe)',
    description: 'Personne ne marque en premier.',
    hasRealOdds: false,
  },
  {
    id: 'last-goal',
    label: 'Dernier but',
    description: 'Équipe marquant le dernier but.',
    hasRealOdds: false,
  },
  {
    id: 'half-time-full-time',
    label: 'Mi-temps / fin de match',
    description: 'Combinaison des issues à la mi-temps et à la fin.',
    hasRealOdds: false,
  },
  {
    id: 'clean-sheet-home',
    label: 'Clean sheet domicile',
    description: "L'équipe à domicile ne concède pas.",
    hasRealOdds: false,
  },
  {
    id: 'clean-sheet-away',
    label: 'Clean sheet extérieur',
    description: "L'équipe à l'extérieur ne concède pas.",
    hasRealOdds: false,
  },
  {
    id: 'over-25',
    label: 'Plus de 2,5 buts',
    description: 'Le match compte plus de 2,5 buts.',
    hasRealOdds: true,
  },
  {
    id: 'btts',
    label: 'Les deux équipes marquent',
    description: 'Les deux équipes marquent au moins un but.',
    hasRealOdds: false,
  },
  {
    id: 'asian-handicap',
    label: 'Handicap asiatique',
    description: 'Résultat après application du handicap de la ligne.',
    // Le moteur n'annonce PAS le handicap : la cote existe, mais il n'y
    // a aucune prédiction à lui confronter. Le marché reste donc non
    // validé (cote disponible, prédiction absente).
    hasRealOdds: false,
  },
  {
    id: 'one-x-two',
    label: 'Issue 1 / X / 2',
    description: 'Issue du match (hors prolongation).',
    hasRealOdds: true,
  },
];

export type MarketStatus = {
  id: string;
  label: string;
  status: MarketValidationStatus;
  /** Nombre de rencontres utilisées pour la validation (null si non validé). */
  samples: number | null;
  /** Écart moyen entre la probabilité du modèle et celle du marché (points). */
  averageGap: number | null;
  /** Log-loss du modèle sur ce marché. */
  modelLogLoss: number | null;
  /** Log-loss du marché sur ce marché. */
  marketLogLoss: number | null;
  /** Explication lisible, affichée dans l'interface. */
  note: string;
};

/**
 * Seuils de validation d'un marché.
 *
 *   - « validé »     : au moins MIN_SAMPLES rencontres confrontées à une
 *                      cote réelle, et log-loss du modèle à moins de
 *                      MAX_LOSS_GAP du marché ;
 *   - « à surveiller »: confrontation possible mais échantillon trop
 *                      faible ou modèle trop éloigné du marché ;
 *   - « non validé »  : aucune cote de référence, ou aucune prédiction
 *                      du modèle à confronter.
 */
export const MIN_SAMPLES = 1000;
export const MIN_WATCH_SAMPLES = 100;
export const MAX_LOSS_GAP = 0.1;

/**
 * Construit le statut de chaque marché à partir du rapport de validation
 * (`data/markets-validation.json`). Sans rapport, tous les marchés sont
 * « non validés » : on ne suppose jamais qu'une validation a eu lieu.
 */
export function buildMarketStatuses(
  validation?: {
    markets?: Record<string, { samples: number; averageGap: number; logLoss: number; marketLogLoss: number }>;
  } | null
): MarketStatus[] {
  const measured = validation?.markets || {};
  return DERIVED_MARKETS.map(market => {
    const result = measured[market.id];
    if (!result || !result.samples) {
      return {
        id: market.id,
        label: market.label,
        status: market.hasRealOdds ? 'à surveiller' : 'non validé',
        samples: result?.samples ?? 0,
        averageGap: result ? Number(result.averageGap.toFixed(4)) : null,
        modelLogLoss: result?.logLoss ?? null,
        marketLogLoss: result?.marketLogLoss ?? null,
        note: market.hasRealOdds
          ? "Aucune cote de marché n'a pu être comparée à ce marché sur le jeu de données de référence : la probabilité annoncée n'est PAS validée."
          : "Ce marché n'a pas de cote de référence dans les sources publiques : la probabilité annoncée est une ESTIMATION du modèle, sans confrontation possible au marché.",
      };
    }
    const gap = Number(result.averageGap.toFixed(4));
    const marketLoss = result.marketLogLoss;
    const lossGap =
      marketLoss > 0 ? Math.abs(result.logLoss - marketLoss) / marketLoss : Infinity;
    let verdict: MarketValidationStatus;
    if (result.samples >= MIN_SAMPLES && lossGap <= MAX_LOSS_GAP) verdict = 'validé';
    else if (result.samples >= MIN_WATCH_SAMPLES) verdict = 'à surveiller';
    else verdict = 'non validé';
    return {
      id: market.id,
      label: market.label,
      status: verdict,
      samples: result.samples,
      averageGap: gap,
      modelLogLoss: result.logLoss,
      marketLogLoss: marketLoss,
      note:
        `Confronté à ${result.samples.toLocaleString('fr-FR')} rencontres avec cotes réelles : écart moyen entre la probabilité du modèle et celle du marché de ${(gap * 100).toFixed(1)} points ; log-loss modèle ${result.logLoss.toFixed(4)} contre ${marketLoss.toFixed(4)} pour le marché.` +
        (verdict === 'validé'
          ? ''
          : verdict === 'à surveiller'
            ? ` Échantillon ou écart insuffisant pour valider : à surveiller.`
            : ` Ni échantillon suffisant ni performance comparable : non validé.`),
    };
  });
}

/** Message court affiché à côté d'un marché non validé. */
export function marketStatusBadge(status: MarketStatus): string {
  switch (status.status) {
    case 'validé':
      return `Validé sur ${status.samples} rencontres`;
    case 'à surveiller':
      return `À surveiller (${status.samples} rencontres)`;
    default:
      return 'Non validé — estimation du modèle';
  }
}
