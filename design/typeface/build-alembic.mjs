// Alembic Titling — CoreWise Academy's custom display face.
// A high-contrast, vertical-stress titling face built from stroke skeletons:
// thick stems, hairline horizontals, hairline slab serifs, ball terminals.
// Every glyph is a set of overlapping filled contours (nonzero winding unions
// them visually), so no boolean-path library is needed.
//
// Usage:  node design/typeface/build-alembic.mjs <opentype.js-dir> <out.otf>
// The generator is part of the portfolio: the font is reproducible from source.

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const opentypeDir = process.argv[2];
const outFile = process.argv[3] ?? 'design/typeface/AlembicTitling.otf';
const opentype = require(path.join(opentypeDir, 'node_modules', 'opentype.js'));

// ---------------------------------------------------------------- metrics
const UPM = 1000;
const CAP = 700;          // cap height
const STEM = 118;         // main stem width
const HAIR = 30;          // hairline width
const SERIF_W = 2.45;     // serif length as multiple of stem width
const SERIF_T = 26;       // serif slab thickness
const BALL = 66;          // ball terminal radius
const OVER = 12;          // overshoot for round glyphs
const SC = 0.74;          // small-caps scale (lowercase maps here)

// ---------------------------------------------------------------- contour helpers
// A contour is an array of on-curve/off-curve commands for opentype.Path.
// We only emit closed convex primitives; nonzero winding unions overlaps.

const K = 0.5522847498; // circle bezier constant

function circle(cx, cy, r) {
  const k = r * K;
  return [
    ['M', cx + r, cy],
    ['C', cx + r, cy + k, cx + k, cy + r, cx, cy + r],
    ['C', cx - k, cy + r, cx - r, cy + k, cx - r, cy],
    ['C', cx - r, cy - k, cx - k, cy - r, cx, cy - r],
    ['C', cx + k, cy - r, cx + r, cy - k, cx + r, cy],
    ['Z'],
  ];
}

// Quadrilateral from a centerline segment expanded by half-widths.
// w1/w2: full stroke widths at each end (lets strokes taper).
function seg(x1, y1, x2, y2, w1, w2 = w1) {
  const dx = x2 - x1, dy = y2 - y1;
  const len = Math.hypot(dx, dy) || 1;
  const nx = -dy / len, ny = dx / len;
  const h1 = w1 / 2, h2 = w2 / 2;
  // vertex order chosen so the contour winds CCW (y-up), matching circle()/rect() —
  // mixed winding under nonzero fill cancels overlaps into holes.
  return [
    ['M', x1 - nx * h1, y1 - ny * h1],
    ['L', x2 - nx * h2, y2 - ny * h2],
    ['L', x2 + nx * h2, y2 + ny * h2],
    ['L', x1 + nx * h1, y1 + ny * h1],
    ['Z'],
  ];
}

// Axis-aligned rectangle (x, y = lower-left).
function rect(x, y, w, h) {
  return [['M', x, y], ['L', x + w, y], ['L', x + w, y + h], ['L', x, y + h], ['Z']];
}

// Signed area of a polygon point list (y-up): positive = CCW.
function signedArea(pts) {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const [x1, y1] = pts[i], [x2, y2] = pts[(i + 1) % pts.length];
    a += x1 * y2 - x2 * y1;
  }
  return a / 2;
}

const polyContour = (pts) => {
  const c = [['M', pts[0][0], pts[0][1]]];
  for (let i = 1; i < pts.length; i++) c.push(['L', pts[i][0], pts[i][1]]);
  c.push(['Z']);
  return c;
};

