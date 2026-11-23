/* ------------------------------------------------------------------ */
/* SÉQUENCES & DYNAMIQUE DE FORMES                                     */
/* ------------------------------------------------------------------ */
/*
 * Une série de buts marqués (ou de clean sheets) est le signal le plus
 * bruité du football : une grande partie des « séries » est du hasard, et le
 * marché y réagit presque toujours trop fort (biais de sur-réaction aux
 * séries, documenté sur les marchés de paris).
 *
 * Le module calcule les séries réellement observées, puis applique un
 * ajustement VOLONTAIREMENT FAIBLE et shrinkage vers la moyenne : on
 * capte le signal sans tomber dans le piège de la sur-réaction.
 *
 * Il exploite également les « oddspoll » FotMob (séries calculées par la
 * source elle-même) comme corroboration, sans jamais les cumuler avec nos
 * propres calculs.
 */

export type SequenceProfile = {
  matches: number;
  scoredStreak: number;
  failedToScoreStreak: number;
  cleanSheetStreak: number;
  concededStreak: number;
  winStreak: number;
  drawStreak: number;
  lossStreak: number;
  avgGoalsScored: number;
  avgGoalsConceded: number;
  avgGoalsScoredLast3: number;
  notes: string[];
};

export type SequenceAdjustment = {
  factor: number;
  signal: number;
  note: string;
};

type MatchLike = {
  utcTime?: string;
  homeId: number;
  awayId: number;
  homeScore: number;
  awayScore: number;
};

function emptyProfile(): SequenceProfile {
  return {
    matches: 0,
    scoredStreak: 0,
    failedToScoreStreak: 0,
    cleanSheetStreak: 0,
    concededStreak: 0,
    winStreak: 0,
    drawStreak: 0,
    lossStreak: 0,
    avgGoalsScored: 0,
    avgGoalsConceded: 0,
    avgGoalsScoredLast3: 0,
    notes: [],
  };
}

/**
 * Analyse les séries d'une équipe sur ses derniers matchs.
 * `venue` : 'home' | 'away' | 'all'.
 */
export function analyseSequences(
  matches: MatchLike[],
  teamId: number,
  venue: 'home' | 'away' | 'all' = 'all',
  limit = 8
): SequenceProfile {
  const played = (matches || [])
    .filter(m => m.homeId === teamId || m.awayId === teamId)
    .filter(m =>
      venue === 'all'
        ? true
        : venue === 'home'
          ? m.homeId === teamId
          : m.awayId === teamId
    )
    .sort((a, b) => Date.parse(b.utcTime || '') - Date.parse(a.utcTime || ''))
    .slice(0, limit);

  if (!played.length) return emptyProfile();

  const results = played.map(m => {
    const isHome = m.homeId === teamId;
    return {
      gf: isHome ? m.homeScore : m.awayScore,
      ga: isHome ? m.awayScore : m.homeScore,
      venue: isHome ? 'home' : 'away',
    };
  });

  const scoredStreak = leadingStreak(results.map(r => r.gf > 0));
  const failedToScoreStreak = leadingStreak(results.map(r => r.gf === 0));
  const cleanSheetStreak = leadingStreak(results.map(r => r.ga === 0));
  const concededStreak = leadingStreak(results.map(r => r.ga > 0));
  const winStreak = leadingStreak(results.map(r => r.gf > r.ga));
  const drawStreak = leadingStreak(results.map(r => r.gf === r.ga));
  const lossStreak = leadingStreak(results.map(r => r.gf < r.ga));

  const avgGoalsScored = results.reduce((a, r) => a + r.gf, 0) / results.length;
  const avgGoalsConceded = results.reduce((a, r) => a + r.ga, 0) / results.length;
  const last3 = results.slice(0, 3);
  const avgGoalsScoredLast3 = last3.length
    ? last3.reduce((a, r) => a + r.gf, 0) / last3.length
    : 0;

  const notes: string[] = [];
  if (scoredStreak >= 3) notes.push(`${scoredStreak} matchs consécutifs marqués`);
  if (failedToScoreStreak >= 2) notes.push(`${failedToScoreStreak} matchs consécutifs sans marquer`);
  if (cleanSheetStreak >= 2) notes.push(`${cleanSheetStreak} clean sheets consécutifs`);
  if (concededStreak >= 3) notes.push(`${concededStreak} matchs consécutifs avec un but encaissé`);
  if (winStreak >= 3) notes.push(`${winStreak} victoires consécutives`);
  if (lossStreak >= 3) notes.push(`${lossStreak} défaites consécutives`);

  return {
    matches: played.length,
    scoredStreak,
    failedToScoreStreak,
    cleanSheetStreak,
    concededStreak,
    winStreak,
    drawStreak,
    lossStreak,
    avgGoalsScored: Number(avgGoalsScored.toFixed(3)),
    avgGoalsConceded: Number(avgGoalsConceded.toFixed(3)),
    avgGoalsScoredLast3: Number(avgGoalsScoredLast3.toFixed(3)),
    notes,
  };
}

