/* ------------------------------------------------------------------ */
/* ÉTIQUETTES DE MATCH                                                  */
/* ------------------------------------------------------------------ */
/*
 * Chaque rencontre reçoit une ou plusieurs étiquettes lisibles :
 *
 *   💎 Value         ⚖️ Serré       🏆 Favori net
 *   🔥 Beaucoup de buts   🧊 Peu de buts   ⚠️ Piège
 *
 * Ces étiquettes ne changent NI les probabilités NI la logique du
 * moteur : elles ne font que décrire ce que le rapport d'analyse
 * mesure déjà. Elles sont produites par une fonction PURE, à partir
 * des champs réels du rapport d'analyse :
 *
 *   - market.calibrated            (probabilités 1X2 calibrées)
 *   - market.edges                 (écart modèle / marché)
 *   - market.odds                  (cotes réelles)
 *   - simulation                   (expectedGoals, over25, btts)
 *   - confidence                   (score de confiance /100)
 *   - absences.officialLineup      (composition confirmée ou non)
 *   - context                      (fatigue, enjeux)
 *
 * Règles tenues :
 *   - une donnée absente n'est JAMAIS remplacée par une supposition :
 *     l'étiquette est omise et un avertissement l'explique ;
 *   - aucun nombre NaN n'est produit, y compris dans les raisons ;
 *   - la détection de « valeur » respecte le verdict du moteur : tant
 *     qu'aucun seuil de valeur n'est démontré sur l'historique de
 *     référence, aucune étiquette « Value » n'est annoncée ;
 *   - la composition officielle nesignale un piège que si le match est
 *     proche du coup d'envoi (sinon, l'absence de onze est normale).
 *
 * La même fonction sert aux deux chemins : l'analyse complète d'un
 * match (rapport du moteur) et le scan d'une journée (calque brut,
 * sans analyse complète). Dans le second cas, seules les étiquettes
 * dont les données sont réellement disponibles sont produites.
 */

/** Identifiants d'étiquettes (ordre d'affichage dans MATCH_TAG_CONFIG). */
export type MatchTagId =
  | 'value'
  | 'tight'
  | 'clear-favourite'
  | 'high-scoring'
  | 'low-scoring'
  | 'trap';

export type MatchTag = {
  id: MatchTagId;
  /** Emoji affichée sur la carte. */
  emoji: string;
  /** Libellé court affiché sur la carte. */
  label: string;
  /** Raison CHIFFRÉE : ce qui a déclenché l'étiquette. */
  reason: string;
};

export type MatchTagsResult = {
  /** Étiquettes retenues, dans l'ordre d'importance. */
  tags: MatchTag[];
  /**
   * Avertissements : pourquoi une étiquette n'a PAS pu être évaluée
   * (donnée absente) ou pourquoi elle a été volontairement écartée.
   */
  warnings: string[];
};

/**
 * TOUS LES SEUILS sont ici, et nulle part ailleurs.
 * Modifier une valeur suffit à changer le comportement des étiquettes.
 */
