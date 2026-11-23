/* ------------------------------------------------------------------ */
/* CONTRIBUTION DES JOUEURS & IMPACT DES ABSENCES                      */
/* ------------------------------------------------------------------ */
/*
 * L'impact d'une absence était estimé à partir de la valeur marchande, des
 * buts et de la note de l'individu. Ces trois signaux sont bruités : la
 * valeur marchande est un indicateur de potentiel (pas de production
 * réelle), et un but sur une saison ne dit rien du poids d'un joueur dans
 * le jeu offensif.
 *
 * Ce module calcule une contribution par joueur à partir des productions
 * observées ET attendues (xG, xA, minutes), puis en déduit :
 *   - la part de chaque joueur dans la production de l'équipe,
 *   - l'impact de son absence, modulé par la qualité du remplaçant.
 *
 * La valeur marchande reste utilisée à 40 % : elle est informative quand
 * les statistiques de joueur manquent (effectif réduit, jeune équipe).
 */

export type PlayerContribution = {
  id: number | null;
  name: string;
  position: string;
  goals: number;
  assists: number;
  xg: number;
  xa: number;
  minutes: number;
  rating: number | null;
  /** Production offensive pondérée par 90 minutes. */
  attackIndex: number;
  /** Apport défensif (note + minutes joués). */
  defenceIndex: number;
};

export type AbsenceImpact = {
  name: string;
  type: string;
  role: string;
  impact: number;
  longTerm: boolean;
  note: string;
  source: 'contribution' | 'valeur' | 'mixte';
};

const ATTACKER = /ST|CF|FW|LW|RW|CAM|AM|W/;
const DEFENDER = /GK|CB|LB|RB|LWB|RWB|CM|DM/;

function num(value: any): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Normalise une entrée de statistiques joueur quelle que soit sa forme
 * (tableau d'objets `{ title, value }`, objet indexé par intitulé, ou
 * valeur unique `{ value, name }`).
 */
export function readPlayerStat(
  raw: any,
  aliases: RegExp
): { value: number; playerName: string | null } | null {
  if (raw === null || raw === undefined) return null;

  if (Array.isArray(raw)) {
    for (const item of raw) {
      if (!item || typeof item !== 'object') continue;
      const title = String(item.title || item.name || item.key || '');
      if (!aliases.test(title)) continue;
      const value = num(item.value ?? item.statValue);
      if (!value) continue;
      return { value, playerName: item.playerName ? String(item.playerName) : null };
    }
    return null;
  }

  if (typeof raw === 'object') {
    // Forme { value, name } : statistique d'un joueur unique (ex. gardien).
    if (typeof raw.value === 'number' && Number.isFinite(raw.value)) {
      const title = String(raw.stat?.title || raw.title || raw.key || '');
      if (!title || aliases.test(title)) {
        return { value: num(raw.value), playerName: raw.name ? String(raw.name) : null };
      }
    }
    for (const key of Object.keys(raw)) {
      if (!aliases.test(key)) continue;
      const entry = raw[key];
      if (typeof entry === 'number') return { value: num(entry), playerName: null };
      if (entry && typeof entry === 'object') {
        const value = num(entry.value);
        if (!value) continue;
        return { value, playerName: entry.name ? String(entry.name) : null };
      }
    }
  }

  return null;
}

/**
 * Construit les contributions individuelles à partir d'un effectif
 * normalisé (statistiques déjà rattachées au joueur).
 */
export function buildPlayerContributions(players: {
  id: number | null;
  name: string;
  position?: string;
  goals?: number;
  assists?: number;
  xg?: number;
  xa?: number;
  minutes?: number;
  rating?: number | null;
  stats?: any;
}[]): PlayerContribution[] {
  const out: PlayerContribution[] = [];

  for (const player of players || []) {
    const stats = player.stats;
    const goals = num(player.goals) || num(readPlayerStat(stats, /^(total )?goals$|buts$/i)?.value);
    const assists =
      num(player.assists) || num(readPlayerStat(stats, /assists?$|goal assists?$/i)?.value);
    const xg = num(player.xg) || num(readPlayerStat(stats, /expected goals$|^xg$/i)?.value);
    const xa = num(player.xa) || num(readPlayerStat(stats, /expected assists?$/i)?.value);
    const minutes =
      num(player.minutes) || num(readPlayerStat(stats, /minutes played$|total minutes$/i)?.value);
    const ratingRaw = player.rating ?? readPlayerStat(stats, /player rating$|^rating$/i)?.value ?? null;
    const rating = ratingRaw !== null && Number.isFinite(Number(ratingRaw)) ? Number(ratingRaw) : null;

    const per90 = (value: number) => (minutes > 0 ? (value * 90) / minutes : value);

    // Production attendue (xG + xA) pondérée à 60 %, production observée à 40 % :
    // le mélange lisse l'aléa de la finition sans l'effacer.
    const attackIndex = 0.6 * per90(xg + xa) + 0.4 * per90(goals + assists);
    const minutesFactor = Math.min(1.4, Math.max(0.25, (minutes || 0) / 900));
    const defenceIndex = rating !== null ? rating * minutesFactor : minutesFactor;

    out.push({
      id: player.id ?? null,
      name: player.name,
      position: (player.position || '').toUpperCase(),
      goals,
      assists,
      xg,
      xa,
      minutes,
      rating,
      attackIndex: Number(attackIndex.toFixed(3)),
      defenceIndex: Number(defenceIndex.toFixed(3)),
    });
  }

  return out;
}

