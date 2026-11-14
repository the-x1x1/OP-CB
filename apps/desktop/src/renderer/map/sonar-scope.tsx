import type { SonarPicture } from './sonar.js';
import { formatDistance } from './measure.js';

const SIZE = 148;
const C = SIZE / 2;
const R = C - 6;

/**
 * The contact sonar's scope (sonar.ts): north up, the range rings' four rings, a sweep going
 * round (a CSS animation, so it costs the page nothing per frame; none with reduced motion),
 * and a blip for each contact — dimmer when it has not been seen lately. Under it, the outer
 * ring's range and what the scope is centred on. Part of the HUD, so hidden from assistive
 * technology with it, and tinted by the visual style the same way.
 */
export function SonarScope({ picture }: { picture: SonarPicture }) {
  const rings = Array.from({ length: picture.rings }, (_, i) => (R * (i + 1)) / picture.rings);
  return (
    <div className="wv-sonar">
      <div className="wv-sonar__north">N</div>
      <svg width={SIZE} height={SIZE} viewBox={`0 0 ${SIZE} ${SIZE}`}>
        <g className="wv-sonar__grid">
          {rings.map((r) => (
            <circle key={r} cx={C} cy={C} r={r} />
          ))}
          <line x1={C} y1={C - R} x2={C} y2={C + R} />
          <line x1={C - R} y1={C} x2={C + R} y2={C} />
        </g>
        <g className="wv-sonar__sweep" style={{ transformOrigin: `${C}px ${C}px` }}>
          <path
            d={`M ${C} ${C} L ${C} ${C - R} A ${R} ${R} 0 0 0 ${C - R * Math.sin(Math.PI / 6)} ${C - R * Math.cos(Math.PI / 6)} Z`}
          />
          <line x1={C} y1={C} x2={C} y2={C - R} />
        </g>
        {picture.contacts.map((c) => {
          const a = (c.bearingDeg * Math.PI) / 180;
          return (
            <circle
              key={c.id}
              className={c.live ? 'wv-sonar__blip' : 'wv-sonar__blip wv-sonar__blip--stale'}
              cx={C + R * c.range * Math.sin(a)}
              cy={C - R * c.range * Math.cos(a)}
              r={2.4}
            />
          );
        })}
        <path className="wv-sonar__centre" d={`M ${C - 4} ${C} H ${C + 4} M ${C} ${C - 4} V ${C + 4}`} />
      </svg>
      <div className="wv-sonar__caption">
        R {formatDistance(picture.rangeM).toUpperCase()} · {picture.onSelection ? 'SEL' : 'VIEW'} ·{' '}
        {picture.contacts.length}
      </div>
    </div>
  );
}