export const MATCH_TAG_CONFIG = {
  /** Ordre d'affichage : les premiers sont les plus parlants. */
  order: ['value', 'tight', 'clear-favourite', 'high-scoring', 'low-scoring', 'trap'] as MatchTagId[],
  /** Nombre maximum de badges affichés sur une carte. */
  maxBadges: 3,
  tight: {
    /** La meilleure issue reste sous ce seuil : personne ne domine. */
    maxBestProbability: 0.42,
    /** Écart maximal entre les deux victoires (points de probabilité). */
    maxWinGap: 0.1,
  },
  clearFavourite: {
    /** Probabilité minimale du favori. */
    minProbability: 0.55,
    /** Avance minimale sur la deuxième issue (points de probabilité). */
    minLead: 0.25,
  },
  goals: {
    /** Total de buts attendus à partir duquel le match est « ouvert ». */
    highTotal: 2.9,
    /** Probabilité « +2,5 buts » à partir de laquelle le match est « ouvert ». */
    highOver25: 0.6,
    /** Total de buts attendu en deçà duquel le match est « fermé ». */
    lowTotal: 2.2,
    /** Probabilité « +2,5 buts » en deçà de laquelle le match est « fermé ». */
    lowOver25: 0.4,
  },
  value: {
    /** Confiance minimale (score /100) pour annoncer une valeur. */
    minConfidenceScore: 60,
    /**
     * Écart minimal exigé selon la cote du pari : plus la cote est
     * haute, plus l'écart doit être net pour conclure à une valeur.
     */
    edgeByOdd: [
      { maxOdd: 3, minEdge: 0.02 },
      { maxOdd: 6, minEdge: 0.05 },
      { maxOdd: Number.POSITIVE_INFINITY, minEdge: 0.08 },
    ],
    /** Un match serré exige un écart plus large. */
    tightBonus: 0.02,
  },
  trap: {
    /** Confiance jugée trop basse (score /100). */
    maxConfidenceScore: 55,
    /** Indice de fatigue (0-1) à partir duquel le calendrier pèse. */
    highFatigue: 0.65,
    /** Facteur d'intensité des enjeux : sous 1, l'enjeu est faible. */
    lowStakesFactor: 1,
    /**
     * Fenêtre avant le coup d'envoi pendant laquelle l'absence de
     * composition officielle constitue un signal (les compositions sont
     * publiées environ une heure avant le match).
     */
    lineupWindowMinutes: 90,
  },
} as const;

/** Emoji et libellé de chaque étiquette. */
export const MATCH_TAG_LABELS: Record<MatchTagId, { emoji: string; label: string }> = {
  value: { emoji: '💎', label: 'Value' },
  tight: { emoji: '⚖️', label: 'Serré' },
  'clear-favourite': { emoji: '🏆', label: 'Favori net' },
  'high-scoring': { emoji: '🔥', label: 'Beaucoup de buts' },
  'low-scoring': { emoji: '🧊', label: 'Peu de buts' },
  trap: { emoji: '⚠️', label: 'Piège' },
};

/**
 * Forme minimale acceptée par `computeMatchTags`. Elle couvre le
 * rapport complet du moteur ET le calque brut d'un scan de journée :
 * chaque bloc est optionnel, et l'étiquette correspondante est omise
 * quand la donnée manque.
 */
export type MatchTagReport = {
  homeName?: string | null;
  awayName?: string | null;
  market?: {
    available?: boolean;
    calibrated?: {
      home?: number | null;
      draw?: number | null;
      away?: number | null;
      over25?: number | null;
      btts?: number | null;
    } | null;
    edges?: { home?: number | null; draw?: number | null; away?: number | null } | null;
    odds?: { home?: number | null; draw?: number | null; away?: number | null; over25?: number | null } | null;
  } | null;
  simulation?: {
    expectedGoals?: { home?: number | null; away?: number | null; total?: number | null } | null;
    over25?: number | null;
    btts?: number | null;
  } | null;
  confidence?: { score?: number | null; label?: string | null } | null;
  absences?: { officialLineup?: { available?: boolean; confirmed?: boolean } | null } | null;
  context?: {
    home?: { restDays?: number | null; fatigue?: number | null } | null;
    away?: { restDays?: number | null; fatigue?: number | null } | null;
    stakes?: {
      home?: string | null;
      away?: string | null;
      homeFactor?: number | null;
      awayFactor?: number | null;
    } | null;
  } | null;
  calibration?: { valueThresholdDemonstrated?: boolean | null } | null;
  /** Calque brut (scan de journée) : probabilités du modèle non calibré. */
  probabilities?: {
    home?: number | null;
    draw?: number | null;
    away?: number | null;
    over25?: number | null;
    bttsYes?: number | null;
  } | null;
  /** Calque brut : buts attendus hors simulation complète. */
  expectedGoals?: { home?: number | null; away?: number | null } | null;
  /**
   * Minutes avant le coup d'envoi, calculées par l'appelant (le
   * moteur). Absent = inconnu : le signal « composition non
   * confirmée » ne peut alors pas être évalué.
   */
  minutesToKickoff?: number | null;
};

/* ------------------------------------------------------------------ */
/* Helpers de lecture (aucun nombre NaN ne peut sortir d'ici)          */
/* ------------------------------------------------------------------ */