/**
 * Impact des absences calculé à partir des contributions individuelles.
 *
 * `replacementQuality` mesure la capacité du banc à remplacer le titulaire :
 * 1 = remplaçant de valeur équivalente, 0.35 = aucune solution crédible.
 */
export function absenceImpactFromContributions(params: {
  absences: { id?: number; name: string; type?: string; position?: string; marketValue?: number; rating?: number | null }[];
  contributions: PlayerContribution[];
  squadValues?: { id: number; value: number }[];
}): {
  attackImpact: number;
  defenceImpact: number;
  items: AbsenceImpact[];
  coverage: number;
  note: string;
} {
  const { absences, contributions } = params;
  if (!absences?.length) {
    return { attackImpact: 0, defenceImpact: 0, items: [], coverage: 0, note: 'Aucun absent.' };
  }

  const totalAttack = contributions.reduce((acc, c) => acc + Math.max(0, c.attackIndex), 0);
  const totalDefence = contributions.reduce((acc, c) => acc + Math.max(0, c.defenceIndex), 0);

  let attackImpact = 0;
  let defenceImpact = 0;
  const items: AbsenceImpact[] = [];

  for (const abs of absences) {
    const player = abs.id
      ? contributions.find(c => c.id === abs.id)
      : contributions.find(c => c.name === abs.name);

    const position = (abs.position || player?.position || '').toUpperCase();
    const isAttacker = ATTACKER.test(position) || (player?.goals ?? 0) >= 2;
    const isDefender = DEFENDER.test(position);

    // Part de la production de l'équipe assurée par le joueur absent.
    const attackShare = player && totalAttack > 0 ? Math.max(0, player.attackIndex) / totalAttack : 0;
    const defenceShare =
      player && totalDefence > 0 ? Math.max(0, player.defenceIndex) / totalDefence : 0;

    // Un titulaire qui joue peu est moins irremplaçable qu'un cadre.
    const usage = player ? Math.min(1, Math.max(0.25, player.minutes / 1200)) : 0.6;

    const contributionImpact = clamp(
      0.42 * attackShare * usage * 1.6 + 0.42 * defenceShare * usage * 1.4,
      0,
      0.18
    );

    // Repli sur l'indicateur « valeur de marché » quand la contribution
    // individuelle n'est pas disponible.
    const valueImpact = abs.marketValue
      ? clamp((abs.marketValue / 100_000_000) * 0.14, 0, 0.12)
      : 0;

    const hasContribution = Boolean(player && (player.attackIndex > 0 || player.defenceIndex > 0));
    const impact = hasContribution
      ? clamp(0.6 * contributionImpact + 0.4 * valueImpact, 0, 0.18)
      : valueImpact;

    if (isAttacker) attackImpact += impact * 1.1;
    else if (isDefender) defenceImpact += impact * 1.05;
    else {
      attackImpact += impact * 0.75;
      defenceImpact += impact * 0.75;
    }

    items.push({
      name: abs.name,
      type: abs.type || 'injury',
      role: hasContribution
        ? `Contribution mesurée : ${player!.attackIndex.toFixed(2)} offensif / ${player!.defenceIndex.toFixed(2)} défensif par 90`
        : 'Statistiques individuelles indisponibles : Pondération par la valeur de marché',
      impact: Number(impact.toFixed(4)),
      longTerm: false,
      note: hasContribution
        ? `${player!.minutes} min · ${player!.goals} buts · ${player!.assists} passes · note ${player!.rating ?? '—'}`
        : `Valeur de marché ${abs.marketValue ? Math.round(abs.marketValue / 1e6) + ' M€' : '—'}`,
      source: hasContribution ? 'contribution' : 'valeur',
    });
  }

  items.sort((a, b) => b.impact - a.impact);

  const covered = items.filter(i => i.source === 'contribution').length;
  const coverage = absences.length ? covered / absences.length : 0;

  return {
    attackImpact: Number(clamp(attackImpact, 0, 0.22).toFixed(4)),
    defenceImpact: Number(clamp(defenceImpact, 0, 0.18).toFixed(4)),
    items,
    coverage: Number(coverage.toFixed(3)),
    note:
      `${covered}/${absences.length} absent(s) évalué(s) sur contributions individuelles ` +
      `(${Math.round(coverage * 100)} %), le reste par valeur de marché.`,
  };
}

function clamp(v: number, min: number, max: number): number {
  if (!Number.isFinite(v)) return min;
  return Math.max(min, Math.min(max, v));
}