// Elliptical arc stroked with didone contrast: width varies with the
// position angle so verticals are thick and horizontals hairline.
// a0/a1 in degrees, 0 = right (3 o'clock), CCW positive.
// Emits ONE band contour (outer edge forward, inner edge back) — or, for a
// full ring, an outer CCW contour plus an inner CW hole. Overlap-free, so
// small sizes rasterize cleanly.
function arc(cx, cy, rx, ry, a0, a1, opts = {}) {
  const {
    thick = STEM, thin = HAIR, steps = 40, pow = 1.15,
    taperStart = 1, taperEnd = 1, // multiply width near ends (for joins)
    caps = true,                  // round caps on open arcs
  } = opts;
  const rad = (d) => (d * Math.PI) / 180;
  const closed = Math.abs(a1 - a0) >= 359.9;
  const outer = [], inner = [], capDots = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const a = rad(a0 + (a1 - a0) * t);
    const cos = Math.cos(a), sin = Math.sin(a);
    let w = thin + (thick - thin) * Math.pow(Math.abs(cos), pow);
    w *= taperStart + (taperEnd - taperStart) * t;
    outer.push([cx + (rx + w / 2) * cos, cy + (ry + w / 2) * sin]);
    inner.push([cx + (rx - w / 2) * cos, cy + (ry - w / 2) * sin]);
    if (caps && !closed && (i === 0 || i === steps)) {
      capDots.push(circle(cx + rx * cos, cy + ry * sin, w / 2));
    }
  }
  const contours = [];
  if (closed) {
    outer.pop(); inner.pop(); // avoid duplicate seam point
    if (signedArea(outer) < 0) outer.reverse();
    if (signedArea(inner) > 0) inner.reverse();
    contours.push(polyContour(outer), polyContour(inner));
  } else {
    const band = outer.concat(inner.slice().reverse());
    if (signedArea(band) < 0) band.reverse();
    contours.push(polyContour(band), ...capDots);
  }
  return contours;
}

// Hairline slab serif centered on a stem end.
function serif(cx, y, stemW = STEM) {
  const w = stemW * SERIF_W;
  return rect(cx - w / 2, y, w, SERIF_T);
}

// Vertical stem with serifs top and bottom.
function stem(cx, y0 = 0, y1 = CAP, w = STEM, serifs = 'both') {
  const c = [seg(cx, y0, cx, y1, w)];
  if (serifs === 'both' || serifs === 'bottom') c.push(serif(cx, y0, w));
  if (serifs === 'both' || serifs === 'top') c.push(serif(cx, y1 - SERIF_T, w));
  return c;
}

const ball = (x, y, r = BALL) => [circle(x, y, r)];
const hair = (x1, y1, x2, y2, w = HAIR) => [seg(x1, y1, x2, y2, w)];

// ---------------------------------------------------------------- glyph definitions
// Each entry: { adv: advance width, parts: [contour groups] }
// Coordinates: baseline y=0, cap height y=CAP.

const G = {};

G['A'] = () => {
  const w = 640, apex = w / 2, spread = 268;
  return {
    adv: w + 60,
    parts: [
      seg(apex, CAP + 6, apex - spread, 0, HAIR, HAIR),                 // left hair diagonal
      seg(apex, CAP + 6, apex + spread, 0, STEM * 0.94, STEM * 1.02),   // right thick diagonal
      hair(apex - spread * 0.52, CAP * 0.26, apex + spread * 0.52, CAP * 0.26),
      serif(apex - spread, 0), serif(apex + spread, 0),
    ],
  };
};

G['B'] = () => {
  const sx = 90, bw1 = 300, bw2 = 330;
  return {
    adv: 560,
    parts: [
      stem(sx + STEM / 2, 0, CAP),
      hair(sx, CAP - HAIR / 2, sx + bw1 * 0.62, CAP - HAIR / 2),
      hair(sx, CAP * 0.535, sx + bw1 * 0.58, CAP * 0.535),
      hair(sx, HAIR / 2, sx + bw2 * 0.62, HAIR / 2),
      arc(sx + bw1 * 0.55, CAP * 0.7625, bw1 * 0.42, CAP * 0.2225, -90, 90, { thick: STEM * 0.86 }),
      arc(sx + bw2 * 0.55, CAP * 0.2675, bw2 * 0.5, CAP * 0.2675, -90, 90, { thick: STEM * 0.96 }),
    ],
  };
};

