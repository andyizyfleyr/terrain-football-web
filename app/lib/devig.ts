/* ------------------------------------------------------------------ */
/* RETRAIT DE MARGE BOOKMAKER (de-vigging)                            */
/* ------------------------------------------------------------------ */
/*
 * Fonctions pures partagées par le moteur quantitatif et par le module
 * de cotes : elles transforment des cotes décimales bookmaker en
 * probabilités « justes » (somme = 1) sans marge.
 *
 * - Shin  : correction du biais « favorite-longshot », méthode de référence
 *           pour un marché à 3 issues (1 / X / 2).
 * - Power : repli si la résolution de Shin n'est pas stable.
 * - Deux issues (Over/Under, BTTS) : normalisation multiplicative, qui est
 *   la dé-vig correcte d'un marché binaire.
 *
 * Formulation de Shin (Shin 1992/1993) :
 *
 *   π_i(z) = [ √( z² + 4(1-z)·q_i² / Σq ) − z ] / ( 2(1−z) )
 *
 * où q_i = probabilités implicites brutes (1 / cote) et Σq = 1 + marge.
 * Le paramètre z est déterminé par la racine de Σ_i π_i(z) = 1 : c'est la
 * fonction objectif qui doit être rootsée, et NON une normalisation
 * appliquée à l'intérieur (sinon la somme vaut toujours 1 et la recherche
 * de racine dégénère en une simple normalisation proportionnelle).
 *
 * La formulation et les valeurs de référence sont alignées sur la
 * bibliothèque `penaltyblog` (Shin 1992, 1993).
 */

export function normaliseProbs(values: number[]): number[] {
  const total = values.reduce((a, b) => a + b, 0);
  if (!total || total <= 0) return values.map(() => 1 / values.length);
  return values.map(v => v / total);
}

/** Somme des puissances de k : monotone décroissante en k (0 < q_i < 1). */
function powerSum(implied: number[], k: number): number {
  let sum = 0;
  for (const q of implied) sum += Math.pow(q, k);
  return sum;
}

/**
 * Méthode « power » : retrait de marge proportionnel à la puissance des cotes.
 * On cherche k tel que Σ q_i^k = 1, les probabilités étant alors q_i^k.
 */
export function devigPower(implied: number[]): { probs: number[]; overround: number; k?: number } {
  const overround = implied.reduce((a, b) => a + b, 0);
  if (!implied.length || overround <= 0) return { probs: normaliseProbs(implied), overround };

  // Encadrement robuste : à k = 0 la somme vaut n (> 1), on agrandit hi
  // jusqu'à ce que la somme passe sous 1.
  let lo = 0;
  let hi = 1;
  let hiSum = powerSum(implied, hi);
  let guard = 0;
  while (hiSum > 1 && guard < 200) {
    hi = hi * 2 + 0.5;
    hiSum = powerSum(implied, hi);
    guard += 1;
  }
  if (!(hiSum <= 1)) {
    // Aucune solution dans l'encadrement : repli sur la normalisation simple.
    return { probs: normaliseProbs(implied), overround };
  }

  for (let i = 0; i < 100; i++) {
    const mid = (lo + hi) / 2;
    if (powerSum(implied, mid) > 1) lo = mid;
    else hi = mid;
  }
  const k = (lo + hi) / 2;
  return { probs: normaliseProbs(implied.map(q => Math.pow(q, k))), overround, k };
}

/**
 * Méthode de Shin : retrait de marge corrigé du biais « favorite-longshot ».
 * Retourne null si aucune racine stable n'est trouvée (l'appelant bascule
 * alors sur la méthode Power).
 */
export function devigShin(implied: number[]): { probs: number[]; overround: number; z?: number } | null {
  if (implied.length < 2) return null;
  const overround = implied.reduce((a, b) => a + b, 0);
  if (overround <= 1.0001) return { probs: normaliseProbs(implied), overround, z: 0 };
  if (implied.some(q => !(q > 0 && q < 1))) return null;

  const sumImplied = overround;

  // π_i(z) — fonction NON normalisée : sa somme vaut 1 exactement pour la
  // racine cherchée, et supérieure à 1 pour z plus petit.
  const shinProbs = (z: number): number[] => {
    const denom = 2 * (1 - z);
    if (Math.abs(denom) < 1e-12) {
      // Limite z → 1 : π_i → q_i² / Σq
      return implied.map(q => (q * q) / sumImplied);
    }
    return implied.map(q => {
      const inner = z * z + (4 * (1 - z) * q * q) / sumImplied;
      return (Math.sqrt(Math.max(0, inner)) - z) / denom;
    });
  };

  const error = (z: number): number => shinProbs(z).reduce((a, b) => a + b, 0) - 1;

  // Encadrement : en z = 0 la somme vaut √(Σq) > 1, en z → 1 elle vaut
  // Σq²/Σq < 1 (toujours vrai car 0 < q_i < 1).
  let lo = 0;
  let hi = 1 - 1e-9;
  let loError = error(lo);
  const hiError = error(hi);
  if (!(loError > 0 && hiError < 0)) return null;

  for (let i = 0; i < 120; i++) {
    const mid = (lo + hi) / 2;
    const midError = error(mid);
    if (midError > 0) {
      lo = mid;
      loError = midError;
    } else {
      hi = mid;
    }
    if (hi - lo < 1e-13) break;
  }
  if (!Number.isFinite(loError)) return null;

  const z = (lo + hi) / 2;
  const probs = shinProbs(z);
  if (probs.some(p => !Number.isFinite(p) || p < 0)) return null;
  const total = probs.reduce((a, b) => a + b, 0);
  if (!(total > 0.5 && total < 1.5)) return null;
  return { probs: normaliseProbs(probs), overround, z };
}

/**
 * Dé-vig d'un marché à 3 issues à partir de cotes décimales (1 / X / 2).
 * Retourne les probabilités justes ainsi que la surcharge appliquée.
 */
export function devigThreeWayDecimal(odds: {
  home: number | null;
  draw: number | null;
  away: number | null;
}): { probs: { home: number; draw: number; away: number }; overround: number; method: string } | null {
  const { home, draw, away } = odds;
  if (!home || !draw || !away) return null;
  if (home <= 1 || draw <= 1 || away <= 1) return null;
  const implied = [1 / home, 1 / draw, 1 / away];
  const shin = devigShin(implied);
  const devig = shin || devigPower(implied);
  return {
    probs: { home: devig.probs[0], draw: devig.probs[1], away: devig.probs[2] },
    overround: devig.overround,
    method: shin ? 'Shin' : 'Power',
  };
}

/**
 * Dé-vig d'un marché binaire (Over/Under 2,5, BTTS…) à partir de deux cotes
 * décimales. La normalisation multiplicative retire exactement la marge.
 */
export function devigTwoWayDecimal(
  a: number | null | undefined,
  b: number | null | undefined
): { prob: number; overround: number } | null {
  if (!a || !b) return null;
  if (a <= 1 || b <= 1) return null;
  const impliedA = 1 / a;
  const impliedB = 1 / b;
  const total = impliedA + impliedB;
  if (total <= 0) return null;
  return { prob: impliedA / total, overround: total };
}
