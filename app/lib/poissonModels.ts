/* ------------------------------------------------------------------ */
/* MODÈLES DE SCORE : Poisson bivarié + correction Dixon-Coles         */
/* ------------------------------------------------------------------ */
/*
 * Le moteur historique reposait sur un Poisson indépendant corrigé par le
 * seul facteur τ de Dixon & Coles (1997). Ce module ajoute la covariance
 * entre les buts des deux équipes, qui est la correction structurelle la
 * plus importante pour un match de football :
 *
 *   X = X₁ + X₃ ,  Y = X₂ + X₃
 *   X₁ ~ Poi(μ₁) , X₂ ~ Poi(μ₂) , X₃ ~ Poi(λ₃)
 *   ⇒ Cov(X, Y) = λ₃
 *
 * λ₃ capte les situations partagées : pressions défensives qui profitent
 * aux deux équipes, ouverture du match, erreurs qui profitent à
 * l'adversaire. Sans elle, la distribution des scores est trop dispersée
 * sur les scores « plausibles » (1-1, 2-1) et la probabilité de nul est
 * systématiquement sous-estimée.
 *
 * La correction Dixon-Coles est conservée et appliquée APRÈS la covariance :
 * Elle ne corrige que les cellules (0,0), (0,1), (1,0), (1,1) — les scores
 * bas — que la seule hypothèse de Poisson traite mal.
 *
 * Toutes les fonctions de ce module sont pures et testables.
 */

/**
 * Fonction de masse de Poisson : P(X = k) = e^{−λ} λ^k / k!.
 *
 * Le calcul se fait en logarithmes (log k! par somme de logarithmes) pour
 * rester stable quand λ est grand.
 */
export function poissonPmf(k: number, lambda: number): number {
  if (!Number.isFinite(lambda) || lambda <= 0) return k === 0 ? 1 : 0;
  if (!Number.isInteger(k) || k < 0) return 0;
  let logFactorial = 0;
  for (let i = 2; i <= k; i++) logFactorial += Math.log(i);
  return Math.exp(-lambda + k * Math.log(lambda) - logFactorial);
}

/** Fonction de répartition cumulative de Poisson. */
export function poissonCdf(k: number, lambda: number): number {
  if (k < 0) return 0;
  let sum = 0;
  for (let i = 0; i <= k; i++) {
    sum += poissonPmf(i, lambda);
    if (sum > 1.5) break;
  }
  return Math.min(1, Math.max(0, sum));
}

/** Probabilité d'au moins (threshold + 1) événements pour une variable de Poisson. */
export function poissonOver(lambda: number, threshold: number): number {
  return Math.max(0, Math.min(1, 1 - poissonCdf(threshold, lambda)));
}

/**
 * Facteur de correction de Dixon & Coles : réajuste les quatre cellules de
 * score bas pour-account l'excès (ou le déficit) de 0-0 / 1-1 par rapport à
 * l'indépendance de Poisson.
 */
export function dixonColesTau(x: number, y: number, lh: number, la: number, rho: number): number {
  if (x === 0 && y === 0) return 1 - lh * la * rho;
  if (x === 0 && y === 1) return 1 + lh * rho;
  if (x === 1 && y === 0) return 1 + la * rho;
  if (x === 1 && y === 1) return 1 - rho;
  return 1;
}

/**
 * Probabilité jointe du Poisson bivarié (composante commune λ₃).
 *
 *   X = X₁ + X₃ , Y = X₂ + X₃
 *   X₁ ~ Poi(λ₁) , X₂ ~ Poi(λ₂) , X₃ ~ Poi(λ₃)
 *   P(X=h, Y=a) = e^{−(λ₁+λ₂+λ₃)} Σ_{k≤min(h,a)}
 *                  λ₁^{h−k} λ₂^{a−k} λ₃^k / ((h−k)! (a−k)! k!)
 *
 * Pour conserver les marges demandées (E[X] = μ₁, E[Y] = μ₂) on pose
 * λ₁ = μ₁ − λ₃ et λ₂ = μ₂ − λ₃ : c'est la composante commune qui est
 * « financée » sur les deux équipes, pas un surplus de buts.
 */
export function bivariatePmf(
  h: number,
  a: number,
  muHome: number,
  muAway: number,
  lambda3: number
): number {
  if (h < 0 || a < 0 || !Number.isInteger(h) || !Number.isInteger(a)) return 0;
  const l3 = Math.max(0, Math.min(0.25, lambda3));
  const l1 = Math.max(0, muHome - l3);
  const l2 = Math.max(0, muAway - l3);
  let total = 0;
  const maxK = Math.min(h, a);
  for (let k = 0; k <= maxK; k++) {
    const term =
      Math.exp(-(l1 + l2 + l3)) *
      Math.pow(l1, h - k) *
      Math.pow(l2, a - k) *
      Math.pow(l3, k);
    total += term / (factorial(h - k) * factorial(a - k) * factorial(k));
  }
  return Number.isFinite(total) ? total : 0;
}