G['C'] = () => {
  const cx = 330, cy = CAP / 2, rx = 270, ry = CAP / 2 + OVER;
  return {
    adv: 640,
    parts: [
      arc(cx, cy, rx, ry, 38, 322, { thick: STEM * 1.04 }),
      ball(cx + rx * Math.cos((38 * Math.PI) / 180) + 6, cy + ry * Math.sin((38 * Math.PI) / 180) - 14),
      ball(cx + rx * Math.cos((322 * Math.PI) / 180) + 6, cy + ry * Math.sin((322 * Math.PI) / 180) + 14),
    ],
  };
};

G['D'] = () => {
  const sx = 90, bw = 430;
  return {
    adv: 620,
    parts: [
      stem(sx + STEM / 2, 0, CAP),
      hair(sx, CAP - HAIR / 2, sx + bw * 0.5, CAP - HAIR / 2),
      hair(sx, HAIR / 2, sx + bw * 0.5, HAIR / 2),
      arc(sx + bw * 0.48, CAP / 2, bw * 0.52, CAP / 2, -90, 90, { thick: STEM * 1.02 }),
    ],
  };
};

G['E'] = () => {
  const sx = 90, w = 380;
  return {
    adv: 520,
    parts: [
      stem(sx + STEM / 2, 0, CAP),
      hair(sx, CAP - HAIR / 2, sx + w, CAP - HAIR / 2),
      hair(sx, CAP * 0.535, sx + w * 0.86, CAP * 0.535),
      hair(sx, HAIR / 2, sx + w + 14, HAIR / 2),
      rect(sx + w - HAIR, CAP - SERIF_T * 2.4, HAIR, SERIF_T * 2.4),
      rect(sx + w + 14 - HAIR, 0, HAIR, SERIF_T * 2.4),
      rect(sx + w * 0.86 - HAIR, CAP * 0.535 - SERIF_T * 1.35, HAIR, SERIF_T * 2.7),
    ],
  };
};

G['F'] = () => {
  const sx = 90, w = 370;
  return {
    adv: 500,
    parts: [
      stem(sx + STEM / 2, 0, CAP),
      hair(sx, CAP - HAIR / 2, sx + w, CAP - HAIR / 2),
      hair(sx, CAP * 0.535, sx + w * 0.82, CAP * 0.535),
      rect(sx + w - HAIR, CAP - SERIF_T * 2.4, HAIR, SERIF_T * 2.4),
      rect(sx + w * 0.82 - HAIR, CAP * 0.535 - SERIF_T * 1.35, HAIR, SERIF_T * 2.7),
    ],
  };
};

G['G'] = () => {
  const cx = 330, cy = CAP / 2, rx = 270, ry = CAP / 2 + OVER;
  const a0 = 32;
  return {
    adv: 680,
    parts: [
      arc(cx, cy, rx, ry, a0, 322, { thick: STEM * 1.04 }),
      ball(cx + rx * Math.cos((322 * Math.PI) / 180) + 6, cy + ry * Math.sin((322 * Math.PI) / 180) + 14),
      seg(cx + rx - STEM * 0.5, cy * 0.96, cx + rx - STEM * 0.5, 0 + 88, STEM),
      serif(cx + rx - STEM * 0.5, 88 - SERIF_T),
      hair(cx + rx - STEM * 1.7, cy * 0.96 - HAIR / 2 + 14, cx + rx + 26, cy * 0.96 - HAIR / 2 + 14),
    ],
  };
};

G['H'] = () => {
  const s1 = 90 + STEM / 2, s2 = 470 + STEM / 2;
  return {
    adv: 660,
    parts: [stem(s1), stem(s2), hair(s1, CAP * 0.52, s2, CAP * 0.52)],
  };
};

G['I'] = () => ({ adv: 300, parts: [stem(150)] });

G['J'] = () => {
  const sx = 330;
  return {
    adv: 470,
    parts: [
      seg(sx, CAP, sx, 170, STEM),
      serif(sx, CAP - SERIF_T),
      arc(sx - 132, 170, 132, 168, 0, -140, { thick: STEM * 0.92 }),
      ball(sx - 132 + 132 * Math.cos((-140 * Math.PI) / 180) - 4, 170 + 168 * Math.sin((-140 * Math.PI) / 180) + 26),
    ],
  };
};

