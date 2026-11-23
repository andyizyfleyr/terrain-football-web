/**
 * Contrôle déterministe de la dé-vig (Shin / Power).
 *
 * Les valeurs attendues sont figées dans `app/lib/devigReference.ts` et
 * proviennent de la bibliothèque de référence `penaltyblog` (Shin 1992/1993)
 * appliquée à des cotes bookmaker réelles.
 *
 * Exécution : npm run check:devig
 */
import { DEVIG_REFERENCE_CASES } from '../app/lib/devigReference.ts';
import { devigPower, devigShin, devigThreeWayDecimal, devigTwoWayDecimal } from '../app/lib/devig.ts';

let failures = 0;
function check(label: string, condition: boolean, detail?: string) {
  if (condition) {
    console.log(`  ok   ${label}`);
  } else {
    failures += 1;
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

const TOL = 5e-6;

console.log('1. Concordance avec la dé-vig de référence');
for (const testCase of DEVIG_REFERENCE_CASES) {
  const implied = testCase.odds.map(o => 1 / o);

  const shin = devigShin(implied);
  if (testCase.shin) {
    const ok = !!shin && Math.max(...testCase.shin.map((p, i) => Math.abs(p - shin.probs[i]))) <= TOL;
    const zOk = !!shin && typeof testCase.z === 'number' && Math.abs((shin.z ?? 0) - testCase.z) <= 1e-6;
    check(
      `${testCase.name} — Shin`,
      ok && zOk,
      `max|Δ|=${shin ? Math.max(...testCase.shin.map((p, i) => Math.abs(p - shin.probs[i]))).toExponential(2) : 'n/a'} z=${
        shin?.z
      }`
    );
  }

  if (testCase.power) {
    const power = devigPower(implied);
    const diff = Math.max(...testCase.power.map((p, i) => Math.abs(p - power.probs[i])));
    check(`${testCase.name} — Power`, diff <= TOL, `max|Δ|=${diff.toExponential(2)}`);
  }

  // Invariants structurels, pour chaque vecteur à 3 issues.
  if (testCase.odds.length === 3) {
    const threeWay = devigThreeWayDecimal({
      home: testCase.odds[0],
      draw: testCase.odds[1],
      away: testCase.odds[2],
    });
    const sum = threeWay ? threeWay.probs.home + threeWay.probs.draw + threeWay.probs.away : 0;
    check(
      `${testCase.name} — somme des probabilités = 1 et surcharge > 1`,
      !!threeWay && Math.abs(sum - 1) <= 1e-9 && threeWay.overround > 1 && threeWay.method === 'Shin',
      `somme=${sum.toFixed(12)} surcharge=${threeWay?.overround}`
    );
  }
}

console.log('2. Correction du biais favorite-longshot');
{
  // Marché favourite nette : la probabilité juste de la favorite doit rester
  // au-dessus de la simple normalisation proportionnelle (Shin corrige le
  // biais « favorite-longshot » du bookmaker).
  const odds = [1.10, 8.0, 15.0];
  const implied = odds.map(o => 1 / o);
  const proportional = implied.map(q => q / implied.reduce((a, b) => a + b, 0));
  const shin = devigShin(implied);
  check(
    'la favorite est remontée par rapport au proportionnel',
    !!shin && shin.probs[0] > proportional[0],
    `shin=${shin?.probs[0].toFixed(6)} proportionnel=${proportional[0].toFixed(6)}`
  );
  check(
    'le outsider est rétrogradé par rapport au proportionnel',
    !!shin && shin.probs[2] < proportional[2],
    `shin=${shin?.probs[2].toFixed(6)} proportionnel=${proportional[2].toFixed(6)}`
  );
}

console.log('3. Cas limites');
{
  // Marché sans marge : Shin doit renvoyer la normalisation simple.
  const shin = devigShin([0.5, 0.5]);
  check('marché sans marge -> normalisation simple', !!shin && Math.abs(shin.probs[0] - 0.5) < 1e-12);

  // Cotes invalides : aucune erreur, repli sur Power.
  const invalid = devigThreeWayDecimal({ home: 1, draw: 4, away: 5 });
  check('cote <= 1 refusée', invalid === null);
  const missing = devigThreeWayDecimal({ home: 2, draw: null, away: 4 });
  check('cote manquante refusée', missing === null);

  // Marché binaire : retrait de marge multiplicatif exact.
  const twoWay = devigTwoWayDecimal(1.78, 2.21);
  const expected = 1 / 1.78 / (1 / 1.78 + 1 / 2.21);
  check('marché binaire exact', !!twoWay && Math.abs(twoWay.prob - expected) < 1e-12);
  check('surcharge binaire > 1', !!twoWay && twoWay.overround > 1);

  // Très forte surcharge : la recherche de racine doit rester stable.
  const extreme = devigThreeWayDecimal({ home: 1.01, draw: 1.01, away: 30 });
  const extremeSum = extreme ? extreme.probs.home + extreme.probs.draw + extreme.probs.away : 0;
  check('marge extrême : somme = 1', !!extreme && Math.abs(extremeSum - 1) <= 1e-9, `somme=${extremeSum}`);
}

console.log('4. Déterminisme');
{
  const implied = [1 / 1.58, 1 / 4.58, 1 / 6.16];
  const a = devigShin(implied);
  const b = devigShin(implied);
  check(
    'deux appels successifs donnent le même résultat',
    !!a && !!b && a.probs.every((p, i) => p === b.probs[i])
  );
}

console.log('');
if (failures) {
  console.log(`${failures} test(s) en échec.`);
  process.exit(1);
}
console.log('Tous les contrôles de dé-vig sont passés.');
