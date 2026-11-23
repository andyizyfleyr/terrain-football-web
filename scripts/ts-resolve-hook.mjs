/**
 * Hook de résolution Node pour exécuter les scripts TypeScript du dépôt :
 * les imports internes sans extension (`./devig`) sont résolus en `.ts`.
 */
export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith('.') && !/\.[cm]?[jt]sx?$/.test(specifier)) {
    try {
      return await nextResolve(`${specifier}.ts`, context);
    } catch {
      /* on continue avec la résolution standard */
    }
  }
  return nextResolve(specifier, context);
}