G['K'] = () => {
  const sx = 90 + STEM / 2, jx = sx + STEM * 0.1, jy = CAP * 0.52;
  return {
    adv: 640,
    parts: [
      stem(sx),
      seg(jx, jy, 520, CAP, HAIR),
      rect(520 - STEM * 0.9, CAP - SERIF_T, STEM * 1.5, SERIF_T),
      seg(jx + 30, jy * 1.08, 560, 0, STEM * 0.94),
      serif(560, 0),
    ],
  };
};

G['L'] = () => {
  const sx = 90;
  return {
    adv: 500,
    parts: [
      stem(sx + STEM / 2, 0, CAP),
      hair(sx, HAIR / 2, sx + 370, HAIR / 2),
      rect(sx + 370 - HAIR, 0, HAIR, SERIF_T * 2.4),
    ],
  };
};

G['M'] = () => {
  const s1 = 95 + STEM / 2, s2 = 705 - STEM / 2, mid = 400;
  return {
    adv: 800,
    parts: [
      stem(s1, 0, CAP, STEM * 0.86),
      stem(s2, 0, CAP, STEM * 0.86),
      seg(s1, CAP, mid, 46, HAIR + 12),
      seg(s2, CAP, mid, 46, STEM * 0.9),
      circle(mid, 46, (HAIR + 14) / 2),
    ],
  };
};

G['N'] = () => {
  const s1 = 90 + STEM / 2, s2 = 500 + STEM / 2;
  return {
    adv: 690,
    parts: [
      seg(s1, 0, s1, CAP, HAIR), serif(s1, 0), serif(s1, CAP - SERIF_T),
      seg(s2, 0, s2, CAP, HAIR), serif(s2, 0), serif(s2, CAP - SERIF_T),
      seg(s1, CAP, s2, 0, STEM),
    ],
  };
};

G['O'] = () => {
  const cx = 340, cy = CAP / 2;
  return {
    adv: 680,
    parts: [arc(cx, cy, 280, CAP / 2 + OVER, 0, 360, { thick: STEM * 1.04 })],
  };
};

G['P'] = () => {
  const sx = 90, bw = 340;
  return {
    adv: 560,
    parts: [
      stem(sx + STEM / 2, 0, CAP),
      hair(sx, CAP - HAIR / 2, sx + bw * 0.58, CAP - HAIR / 2),
      hair(sx, CAP * 0.46, sx + bw * 0.58, CAP * 0.46),
      arc(sx + bw * 0.52, CAP * 0.7275, bw * 0.46, CAP * 0.2625, -90, 90, { thick: STEM * 0.92 }),
    ],
  };
};

G['Q'] = () => {
  const cx = 340, cy = CAP / 2;
  return {
    adv: 690,
    parts: [
      arc(cx, cy, 280, CAP / 2 + OVER, 0, 360, { thick: STEM * 1.04 }),
      // the tail: Alembic's signature — a long spout below the baseline
      seg(cx + 60, 120, cx + 320, -140, STEM * 0.72, HAIR + 8),
      ball(cx + 332, -146, BALL * 0.92),
    ],
  };
};

G['R'] = () => {
  const sx = 90, bw = 340;
  return {
    adv: 620,
    parts: [
      stem(sx + STEM / 2, 0, CAP),
      hair(sx, CAP - HAIR / 2, sx + bw * 0.58, CAP - HAIR / 2),
      hair(sx, CAP * 0.46, sx + bw * 0.52, CAP * 0.46),
      arc(sx + bw * 0.52, CAP * 0.7275, bw * 0.46, CAP * 0.2625, -90, 90, { thick: STEM * 0.92 }),
      seg(sx + bw * 0.5, CAP * 0.46, 570, 0, STEM * 0.9, HAIR + 10),
      ball(578, -4, BALL * 0.9),
    ],
  };
};