export function factorial(n: number): number {
  if (n < 0) return 0;
  let out = 1;
  for (let i = 2; i <= n; i++) out *= i;
  return out;
}

/**
 * Matrice des scores (proba en ligne = buts domicile, colonne = buts extérieur)
 * corrigée de la covariance puis de la correction Dixon-Coles.
 */
export function buildScoreMatrix(params: {
  lambdaHome: number;
  lambdaAway: number;
  covariance?: number;
  rho?: number;
  maxGoals?: number;
}): number[][] {
  const lambdaHome = Math.max(0.02, params.lambdaHome);
  const lambdaAway = Math.max(0.02, params.lambdaAway);
  const lambda3 = Math.max(0, Math.min(0.25, params.covariance ?? 0));
  const rho = params.rho ?? 0;
  const maxGoals = params.maxGoals ?? 8;

  const matrix: number[][] = [];
  let total = 0;
  for (let h = 0; h <= maxGoals; h++) {
    const row: number[] = [];
    for (let a = 0; a <= maxGoals; a++) {
      const base = bivariatePmf(h, a, lambdaHome, lambdaAway, lambda3);
      const tau = dixonColesTau(h, a, lambdaHome, lambdaAway, rho);
      const value = Math.max(0, base * tau);
      row.push(value);
      total += value;
    }
    matrix.push(row);
  }
  if (total > 0) {
    for (let h = 0; h <= maxGoals; h++) {
      for (let a = 0; a <= maxGoals; a++) matrix[h][a] /= total;
    }
  }
  return matrix;
}

/**
 * Agrégats issus d'une matrice de scores : issues, totals, BTTS, scores
 * exacts et répartition par période.
 */
export type ScoreMatrixSummary = {
  home: number;
  draw: number;
  away: number;
  btts: number;
  over15: number;
  over25: number;
  over35: number;
  noGoal: number;
  firstHalfGoals: number;
  secondHalfGoals: number;
  firstHalfOver05: number;
  secondHalfOver05: number;
  expectedGoals: number;
  scores: { h: number; a: number; p: number }[];
};

export function summariseScoreMatrix(
  matrix: number[][],
  firstHalfShare: number
): ScoreMatrixSummary {
  let pHome = 0;
  let pDraw = 0;
  let pAway = 0;
  let btts = 0;
  let over15 = 0;
  let over25 = 0;
  let over35 = 0;
  let firstHalfGoals = 0;
  let secondHalfGoals = 0;
  let expectedGoals = 0;
  const scores: { h: number; a: number; p: number }[] = [];

  const pH1 = Math.max(0.15, Math.min(0.75, firstHalfShare));

  for (let h = 0; h < matrix.length; h++) {
    for (let a = 0; a < matrix.length; a++) {
      const p = matrix[h][a];
      if (h > a) pHome += p;
      else if (h === a) pDraw += p;
      else pAway += p;
      if (h >= 1 && a >= 1) btts += p;
      if (h + a >= 2) over15 += p;
      if (h + a >= 3) over25 += p;
      if (h + a >= 4) over35 += p;
      firstHalfGoals += p * (h + a) * pH1;
      secondHalfGoals += p * (h + a) * (1 - pH1);
      expectedGoals += p * (h + a);
      if (h <= 6 && a <= 6) scores.push({ h, a, p });
    }
  }

  scores.sort((x, y) => y.p - x.p);

  return {
    home: pHome,
    draw: pDraw,
    away: pAway,
    btts,
    over15,
    over25,
    over35,
    noGoal: matrix[0][0],
    firstHalfGoals,
    secondHalfGoals,
    firstHalfOver05: 1 - Math.exp(-expectedGoals * pH1),
    secondHalfOver05: 1 - Math.exp(-expectedGoals * (1 - pH1)),
    expectedGoals,
    scores,
  };
}

/**
 * Estimation de la composante commune λ₃ (covariance empirique résiduelle).
 *
 * Sur un panel de matchs, on mesure la covariance résiduelle entre les buts
 * domicile et les buts extérieur :
 *   λ̂₃ = moyenne de (buts_dom − μ₁) × (buts_ext − μ₂)
 *
 * La valeur est bornée : au-delà de 0,08 la composante commune devient
 * physiology improbable et le modèle se dilue.
 */
export function estimateCovariance(
  samples: { homeGoals: number; awayGoals: number }[],
  muHome: number,
  muAway: number,
  options?: { max?: number; min?: number }
): { covariance: number; samples: number } {
  const min = options?.min ?? 0;
  const max = options?.max ?? 0.08;
  const usable = samples.filter(
    s => Number.isFinite(s.homeGoals) && Number.isFinite(s.awayGoals)
  );
  if (usable.length < 12) return { covariance: 0, samples: usable.length };

  let sum = 0;
  for (const s of usable) {
    sum += (s.homeGoals - muHome) * (s.awayGoals - muAway);
  }
  const raw = sum / usable.length;
  const covariance = Math.max(min, Math.min(max, raw));
  return { covariance: Number(covariance.toFixed(5)), samples: usable.length };
}

