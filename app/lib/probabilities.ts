/* ------------------------------------------------------------------ */
/* VALIDATION DES PROBABILITÉS                                         */
/* ------------------------------------------------------------------ */
/*
 * Toute probabilité affichée doit être FINIE, comprise entre 0 et 1 et,
 * pour un ensemble d'issues exhaustives (1 / X / 2), sommer à 1.
 *
 * Ces contrôles sont appliqués à la frontière de sortie du moteur : une
 * valeur invalide (NaN, infini, somme ≠ 1) ne doit jamais atteindre
 * l'interface ni l'API, qui la présenterait comme une mesure.
 *
 * Quand une probabilité est inutilisable, on ne la « nettoie » pas : on
 * la REMPLACE par une valeur neutre explicite et on signale le défaut,
 * pour que l'appelant puisse l'afficher comme telle.
 */

/** Tolérance sur la somme d'un ensemble exhaustif (arrondi numérique). */
export const PROBABILITY_SUM_TOLERANCE = 1e-6;

/** true si la valeur est un nombre fini. */
export function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/** true si la valeur est une probabilité exploitable (finie, dans [0,1]). */
export function isValidProbability(value: unknown): value is number {
  return isFiniteNumber(value) && value >= 0 && value <= 1;
}

/**
 * Contrôle d'un ensemble d'issues exhaustives (1 / X / 2).
 * Renvoie true si chaque valeur est valide ET si la somme vaut 1.
 */
export function isValidOutcomeSet(values: {
  home: number;
  draw: number;
  away: number;
}): boolean {
  const { home, draw, away } = values;
  if (!isValidProbability(home) || !isValidProbability(draw) || !isValidProbability(away)) {
    return false;
  }
  const sum = home + draw + away;
  return Math.abs(sum - 1) <= PROBABILITY_SUM_TOLERANCE;
}

/**
 * Normalise un ensemble d'issues exhaustives.
 * - si les valeurs sont valides, elles sont renvoyées telles quelles ;
 * - si elles sont finies mais ne somment pas à 1, elles sont renormalisées
 *   (correction d'arrondi) ;
 * - si l'une d'elles est inutilisable (NaN, infini, hors bornes), le
 *   repli fourni est renvoyé.
 */
export function normaliseOutcomeSet<T extends { home: number; draw: number; away: number }>(
  values: T,
  fallback: { home: number; draw: number; away: number }
): T {
  const { home, draw, away } = values;
  if (!isValidProbability(home) || !isValidProbability(draw) || !isValidProbability(away)) {
    return { ...values, ...fallback };
  }
  const sum = home + draw + away;
  if (sum <= 0 || !isFiniteNumber(sum)) return { ...values, ...fallback };
  if (Math.abs(sum - 1) <= PROBABILITY_SUM_TOLERANCE) return values;
  return {
    ...values,
    home: home / sum,
    draw: draw / sum,
    away: away / sum,
  };
}

/**
 * Contrôle d'une probabilité simple (over/under, BTTS…).
 * Renvoie la valeur si elle est valide, sinon null : le appelant affiche
 * alors « inconnu » plutôt qu'un nombre faux.
 */
export function safeProbability(value: unknown): number | null {
  return isValidProbability(value) ? value : null;
}

/**
 * Comme `safeProbability`, mais avec une valeur de repli : le résultat
 * reste toujours un nombre affichable.
 */
export function safeProbabilityOr(value: unknown, fallback: number): number {
  return isValidProbability(value) ? value : fallback;
}
