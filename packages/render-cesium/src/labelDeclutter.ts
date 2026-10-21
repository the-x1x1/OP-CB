/**
 * Priority-based label decluttering in screen space. Pure: the renderer projects
 * label anchors to window coordinates each pass and applies the returned
 * visibility set. Higher `priority` wins a collision; ties break on id so the
 * result is deterministic frame to frame.
 */
export interface LabelCandidate {
  id: string;
  /** Anchor in window px. */
  x: number;
  y: number;
  width: number;
  height: number;
  priority: number;
  /** Where the box sits relative to the anchor (default: centred horizontally, hanging below). */
  anchor?: 'center' | 'below' | 'right';
}

export interface DeclutterOptions {
  /** Extra px around every box. */
  padding?: number;
  /** Spatial hash cell size in px. */
  cellPx?: number;
  /**
   * Boxes already taken by labels of another pass, which this pass's labels must not cover
   * (the map's place names give way to its objects' labels).
   */
  occupied?: readonly LabelBox[];
  /** When given, the boxes of the labels this pass shows are appended to it. */
  placed?: LabelBox[];
}

export interface LabelBox {
  id: string;
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export function labelBox(c: LabelCandidate, padding = 0): LabelBox {
  const anchor = c.anchor ?? 'below';
  let left: number, top: number;
  if (anchor === 'center') {
    left = c.x - c.width / 2;
    top = c.y - c.height / 2;
  } else if (anchor === 'right') {
    left = c.x;
    top = c.y - c.height / 2;
  } else {
    left = c.x - c.width / 2;
    top = c.y;
  }
  return {
    id: c.id,
    left: left - padding,
    top: top - padding,
    right: left + c.width + padding,
    bottom: top + c.height + padding,
  };
}

/** Estimated label extent for a proportional UI font (avg glyph ≈ 0.58 em, line ≈ 1.3 em). */
export function estimateLabelSize(text: string, fontPx: number): { width: number; height: number } {
  return { width: Math.max(1, Math.ceil(text.length * fontPx * 0.58)), height: Math.ceil(fontPx * 1.3) };
}

function overlaps(a: LabelBox, b: LabelBox): boolean {
  return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
}

/** Returns the ids that may be shown. Off-viewport candidates are hidden. */
export function declutterLabels(
  candidates: LabelCandidate[],
  viewport: { width: number; height: number },
  options: DeclutterOptions = {},
): Set<string> {
  const padding = options.padding ?? 2;
  const cell = Math.max(8, options.cellPx ?? 64);
  const ordered = [...candidates].sort((a, b) => b.priority - a.priority || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const grid = new Map<string, LabelBox[]>();
  const visible = new Set<string>();
  const occupy = (box: LabelBox) => {
    const c0 = Math.floor(box.left / cell),
      c1 = Math.floor(box.right / cell),
      r0 = Math.floor(box.top / cell),
      r1 = Math.floor(box.bottom / cell);
    for (let r = r0; r <= r1; r++)
      for (let col = c0; col <= c1; col++) {
        const key = `${r}:${col}`;
        let bucket = grid.get(key);
        if (!bucket) {
          bucket = [];
          grid.set(key, bucket);
        }
        bucket.push(box);
      }
  };
  for (const box of options.occupied ?? []) {
    // Off-screen boxes cannot collide, and a huge one must not make a huge loop.
    if (box.right < 0 || box.bottom < 0 || box.left > viewport.width || box.top > viewport.height) continue;
    occupy({
      ...box,
      left: Math.max(-cell, box.left),
      top: Math.max(-cell, box.top),
      right: Math.min(viewport.width + cell, box.right),
      bottom: Math.min(viewport.height + cell, box.bottom),
    });
  }
  for (const c of ordered) {
    if (!Number.isFinite(c.x) || !Number.isFinite(c.y)) continue;
    const box = labelBox(c, padding);
    if (box.right < 0 || box.bottom < 0 || box.left > viewport.width || box.top > viewport.height) continue;
    const c0 = Math.floor(box.left / cell),
      c1 = Math.floor(box.right / cell),
      r0 = Math.floor(box.top / cell),
      r1 = Math.floor(box.bottom / cell);
    let blocked = false;
    outer: for (let r = r0; r <= r1; r++)
      for (let col = c0; col <= c1; col++) {
        const bucket = grid.get(`${r}:${col}`);
        if (!bucket) continue;
        for (const other of bucket)
          if (overlaps(box, other)) {
            blocked = true;
            break outer;
          }
      }
    if (blocked) continue;
    visible.add(c.id);
    occupy(box);
    options.placed?.push(box);
  }
  return visible;
}
