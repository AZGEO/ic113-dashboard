/* ==========================================================================
   VISUAL BUILDERS: pure functions (no DOM access) that return HTML/SVG strings.
   Loaded before app.js. Unit-tested in Node via tests/visuals.test.js.
   ========================================================================== */

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// One value per week (index 0 = week 1); weeks with no rows are null.
function weeklySeries(rows, pick, weeks = 26) {
  const byWeek = new Map();
  for (const r of rows) {
    if (!byWeek.has(r.week)) byWeek.set(r.week, []);
    byWeek.get(r.week).push(r);
  }
  const out = [];
  for (let w = 1; w <= weeks; w++) {
    const wr = byWeek.get(w);
    out.push(wr && wr.length ? pick(wr) : null);
  }
  return out;
}

function buildSparkline(values, opts = {}) {
  const kind = opts.kind || 'line';
  const width = opts.width || 120;
  const height = opts.height || 32;
  const tone = opts.tone || 'brand';
  const pad = 2;
  const open = `<svg class="spark tone-${tone}" viewBox="0 0 ${width} ${height}" width="100%" height="${height}" preserveAspectRatio="none" role="img" aria-hidden="true"`;
  const present = values.filter((v) => v !== null && v !== undefined && !Number.isNaN(v));
  if (!present.length) return `${open} data-empty="true" data-points="0"></svg>`;

  const lo = kind === 'bars' ? 0 : Math.min(...present);
  const hi = Math.max(...present);
  const span = hi - lo || 1;
  const n = values.length;
  const step = n > 1 ? (width - pad * 2) / (n - 1) : 0;
  const yOf = (v) => (height - pad - ((v - lo) / span) * (height - pad * 2)).toFixed(1);
  const xOf = (i) => (pad + i * step).toFixed(1);

  let body = '';
  if (kind === 'bars') {
    const bw = Math.max(1, (width - pad * 2) / n - 1);
    values.forEach((v, i) => {
      if (v === null || v === undefined) return;
      const y = yOf(v);
      const h = Math.max(1, height - pad - Number(y));
      body += `<rect x="${(pad + i * ((width - pad * 2) / n)).toFixed(1)}" y="${y}" width="${bw.toFixed(1)}" height="${h.toFixed(1)}" rx="1"/>`;
    });
  } else {
    let run = [];
    const flush = () => {
      if (run.length === 1) body += `<circle cx="${run[0][0]}" cy="${run[0][1]}" r="1.6"/>`;
      else if (run.length > 1) body += `<polyline points="${run.map((p) => p.join(',')).join(' ')}" fill="none"/>`;
      run = [];
    };
    values.forEach((v, i) => {
      if (v === null || v === undefined) flush();
      else run.push([xOf(i), yOf(v)]);
    });
    flush();
  }
  return `${open} data-points="${present.length}">${body}</svg>`;
}

function severityFor(kind, value) {
  if (kind === 'elevated') {
    if (value <= 0) return { tone: 'safe', label: 'None' };
    if (value <= 2) return { tone: 'warn', label: 'Some' };
    return { tone: 'danger', label: 'Many' };
  }
  if (value < 6.5) return { tone: 'safe', label: 'Normal' };
  if (value < 8.5) return { tone: 'warn', label: 'Elevated' };
  return { tone: 'danger', label: 'Critical' };
}

function rateSeverity(rate, hasRows) {
  if (!hasRows) return { tone: 'neutral', label: 'No data' };
  return severityFor('rate', rate);
}

// Scenario swaps the dataset rather than subsetting it, so it does not count as a filter here.
function attemptsScopeBadge(chips) {
  const subset = chips.some((c) => c.key !== 'scenario' && !c.isDefault);
  return subset ? { tone: 'warn', label: 'Filtered scope' } : { tone: 'safe', label: 'Full scope' };
}

function heatColor(rate, max) {
  if (rate === null || rate === undefined || Number.isNaN(rate)) return 'transparent';
  const m = max > 0 ? max : 1;
  const pct = Math.round(Math.min(1, Math.max(0, rate / m)) * 100);
  return `color-mix(in srgb, var(--heat-hi) ${pct}%, var(--heat-lo))`;
}

function buildHeatmapGrid(rows, colleges, weeks = 26) {
  if (!rows.length) return '<p class="heat-none">No data for the current filters.</p>';
  const lookup = new Map(rows.map((r) => [`${r.college}_${r.week}`, r]));
  let first = true;
  let html = '';
  for (const c of colleges) {
    html += `<div class="heat-row" role="row"><span class="heat-label" role="rowheader" title="${escapeHtml(c.name)}">${escapeHtml(c.code)}</span>`;
    for (let w = 1; w <= weeks; w++) {
      const r = lookup.get(`${c.code}_${w}`);
      if (!r) {
        html += `<span class="heat-cell heat-empty" role="gridcell" aria-label="${escapeHtml(c.code)} week ${w}: no data"></span>`;
        continue;
      }
      const rate = r.failed_login_rate;
      html += `<button type="button" class="heat-cell" role="gridcell" tabindex="${first ? 0 : -1}" data-college="${escapeHtml(c.code)}" data-week="${w}" data-rate="${rate}" data-attempts="${r.login_attempts}" data-failed="${r.failed_logins}" aria-label="${escapeHtml(c.code)} week ${w}: ${rate.toFixed(2)} percent failed logins"></button>`;
      first = false;
    }
    html += '</div>';
  }
  return html;
}

const SCOPE_LABELS = {
  scenario: 'Scenario',
  period: 'Window',
  college: 'College',
  device: 'Device',
  outliers: 'Outliers',
};

function scopeChips(values, defaults) {
  return ['scenario', 'period', 'college', 'device', 'outliers'].map((key) => ({
    key,
    label: SCOPE_LABELS[key],
    value: values[key],
    isDefault: values[key] === defaults[key],
  }));
}

// Literal, case-insensitive match highlighting; text is HTML-escaped piecewise.
function highlightMatch(text, query) {
  const t = String(text);
  if (!query) return escapeHtml(t);
  const lower = t.toLowerCase();
  const q = String(query).toLowerCase();
  let out = '';
  let i = 0;
  while (i < t.length) {
    const at = lower.indexOf(q, i);
    if (at === -1) break;
    out += escapeHtml(t.slice(i, at)) + '<mark>' + escapeHtml(t.slice(at, at + q.length)) + '</mark>';
    i = at + q.length;
  }
  return out + escapeHtml(t.slice(i));
}

// Mark the "W05" label only when the query names exactly that week ("w5" or "5").
function highlightWeek(week, query) {
  const label = 'W' + String(week).padStart(2, '0');
  const q = String(query || '').trim().toLowerCase();
  return q === 'w' + week || q === String(week) ? '<mark>' + label + '</mark>' : label;
}

// Closest populated week to target; the lower week wins ties; null when none.
function nearestWeek(weeks, target) {
  let best = null;
  for (const w of weeks) {
    if (best === null || Math.abs(w - target) < Math.abs(best - target) || (Math.abs(w - target) === Math.abs(best - target) && w < best)) best = w;
  }
  return best;
}

function rateBar(rate, max) {
  const m = max > 0 ? max : 1;
  const pct = Math.round(Math.min(100, Math.max(0, (rate / m) * 100)));
  return `<span class="rate-bar"><i style="width:${pct}%"></i></span>`;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { highlightWeek, nearestWeek, rateSeverity, attemptsScopeBadge, escapeHtml, weeklySeries, buildSparkline, severityFor, heatColor, buildHeatmapGrid, scopeChips, highlightMatch, rateBar };
}
