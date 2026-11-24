/* ------------------------------------------------------------------ */
/* DISCLOSURE TRANSPARENTE                                              */
/* ------------------------------------------------------------------ */
/*
 * Le site doit dire clairement ce que le modèle vaut, y compris
 * lorsqu'il ne vaut pas mieux que le marché.
 *
 * Ce module calcule le VERDICT à partir des métriques mesurées :
 *
 *   - « outperform »  : la log-loss calibrée du modèle est
 *     significativement meilleure (au seuil de 1 %) que celle du
 *     marché, sur l'échantillon de référence ;
 *   - « équivalent »  : l'écart est inférieur au seuil ou n'est pas
 *     significatif ;
 *   - « sous le marché »: le marché est significativement meilleur.
 *
 * Le seuil est celui utilisé dans le backtest strict : 1 % de log-loss.
 * Ce n'est pas un seuil arbitraire « pour faire peur » : c'est
 * l'ordre de grandeur de l'intervalle de confiance bootstrap observé
 * sur l'échantillon de référence.
 */

export type DisclosureVerdict = 'outperform' | 'équivalent' | 'sous le marché';

export type DisclosureInput = {
  /** Log-loss calibrée hors échantillon du modèle. */
  calibratedLogLoss: number | null;
  /** Log-loss calibrée ajustée ET évaluée sur le même échantillon. */
  calibratedLogLossInSample?: number | null;
  /** Log-loss du marché de référence. */
  marketLogLoss: number | null;
  /** Log-loss du modèle pur (non calibré). */
  modelLogLoss?: number | null;
  /** Échantillon de référence. */
  sampleSize?: number | null;
  /** Le seuil de valeur a-t-il été démontré sur cet échantillon ? */
  valueDemonstrated?: boolean;
  /** Nombre de paris à « valeur » dans le backtest. */
  valueBets?: number | null;
  /** ROI mesuré sur ces paris. */
  valueRoi?: number | null;
  /** Nombre de marchés dérivés validés contre cotes réelles. */
  validatedMarkets?: number | null;
  /** Nombre de marchés dérivés annoncés. */
  totalMarkets?: number | null;
};

/** Écart relatif considéré comme significatif (1 % de log-loss). */
export const DISCLOSURE_THRESHOLD = 0.01;

export type Disclosure = {
  verdict: DisclosureVerdict;
  /** Écart relatif (log-loss modèle − marché) / marché. */
  relativeGap: number | null;
  /** Phrase courte affichée dans l'interface. */
  headline: string;
  /** Explication complète, en français. */
  detail: string;
  /** true si les paris à « valeur » doivent rester désactivés. */
  valueBetsDisabled: boolean;
  /** Liste des points à signaler au lecteur. */
  caveats: string[];
};

function formatGap(gap: number): string {
  const points = gap * 100;
  return `${points > 0 ? '+' : ''}${points.toFixed(2)} %`;
}

export function buildDisclosure(input: DisclosureInput): Disclosure {
  const caveats: string[] = [];
  const calibrated = input.calibratedLogLoss;
  const market = input.marketLogLoss;

  let verdict: DisclosureVerdict = 'équivalent';
  let relativeGap: number | null = null;

  if (typeof calibrated === 'number' && typeof market === 'number' && market > 0) {
    relativeGap = (calibrated - market) / market;
    if (relativeGap < -DISCLOSURE_THRESHOLD) verdict = 'outperform';
    else if (relativeGap > DISCLOSURE_THRESHOLD) verdict = 'sous le marché';
    else verdict = 'équivalent';
  }

  const headline =
    verdict === 'outperform'
      ? 'Sur l’échantillon de référence, le modèle fait mieux que le marché.'
      : verdict === 'sous le marché'
        ? 'Sur l’échantillon de référence, le marché fait mieux que le modèle.'
        : 'Sur l’échantillon de référence, le modèle ne fait pas mieux que le marché.';

  const detailParts: string[] = [];
  if (typeof calibrated === 'number' && typeof market === 'number') {
    detailParts.push(
      `Log-loss calibrée hors échantillon : ${calibrated.toFixed(4)} contre ${market.toFixed(4)} pour le marché ` +
        `(écart ${formatGap(relativeGap ?? 0)}).`
    );
  } else {
    detailParts.push(
      "Les métriques hors échantillon du marché ne sont pas disponibles : aucune supériorité du modèle ne peut être affirmée."
    );
  }
  if (typeof input.sampleSize === 'number' && input.sampleSize > 0) {
    detailParts.push(`Échantillon de référence : ${input.sampleSize} rencontres.`);
  }
  if (typeof input.modelLogLoss === 'number' && typeof calibrated === 'number') {
    detailParts.push(
      `Le modèle pur (non calibré) atteint ${input.modelLogLoss.toFixed(4)} : la calibration avec le marché est ` +
        'ce qui produit la performance finale, pas le modèle seul.'
    );
  }

  // Avertissements obligatoires.
  if (verdict !== 'outperform') {
    caveats.push(
      "Aucune supériorité du modèle sur le marché n'est démontrée : les écarts relevés sont du même ordre que " +
        'l’incertitude d’échantillonnage.'
    );
  }
  const valueDemonstrated = Boolean(input.valueDemonstrated);
  const valueBets = input.valueBets ?? 0;
  if (!valueDemonstrated) {
    caveats.push(
      valueBets > 0
        ? `Les ${valueBets} paris à « valeur » de l’échantillon ne sont pas significatifs (ROI mesuré ` +
          `${input.valueRoi != null ? `${Math.round(input.valueRoi * 100)} %` : 'indéterminé'}) : la détection de valeur est désactivée.`
        : "Aucune « valeur » n'a été démontrée sur l'échantillon de référence : la détection de valeur est désactivée."
    );
  }
  if (
    typeof input.validatedMarkets === 'number' &&
    typeof input.totalMarkets === 'number' &&
    input.totalMarkets > input.validatedMarkets
  ) {
    caveats.push(
      `${input.totalMarkets - input.validatedMarkets} marchés dérivés sur ${input.totalMarkets} n'ont pas pu être ` +
        'confrontés à des cotes réelles : ce sont des estimations du modèle, pas des mesures.'
    );
  }

  return {
    verdict,
    relativeGap: relativeGap === null ? null : Number(relativeGap.toFixed(5)),
    headline,
    detail: detailParts.join(' '),
    // Tant qu'aucun seuil de valeur n'est démontré, aucune mise en avant
    // de « valeur » n'est faite : le comportement doit correspondre à la
    // mesure, pas à l'inverse.
    valueBetsDisabled: !valueDemonstrated,
    caveats,
  };
}