G['S'] = () => {
  const cx = 300, w = 250;
  return {
    adv: 600,
    parts: [
      arc(cx + 8, CAP * 0.734, w * 0.94, CAP * 0.266 + OVER, 30, 262, { thick: STEM * 0.9 }),
      arc(cx - 8, CAP * 0.26, w, CAP * 0.26 + OVER, -150, 82, { thick: STEM * 0.98 }),
      ball(cx + 8 + w * 0.94 * Math.cos((30 * Math.PI) / 180), CAP * 0.734 + (CAP * 0.266 + OVER) * Math.sin((30 * Math.PI) / 180) - 10),
      ball(cx - 8 + w * Math.cos((-150 * Math.PI) / 180) + 10, CAP * 0.26 + (CAP * 0.26 + OVER) * Math.sin((-150 * Math.PI) / 180) + 12),
    ],
  };
};

G['T'] = () => {
  const cx = 300, w = 560;
  return {
    adv: 600,
    parts: [
      seg(cx, 0, cx, CAP, STEM), serif(cx, 0),
      hair(cx - w / 2, CAP - HAIR / 2, cx + w / 2, CAP - HAIR / 2),
      rect(cx - w / 2, CAP - SERIF_T * 2.4, HAIR, SERIF_T * 2.4),
      rect(cx + w / 2 - HAIR, CAP - SERIF_T * 2.4, HAIR, SERIF_T * 2.4),
    ],
  };
};

G['U'] = () => {
  const s1 = 90 + STEM / 2, s2 = 510 + STEM / 2, cx = (s1 + s2) / 2;
  return {
    adv: 700,
    parts: [
      seg(s1, CAP, s1, 230, STEM), serif(s1, CAP - SERIF_T),
      seg(s2, CAP, s2, 230, HAIR), serif(s2, CAP - SERIF_T),
      arc(cx, 230, (s2 - s1) / 2, 230 + OVER, 180, 360, { thick: STEM * 1.0 }),
    ],
  };
};

G['V'] = () => {
  const w = 640, apex = w / 2, spread = 272;
  return {
    adv: w + 40,
    parts: [
      seg(apex - spread, CAP, apex, -6, STEM * 1.0, STEM * 0.5),
      seg(apex + spread, CAP, apex, -6, HAIR),
      serif(apex - spread, CAP - SERIF_T), serif(apex + spread, CAP - SERIF_T),
      circle(apex, 0, STEM * 0.28),
    ],
  };
};

G['W'] = () => {
  const spread = 210, x0 = 120;
  const pts = [x0, x0 + spread, x0 + spread * 2, x0 + spread * 3, x0 + spread * 4];
  return {
    adv: x0 * 2 + spread * 4,
    parts: [
      seg(pts[0], CAP, pts[1], -6, STEM * 0.92, STEM * 0.5),
      seg(pts[2], CAP * 0.86, pts[1], -6, HAIR),
      seg(pts[2], CAP * 0.86, pts[3], -6, STEM * 0.86, STEM * 0.46),
      seg(pts[4], CAP, pts[3], -6, HAIR),
      serif(pts[0], CAP - SERIF_T), serif(pts[4], CAP - SERIF_T),
      circle(pts[1], 0, STEM * 0.26), circle(pts[3], 0, STEM * 0.26),
    ],
  };
};

G['X'] = () => {
  const w = 620, cx = w / 2, spread = 250;
  return {
    adv: w + 20,
    parts: [
      seg(cx - spread, CAP, cx + spread, 0, STEM * 0.98),
      seg(cx + spread, CAP, cx - spread, 0, HAIR),
      serif(cx - spread, CAP - SERIF_T), serif(cx + spread, CAP - SERIF_T),
      serif(cx - spread, 0), serif(cx + spread, 0),
    ],
  };
};

G['Y'] = () => {
  const cx = 300, jy = CAP * 0.46;
  return {
    adv: 600,
    parts: [
      seg(cx - 260, CAP, cx, jy, STEM * 0.96, STEM * 0.7),
      seg(cx + 260, CAP, cx, jy, HAIR),
      seg(cx, jy, cx, 0, STEM), serif(cx, 0),
      serif(cx - 260, CAP - SERIF_T), serif(cx + 260, CAP - SERIF_T),
    ],
  };
};

