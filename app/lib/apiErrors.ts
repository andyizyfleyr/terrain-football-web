/* ------------------------------------------------------------------ */
/* CONTRAT D'ERREUR DE L'API                                           */
/* ------------------------------------------------------------------ */
/*
 * L'API distingue les situations suivantes, pour que l'interface puisse
 * expliquer ce qui s'est passé au lieu d'afficher un échec générique :
 *
 *   - `bad_request`      : la requête est mal formée (400) ;
 *   - `unauthorized`     : jeton d'accès absent ou invalide (401) ;
 *   - `rate_limited`     : trop de requêtes (429) ;
 *   - `upstream_unavailable` : la source externe est injoignable ou
 *                              renvoie une erreur (502) ;
 *   - `upstream_timeout` : la source externe n'a pas répondu à temps (504) ;
 *   - `no_data`          : la source a répondu sans donnée exploitable
 *                          (200, mais `degraded: true`) ;
 *   - `internal_error`   : erreur inattendue (500).
 *
 * Toute réponse porte `error` (message lisible), `code` (code stable),
 * `retryable` (booléen) et `degraded` (booléen : le service répond mais
 * avec des données partielles ou des sources de secours).
 */

export type ApiErrorCode =
  | 'bad_request'
  | 'unauthorized'
  | 'not_found'
  | 'rate_limited'
  | 'upstream_unavailable'
  | 'upstream_timeout'
  | 'no_data'
  | 'internal_error';

export type ApiErrorBody = {
  error: string;
  code: ApiErrorCode;
  retryable: boolean;
  degraded?: boolean;
  /** Détail technique court, utile pour le diagnostic (jamais pour l'affichage). */
  detail?: string;
  league?: string;
  date?: string;
  matches?: unknown[];
};

/** Message lisible par l'utilisateur final pour chaque code. */
export const API_ERROR_MESSAGES: Record<ApiErrorCode, string> = {
  bad_request: 'Requête invalide.',
  unauthorized: 'Accès refusé au service d’analyse.',
  not_found: 'Ressource introuvable.',
  rate_limited: 'Trop de requêtes : réessayez dans un instant.',
  upstream_unavailable: 'Source de données momentanément indisponible.',
  upstream_timeout: 'La source de données a mis trop de temps à répondre.',
  no_data: 'Aucune donnée exploitable pour cette journée.',
  internal_error: 'Erreur interne du service d’analyse.',
};

const RETRYABLE: Record<ApiErrorCode, boolean> = {
  bad_request: false,
  unauthorized: false,
  not_found: false,
  rate_limited: true,
  upstream_unavailable: true,
  upstream_timeout: true,
  no_data: false,
  internal_error: true,
};

/** Code HTTP associé à chaque code d'erreur. */
export const API_ERROR_STATUS: Record<ApiErrorCode, number> = {
  bad_request: 400,
  unauthorized: 401,
  not_found: 404,
  rate_limited: 429,
  upstream_unavailable: 502,
  upstream_timeout: 504,
  no_data: 200,
  internal_error: 500,
};

export function buildApiError(
  code: ApiErrorCode,
  options: {
    message?: string;
    detail?: string;
    league?: string;
    date?: string;
    degraded?: boolean;
  } = {}
): ApiErrorBody {
  return {
    error: options.message || API_ERROR_MESSAGES[code],
    code,
    retryable: RETRYABLE[code],
    degraded: options.degraded ?? false,
    ...(options.detail ? { detail: options.detail } : {}),
    ...(options.league ? { league: options.league } : {}),
    ...(options.date ? { date: options.date } : {}),
  };
}

/** Classe une exception réseau en code d'erreur API. */
export function classifyNetworkError(error: unknown): {
  code: ApiErrorCode;
  detail: string;
} {
  const message = error instanceof Error ? error.message : String(error);
  if (/abort|timeout|timed out|ETIMEDOUT/i.test(message)) {
    return { code: 'upstream_timeout', detail: message };
  }
  return { code: 'upstream_unavailable', detail: message };
}

/** Message à afficher à l'utilisateur final pour une erreur réseau. */
export function userFacingError(code: ApiErrorCode, detail?: string): string {
  const base = API_ERROR_MESSAGES[code];
  if (code === 'upstream_unavailable' && detail) {
    return `${base} Détail technique : ${detail.slice(0, 200)}`;
  }
  return base;
}
