import { useEffect, useRef, useState } from 'react';
import { useSceneStore } from '../store/sceneStore';

interface Motion {
  x: number;
  y: number;
  tx: number;
  ty: number;
  active: boolean;
}

/**
 * Other people's cursors and selection outlines.
 *
 * Cursor updates arrive at ~25 Hz (throttled by the sender). Interpolating
 * towards the newest target on every animation frame makes them look smooth
 * without inventing a higher network rate — the last few pixels of each hop
 * are caught up locally.
 *
 * Selection outlines are drawn from the same presence message, so they are
 * always ephemeral: no document state, no operation, no persistence.
 */
export function PeerLayer({ zoom }: { zoom: number }) {
  const peers = useSceneStore((state) => state.peers);
  const selfSessionId = useSceneStore((state) => state.selfSessionId);
  const scene = useSceneStore((state) => state.scene);

  const motion = useRef(new Map<string, Motion>());
  const frame = useRef<number | null>(null);
  const [display, setDisplay] = useState<Map<string, Motion>>(() => new Map());

  useEffect(() => {
    const entries = motion.current;
    const seen = new Set<string>();

    for (const peer of peers) {
      if (peer.sessionId === selfSessionId) continue;
      seen.add(peer.sessionId);

      if (!peer.cursor) {
        const existing = entries.get(peer.sessionId);
        if (existing) existing.active = false;
        continue;
      }

      const existing = entries.get(peer.sessionId);
      if (existing) {
        existing.tx = peer.cursor.x;
        existing.ty = peer.cursor.y;
        // A peer that comes back after a cursor-less update snaps to its new
        // position instead of sliding across the canvas from the old one.
        if (!existing.active) {
          existing.x = peer.cursor.x;
          existing.y = peer.cursor.y;
        }
        existing.active = true;
      } else {
        entries.set(peer.sessionId, {
          x: peer.cursor.x,
          y: peer.cursor.y,
          tx: peer.cursor.x,
          ty: peer.cursor.y,
          active: true,
        });
      }
    }

    for (const sessionId of [...entries.keys()]) {
      if (!seen.has(sessionId)) entries.delete(sessionId);
    }

    const tick = () => {
      let moving = false;
      for (const entry of entries.values()) {
        if (!entry.active) continue;
        const dx = entry.tx - entry.x;
        const dy = entry.ty - entry.y;
        if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) {
          entry.x = entry.tx;
          entry.y = entry.ty;
          continue;
        }
        entry.x += dx * 0.35;
        entry.y += dy * 0.35;
        moving = true;
      }
      setDisplay(new Map(entries));
      frame.current = moving ? requestAnimationFrame(tick) : null;
    };

    if (frame.current === null) frame.current = requestAnimationFrame(tick);

    return () => {
      if (frame.current !== null) {
        cancelAnimationFrame(frame.current);
        frame.current = null;
      }
    };
  }, [peers, selfSessionId]);

  const others = peers.filter((peer) => peer.sessionId !== selfSessionId);

  return (
    <g className="peer-layer" pointerEvents="none">
      {others.map((peer) => {
        const selected = peer.selection.flatMap((id) => {
          const object = scene.objects.get(id);
          return object ? [object] : [];
        });
        const cursor = display.get(peer.sessionId);

        return (
          <g key={peer.sessionId}>
            {selected.map((object) => (
              <rect
                key={object.id}
                x={object.x}
                y={object.y}
                width={object.w}
                height={object.h}
                transform={`rotate(${object.rotation} ${object.x + object.w / 2} ${
                  object.y + object.h / 2
                })`}
                fill="none"
                stroke={peer.color}
                strokeWidth={1.5 / zoom}
                strokeDasharray={`${6 / zoom} ${4 / zoom}`}
                opacity={0.9}
              />
            ))}

            {cursor?.active ? (
              <g transform={`translate(${cursor.x} ${cursor.y}) scale(${1 / zoom})`}>
                <path
                  d="M0 0 L0 15 L4 11.5 L7.3 18 L10 16.6 L6.8 10.4 L12 10 Z"
                  fill={peer.color}
                  stroke="#fff"
                  strokeWidth={1.2}
                  strokeLinejoin="round"
                />
                <g transform="translate(13 10)">
                  <rect
                    width={Math.max(42, peer.displayName.length * 6.6 + 12)}
                    height={18}
                    rx={4}
                    fill={peer.color}
                  />
                  <text
                    x={6}
                    y={12.5}
                    fill="#fff"
                    fontSize={11}
                    fontFamily="system-ui, sans-serif"
                    fontWeight={600}
                  >
                    {peer.displayName}
                  </text>
                </g>
              </g>
            ) : null}
          </g>
        );
      })}
    </g>
  );
}
