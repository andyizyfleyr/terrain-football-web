'use client';

import { useEffect, useState } from 'react';

type MarketStatus = {
  id: string;
  label: string;
  status: 'validé' | 'non validé' | 'à surveiller';
  samples: number | null;
  averageGap: number | null;
  note: string;
};

type ValidationPayload = {
  generatedAt: string | null;
  summary: { total: number; validated: number; toWatch: number; notValidated: number };
  markets: MarketStatus[];
};

const CLASS_BY_STATUS: Record<string, string> = {
  'validé': 'marketStatusValidé',
  'à surveiller': 'marketStatusSurveiller',
  'non validé': 'marketStatusNonValidé',
};

/**
 * Statut de validation des marchés dérivés.
 *
 * La liste des marchés annoncés par le moteur est longue : l'utilisateur
 * doit pouvoir distinguer, marché par marché, ce qui a été confronté à
 * une cote réelle et ce qui n'est qu'une estimation du modèle.
 */
export function DerivedMarketsStatus() {
  const [payload, setPayload] = useState<ValidationPayload | null>(null);
  const [failure, setFailure] = useState('');

  useEffect(() => {
    let active = true;
    fetch('/api/markets/validation')
      .then(response => response.json())
      .then(data => {
        if (!active) return;
        if (data?.error) {
          setFailure(
            data.code === 'not_found'
              ? "Aucun rapport de validation n'est disponible : aucun de ces marchés ne peut être présenté comme validé."
              : String(data.error)
          );
          return;
        }
        setPayload(data);
      })
      .catch(() => active && setFailure('Statut de validation indisponible.'));
    return () => {
      active = false;
    };
  }, []);

  if (failure) {
    return (
      <section className="analystBlock">
        <div className="subsectionHeading">
          <span className="sectionKicker">MARCHÉS DÉRIVÉS</span>
          <h3>Statut de validation indisponible</h3>
        </div>
        <p className="dataWarning" style={{ margin: '0 19px 14px' }}>{failure}</p>
      </section>
    );
  }

  if (!payload) return null;

  return (
    <section className="analystBlock">
      <div className="subsectionHeading">
        <span className="sectionKicker">MARCHÉS DÉRIVÉS · STATUT DE VALIDATION</span>
        <h3>
          {payload.summary.validated} validé(s), {payload.summary.toWatch} à surveiller,{' '}
          {payload.summary.notValidated} non validé(s)
        </h3>
        <p>
          Chaque marché dérivé annoncé par le moteur est listé ici avec son statut. « Non validé » signifie
          qu&apos;aucune cote de marché n&apos;a pu lui être confrontée : la probabilité affichée est une
          estimation du modèle, pas une mesure. Rien n&apos;est présenté comme validé sans confrontation
          effective à des cotes réelles.
        </p>
      </div>
      <div className="marketStatusGrid">
        {payload.markets.map(market => (
          <div className="marketStatusCard" key={market.id}>
            <b>{market.label}</b>
            <em className={CLASS_BY_STATUS[market.status] || 'marketStatusNonValidé'}>
              {market.status}
              {market.samples ? ` · n = ${market.samples.toLocaleString('fr-FR')}` : ''}
              {market.averageGap !== null ? ` · écart ${(market.averageGap * 100).toFixed(1)} pts` : ''}
            </em>
          </div>
        ))}
      </div>
    </section>
  );
}