G['Z'] = () => {
  const sx = 70, w = 480;
  return {
    adv: 620,
    parts: [
      hair(sx, CAP - HAIR / 2, sx + w, CAP - HAIR / 2),
      hair(sx, HAIR / 2, sx + w + 16, HAIR / 2),
      seg(sx + w, CAP, sx, 0, STEM * 1.0),
      rect(sx, CAP - SERIF_T * 2.4, HAIR, SERIF_T * 2.4),
      rect(sx + w + 16 - HAIR, 0, HAIR, SERIF_T * 2.4),
    ],
  };
};

// ------------------------------------------------------------- digits
G['0'] = () => ({
  adv: 620,
  parts: [arc(310, CAP / 2, 250, CAP / 2 + OVER, 0, 360, { thick: STEM * 0.96 })],
});
G['1'] = () => ({
  adv: 420,
  parts: [
    seg(240, 0, 240, CAP, STEM), serif(240, 0),
    seg(240 - 4, CAP - 8, 96, CAP * 0.72, HAIR + 10, HAIR),
  ],
});
G['2'] = () => ({
  adv: 580,
  parts: [
    arc(300, CAP * 0.72, 210, CAP * 0.28 + OVER, 165, -20, { thick: STEM * 0.9 }),
    seg(300 + 210 * Math.cos((-20 * Math.PI) / 180), CAP * 0.72 + (CAP * 0.28 + OVER) * Math.sin((-20 * Math.PI) / 180), 110, 0, STEM * 0.88, HAIR + 6),
    hair(96, HAIR / 2, 520, HAIR / 2),
    rect(520 - HAIR, 0, HAIR, SERIF_T * 2.2),
    ball(300 + 210 * Math.cos((165 * Math.PI) / 180) + 8, CAP * 0.72 + (CAP * 0.28 + OVER) * Math.sin((165 * Math.PI) / 180) - 16, BALL * 0.82),
  ],
});
G['3'] = () => ({
  adv: 560,
  parts: [
    arc(270, CAP * 0.745, 200, CAP * 0.255 + OVER, 150, -90, { thick: STEM * 0.86 }),
    arc(270, CAP * 0.255, 218, CAP * 0.255 + OVER, 90, -150, { thick: STEM * 0.94 }),
    ball(270 + 200 * Math.cos((150 * Math.PI) / 180) + 8, CAP * 0.745 + (CAP * 0.255 + OVER) * Math.sin((150 * Math.PI) / 180) - 12, BALL * 0.8),
    ball(270 + 218 * Math.cos((-150 * Math.PI) / 180) + 8, CAP * 0.255 + (CAP * 0.255 + OVER) * Math.sin((-150 * Math.PI) / 180) + 12, BALL * 0.8),
  ],
});
G['4'] = () => ({
  adv: 600,
  parts: [
    seg(400, 0, 400, CAP, STEM), serif(400, 0),
    seg(400, CAP, 90, CAP * 0.30, HAIR),
    hair(70, CAP * 0.30, 540, CAP * 0.30),
  ],
});
G['5'] = () => ({
  adv: 570,
  parts: [
    hair(150, CAP - HAIR / 2, 470, CAP - HAIR / 2),
    rect(470 - HAIR, CAP - SERIF_T * 2.2, HAIR, SERIF_T * 2.2),
    seg(150, CAP, 138, CAP * 0.47, HAIR),
    arc(280, CAP * 0.27, 210, CAP * 0.27 + OVER, 118, -150, { thick: STEM * 0.94 }),
    ball(280 + 210 * Math.cos((-150 * Math.PI) / 180) + 8, CAP * 0.27 + (CAP * 0.27 + OVER) * Math.sin((-150 * Math.PI) / 180) + 12, BALL * 0.8),
  ],
});
G['6'] = () => ({
  adv: 600,
  parts: [
    arc(310, CAP * 0.26, 230, CAP * 0.26 + OVER, 0, 360, { thick: STEM * 0.92 }),
    arc(430, CAP * 0.62, 350, CAP * 0.40, 96, 178, { thick: STEM * 0.7, thin: HAIR }),
    ball(430 + 350 * Math.cos((96 * Math.PI) / 180) + 4, CAP * 0.62 + CAP * 0.40 * Math.sin((96 * Math.PI) / 180) - 4, BALL * 0.78),
  ],
});
G['7'] = () => ({
  adv: 540,
  parts: [
    hair(90, CAP - HAIR / 2, 500, CAP - HAIR / 2),
    rect(90, CAP - SERIF_T * 2.2, HAIR, SERIF_T * 2.2),
    seg(500, CAP, 230, 0, STEM * 0.9),
    serif(230, 0),
  ],
});
G['8'] = () => ({
  adv: 600,
  parts: [
    arc(300, CAP * 0.735, 196, CAP * 0.265 + OVER, 0, 360, { thick: STEM * 0.84 }),
    arc(300, CAP * 0.25, 226, CAP * 0.25 + OVER, 0, 360, { thick: STEM * 0.94 }),
  ],
});
G['9'] = () => ({
  adv: 600,
  parts: [
    arc(290, CAP * 0.74, 230, CAP * 0.26 + OVER, 0, 360, { thick: STEM * 0.92 }),
    arc(170, CAP * 0.38, 350, CAP * 0.40, -84, -2, { thick: STEM * 0.7, thin: HAIR }),
    ball(170 + 350 * Math.cos((-84 * Math.PI) / 180) - 4, CAP * 0.38 + CAP * 0.40 * Math.sin((-84 * Math.PI) / 180) + 4, BALL * 0.78),
  ],
});

