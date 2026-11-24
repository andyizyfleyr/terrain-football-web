/* ------------------------------------------------------------------ */
/* CLIENT HTTP CÔTÉ NAVIGATEUR                                          */
/* ------------------------------------------------------------------ */
/*
 * Utilitaire unique pour les appels API du front. Il applique le
 * contrat d'erreur défini dans `app/lib/apiErrors.ts` :
 *
 *   - une réponse HTTP en erreur n'est jamais confondue avec une
 *     réponse « vide » ;
 *   - le code d'erreur est conservé tel quel ;
 *   - `retryable` indique si un nouvel essai a des chances d'aboutir ;
 *   - `degraded` signale une réponse utilisable mais partielle.
 *
 * L'interface peut ainsi distinguer « pas de données pour cette
 * journée » (aucune action nécessaire) de « source indisponible »
 * (action utilisateur possible : réessayer).
 */

export type ClientError = {
  code: string;
  message: string;
  retryable: boolean;
  degraded: boolean;
  status: number;
};

export type ClientResult<T> = {
  ok: boolean;
  data: T | null;
  error: ClientError | null;
  degraded: boolean;
};

const DEFAULT_TIMEOUT = 30_000;

/** Lit le corps JSON sans faire échouer la requête si le corps est vide. */
async function readJson(response: Response): Promise<any> {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * Appelle une route API et renvoie un résultat typé.
 * Ne lève jamais : l'appelant décide de l'affichage.
 */
export async function apiFetch<T = any>(
  url: string,
  options: {
    method?: string;
    body?: unknown;
    timeoutMs?: number;
    signal?: AbortSignal;
  } = {}
): Promise<ClientResult<T>> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_TIMEOUT);
  const onAbort = () => controller.abort();
  options.signal?.addEventListener('abort', onAbort);

  try {
    const response = await fetch(url, {
      method: options.method || 'GET',
      headers: {
        Accept: 'application/json',
        ...(options.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
      cache: 'no-store',
      signal: controller.signal,
    });

    const payload = await readJson(response);

    if (!response.ok) {
      return {
        ok: false,
        data: null,
        degraded: false,
        error: {
          code: payload?.code || (response.status >= 500 ? 'upstream_unavailable' : 'bad_request'),
          message:
            payload?.error ||
            (response.status >= 500
              ? 'Le service de données est momentanément indisponible.'
              : `Requête refusée (HTTP ${response.status}).`),
          retryable: payload?.retryable ?? (response.status >= 500 || response.status === 429),
          degraded: false,
          status: response.status,
        },
      };
    }

    return {
      ok: true,
      data: (payload ?? null) as T | null,
      degraded: Boolean(payload?.degraded),
      error: null,
    };
  } catch (error) {
    const aborted = error instanceof Error && error.name === 'AbortError';
    return {
      ok: false,
      data: null,
      degraded: false,
      error: {
        code: aborted ? 'upstream_timeout' : 'upstream_unavailable',
        message: aborted
          ? 'La source de données a mis trop de temps à répondre.'
          : 'Source de données injoignable. Vérifiez votre connexion puis réessayez.',
        retryable: true,
        degraded: false,
        status: 0,
      },
    };
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener('abort', onAbort);
  }
}

/** Message court et actionnable pour un échec réseau. */
export function describeFailure(error: ClientError | null): string {
  if (!error) return '';
  if (error.code === 'no_data') {
    return "Aucune rencontre n'est programmée ou disponible pour cette journée : ce n'est pas une panne.";
  }
  if (!error.retryable) return error.message;
  return `${error.message}`;
}
