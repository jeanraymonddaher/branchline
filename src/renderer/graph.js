// Commit graph layout: assigns each commit a lane (column) and records the
// line segments that cross each row, so rows can be drawn independently.

export const LANE_COLORS = ['#15a0bf', '#0669f7', '#8e00c2', '#c517b6', '#d90171', '#cd0101', '#f25d2e', '#f2ca33', '#7bd938', '#2ece9d'];
export const laneColor = (i) => LANE_COLORS[i % LANE_COLORS.length];

export const ROW = 28;
export let LANE = 22;
export let X0 = 34;
export let NODE_R = 11;
// Compact mode packs lanes closer together and shrinks the nodes.
export function setCompact(on) {
  LANE = on ? 14 : 22;
  X0 = on ? 22 : 34;
  NODE_R = on ? 8 : 11;
}
const R = 8;
export const laneX = (col) => X0 + col * LANE;

// commits must be ordered children before parents (git log --date-order).
export function layout(commits) {
  const lanes = []; // lanes[i] = { sha: next commit expected in this lane, dashed }
  const rows = [];
  let maxCol = 0;
  const free = () => {
    const i = lanes.indexOf(null);
    return i < 0 ? lanes.length : i;
  };
  for (const c of commits) {
    const segs = [];
    let col = -1;
    for (let i = 0; i < lanes.length; i++) {
      if (lanes[i] && lanes[i].sha === c.sha && col < 0) col = i;
    }
    if (col < 0) col = free();
    for (let i = 0; i < lanes.length; i++) {
      const l = lanes[i];
      if (!l) continue;
      if (l.sha !== c.sha) segs.push({ t: 'v', c: i, d: l.dashed });
      else {
        segs.push({ t: i === col ? 'top' : 'in', c: i, d: l.dashed });
        lanes[i] = null;
      }
    }
    lanes[col] = null;
    c.parents.forEach((p, k) => {
      if (k === 0) {
        lanes[col] = { sha: p, dashed: !!c.wip };
        segs.push({ t: 'bot', c: col, d: !!c.wip });
      } else {
        let j = lanes.findIndex((l) => l && l.sha === p);
        if (j < 0) {
          j = free();
          lanes[j] = { sha: p, dashed: false };
        }
        segs.push({ t: 'out', c: j });
      }
    });
    while (lanes.length && lanes[lanes.length - 1] == null) lanes.pop();
    for (const s of segs) if (s.c > maxCol) maxCol = s.c;
    if (col > maxCol) maxCol = col;
    rows.push({ commit: c, col, segs });
  }
  return { rows, maxCol };
}

export function rowSvg(row, width) {
  const cx = laneX(row.col);
  const cy = ROW / 2;
  let out = '';
  for (const s of row.segs) {
    const x = laneX(s.c);
    let d;
    if (s.t === 'v') d = `M${x} 0V${ROW}`;
    else if (s.t === 'top') d = `M${x} 0V${cy}`;
    else if (s.t === 'bot') d = `M${x} ${cy}V${ROW}`;
    else if (s.t === 'in') d = `M${x} 0V${cy - R}Q${x} ${cy} ${x - R} ${cy}H${cx}`;
    else {
      const dir = x > cx ? 1 : -1;
      d = `M${cx} ${cy}H${x - dir * R}Q${x} ${cy} ${x} ${cy + R}V${ROW}`;
    }
    out += `<path d="${d}" stroke="${laneColor(s.c)}"${s.d ? ' stroke-dasharray="2.5 2.5"' : ''}/>`;
  }
  return `<svg width="${width}" height="${ROW}" fill="none" stroke-width="2">${out}</svg>`;
}
