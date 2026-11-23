/* ------------------------------------------------------------------ */
/* PROFIL D'ARBITRE                                                     */
/* ------------------------------------------------------------------ */
/*
 * FotMob fournit pour chaque arbitre ses moyennes ET la moyenne du
 * championnat (`average`, `averageType`), ce qui permet de mesurer un biais
 * relatif réel plutôt qu'un seuil arbitraire :
 *
 *   - fautes et cartes au-dessus de la moyenne → jeu plus fragmenté,
 *     moins de phases de jeu fluide, donc un total de buts légèrement
 *     plus faible ;
 *   - penalties au-dessus de la moyenne → les penalties représentant
 *     environ 16 % des buts, la part « penalty » du total augmente.
 *
 * Les effets sont bornés à ±4 % : l'arbitre est un facteur réel mais
 * mineur, et le sur-branler produirait plus de bruit que d'information.
 */

export type RefereeStats = {
  name?: string;
  matches?: number;
  yellowPerMatch?: number | null;
  yellowAverage?: number | null;
  yellowAverageType?: string | null;
  foulsPerMatch?: number | null;
  foulsAverage?: number | null;
  foulsAverageType?: string | null;
  penaltiesTotal?: number | null;
  penaltiesPerMatch?: number | null;
  redCardsTotal?: number | null;
};

export type RefereeProfile = {
  name: string;
  matches: number | null;
  yellowPerMatch: number | null;
  yellowDelta: number | null;
  foulsPerMatch: number | null;
  foulsDelta: number | null;
  penaltiesPerMatch: number | null;
  /** Multiplicateur appliqué au total de buts. */
  effect: number;
  /** Écart-type relatif ajouté à la dispersion des scores. */
  volatility: number;
  note: string;
};

const PENALTY_SHARE = 0.16;
const LEAGUE_PENALTY_RATE = 0.3;

export function buildRefereeProfile(referee: RefereeStats | null | undefined): RefereeProfile {
  const name = referee?.name ? String(referee.name) : 'Non désigné';
  const matches = typeof referee?.matches === 'number' ? referee.matches : null;
  const yellowPerMatch = numberOrNull(referee?.yellowPerMatch);
  const yellowAverage = numberOrNull(referee?.yellowAverage);
  const foulsPerMatch = numberOrNull(referee?.foulsPerMatch);
  const foulsAverage = numberOrNull(referee?.foulsAverage);
  const penaltiesPerMatch = numberOrNull(referee?.penaltiesPerMatch);

  const yellowDelta = relativeDelta(yellowPerMatch, yellowAverage);
  const foulsDelta = relativeDelta(foulsPerMatch, foulsAverage);

  const notes: string[] = [];
  let effect = 1;
  let volatility = 0;

  if (yellowDelta !== null) {
    // Plus de cartes → plus d'interruptions → jeu fluide en baisse.
    effect *= 1 + clamp(yellowDelta * 0.02, -0.03, 0.03);
    volatility += clamp(Math.abs(yellowDelta) * 0.03, 0, 0.05);
    notes.push(
      `${yellowPerMatch!.toFixed(2)} cartons/match contre ${yellowAverage!.toFixed(2)} en moyenne ` +
        `(${yellowDelta > 0 ? '+' : ''}${Math.round(yellowDelta * 100)} %)`
    );
  }

  if (foulsDelta !== null) {
    effect *= 1 + clamp(foulsDelta * 0.015, -0.02, 0.02);
    notes.push(
      `${foulsPerMatch!.toFixed(1)} fautes/match (${foulsDelta > 0 ? '+' : ''}${Math.round(foulsDelta * 100)} % vs moyenne)`
    );
  }

  if (penaltiesPerMatch !== null) {
    const penaltyDelta = (penaltiesPerMatch - LEAGUE_PENALTY_RATE) / LEAGUE_PENALTY_RATE;
    effect *= 1 + clamp(penaltyDelta * PENALTY_SHARE, -0.03, 0.04);
    notes.push(
      `${penaltiesPerMatch.toFixed(2)} penalty(s)/match (moyenne ≈ ${LEAGUE_PENALTY_RATE}) → part penalty ajustée`
    );
  }

  if (!notes.length) notes.push('Statistiques de l’arbitre indisponibles : effet neutre appliqué.');

  return {
    name,
    matches,
    yellowPerMatch,
    yellowDelta: yellowDelta !== null ? Number(yellowDelta.toFixed(4)) : null,
    foulsPerMatch,
    foulsDelta: foulsDelta !== null ? Number(foulsDelta.toFixed(4)) : null,
    penaltiesPerMatch,
    effect: Number(effect.toFixed(4)),
    volatility: Number(volatility.toFixed(4)),
    note: notes.join(' · '),
  };
}

function numberOrNull(value: any): number | null {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function relativeDelta(value: number | null, average: number | null): number | null {
  if (value === null || average === null || !average) return null;
  return value / average - 1;
}

function clamp(v: number, min: number, max: number): number {
  if (!Number.isFinite(v)) return min;
  return Math.max(min, Math.min(max, v));
}
