// Generates SVG geometry for the dashboard artboards so the paths are real,
// not eyeballed. Prints ready-to-paste `d` attributes.
const W = 664, H = 196;
const hours = 24;
// Plausible 24h energy curve: overnight dip, morning + evening peaks.
const shape = [22,17,14,12,13,19,34,58,74,69,62,58,61,64,67,72,86,104,118,112,92,68,46,31];
const s16 = shape.map((v, i) => v * (0.62 + 0.05 * Math.sin(i / 3)));
const s201 = shape.map((v, i) => v * (0.30 + 0.04 * Math.cos(i / 4)));
const totals = s16.map((v, i) => v + s201[i]);
const max = Math.ceil(Math.max(...totals) / 20) * 20;

const x = (i) => +( (i / (hours - 1)) * W ).toFixed(1);
const y = (v) => +( H - (v / max) * H ).toFixed(1);

function line(vals) {
  return vals.map((v, i) => `${i ? 'L' : 'M'}${x(i)} ${y(v)}`).join(' ');
}
function area(upper, lower) {
  const up = upper.map((v, i) => `${i ? 'L' : 'M'}${x(i)} ${y(v)}`).join(' ');
  const down = lower.map((v, i) => `L${x(lower.length - 1 - i)} ${y(lower[lower.length - 1 - i])}`).join(' ');
  return `${up} ${down} Z`;
}
const zero = new Array(hours).fill(0);
console.log('MAX_Y', max);
console.log('AREA_16  ', area(s16, zero));
console.log('LINE_16  ', line(s16));
console.log('AREA_201 ', area(totals, s16));
console.log('LINE_201 ', line(totals));
console.log('GRIDLABELS', [0, 0.25, 0.5, 0.75, 1].map((f) => Math.round(max * f)).join(','));

// Sparklines for KPI tiles: 20 points, 84x26 box
function spark(vals, w = 84, h = 26) {
  const mn = Math.min(...vals), mx = Math.max(...vals);
  const sx = (i) => +((i / (vals.length - 1)) * w).toFixed(1);
  const sy = (v) => +(h - ((v - mn) / (mx - mn || 1)) * (h - 3) - 1.5).toFixed(1);
  return vals.map((v, i) => `${i ? 'L' : 'M'}${sx(i)} ${sy(v)}`).join(' ');
}
console.log('SPARK_STATIONS', spark([182,184,183,186,188,187,189,190,188,191,192,191,193,194,193,195,196,195,197,198]));
console.log('SPARK_SESSIONS', spark([9,12,10,14,18,22,19,24,28,31,27,33,36,34,39,42,38,44,47,51]));
console.log('SPARK_ENERGY  ', spark([310,290,340,420,480,460,520,610,580,640,700,680,720,810,790,860,910,880,950,1020]));
console.log('SPARK_REVENUE ', spark([120,118,131,160,182,176,198,231,220,244,266,258,274,308,300,327,346,334,361,388]));
