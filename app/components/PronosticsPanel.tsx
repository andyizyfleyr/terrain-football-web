'use client';

import { ProbBar } from './ProbBar';

/**
 * Nombre de marchés couverts par le bloc « pronostics dérivés ».
 * Compté à partir des données présentes pour rester exact même si un
 * bloc devient indisponible.
 */
export function pronosticsMarketCount(p: any): number {
  if (!p) return 0;
  let count = 0;
  if (typeof p.totalOdd === 'number' && typeof p.totalEven === 'number') count += 1;
  if (p.headerGoal) count += 1;
  if (p.teamGoals?.home) count += 1;
  if (p.teamGoals?.away) count += 1;
  if (p.halves?.first) count += 1;
  if (p.halves?.second) count += 1;
  if (p.atLeastOneHalf?.home !== undefined) count += 1;
  if (p.atLeastOneHalf?.away !== undefined) count += 1;
  if (p.atLeastOneHalf?.draw !== undefined) count += 1;
  if (p.firstTo?.one) count += 1;
  if (p.firstTo?.two) count += 1;
  if (p.firstTo?.three) count += 1;
  if (p.lastGoal) count += 1;
  if (p.halfTimeFullTime) count += 1;
  if (p.cleanSheet?.home !== undefined) count += 1;
  if (p.cleanSheet?.away !== undefined) count += 1;
  return count;
}

/**
 * PRONOSTICS DÉRIVÉS
 *
 * Tous les pronostics ci-dessous sont issus de la même simulation
 * minute par minute (10 000 itérations) que le résultat final : ils sont
 * donc cohérents entre eux et avec le score prédit. Aucune estimation
 * supplémentaire n'est fabriquée après coup.
 */
