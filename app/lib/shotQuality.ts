/* ------------------------------------------------------------------ */
/* QUALITÉ DE TIR (shotmap) : xG, xGOT, volume et danger des occasions */
/* ------------------------------------------------------------------ */
/*
 * Le ratio « buts / xG de saison » mélange deux phénomènes : la qualité
 * des occasions créées et la chance de finition. Le shotmap FotMob les
 * sépare :
 *
 *  - expectedGoals        : xG du tir (probabilité que le tir devienne un but)
 *  - expectedGoalsOnTarget: xGOT, xG conditionné au tir cadré = « danger »
 *  - isFromInsideBox     : localisation de l'occasion
 *  - situation / period  : type d'action et moment du match
 *
 * Un xGOT/xG élevé signifie que l'équipe ne se contente pas de tirer :
 * elle se crée des situations réellement dangereuses. C'est un signal
 * beaucoup plus stable d'un match à l'autre que le nombre de buts.
 *
 * Deux formes de payload sont gérées :
 *  1. content.shotmap.shots[]  (forme plate, ShotmapEvent)
 *  2. content.events.events[].shotmapEvent (imbriqué dans les événements)
 */

export type ShotRecord = {
  teamId: number | null;
  isGoal: boolean;
  isBigChance: boolean;
  isOnTarget: boolean;
  isBlocked: boolean;
  isFromInsideBox: boolean | null;
  xg: number;
  xgot: number;
  situation: string;
  shotType: string;
  period: string;
  minute: number | null;
};

export type ShotQualityProfile = {
  shots: number;
  goals: number;
  onTarget: number;
  bigChances: number;
  insideBox: number;
  penalties: number;
  setPieces: number;
  headers: number;
  fastBreaks: number;
  xg: number;
  xgot: number;
  xgPerShot: number;
  xgotPerShot: number;
  conversion: number;
  goalRate: number;
  /** xGOT / xG : qualité des occasions (1 = neutre). */
  qualityRatio: number;
  /** Buts marqués rapportés au xG des tirs (1 = finition conforme). */
  finishingRatio: number;
  matches: number;
  note: string;
};

export const EMPTY_SHOT_PROFILE: ShotQualityProfile = {
  shots: 0,
  goals: 0,
  onTarget: 0,
  bigChances: 0,
  insideBox: 0,
  penalties: 0,
  setPieces: 0,
  headers: 0,
  fastBreaks: 0,
  xg: 0,
  xgot: 0,
  xgPerShot: 0,
  xgotPerShot: 0,
  conversion: 0,
  goalRate: 0,
  qualityRatio: 1,
  finishingRatio: 1,
  matches: 0,
  note: 'Aucune donnée de tir exploitée.',
};

const SET_PIECE_SITUATIONS = /setpiece|corner|freekick|penalty/i;
const FAST_BREAK_SITUATIONS = /fastbreak|counter/i;

function num(value: any): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function normaliseShot(raw: any, fallbackTeamId: number | null): ShotRecord | null {
  if (!raw || typeof raw !== 'object') return null;
  const eventType = String(raw.eventType || raw.type || '');
  const isGoal = raw.isGoal === true || eventType === 'Goal';
  const isShot =
    raw.isShot === true ||
    eventType === 'Goal' ||
    eventType === 'AttemptSaved' ||
    eventType === 'Miss' ||
    eventType === 'Blocked' ||
    eventType === 'Post' ||
    eventType === 'OffTarget' ||
    raw.expectedGoals !== undefined;
  if (!isShot) return null;

  const teamIdRaw = raw.teamId ?? raw.team_id ?? fallbackTeamId;
  const teamId = typeof teamIdRaw === 'number' && Number.isFinite(teamIdRaw) ? teamIdRaw : null;
  const xg = num(raw.expectedGoals);
  const xgot = num(raw.expectedGoalsOnTarget);

  return {
    teamId,
    isGoal,
    // FotMob ne fournit pas toujours le flag « grande occasion » : on
    // l'approximise par un xG élevé, convention usuelle (xG ≥ 0,30).
    isBigChance: raw.isBigChance === true || xg >= 0.3,
    isOnTarget: raw.isOnTarget === true || isGoal || eventType === 'AttemptSaved',
    isBlocked: raw.isBlocked === true || eventType === 'Blocked',
    isFromInsideBox:
      typeof raw.isFromInsideBox === 'boolean'
        ? raw.isFromInsideBox
        : raw.isFromInsideBox === 'true'
          ? true
          : raw.isFromInsideBox === 'false'
            ? false
            : null,
    xg,
    xgot,
    situation: String(raw.situation || ''),
    shotType: String(raw.shotType || ''),
    period: String(raw.period || ''),
    minute: typeof raw.min === 'number' ? raw.min : null,
  };
}