function leadingStreak(flags: boolean[]): number {
  let streak = 0;
  for (const flag of flags) {
    if (!flag) break;
    streak += 1;
  }
  return streak;
}

/**
 * Ajustement d'attaque induit par les séries.
 *
 * Signal = (série de buts marqués) − (série d'échecs) normalisé, avec un
 * poids volontairement faible : le modèle ne « parie » pas sur la série,
 * il l'amorce seulement. L'effet est borné à ±4 %.
 */
export function sequenceAttackAdjustment(
  profile: SequenceProfile,
  referenceGoals: number
): SequenceAdjustment {
  if (!profile.matches || !referenceGoals) {
    return { factor: 1, signal: 0, note: 'Historique insuffisant pour isoler les séries.' };
  }
  const scored = Math.min(4, profile.scoredStreak) / 4;
  const failed = Math.min(3, profile.failedToScoreStreak) / 3;
  const signal = scored - failed;
  if (!signal) {
    return { factor: 1, signal: 0, note: 'Aucune série dominante : aucun ajustement.' };
  }
  const factor = Math.max(0.96, Math.min(1.04, 1 + signal * 0.03));
  return {
    factor: Number(factor.toFixed(4)),
    signal: Number(signal.toFixed(3)),
    note:
      `Séries : ${profile.scoredStreak} matchs marqués consécutifs, ` +
      `${profile.failedToScoreStreak} sans marquer → ×${factor.toFixed(3)} (ajustement plafonné à ±4 %).`,
  };
}

/**
 * Ajustement défensif induit par les séries d'encaissement / clean sheets.
 */
export function sequenceDefenceAdjustment(
  profile: SequenceProfile,
  referenceConceded: number
): SequenceAdjustment {
  if (!profile.matches || !referenceConceded) {
    return { factor: 1, signal: 0, note: 'Historique insuffisant pour isoler les séries.' };
  }
  const clean = Math.min(4, profile.cleanSheetStreak) / 4;
  const conceding = Math.min(3, profile.concededStreak) / 3;
  const signal = clean - conceding;
  if (!signal) {
    return { factor: 1, signal: 0, note: 'Aucune série dominante : aucun ajustement.' };
  }
  const factor = Math.max(0.96, Math.min(1.04, 1 + signal * 0.03));
  return {
    factor: Number(factor.toFixed(4)),
    signal: Number(signal.toFixed(3)),
    note:
      `Séries défensives : ${profile.cleanSheetStreak} clean sheet(s), ` +
      `${profile.concededStreak} match(s) avec encaissement → ×${factor.toFixed(3)}.`,
  };
}

/**
 * Faits « oddspoll » de FotMob : séries calculées par la source sur des
 * données parfois plus larges que notre fenêtre. Utilisés en corroboration
 * uniquement, et seulement si notre propre historique est incomplet.
 */
export type PollFact = {
  label: string;
  value: string;
  team: 'home' | 'away';
};

export function extractPollFacts(oddspoll: any): PollFact[] {
  const facts = oddspoll?.Facts;
  if (!Array.isArray(facts)) return [];
  const out: PollFact[] = [];
  for (const fact of facts) {
    if (!fact || typeof fact !== 'object') continue;
    const template = String(fact.DefaultTemplate || fact.TextTemplateId || '');
    const values = Array.isArray(fact.StatValues) ? fact.StatValues.map(String) : [];
    if (!template || !values.length) continue;
    const team = String(fact.StatValues?.[0] || '').includes('away_team') ? 'away' : 'home';
    out.push({
      label: template.replace(/\{0\}/g, values[0] ?? '').replace(/\{1\}/g, values[1] ?? ''),
      value: values.slice(1).join(' / '),
      team,
    });
  }
  return out;
}