// ------------------------------------------------------------- punctuation
G['.'] = () => ({ adv: 260, parts: [circle(130, 62, 62)] });
G[','] = () => ({
  adv: 260,
  parts: [circle(130, 62, 62), seg(150, 30, 96, -120, 70, 18)],
});
G[':'] = () => ({ adv: 260, parts: [circle(130, 62, 62), circle(130, CAP * 0.52, 62)] });
G[';'] = () => ({
  adv: 260,
  parts: [circle(130, CAP * 0.52, 62), circle(130, 62, 62), seg(150, 30, 96, -120, 70, 18)],
});
G['!'] = () => ({
  adv: 300,
  parts: [circle(150, 62, 62), seg(150, 210, 150, CAP, HAIR + 26, STEM * 0.86)],
});
G['?'] = () => ({
  adv: 480,
  parts: [
    circle(240, 62, 62),
    arc(240, CAP * 0.72, 172, CAP * 0.26 + OVER, 200, -35, { thick: STEM * 0.86 }),
    seg(240 + 172 * Math.cos((-35 * Math.PI) / 180), CAP * 0.72 + (CAP * 0.26 + OVER) * Math.sin((-35 * Math.PI) / 180), 240, 210, STEM * 0.6, HAIR + 8),
    ball(240 + 172 * Math.cos((200 * Math.PI) / 180) + 6, CAP * 0.72 + (CAP * 0.26 + OVER) * Math.sin((200 * Math.PI) / 180) - 4, BALL * 0.78),
  ],
});
G['-'] = () => ({ adv: 420, parts: [hair(80, CAP * 0.34, 340, CAP * 0.34, HAIR + 14)] });
G['–'] = () => ({ adv: 560, parts: [hair(70, CAP * 0.34, 490, CAP * 0.34, HAIR + 10)] }); // en dash
G['—'] = () => ({ adv: 800, parts: [hair(60, CAP * 0.34, 740, CAP * 0.34, HAIR + 10)] }); // em dash
G["'"] = () => ({ adv: 220, parts: [seg(120, CAP, 92, CAP - 170, 74, 20)] });
G['’'] = G["'"];
G['"'] = () => ({ adv: 360, parts: [seg(120, CAP, 92, CAP - 170, 74, 20), seg(260, CAP, 232, CAP - 170, 74, 20)] });
G['“'] = () => ({ adv: 360, parts: [seg(92, CAP - 170, 120, CAP, 20, 74), seg(232, CAP - 170, 260, CAP, 20, 74)] });
G['”'] = G['"'];
G['('] = () => ({
  adv: 380,
  parts: [arc(430, CAP * 0.5 - 30, 300, CAP * 0.62, 128, 232, { thick: STEM * 0.62 })],
});
G[')'] = () => ({
  adv: 380,
  parts: [arc(-50, CAP * 0.5 - 30, 300, CAP * 0.62, -52, 52, { thick: STEM * 0.62 })],
});
G['&'] = () => ({
  adv: 700,
  parts: [
    arc(300, CAP * 0.75, 160, CAP * 0.25 + OVER, 0, 360, { thick: STEM * 0.72 }),
    arc(290, CAP * 0.27, 220, CAP * 0.27 + OVER, 55, 355, { thick: STEM * 0.94 }),
    seg(330, CAP * 0.52, 620, 0, HAIR + 8),
    ball(628, -4, BALL * 0.8),
  ],
});
G['№'] = () => { // № — the issue mark
  const n = G['N']().parts.map((c) => scaleContours([c], 0.72, 0)[0]);
  return {
    adv: 690 * 0.72 + 430,
    parts: [
      ...n,
      arc(690 * 0.72 + 190, CAP * 0.72 * 0.5 + CAP * 0.28, 120, 120, 0, 360, { thick: STEM * 0.6, thin: HAIR }),
      hair(690 * 0.72 + 80, CAP * 0.1, 690 * 0.72 + 310, CAP * 0.1, HAIR + 12),
    ],
  };
};
G['/'] = () => ({ adv: 460, parts: [seg(400, CAP + 20, 60, -20, HAIR + 16)] });