/** Extrait la liste normalisée de tirs d'un payload FotMob quelconque. */
export function extractShots(details: any): ShotRecord[] {
  if (!details || typeof details !== 'object') return [];
  const content = details.content || {};
  const shots: ShotRecord[] = [];

  const flat = content.shotmap?.shots;
  if (Array.isArray(flat)) {
    for (const raw of flat) {
      const shot = normaliseShot(raw, null);
      if (shot) shots.push(shot);
    }
  }

  if (!shots.length) {
    const periods = content.shotmap?.Periods;
    if (periods && typeof periods === 'object') {
      const all = periods.All;
      if (Array.isArray(all)) {
        for (const raw of all) {
          const shot = normaliseShot(raw, null);
          if (shot) shots.push(shot);
        }
      }
    }
  }

  if (!shots.length) {
    const events = content.events?.events;
    if (Array.isArray(events)) {
      for (const event of events) {
        const shot = normaliseShot(event?.shotmapEvent, null);
        if (shot) shots.push(shot);
      }
    }
  }

  return shots;
}

/** Construit le profil de qualité de tir d'une équipe à partir de ses tirs. */
export function buildShotProfile(shots: ShotRecord[], matches: number): ShotQualityProfile {
  if (!shots.length) {
    return { ...EMPTY_SHOT_PROFILE, matches };
  }
  let goals = 0;
  let onTarget = 0;
  let bigChances = 0;
  let insideBox = 0;
  let penalties = 0;
  let setPieces = 0;
  let headers = 0;
  let fastBreaks = 0;
  let xg = 0;
  let xgot = 0;

  for (const shot of shots) {
    if (shot.isGoal) goals += 1;
    if (shot.isOnTarget) onTarget += 1;
    if (shot.isBigChance) bigChances += 1;
    if (shot.isFromInsideBox) insideBox += 1;
    if (/penalty/i.test(shot.situation)) penalties += 1;
    else if (SET_PIECE_SITUATIONS.test(shot.situation)) setPieces += 1;
    if (/head/i.test(shot.shotType)) headers += 1;
    if (FAST_BREAK_SITUATIONS.test(shot.situation)) fastBreaks += 1;
    xg += shot.xg;
    xgot += shot.xgot;
  }

  const shots_ = shots.length;
  const xgPerShot = shots_ ? xg / shots_ : 0;
  const xgotPerShot = shots_ ? xgot / shots_ : 0;

  return {
    shots: shots_,
    goals,
    onTarget,
    bigChances,
    insideBox,
    penalties,
    setPieces,
    headers,
    fastBreaks,
    xg: Number(xg.toFixed(3)),
    xgot: Number(xgot.toFixed(3)),
    xgPerShot: Number(xgPerShot.toFixed(4)),
    xgotPerShot: Number(xgotPerShot.toFixed(4)),
    conversion: xg > 0 ? Number((goals / xg).toFixed(3)) : 1,
    goalRate: shots_ ? Number((goals / shots_).toFixed(4)) : 0,
    qualityRatio: xg > 0.001 ? Number((xgot / xg).toFixed(3)) : 1,
    finishingRatio: xg > 0.001 ? Number((goals / xg).toFixed(3)) : 1,
    matches,
    note:
      `${shots_} tirs sur ${matches} match(s) · xG ${xg.toFixed(2)} · xGOT ${xgot.toFixed(2)} · ` +
      `${bigChances} grande(s) occasion(s) · ${goals} but(s).`,
  };
}

/**
 * Agrège les profils de tir de plusieurs matchs en un profil unique
 * (somme des volumes, ratios recalculés).
 */
