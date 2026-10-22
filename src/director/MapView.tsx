import { useMemo } from 'react';
import type { DirectorState } from '../../shared/protocol';
import type { World } from '../../shared/types';

const KIND_STROKE: Record<string, string> = { main: '#8a8883', street: '#a9a7a2', alley: '#6d6b67', path: '#b5a98f' };

export function MapView({ world, state, onNode }: { world: World; state: DirectorState | null; onNode?: (id: number) => void }) {
  const b = world.stats.bounds;
  const pad = 12;
  const vb = `${b.minX - pad} ${b.minZ - pad} ${b.maxX - b.minX + pad * 2} ${b.maxZ - b.minZ + pad * 2}`;
  const edgePaths = useMemo(
    () => world.edges.map((e) => ({ id: e.id, d: 'M' + e.points.map((p) => `${p.x.toFixed(1)},${p.z.toFixed(1)}`).join(' L'), w: e.width, kind: e.kind })),
    [world],
  );
  const planned = new Set(state?.planned ?? []);
  const cat = state?.cat;
  return (
    <svg className="map" viewBox={vb} preserveAspectRatio="xMidYMid meet">
      {edgePaths.map((e) => (
        <path key={e.id} d={e.d} stroke={KIND_STROKE[e.kind]} strokeWidth={e.w} fill="none" strokeLinecap="round" opacity={0.9} />
      ))}
      {edgePaths
        .filter((e) => planned.has(e.id))
        .map((e) => (
          <path key={'p' + e.id} d={e.d} stroke="#c3221c" strokeWidth={1.2} fill="none" strokeDasharray="3 2" />
        ))}
      {world.nodes.map((n) => (
        <g key={n.id} onClick={() => onNode?.(n.id)} style={{ cursor: onNode ? 'pointer' : 'default' }}>
          <circle cx={n.x} cy={n.z} r={n.id === world.home ? n.r : n.kind === 'plaza' ? n.r * 0.8 : 1.6} fill={n.id === world.home ? '#c3221c' : n.id === world.start ? '#1d1d1d' : n.discovery ? '#d9a33c' : n.kind === 'plaza' ? '#cfcdc7' : '#55534f'} opacity={n.kind === 'plaza' ? 0.6 : 1} />
          <text x={n.x + 2} y={n.z - 2} fontSize={3.2} fill="#55534f">
            {n.id}
          </text>
        </g>
      ))}
      {world.landmarks.map((l) => (
        <rect key={l.id} x={l.x - 1.2} y={l.z - 1.2} width={2.4} height={2.4} fill={l.meaning === 'true' ? '#c3221c' : l.meaning === 'memory' ? '#e07a2c' : '#e6a3a0'} transform={`rotate(45 ${l.x} ${l.z})`} />
      ))}
      {cat && (
        <g transform={`translate(${cat.x} ${cat.z}) rotate(${(-cat.heading * 180) / Math.PI})`}>
          <circle r={3} fill="#111" />
          <path d="M0,0 L0,6" stroke="#111" strokeWidth={1.2} />
        </g>
      )}
    </svg>
  );
}