export function PronosticsPanel({
  analyst,
  hideHeading = false,
}: {
  analyst: any;
  /**
   * Masque le titre interne du bloc. Utilisé quand le panneau est
   * intégré dans un document qui fournit déjà son propre titre
   * (rapport Analyst IA, version imprimable).
   */
  hideHeading?: boolean;
}) {
  const p = analyst?.pronostics;
  if (!p) return null;

  const home = analyst.homeName || 'Équipe 1';
  const away = analyst.awayName || 'Équipe 2';
  const short = (name: string) => (name.length > 18 ? `${name.slice(0, 17)}…` : name);

  const complement = (value: any) =>
    typeof value === 'number' && Number.isFinite(value) ? 1 - value : undefined;

  const goalRows = (dist: number[]) => (
    <>
      <ProbBar label="0 but" value={dist?.[0]} />
      <ProbBar label="1 but" value={dist?.[1]} />
      <ProbBar label="2 buts" value={dist?.[2]} />
      <ProbBar label="3 buts ou plus" value={dist?.[3]} />
    </>
  );

  const firstToRows = (n: number, bucket: any) => (
    <div className="periodGroup" key={`ft${n}`}>
      <span className="periodGroupLabel">
        Premier à {n} but{n > 1 ? 's' : ''}
      </span>
      <ProbBar label={short(home)} value={bucket?.home} />
      <ProbBar label={short(away)} value={bucket?.away} color="var(--blue)" />
      <ProbBar label="Aucun but" value={bucket?.none} color="var(--gold)" />
    </div>
  );

  const htFt = p.halfTimeFullTime || {};
  const halfLabel = (key: string) =>
    key === 'H' ? short(home) : key === 'A' ? short(away) : 'Nul';
  const ftColor = (ft: string) =>
    ft === 'H' ? 'var(--green)' : ft === 'A' ? 'var(--blue)' : 'var(--gold)';

  const header = p.headerGoal || {};

  return (
    <div className="pronosticsBlock">
      {!hideHeading ? (
        <div className="subsectionHeading">
          <span className="sectionKicker">PRONOSTICS DÉRIVÉS · MOTEUR V3</span>
          <h3>Totaux, mi-temps, premier et dernier but</h3>
          <p>
            {pronosticsMarketCount(p)} marchés, tous lus dans la simulation minute par minute (10 000
            itérations) qui produit le score final. Un but compté « premier » est le même but que celui
            compté « dernier » ou celui du score à la mi-temps.
          </p>
        </div>
      ) : null}

      <div className="predictionGrid">
        {/* ---------------- Total pair / impair ---------------- */}
        <article className="predictionCard">
          <div className="cardHeading">
            <span>Σ</span>
            <div>
              <b>Total pair ou impair</b>
              <small>Nombre total de buts</small>
            </div>
          </div>
          <ProbBar label="Total impair" value={p.totalOdd} />
          <ProbBar label="Total pair" value={p.totalEven} color="var(--blue)" />
          <small className="tableNote">
            Le total impair est majoritaire quand la moyenne de buts est proche de 2,5.
          </small>
        </article>

        {/* ---------------- But de tête ---------------- */}
        <article className="predictionCard">
          <div className="cardHeading">
            <span>⚑</span>
            <div>
              <b>Un but de tête sera marqué</b>
              <small>Oui / Non</small>
            </div>
          </div>
          {header.available ? (
            <>
              <ProbBar label="Oui · au moins un but de tête" value={header.probability} />
              <ProbBar label="Non · aucun but de tête" value={complement(header.probability)} color="var(--blue)" />
              <small className="tableNote">{header.note}</small>
            </>
          ) : (
            <p className="tableNote">
              Données de tirs indisponibles (type de tir absent) : ce pronostic n’est pas estimable et
              n’est volontairement pas chiffré.
            </p>
          )}
        </article>

        {/* ---------------- Buts par équipe ---------------- */}
        <article className="predictionCard">
          <div className="cardHeading">
            <span>1</span>
            <div>
              <b>Total de buts · {short(home)}</b>
              <small>Répartition du nombre de buts</small>
            </div>
          </div>
          {goalRows(p.teamGoals?.home?.distribution)}
          <small className="tableNote">
            Moyenne attendue : {p.teamGoals?.home?.mean ?? '—'} but(s) · au moins un but :{' '}
            {Math.round((p.teamGoals?.home?.over05 || 0) * 100)}% · au moins 2 buts :{' '}
            {Math.round((p.teamGoals?.home?.over15 || 0) * 100)}%
          </small>
        </article>

        <article className="predictionCard">
          <div className="cardHeading">
            <span>2</span>
            <div>
              <b>Total de buts · {short(away)}</b>
              <small>Répartition du nombre de buts</small>
            </div>
          </div>
          {goalRows(p.teamGoals?.away?.distribution)}
          <small className="tableNote">
            Moyenne attendue : {p.teamGoals?.away?.mean ?? '—'} but(s) · au moins un but :{' '}
            {Math.round((p.teamGoals?.away?.over05 || 0) * 100)}% · au moins 2 buts :{' '}
            {Math.round((p.teamGoals?.away?.over15 || 0) * 100)}%
          </small>
        </article>

        {/* ---------------- Issue de chaque mi-temps ---------------- */}
        <article className="predictionCard fullPrediction">
          <div className="cardHeading">
            <span>½</span>
            <div>
              <b>Score dans chaque mi-temps</b>
              <small>Qui termine la période en tête</small>
            </div>
          </div>
          <div className="periodRows periodRows2">
            <div className="periodGroup">
              <span className="periodGroupLabel">1re mi-temps</span>
              <ProbBar label={`${short(home)} gagne`} value={p.halves?.first?.home} />
              <ProbBar label="Match nul" value={p.halves?.first?.draw} color="var(--gold)" />
              <ProbBar label={`${short(away)} gagne`} value={p.halves?.first?.away} color="var(--blue)" />
            </div>
            <div className="periodGroup">
              <span className="periodGroupLabel">2e mi-temps</span>
              <ProbBar label={`${short(home)} gagne`} value={p.halves?.second?.home} />
              <ProbBar label="Match nul" value={p.halves?.second?.draw} color="var(--gold)" />
              <ProbBar label={`${short(away)} gagne`} value={p.halves?.second?.away} color="var(--blue)" />
            </div>
          </div>
          <small className="tableNote">
            « 1 &gt; 2 » : l’équipe à domicile mène à la fin de la période ; « 1 = 2 » : nul de la
            période.
          </small>
        </article>

        {/* ---------------- Au moins une mi-temps ---------------- */}
        <article className="predictionCard fullPrediction">
          <div className="cardHeading">
            <span>½</span>
            <div>
              <b>Gagner au moins une mi-temps</b>
              <small>Oui / Non par équipe, nul inclus</small>
            </div>
          </div>
          <div className="periodRows periodRows3">
            <div className="periodGroup">
              <span className="periodGroupLabel">{short(home)}</span>
              <ProbBar label="Oui · gagne une mi-temps" value={p.atLeastOneHalf?.home} />
              <ProbBar label="Non · n’en gagne aucune" value={complement(p.atLeastOneHalf?.home)} color="var(--blue)" />
            </div>
            <div className="periodGroup">
              <span className="periodGroupLabel">{short(away)}</span>
              <ProbBar label="Oui · gagne une mi-temps" value={p.atLeastOneHalf?.away} />
              <ProbBar label="Non · n’en gagne aucune" value={complement(p.atLeastOneHalf?.away)} color="var(--blue)" />
            </div>
            <div className="periodGroup">
              <span className="periodGroupLabel">Nul</span>
              <ProbBar label="Oui · nul dans une mi-temps" value={p.atLeastOneHalf?.draw} color="var(--gold)" />
              <ProbBar label="Non · nul dans aucune mi-temps" value={complement(p.atLeastOneHalf?.draw)} color="var(--blue)" />
            </div>
          </div>
          <small className="tableNote">
            Les trois réponses peuvent être vraies en même temps : une équipe peut gagner une
            mi-temps et l’autre aussi.
          </small>
        </article>

        {/* ---------------- Dernier but ---------------- */}
        <article className="predictionCard">
          <div className="cardHeading">
            <span>Ω</span>
            <div>
              <b>Équipe marquant le dernier but</b>
              <small>Dernier but de la rencontre</small>
            </div>
          </div>
          <ProbBar label={short(home)} value={p.lastGoal?.home} />
          <ProbBar label={short(away)} value={p.lastGoal?.away} color="var(--blue)" />
          <ProbBar label="Pas de but" value={p.lastGoal?.none} color="var(--gold)" />
        </article>

        {/* ---------------- Clean sheet ---------------- */}
        <article className="predictionCard">
          <div className="cardHeading">
            <span>0</span>
            <div>
              <b>N’encaissera pas de but</b>
              <small>Match sans but encaissé</small>
            </div>
          </div>
          <ProbBar label={`Oui · ${short(home)}`} value={p.cleanSheet?.home} />
          <ProbBar label={`Oui · ${short(away)}`} value={p.cleanSheet?.away} color="var(--blue)" />
          <small className="tableNote">
            « {short(home)} n’encaisse pas » = l’équipe à l’extérieur ne marque pas (et l’inverse).
          </small>
        </article>

        {/* ---------------- Premier à N buts ---------------- */}
        <article className="predictionCard fullPrediction">
          <div className="cardHeading">
            <span>1er</span>
            <div>
              <b>Premier à obtenir N buts</b>
              <small>Équipe qui atteint le N-ième but en premier</small>
            </div>
          </div>
          <div className="periodRows periodRows3">
            {firstToRows(1, p.firstTo?.one)}
            {firstToRows(2, p.firstTo?.two)}
            {firstToRows(3, p.firstTo?.three)}
          </div>
          <small className="tableNote">
            « Aucun but » = personne n’atteint N buts (match trop peu prolifique).
          </small>
        </article>

        {/* ---------------- Mi-temps + fin de match ---------------- */}
        <article className="predictionCard fullPrediction">
          <div className="cardHeading">
            <span>MT</span>
            <div>
              <b>Mi-temps + fin de match</b>
              <small>9 combinaisons possibles</small>
            </div>
          </div>
          <div className="periodRows periodRows3">
            {(['H', 'D', 'A'] as const).map(ht => (
              <div className="periodGroup" key={ht}>
                <span className="periodGroupLabel">Mi-temps : {halfLabel(ht)}</span>
                {(['H', 'D', 'A'] as const).map(ft => (
                  <ProbBar
                    key={`${ht}${ft}`}
                    label={`Fin : ${halfLabel(ft)}`}
                    value={htFt[`${ht}/${ft}`]}
                    color={ftColor(ft)}
                  />
                ))}
              </div>
            ))}
          </div>
          <small className="tableNote">
            Lecture : colonne = résultat à la mi-temps, ligne = résultat final. Les 9 combinaisons
            totalisent 100 %.
          </small>
        </article>
      </div>

      {p.note ? <small className="tableNote pronosticsNote">{p.note}</small> : null}
    </div>
  );
}

export default PronosticsPanel;