export function mergeShotProfiles(profiles: ShotQualityProfile[]): ShotQualityProfile {
  const usable = profiles.filter(p => p.shots > 0);
  if (!usable.length) return { ...EMPTY_SHOT_PROFILE };

  const total = usable.reduce(
    (acc, p) => ({
      shots: acc.shots + p.shots,
      goals: acc.goals + p.goals,
      onTarget: acc.onTarget + p.onTarget,
      bigChances: acc.bigChances + p.bigChances,
      insideBox: acc.insideBox + p.insideBox,
      penalties: acc.penalties + p.penalties,
      setPieces: acc.setPieces + p.setPieces,
      headers: acc.headers + p.headers,
      fastBreaks: acc.fastBreaks + p.fastBreaks,
      xg: acc.xg + p.xg,
      xgot: acc.xgot + p.xgot,
      matches: acc.matches + p.matches,
    }),
    {
      shots: 0,
      goals: 0,
      onTarget: 0,
      bigChances: 0,
      insideBox: 0,
      penalties: 0,
      setPieces: 0,
      headers: 0,
      fastBreaks: 0,
      xg: 0,
      xgot: 0,
      matches: 0,
    }
  );

  const xgPerShot = total.shots ? total.xg / total.shots : 0;
  const xgotPerShot = total.shots ? total.xgot / total.shots : 0;

  return {
    ...total,
    xg: Number(total.xg.toFixed(3)),
    xgot: Number(total.xgot.toFixed(3)),
    xgPerShot: Number(xgPerShot.toFixed(4)),
    xgotPerShot: Number(xgotPerShot.toFixed(4)),
    conversion: total.xg > 0 ? Number((total.goals / total.xg).toFixed(3)) : 1,
    goalRate: total.shots ? Number((total.goals / total.shots).toFixed(4)) : 0,
    qualityRatio: total.xg > 0.001 ? Number((total.xgot / total.xg).toFixed(3)) : 1,
    finishingRatio: total.xg > 0.001 ? Number((total.goals / total.xg).toFixed(3)) : 1,
    note:
      `${total.shots} tirs sur ${total.matches} match(s) · xG ${total.xg.toFixed(2)} · ` +
      `xGOT ${total.xgot.toFixed(2)} · ${total.bigChances} grande(s) occasion(s) · ${total.goals} but(s).`,
  };
}

/**
 * Multiplicateur de finition déduit de la qualité des tirs.
 *
 * On compare le danger moyen des occasions de l'équipe (xGOT par tir) à la
 * référence league (fournie par l'appelant). Un ratio supérieur signifie
 * que l'équipe transforme des occasions plus dangerouses que la moyenne :
 * on augmente modérément son λ. L'effet est volontairement borné (≤ ±8 %)
 * car la qualité de tir est déjà partiellement captée par le xG de saison.
 */
export function shotQualityFactor(
  profile: ShotQualityProfile | null | undefined,
  leagueXgPerShot: number,
  leagueXgotPerShot: number
): { factor: number; note: string } {
  if (!profile || profile.shots < 12 || !leagueXgPerShot) {
    return { factor: 1, note: 'Qualité de tir non exploitable (volume insuffisant).' };
  }
  const qualityGap = profile.xgPerShot / leagueXgPerShot - 1;
  const dangerGap = leagueXgotPerShot > 0 ? profile.xgotPerShot / leagueXgotPerShot - 1 : 0;
  // Le volume de tirs est déjà pris en compte par le xG de saison : on ne
  // retient que l'écart de qualité (danger), avec un poids réduit.
  const blended = 0.65 * dangerGap + 0.35 * qualityGap;
  const factor = Math.max(0.92, Math.min(1.08, 1 + blended * 0.5));
  return {
    factor: Number(factor.toFixed(4)),
    note:
      `xG/tir ${profile.xgPerShot.toFixed(3)} (league ${leagueXgPerShot.toFixed(3)}) · ` +
      `xGOT/tir ${profile.xgotPerShot.toFixed(3)} (league ${leagueXgotPerShot.toFixed(3)}) → ×${factor.toFixed(3)}.`,
  };
}
