/**
 * Test du récupérateur de cotes : priorité des points de vente, fusion des
 * marchés partiels, journal des opérateurs réellement servis.
 *
 * Le réseau est simulé (aucun appel externe) : seules les routes de l'API
 * de marché sont interceptées.
 *
 * Exécution : npm run check:market:fetch
 */
import { fetchFotmobMarketOdds } from '../app/lib/fotmob.ts';

let failures = 0;
function check(label: string, condition: boolean, detail?: string) {
  if (condition) {
    console.log(`  ok   ${label}`);
  } else {
    failures += 1;
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

type Stub = { url: string; body: any };

const jsonResponse = (body: any) => ({
  ok: true,
  headers: { get: (name: string) => (name.toLowerCase() === 'content-type' ? 'application/json' : null) },
  json: async () => body,
});

const marketPayload = (persistentKey: string, providerId: string, odds: Record<string, any>) => ({
  persistentKey,
  providerId,
  ongoing: false,
  odds: {
    matchfactMarkets: [
      {
        header: 'Match Result',
        headerTranslationKey: 'who_will_win',
        selections: [
          { name: '1', oddsDecimal: String(odds.home) },
          { name: 'x', oddsDecimal: String(odds.draw) },
          { name: '2', oddsDecimal: String(odds.away) },
        ],
        fotMobMarketTypeId: { translationKey: 'who_will_win' },
      },
    ],
    oddsTabMarkets: [
      {
        category: 'Bets',
        markets: [
          {
            header: 'Both Teams To Score',
            headerTranslationKey: 'both_score',
            selections: [
              { name: 'Yes', oddsDecimal: String(odds.bttsYes) },
              { name: 'No', oddsDecimal: String(odds.bttsNo) },
            ],
            fotMobMarketTypeId: { translationKey: 'both_score' },
          },
          {
            header: 'Over/Under 2.5',
            headerTranslationKey: 'odds_goals_over_under',
            selections: [
              { name: 'Over', oddsDecimal: String(odds.over25) },
              { name: 'Under', oddsDecimal: String(odds.under25) },
            ],
            fotMobMarketTypeId: { translationKey: 'odds_goals_over_under' },
          },
        ],
      },
    ],
  },
});

let stubs: Stub[] = [];
const calls: string[] = [];

(globalThis as any).fetch = async (url: string) => {
  calls.push(String(url));
  const match = stubs.find(s => String(url).includes(s.url));
  if (!match) return { ok: false, status: 404, headers: { get: () => 'text/html' }, json: async () => ({}) };
  return jsonResponse(match.body);
};

async function main() {
console.log('1. Point de vente prioritaire complet (une seule requête)');
{
  stubs = [
    {
      url: 'bettingProvider=1xBet_Spain',
      body: marketPayload('1xBet_Spain', '449', {
        home: 2.02,
        draw: 4.09,
        away: 3.62,
        bttsYes: 1.48,
        bttsNo: 2.5,
        over25: 1.55,
        under25: 2.45,
      }),
    },
  ];
  calls.length = 0;
  const result = await fetchFotmobMarketOdds({ fotmobMatchId: 9000001, homeName: 'Manchester United', awayName: 'Brentford' });
  check('marché disponible', result.available);
  check('une seule requête', calls.length === 1, `${calls.length} requêtes`);
  check('opérateur affiché = 1xBet Espagne', result.provider?.label === '1xBet Espagne', result.provider?.label);
  check('opérateur demandé honoré', result.provider?.honored === true);
  check('cotes 1X2', result.odds?.home === 2.02 && result.odds?.draw === 4.09 && result.odds?.away === 3.62);
  check('cotes BTTS', result.odds?.bttsYes === 1.48 && result.odds?.bttsNo === 2.5);
  check('cotes total 2,5', result.odds?.over25 === 1.55 && result.odds?.under25 === 2.45);
  check('probabilités dé-vigguées', (result.parsed?.probabilities.home ?? 0) > 0 && (result.parsed?.probabilities.home ?? 0) < 1);
  check('horodatage d\'extraction', typeof result.fetchedAt === 'string' && result.fetchedAt.length > 0);
  check('journal des sources', result.sources.length === 1 && result.sources[0].used === true);
}

console.log('2. Fusion avec les points de vente de repli');
{
  stubs = [
    {
      // Opérateur prioritaire : 1X2 seul (pas de BTTS ni de total).
      url: 'bettingProvider=1xBet_Spain',
      body: {
        persistentKey: '1xBet_Spain',
        providerId: '449',
        odds: {
          matchfactMarkets: [
            {
              headerTranslationKey: 'who_will_win',
              selections: [
                { name: '1', oddsDecimal: '1.80' },
                { name: 'x', oddsDecimal: '4.00' },
                { name: '2', oddsDecimal: '3.90' },
              ],
            },
          ],
        },
      },
    },
    {
      url: 'ccode3=ESP',
      body: marketPayload('Bet365_Spain', '16', {
        home: 1.91,
        draw: 3.7,
        away: 3.6,
        bttsYes: 1.53,
        bttsNo: 2.38,
        over25: 1.6,
        under25: 2.3,
      }),
    },
  ];
  calls.length = 0;
  const result = await fetchFotmobMarketOdds({ fotmobMatchId: 9000002, homeName: 'Liverpool', awayName: 'Manchester United' });
  check('1X2 prioritaire conservé', result.odds?.home === 1.8 && result.odds?.draw === 4 && result.odds?.away === 3.9);
  check('BTTS complété par le repli', result.odds?.bttsYes === 1.53);
  check('total 2,5 complété par le repli', result.odds?.over25 === 1.6);
  check('opérateur affiché = celui du 1X2', result.provider?.label === '1xBet Espagne', result.provider?.label);
  check('opérateur demandé honoré', result.provider?.honored === true);
  check('repli interrogé', result.sources.length >= 2);
  check('un seul point de vente marqué utilisé', result.sources.filter(s => s.used).length === 1);
  check('le repli n\'est pas marqué utilisé', result.sources.filter(s => s.used)[0].country === 'ESP');
}

console.log('3. Opérateur demandé non honoré (alias ignoré par la source)');
{
  stubs = [
    {
      url: 'bettingProvider=1xBet_Spain',
      body: {
        persistentKey: 'Bwin_France',
        providerId: '77',
        odds: {
          matchfactMarkets: [
            {
              headerTranslationKey: 'who_will_win',
              selections: [
                { name: '1', oddsDecimal: '2.35' },
                { name: 'x', oddsDecimal: '3.3' },
                { name: '2', oddsDecimal: '3.15' },
              ],
            },
          ],
        },
      },
    },
  ];
  calls.length = 0;
  const result = await fetchFotmobMarketOdds({ fotmobMatchId: 9000003, homeName: 'Manchester United', awayName: 'Brentford' });
  check('marché disponible malgré la redirection', result.available);
  check('opérateur réellement servi affiché', result.provider?.key === 'Bwin_France', result.provider?.key);
  check('alias signalé comme non honoré', result.provider?.honored === false);
  check('opérateur demandé mémorisé', result.provider?.requested === '1xBet_Spain');
}

console.log('4. Aucun marché disponible');
{
  stubs = [];
  calls.length = 0;
  const result = await fetchFotmobMarketOdds({ fotmobMatchId: 9000004, homeName: 'Manchester United', awayName: 'Brentford' });
  check('marché indisponible', !result.available);
  check('cotes nulles', result.odds === null);
  check('opérateur nul', result.provider === null);
}

console.log('');
if (failures) {
  console.log(`${failures} test(s) en échec.`);
  process.exit(1);
}
console.log('Le récupérateur de cotes se comporte comme attendu.');
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