function finite(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** Probabilité en pourcentage lisible : 0.412 → « 41 % ». */
function pct(value: number): string {
  return `${Math.round(value * 100)} %`;
}

/** Écart en points de probabilité : 0.087 → « 9 pts ». */
function pts(value: number): string {
  return `${Math.round(value * 100)} pts`;
}

/** Nombre à la française : 3.142 → « 3,14 ». */
function num(value: number, digits = 2): string {
  return value.toFixed(digits).replace('.', ',');
}

function readTriple(
  source: { home?: number | null; draw?: number | null; away?: number | null } | null | undefined
): { home: number; draw: number; away: number } | null {
  const home = finite(source?.home);
  const draw = finite(source?.draw);
  const away = finite(source?.away);
  if (home === null || draw === null || away === null) return null;
  return { home, draw, away };
}

function makeTag(id: MatchTagId, reason: string): MatchTag {
  return { id, ...MATCH_TAG_LABELS[id], reason };
}

/**
 * Seuil d'écart exigé pour annoncer une valeur, selon la cote du pari.
 * `tight` ajoute une marge : sur un match serré, un écart modeste ne
 * prouve rien.
 */
export function valueEdgeThreshold(odd: number, tight: boolean): number {
  const buckets = MATCH_TAG_CONFIG.value.edgeByOdd as readonly { maxOdd: number; minEdge: number }[];
  const bucket = buckets.find(entry => odd <= entry.maxOdd) ?? buckets[buckets.length - 1];
  const threshold = bucket.minEdge;
  return tight ? threshold + MATCH_TAG_CONFIG.value.tightBonus : threshold;
}

/**
 * Calcule les étiquettes d'une rencontre.
 *
 * Fonction PURE : mêmes données → mêmes étiquettes, dans le même ordre.
 * Aucune donnée inventée, aucun NaN.
 */
export function computeMatchTags(report: MatchTagReport | null | undefined): MatchTagsResult {
  const tags: MatchTag[] = [];
  const warnings: string[] = [];

  if (!report) {
    warnings.push('Aucune analyse disponible : aucune étiquette ne peut être calculée.');
    return { tags, warnings };
  }

  /* --- Probabilités 1X2 ------------------------------------------- */
  // Priorité aux probabilités CALIBRÉES du rapport complet ; à défaut,
  // les probabilités brutes du modèle (scan de journée, sans marché).
  const calibrated = readTriple(report.market?.calibrated);
  const probs = calibrated ?? readTriple(report.probabilities);
  const probSource = calibrated ? 'calibrées' : 'du modèle';

  if (!probs) {
    warnings.push(
      "Probabilités indisponibles : les étiquettes « Serré » et « Favori net » n'ont pas pu être évaluées."
    );
  } else {
    const best = Math.max(probs.home, probs.draw, probs.away);
    const winGap = Math.abs(probs.home - probs.away);

    // Serré : personne ne domine et les deux victoires sont proches.
    if (
      best < MATCH_TAG_CONFIG.tight.maxBestProbability &&
      winGap < MATCH_TAG_CONFIG.tight.maxWinGap
    ) {
      tags.push(
        makeTag(
          'tight',
          `Meilleure probabilité ${pct(best)} · écart entre les deux victoires ${pts(winGap)}`
        )
      );
    }

    // Favori net : une équipe domine et prend de l'avance sur l'autre.
    const favouriteIsHome = probs.home >= probs.away;
    const favouriteProb = favouriteIsHome ? probs.home : probs.away;
    const otherWinProb = favouriteIsHome ? probs.away : probs.home;
    const runnerUp = Math.max(probs.draw, otherWinProb);
    const lead = favouriteProb - runnerUp;
    if (
      favouriteProb >= MATCH_TAG_CONFIG.clearFavourite.minProbability &&
      lead >= MATCH_TAG_CONFIG.clearFavourite.minLead
    ) {
      const name = favouriteIsHome ? report.homeName : report.awayName;
      const label = name ? `Favori ${name}` : 'Favori';
      tags.push(makeTag('clear-favourite', `${label} ${pct(favouriteProb)} · ${pts(lead)} d’avance`));
    }
  }

  /* --- Volume de buts --------------------------------------------- */
  const simGoals = report.simulation?.expectedGoals;
  let expectedTotal = finite(simGoals?.total);
  let goalsAreEstimate = false;
  if (expectedTotal === null) {
    const simHome = finite(simGoals?.home);
    const simAway = finite(simGoals?.away);
    if (simHome !== null && simAway !== null) expectedTotal = simHome + simAway;
  }
  if (expectedTotal === null) {
    // Calque brut du scan de journée : buts attendus hors simulation.
    const baseHome = finite(report.expectedGoals?.home);
    const baseAway = finite(report.expectedGoals?.away);
    if (baseHome !== null && baseAway !== null) {
      expectedTotal = baseHome + baseAway;
      goalsAreEstimate = true;
    }
  }

  const over25 =
    finite(report.simulation?.over25) ??
    finite(report.market?.calibrated?.over25) ??
    finite(report.probabilities?.over25);

  if (expectedTotal === null && over25 === null) {
    warnings.push(
      "Buts attendus indisponibles : les étiquettes « Beaucoup de buts » et « Peu de buts » n'ont pas pu être évaluées."
    );
  } else {
    const goalParts: string[] = [];
    if (expectedTotal !== null) {
      goalParts.push(`buts attendus ${num(expectedTotal)}${goalsAreEstimate ? ' (estimation de base)' : ''}`);
    }
    if (over25 !== null) goalParts.push(`+2,5 buts à ${pct(over25)}`);

    // Les deux étiquettes sont exclusives l'une de l'autre. Le total de
    // buts attendus est le signal principal : c'est lui qui tranche
    // quand la probabilité « +2,5 » en dit autre chose.
    const totalHigh = expectedTotal !== null && expectedTotal >= MATCH_TAG_CONFIG.goals.highTotal;
    const totalLow = expectedTotal !== null && expectedTotal <= MATCH_TAG_CONFIG.goals.lowTotal;
    const overHigh = over25 !== null && over25 >= MATCH_TAG_CONFIG.goals.highOver25;
    const overLow = over25 !== null && over25 <= MATCH_TAG_CONFIG.goals.lowOver25;

    let goalTag: 'high-scoring' | 'low-scoring' | null = null;
    if (totalHigh !== totalLow) {
      goalTag = totalHigh ? 'high-scoring' : 'low-scoring';
    } else if (!totalHigh && !totalLow) {
      if (overHigh !== overLow) goalTag = overHigh ? 'high-scoring' : 'low-scoring';
    }

    if ((totalHigh && overLow) || (totalLow && overHigh)) {
      warnings.push(
        'Le total de buts attendus et la probabilité « +2,5 buts » se contredisent : la mention retenue suit le total de buts.'
      );
    }

    if (goalTag) {
      tags.push(makeTag(goalTag, goalParts.join(' · ')));
    }
  }

  /* --- Value -------------------------------------------------------- */
  const edges = report.market?.edges;
  const odds = report.market?.odds;
  const marketAvailable = report.market?.available === true;
  const hasOdds =
    finite(odds?.home) !== null || finite(odds?.draw) !== null || finite(odds?.away) !== null;

  if (report.calibration?.valueThresholdDemonstrated === false) {
    // Le moteur lui-même refuse d'annoncer une valeur : l'étiquette
    // ferait écran de fumée à une conclusion que l'analyse ne pose pas.
    warnings.push(
      "Aucun seuil de valeur n'a été démontré sur l'historique de référence : la détection de valeur reste inactive."
    );
  } else if (!marketAvailable || !hasOdds) {
    warnings.push("Cotes de marché indisponibles : l'étiquette « Value » n'a pas pu être évaluée.");
  } else if (!edges) {
    warnings.push(
      "Écarts modèle/marché indisponibles dans cette réponse : l'étiquette « Value » n'a pas pu être évaluée."
    );
  } else {
    const confidenceScore = finite(report.confidence?.score);
    if (confidenceScore === null) {
      warnings.push("Confiance indisponible : l'étiquette « Value » n'a pas pu être évaluée.");
    } else if (confidenceScore < MATCH_TAG_CONFIG.value.minConfidenceScore) {
      // Écart volontaire : la confiance est trop faible. Pas un avertissement.
    } else {
      const candidates = [
        {
          key: 'home',
          label: report.homeName ? `victoire ${report.homeName}` : 'victoire domicile',
          edge: finite(edges.home),
          odd: finite(odds?.home),
        },
        {
          key: 'draw',
          label: 'match nul',
          edge: finite(edges.draw),
          odd: finite(odds?.draw),
        },
        {
          key: 'away',
          label: report.awayName ? `victoire ${report.awayName}` : 'victoire extérieur',
          edge: finite(edges.away),
          odd: finite(odds?.away),
        },
      ].filter(entry => entry.edge !== null) as { key: string; label: string; edge: number; odd: number | null }[];

      const best = candidates.sort((a, b) => b.edge - a.edge)[0];
      if (best) {
        const odd = best.odd ?? 0;
        const tight = tags.some(tag => tag.id === 'tight');
        const threshold = valueEdgeThreshold(odd, tight);
        if (best.edge >= threshold) {
          tags.push(
            makeTag(
              'value',
              `Écart ${pts(best.edge)} sur ${best.label}` +
                (odd > 0 ? ` (cote ${num(odd)})` : '') +
                ` · confiance ${Math.round(confidenceScore)}/100`
            )
          );
        }
      }
    }
  }

  /* --- Piège -------------------------------------------------------- */
  const trapSignals: string[] = [];

  const lineup = report.absences?.officialLineup;
  const minutesToKickoff = finite(report.minutesToKickoff);
  if (lineup) {
    const lineupKnown = lineup.available === true;
    const lineupConfirmed = lineup.confirmed === true;
    if (!lineupKnown || !lineupConfirmed) {
      if (minutesToKickoff === null) {
        warnings.push(
          "Distance au coup d'envoi inconnue : l'absence de composition officielle n'a pas pu être interprétée."
        );
      } else if (minutesToKickoff <= MATCH_TAG_CONFIG.trap.lineupWindowMinutes) {
        trapSignals.push(
          lineupKnown
            ? 'composition annoncée mais non confirmée'
            : 'composition officielle non publiée'
        );
      }
    }
  }

  const homeFatigue = finite(report.context?.home?.fatigue);
  const awayFatigue = finite(report.context?.away?.fatigue);
  const fatigue = Math.max(homeFatigue ?? 0, awayFatigue ?? 0);
  if (homeFatigue !== null || awayFatigue !== null) {
    if (fatigue >= MATCH_TAG_CONFIG.trap.highFatigue) {
      trapSignals.push(`fatigue ${Math.round(fatigue * 100)} % sur 14 jours`);
    }
  }

  const homeStakes = finite(report.context?.stakes?.homeFactor);
  const awayStakes = finite(report.context?.stakes?.awayFactor);
  if (homeStakes !== null || awayStakes !== null) {
    const weakest = Math.min(homeStakes ?? 1, awayStakes ?? 1);
    if (weakest < MATCH_TAG_CONFIG.trap.lowStakesFactor) {
      trapSignals.push('enjeu limité pour une des deux équipes');
    }
  }

  const confidenceScore = finite(report.confidence?.score);
  if (confidenceScore !== null && confidenceScore < MATCH_TAG_CONFIG.trap.maxConfidenceScore) {
    trapSignals.push(`confiance faible ${Math.round(confidenceScore)}/100`);
  }

  if (trapSignals.length) {
    tags.push(makeTag('trap', trapSignals.join(' · ')));
  } else if (!lineup && confidenceScore === null && homeFatigue === null && awayFatigue === null) {
    warnings.push(
      "Signaux de piège indisponibles dans cette réponse (composition, fatigue, enjeux, confiance) : l'étiquette « Piège » n'a pas pu être évaluée."
    );
  }

  /* --- Ordre et quantité ------------------------------------------- */
  const ordered = MATCH_TAG_CONFIG.order
    .map(id => tags.find(tag => tag.id === id))
    .filter((tag): tag is MatchTag => Boolean(tag));

  return { tags: ordered, warnings };
}

/**
 * Étiquettes à afficher sur une carte (3 maximum).
 * Conserve l'ordre d'importance et ne coupe jamais une étiquette au
 * milieu d'une raison.
 */
export function pickBadges(tags: MatchTag[] | null | undefined, max = MATCH_TAG_CONFIG.maxBadges): MatchTag[] {
  if (!Array.isArray(tags)) return [];
  return tags.slice(0, Math.max(0, max));
}
