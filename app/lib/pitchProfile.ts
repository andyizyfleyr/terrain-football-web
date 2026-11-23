/* ------------------------------------------------------------------ */
/* PROFIL DE TERRAIN (surface, capacité, stade)                        */
/* ------------------------------------------------------------------ */
/*
 * La surface de jeu influence le nombre de buts de manière documentée :
 * sur gazon synthétique, le rebond est plus prévisible, les ballons longuement
 * lobés sont moins contrôlés et les erreurs plus fréquentes — le total de
 * buts tend à augmenter de quelques pour cent.
 *
 * L'effet retenu est volontairement conservateur (+3 % au maximum) car il
 * s'applique à une minorité des rencontres du championnat.
 */

export type PitchProfile = {
  name: string | null;
  city: string | null;
  capacity: number | null;
  surface: string;
  isArtificial: boolean;
  /** Multiplicateur appliqué au total de buts. */
  effect: number;
  note: string;
};

const ARTIFICIAL = /artificial|synthet|gazon synth/i;

export function buildPitchProfile(stadium: any): PitchProfile {
  const name = stadium?.name ? String(stadium.name) : null;
  const city = stadium?.city ? String(stadium.city) : null;
  const capacity = typeof stadium?.capacity === 'number' ? stadium.capacity : null;
  const surface = stadium?.surface ? String(stadium.surface) : 'inconnue';
  const isArtificial = ARTIFICIAL.test(surface);

  const effect = isArtificial ? 1.03 : 1;

  const notes: string[] = [];
  notes.push(
    isArtificial
      ? `Surface synthétique (${surface}) : rebond plus prévisible, total de buts ajusté ×${effect.toFixed(2)}.`
      : `Surface ${surface} : aucun effet particulier appliqué.`
  );
  if (capacity) notes.push(`Capacité ${capacity.toLocaleString('fr-FR')} places`);

  return {
    name,
    city,
    capacity,
    surface,
    isArtificial,
    effect: Number(effect.toFixed(4)),
    note: notes.join(' · '),
  };
}