/**
 * Part des buts marqués en première période, estimée sur des rencontres
 * disposant d'un score à la mi-temps. Repli sur la valeur de référence
 * (44 %) quand l'échantillon est insuffisant.
 */
export function estimateFirstHalfShare(
  matches: { htHome: number; htAway: number; homeGoals: number; awayGoals: number }[],
  fallback = 0.44
): { share: number; samples: number; fitted: boolean } {
  let first = 0;
  let total = 0;
  let usable = 0;
  for (const m of matches) {
    const ht = (m.htHome || 0) + (m.htAway || 0);
    const ft = (m.homeGoals || 0) + (m.awayGoals || 0);
    if (!Number.isFinite(ht) || !Number.isFinite(ft) || ft <= 0) continue;
    first += ht;
    total += ft;
    usable += 1;
  }
  if (usable < 10 || total <= 0) return { share: fallback, samples: usable, fitted: false };
  const share = Math.max(0.32, Math.min(0.58, first / total));
  return { share: Number(share.toFixed(4)), samples: usable, fitted: true };
}

/**
 * Ajustement de température (« sharpness ») : p ∝ p^γ, renormalisé.
 * γ > 1 accentue les avis (modèle trop prudent), γ < 1 les tempère.
 */
export function applySharpness(probs: number[], gamma: number): number[] {
  if (!probs.length) return probs;
  const g = Math.max(0.4, Math.min(2.2, gamma));
  const raw = probs.map(p => Math.pow(Math.max(1e-9, p), g));
  const total = raw.reduce((a, b) => a + b, 0);
  if (!total) return probs.slice();
  return raw.map(p => p / total);
}

/**
 * Intervalle de crédibilité Bayésien (Beta) à 80 % autour d'une probabilité,
 * avec une concentration n_eff calibrée sur données historiques.
 *   p ~ Beta(p̂ · n, (1 − p̂) · n)
 */
export function credibleInterval(probability: number, effectiveSampleSize: number, level = 0.8): {
  low: number;
  high: number;
} {
  const p = Math.max(0.001, Math.min(0.999, probability));
  const n = Math.max(4, effectiveSampleSize);
  const a = p * n;
  const b = (1 - p) * n;
  const lo = Math.max(0, betaQuantile(a, b, (1 - level) / 2));
  const hi = Math.min(1, betaQuantile(a, b, 1 - (1 - level) / 2));
  return { low: Number(lo.toFixed(4)), high: Number(hi.toFixed(4)) };
}

/** Quantile d'une loi Beta(a, b) par inversion de la loi Beta incomplète. */
export function betaQuantile(a: number, b: number, q: number): number {
  const p = Math.max(1e-6, Math.min(1 - 1e-6, q));
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (regularizedIncompleteBeta(a, b, mid) < p) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/** Fonction Beta incomplète régularisée I_x(a, b). */
export function regularizedIncompleteBeta(a: number, b: number, x: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const logBeta = logGamma(a) + logGamma(b) - logGamma(a + b);
  const front = Math.exp(a * Math.log(x) + b * Math.log(1 - x) - logBeta);
  if (x < (a + 1) / (a + b + 2)) {
    return (front * betaContinuedFraction(a, b, x)) / a;
  }
  return 1 - (Math.exp(b * Math.log(1 - x) + a * Math.log(x) - logBeta) * betaContinuedFraction(b, a, 1 - x)) / b;
}

function betaContinuedFraction(a: number, b: number, x: number): number {
  const maxIterations = 200;
  const epsilon = 3e-12;
  const tiny = 1e-30;
  let qab = a + b;
  let qap = a + 1;
  let qam = a - 1;
  let c = 1;
  let d = 1 - (qab * x) / qap;
  if (Math.abs(d) < tiny) d = tiny;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= maxIterations; m++) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < tiny) d = tiny;
    c = 1 + aa / c;
    if (Math.abs(c) < tiny) c = tiny;
    d = 1 / d;
    h *= d * c;
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < tiny) d = tiny;
    c = 1 + aa / c;
    if (Math.abs(c) < tiny) c = tiny;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < epsilon) break;
  }
  return h;
}

/** Fonction Gamma (Lanczos). */
export function logGamma(z: number): number {
  const g = 7;
  const coefficients = [
    0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313,
    -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6,
    1.5056327351493116e-7,
  ];
  if (z < 0.5) {
    return Math.log(Math.PI / Math.sin(Math.PI * z)) - logGamma(1 - z);
  }
  const zz = z - 1;
  let x = coefficients[0];
  for (let i = 1; i < g + 2; i++) {
    x += coefficients[i] / (zz + i);
  }
  const t = zz + g + 0.5;
  return (
    0.5 * Math.log(2 * Math.PI) + (zz + 0.5) * Math.log(t) - t + Math.log(x)
  );
}
