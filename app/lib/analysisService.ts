import { enrichEspnMatchWithFotmob } from './fotmob';

/**
 * SERVICE D'ANALYSE — couche unique de calcul
 * ------------------------------------------------------------------
 * Le moteur quantitatif (Dixon-Coles, xG, calibration marché, Monte-Carlo
 * et les marchés dérivés) existe en un seul endroit : ce module. Il est
 * utilisé par :
 *
 *   - la route front `/api/analyze` (application web) ;
 *   - la route `/api/engine/analyze` (service d'analyse exposé au backend
 *     Python, qui s'en sert pour renvoyer une analyse COMPLÈTE alors
 *     qu'il ne possède que la couche d'ingestion ESPN).
 *
 * Linterest technique : une seule implémentation du modèle, donc aucun
 * risque de divergence entre ce que voit l'utilisateur et ce que
 * renvoie l'API.
 */

/** Match brut au format ESPN (identifiants, noms, facteurrophes). */
export type BaseMatch = any;

export type EnrichMatchesOptions = {
  /** Slug du championnat (`eng.1`, `esp.1`). */
  leagueSlug: string;
  /** Date compacte (`YYYYMMDD`) ou ISO, utilisée pour les requêtes FotMob. */
  compactDate: string;
  /**
   * Récupération approfondie des équipes (effectif, valeurs, coachs,
   * classement xG complet). Réservée à la vue match : sur un balayage
   * de journée, elle serait trop coûteuse.
   */
  deepTeamFetch?: boolean;
};

export type EnrichedMatchesResult = {
  matches: any[];
  /** Vrai si au moins un match a pu être enrichi par FotMob. */
  anyFotmob: boolean;
};

/**
 * Enrichit une liste de matchs bruts : données FotMob (effectifs,
 * blessures, arbitrage, météo, surface, cotes), puis moteur quantitatif
 * v3 (modules, simulation, marchés dérivés).
 *
 * Un match dont l'enrichissement échoue est renvoyé tel quel : on ne
 * perd jamais la donnée de base.
 */
export async function enrichMatches(
  baseMatches: BaseMatch[],
  options: EnrichMatchesOptions
): Promise<EnrichedMatchesResult> {
  const { leagueSlug, compactDate, deepTeamFetch = false } = options;

  const enriched = await Promise.all(
    (baseMatches || []).map(async match => {
      try {
        return await enrichEspnMatchWithFotmob({
          espnMatch: match,
          leagueSlug,
          compactDate,
          deepTeamFetch,
        });
      } catch {
        return match;
      }
    })
  );

  return {
    matches: enriched,
    anyFotmob: enriched.some(match => Boolean(match?.fotmob)),
  };
}

/**
 * Vrai si le payload amont contient déjà une analyse complète
 * (bloc `analyst` avec marchés dérivés). Sert à court-circuiter le
 * recalcul local quand le backend sait déjà tout faire.
 */
export function hasCompleteAnalysis(matches: any[]): boolean {
  if (!Array.isArray(matches) || !matches.length) return false;
  return matches.some(
    match => Boolean(match?.analyst) && Boolean(match?.analyst?.pronostics)
  );
}

/** Sources à afficher en pied de payload. */
export function analysisSources(anyFotmob: boolean): string[] {
  return anyFotmob
    ? ['Données publiques', 'Statistiques détaillées']
    : ['Données publiques'];
}
