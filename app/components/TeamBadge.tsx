'use client';

import { useEffect, useState } from 'react';
import { Team } from '../lib/terrain';

export function TeamBadge({ team, size = 36 }: { team?: Team; size?: number }) {
  const [broken, setBroken] = useState(false);
  useEffect(() => setBroken(false), [team?.id, team?.logo]);
  const logo = team?.logo || (team?.id ? `https://a.espncdn.com/i/teamlogos/soccer/500/${team.id}.png` : '');
  return (
    <span className="teamBadge" style={{ width: size, height: size }}>
      {logo && !broken ? (
        <img src={logo} alt={`${team?.name || 'Équipe'} — logo`} loading="lazy" onError={() => setBroken(true)} />
      ) : (
        <span>{(team?.short || team?.name || '?').slice(0, 3)}</span>
      )}
    </span>
  );
}