// ---------------------------------------------------------------- assembly

function scaleContours(contours, s, dy = 0) {
  return contours.map((cmds) => cmds.map((c) => {
    const [op, ...nums] = c;
    return [op, ...nums.map((v, i) => (i % 2 === 0 ? v * s : v * s + dy))];
  }));
}

function toPath(contours) {
  const p = new opentype.Path();
  for (const cmds of contours) {
    for (const c of cmds) {
      if (c[0] === 'M') p.moveTo(c[1], c[2]);
      else if (c[0] === 'L') p.lineTo(c[1], c[2]);
      else if (c[0] === 'C') p.curveTo(c[1], c[2], c[3], c[4], c[5], c[6]);
      else if (c[0] === 'Z') p.close();
    }
  }
  return p;
}

function flatten(parts) {
  // parts may nest one level (helpers return arrays of contours)
  const out = [];
  for (const p of parts) {
    if (Array.isArray(p[0])) out.push(...(Array.isArray(p[0][0]) ? p : [p]));
    else out.push(p);
  }
  // normalize: a contour is an array whose first element is a command array
  return out.filter((c) => Array.isArray(c) && Array.isArray(c[0]));
}

const glyphs = [
  new opentype.Glyph({ name: '.notdef', advanceWidth: 600, path: new opentype.Path() }),
  new opentype.Glyph({ name: 'space', unicode: 32, advanceWidth: 300, path: new opentype.Path() }),
];

const made = {};
for (const [ch, fn] of Object.entries(G)) {
  const { adv, parts } = fn();
  made[ch] = { adv, contours: flatten(parts) };
}

for (const [ch, { adv, contours }] of Object.entries(made)) {
  glyphs.push(new opentype.Glyph({
    name: `uni${ch.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}`,
    unicode: ch.codePointAt(0),
    advanceWidth: adv,
    path: toPath(contours),
  }));
}

// lowercase → small caps
for (const ch of 'abcdefghijklmnopqrstuvwxyz') {
  const up = made[ch.toUpperCase()];
  if (!up) continue;
  glyphs.push(new opentype.Glyph({
    name: `uni${ch.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}`,
    unicode: ch.codePointAt(0),
    advanceWidth: Math.round(up.adv * SC + 26),
    path: toPath(scaleContours(up.contours, SC)),
  }));
}

const font = new opentype.Font({
  familyName: 'Alembic Titling',
  styleName: 'Regular',
  unitsPerEm: UPM,
  ascender: 780,
  descender: -220,
  glyphs,
});

fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, Buffer.from(font.toArrayBuffer()));
console.log(`wrote ${outFile} (${glyphs.length} glyphs)`);
