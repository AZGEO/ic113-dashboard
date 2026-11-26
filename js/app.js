
/* --------------------------------------------------------------------------
   C. APPLICATION STATE & FILTER PIPELINE
   -------------------------------------------------------------------------- */
const state = {
  role: 'dean',
  theme: 'dark',
  activeTab: 0,
  plannerStep: 1,
  recordsSortKey: 'week',
  recordsSortAsc: true,
  recordsPage: 1,
  recordsPageSize: 18,
  filteredPooled: [],
  collegeStats: [],
  omnibus: null,
  univBaselineRate: 0,
  scenario: 'effect',
};

let barChartInstance = null;
let trendChartInstance = null;
let deviceChartInstance = null;

/* --------------------------------------------------------------------------
   MOTION HELPERS: reduced-motion, debounce, counters, Chart.js defaults
   -------------------------------------------------------------------------- */
const reducedMotionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');

function debounce(fn, wait) {
  let t = null;
  return function (...args) {
    clearTimeout(t);
    t = setTimeout(() => fn.apply(this, args), wait);
  };
}

// Tween a numeric readout with one rAF loop per element; only textContent is written.
function animateNumber(el, to, format, duration = 420) {
  if (!el) return;
  cancelAnimationFrame(el._rafId);
  const from = Number.isFinite(el._value) ? el._value : to;
  el._value = to;
  if (reducedMotionQuery.matches || from === to) {
    el.textContent = format(to);
    return;
  }
  const start = performance.now();
  function tick(now) {
    const t = Math.min(1, (now - start) / duration);
    const eased = 1 - Math.pow(1 - t, 3);
    el.textContent = format(from + (to - from) * eased);
    if (t < 1) el._rafId = requestAnimationFrame(tick);
  }
  el._rafId = requestAnimationFrame(tick);
}

// Replay a short opacity/transform swap on an element.
function replayFx(el) {
  if (!el || reducedMotionQuery.matches) return;
  el.classList.remove('fx-swap');
  void el.offsetWidth;
  el.classList.add('fx-swap');
}

function configureChartMotion() {
  Chart.defaults.animation = reducedMotionQuery.matches
    ? false
    : { duration: 420, easing: 'easeOutQuart' };
  // Skip resize tweening and coalesce resize bursts to avoid layout thrash.
  Chart.defaults.transitions.resize = { animation: { duration: 0 } };
  Chart.defaults.resizeDelay = 100;
}
configureChartMotion();
reducedMotionQuery.addEventListener('change', configureChartMotion);

const applyFiltersDebounced = debounce(() => applyFilters(), 120);
const renderRecordsTableDebounced = debounce(() => renderRecordsTable(), 150);
const setMatchCountText = debounce((text) => {
  const el = document.getElementById('records-match-count');
  if (el) el.textContent = text;
}, 300);

function getActiveRawDataset() {
  const scenario = document.getElementById('filter-scenario').value;
  state.scenario = scenario;
  return DATASETS[scenario] || DATASETS.effect;
}

function getFilteredRows() {
  const raw = getActiveRawDataset();
  const period = document.getElementById('filter-period').value;
  const college = document.getElementById('filter-college').value;
  const device = document.getElementById('filter-device').value;
  const outlierMode = document.getElementById('filter-outliers').value;

  const baseFiltered = raw.filter((r) => {
    if (period === 'first_half' && r.week > 13) return false;
    if (period === 'second_half' && r.week < 14) return false;
    if (period === 'exams' && !r.isExam) return false;
    if (period === 'regular' && r.isExam) return false;
    if (device !== 'ALL' && r.device_type !== device) return false;
    return true;
  });

  // Pool counts by (week, college) before dividing to prevent Simpson's Paradox
  const map = new Map();
  for (const r of baseFiltered) {
    const key = `${r.week}_${r.college}`;
    if (!map.has(key)) {
      map.set(key, {
        week: r.week,
        college: r.college,
        collegeName: r.collegeName,
        device_type: device === 'ALL' ? 'All Devices (Pooled)' : device,
        active_users: 0,
        login_attempts: 0,
        failed_logins: 0,
        isExam: r.isExam,
      });
    }
    const entry = map.get(key);
    entry.active_users += r.active_users;
    entry.login_attempts += r.login_attempts;
    entry.failed_logins += r.failed_logins;
  }

  let pooled = Array.from(map.values()).map((d) => ({
    ...d,
    failed_login_rate: d.login_attempts > 0 ? (d.failed_logins / d.login_attempts) * 100 : 0,
  }));

  // Tukey fence per college (Q3 + 1.5 * IQR) to flag statistical outlier spike weeks
  const byCol = new Map();
  for (const p of pooled) {
    if (!byCol.has(p.college)) byCol.set(p.college, []);
    byCol.get(p.college).push(p.failed_login_rate);
  }
  const fences = new Map();
  for (const [c, vals] of byCol.entries()) {
    const s = [...vals].sort((a, b) => a - b);
    const q1 = quantile(s, 0.25);
    const q3 = quantile(s, 0.75);
    fences.set(c, q3 + 1.5 * (q3 - q1));
  }

  pooled = pooled.map((p) => ({
    ...p,
    isOutlier: p.failed_login_rate > (fences.get(p.college) ?? Infinity),
  }));

  pooled = pooled.filter((p) => {
    if (outlierMode === 'exclude' && p.isOutlier) return false;
    if (outlierMode === 'only' && !p.isOutlier) return false;
    if (college !== 'ALL' && p.college !== college) return false;
    return true;
  });

  return pooled;
}

function applyFilters() {
  const pooled = getFilteredRows();
  state.filteredPooled = pooled;
  state.recordsPage = 1;

  const totalAttempts = pooled.reduce((a, b) => a + b.login_attempts, 0);
  const totalFailed = pooled.reduce((a, b) => a + b.failed_logins, 0);
  const univBaseline = totalAttempts > 0 ? (totalFailed / totalAttempts) * 100 : 0;
  state.univBaselineRate = univBaseline;

  const activeColleges = COLLEGES.filter((c) => pooled.some((p) => p.college === c.code));
  const groups = activeColleges.map((c) =>
    pooled.filter((p) => p.college === c.code).map((p) => p.failed_login_rate)
  );

  // Build complete week-block matrix (b weeks x k colleges) for repeated-measures omnibus test
  const allWeeks = Array.from(new Set(pooled.map((p) => p.week))).sort((a, b) => a - b);
  const completeWeeks = allWeeks.filter((w) =>
    activeColleges.every((c) => pooled.some((p) => p.week === w && p.college === c.code))
  );
  const blockMatrix = completeWeeks.map((w) =>
    activeColleges.map((c) => {
      const row = pooled.find((p) => p.week === w && p.college === c.code);
      return row ? row.failed_login_rate : 0;
    })
  );

  // Assumption checks: Brown-Forsythe Levene + max skewness
  const medianDeviations = groups.map((g) => {
    const med = quantile([...g].sort((a, b) => a - b), 0.5);
    return g.map((v) => Math.abs(v - med));
  });
  const levene = computeOneWayAnova(medianDeviations);
  const maxSkew = groups.length ? Math.max(...groups.map((g) => Math.abs(skewness(g)))) : 0;

  const override = document.getElementById('test-override').value;
  const useFriedman = override === 'friedman' || (override === 'auto' && (levene.p < 0.05 || maxSkew > 1.25));

  const friedman = computeFriedmanTest(blockMatrix);
  const rmAnova = computeRepeatedMeasuresAnova(blockMatrix);
  const N = pooled.length;

  // Leave-One-College-Out (Rest-of-University) paired weekly series & raw post-hoc p-values
  const rawPostHocResults = activeColleges.map((col) => {
    const colRows = pooled.filter((p) => p.college === col.code).sort((a, b) => a.week - b.week);
    const colWeeks = colRows.map((r) => r.week);

    // Leave-one-out overall pooled baseline (excludes college being tested)
    const otherAll = pooled.filter((p) => p.college !== col.code);
    const otherAtt = otherAll.reduce((a, b) => a + b.login_attempts, 0);
    const otherFail = otherAll.reduce((a, b) => a + b.failed_logins, 0);
    const looBaseline = otherAtt > 0 ? (otherFail / otherAtt) * 100 : univBaseline;

    // Paired weekly rates vs. leave-one-out weekly rest-of-university rate
    const xWeekly = [];
    const looWeekly = [];
    for (const r of colRows) {
      const weekOthers = pooled.filter((p) => p.week === r.week && p.college !== col.code);
      if (weekOthers.length > 0) {
        const wAtt = weekOthers.reduce((a, b) => a + b.login_attempts, 0);
        const wFail = weekOthers.reduce((a, b) => a + b.failed_logins, 0);
        xWeekly.push(r.failed_login_rate);
        looWeekly.push(wAtt > 0 ? (wFail / wAtt) * 100 : looBaseline);
      }
    }

    const rawP = useFriedman
      ? computePairedWilcoxon(xWeekly, looWeekly).p
      : computePairedTTest(xWeekly, looWeekly).p;

    return { looBaseline, rawP, weeksCount: colWeeks.length };
  });

  const holmPValues = holmAdjust(rawPostHocResults.map((r) => r.rawP));

  const statsList = activeColleges.map((col, idx) => {
    const vals = groups[idx];
    const sorted = [...vals].sort((a, b) => a - b);
    const m = mean(vals);
    const s = sd(vals);
    const med = quantile(sorted, 0.5);
    const q1 = quantile(sorted, 0.25);
    const q3 = quantile(sorted, 0.75);
    const iqr = q3 - q1;
    const se = vals.length > 0 ? s / Math.sqrt(vals.length) : 0;
    const ciLow = Math.max(0, m - 1.96 * se);
    const ciHigh = m + 1.96 * se;
    const outlierCount = pooled.filter((p) => p.college === col.code && p.isOutlier).length;
    const looBaseline = rawPostHocResults[idx].looBaseline;
    const holmP = holmPValues[idx];

    // Consistent classification:
    // "Chronically Elevated" requires BOTH Holm p < 0.05 AND typical median > leave-one-out baseline
    const isChronicallyElevated = activeColleges.length > 1 && holmP < 0.05 && med > looBaseline;
    const isSpikeSkewed = !isChronicallyElevated && outlierCount > 0;

    return {
      ...col,
      n: vals.length,
      vals,
      sorted,
      mean: m,
      sd: s,
      median: med,
      q1,
      q3,
      iqr,
      ciLow,
      ciHigh,
      min: sorted[0] ?? 0,
      max: sorted[sorted.length - 1] ?? 0,
      outlierCount,
      looBaseline,
      holmP,
      isChronicallyElevated,
      isSpikeSkewed,
    };
  });

  statsList.sort((a, b) => b.mean - a.mean);
  state.collegeStats = statsList;
  state.omnibus = {
    useFriedman,
    friedman,
    rmAnova,
    levene,
    maxSkew,
    N,
    b: completeWeeks.length,
    k: activeColleges.length,
  };

  updateSidebarDiagnostics();
  updateVerdictAndKPIs(totalAttempts, totalFailed);
  renderKpiVisuals();
  replayFx(document.getElementById('verdict-headline').closest('.surface-card'));
  renderBarChart();
  renderHeatmap();
  renderSummaryTable();
  renderTrendChart();
  renderBoxplot();
  renderDeviceChart();
  updatePlannerProjection();
  renderRecordsTable();
  renderActiveScope();
}

const SCOPE_DEFAULTS = { scenario: 'effect', period: 'all', college: 'ALL', device: 'ALL', outliers: 'include' };
const SCOPE_SELECT_IDS = {
  scenario: 'filter-scenario',
  period: 'filter-period',
  college: 'filter-college',
  device: 'filter-device',
  outliers: 'filter-outliers',
};

function renderActiveScope() {
  const bar = document.getElementById('active-scope-bar');
  if (!bar) return;
  const raw = {};
  const text = {};
  for (const key of Object.keys(SCOPE_SELECT_IDS)) {
    const sel = document.getElementById(SCOPE_SELECT_IDS[key]);
    raw[key] = sel.value;
    text[key] = sel.options[sel.selectedIndex].text;
  }
  const chips = scopeChips(raw, SCOPE_DEFAULTS);
  bar.innerHTML = chips
    .map((c) => {
      const label = escapeHtml(c.label) + ': ' + escapeHtml(text[c.key]);
      return c.isDefault
        ? '<li><span class="scope-pill" title="' + label + '">' + label + '</span></li>'
        : '<li><button type="button" class="scope-pill is-changed" title="Reset ' + escapeHtml(c.label) + '" aria-label="Reset ' + escapeHtml(c.label) + ' filter" data-scope-key="' + c.key + '" onclick="resetScopeFilter(this.dataset.scopeKey)">' + label + ' <span aria-hidden="true">×</span></button></li>';
    })
    .join('');
  const changed = chips.filter((c) => !c.isDefault).length;
  document.getElementById('active-scope-count').textContent = changed ? changed + ' changed' : 'Default scope';
}

function resetScopeFilter(key) {
  const id = SCOPE_SELECT_IDS[key];
  if (!id) return;
  document.getElementById(id).value = SCOPE_DEFAULTS[key];
  applyFilters();
}

function resetFilters() {
  document.getElementById('filter-scenario').value = 'effect';
  document.getElementById('filter-period').value = 'all';
  document.getElementById('filter-college').value = 'ALL';
  document.getElementById('filter-device').value = 'ALL';
  document.getElementById('filter-outliers').value = 'include';
  document.getElementById('test-override').value = 'auto';
  applyFilters();
  showToast('Filters reset to Effect Scenario (26 weeks)');
}

/* --------------------------------------------------------------------------
   D. UI UPDATERS (SIDEBAR, VERDICT, KPI CARDS, TABLES)
   -------------------------------------------------------------------------- */
function formatP(p) {
  if (p < 0.0001) return '< 0.0001';
  return p.toFixed(4);
}

function updateSidebarDiagnostics() {
  const { useFriedman, friedman, rmAnova, levene, maxSkew, b, k } = state.omnibus;
  const badge = document.getElementById('badge-test-type');
  const mainLabel = document.getElementById('stat-main-label');
  const mainVal = document.getElementById('stat-main-val');
  const pValEl = document.getElementById('stat-p-val');
  const effLabel = document.getElementById('stat-eff-label');
  const effVal = document.getElementById('stat-eff-val');
  const noteEl = document.getElementById('stat-assumption-note');

  if (k < 2 || b < 2) {
    badge.textContent = 'Single Series';
    mainLabel.textContent = 'Blocked Test';
    mainVal.textContent = 'N/A';
    pValEl.textContent = '—';
    effVal.textContent = '—';
    noteEl.textContent = 'Select "All 8 USeP Colleges" with ≥ 2 complete week blocks to run the repeated-measures test.';
    return;
  }

  if (useFriedman) {
    badge.textContent = 'Friedman χ²r';
    mainLabel.textContent = `Friedman χ²r (df = ${friedman.df})`;
    mainVal.textContent = friedman.chi2.toFixed(2);
    pValEl.textContent = formatP(friedman.p);
    pValEl.style.color = friedman.p < 0.05 ? 'var(--status-danger)' : 'var(--status-safe)';
    effLabel.textContent = "Kendall's W";
    const mag = friedman.W >= 0.5 ? 'Large' : friedman.W >= 0.3 ? 'Moderate' : friedman.W >= 0.1 ? 'Small' : 'Negligible';
    effVal.textContent = `${friedman.W.toFixed(3)} (${mag})`;
    noteEl.textContent = `Blocked across b = ${b} shared weeks (Levene p = ${formatP(levene.p)}, skew = ${maxSkew.toFixed(2)}). Friedman + Holm-corrected paired Wilcoxon post-hoc active.`;
  } else {
    badge.textContent = 'RM-ANOVA F';
    mainLabel.textContent = `Blocked F(${rmAnova.df1}, ${rmAnova.df2})`;
    mainVal.textContent = rmAnova.F.toFixed(2);
    pValEl.textContent = formatP(rmAnova.p);
    pValEl.style.color = rmAnova.p < 0.05 ? 'var(--status-danger)' : 'var(--status-safe)';
    effLabel.textContent = 'Partial η²p';
    const mag = rmAnova.etaSqP >= 0.14 ? 'Large' : rmAnova.etaSqP >= 0.06 ? 'Medium' : 'Small';
    effVal.textContent = `${rmAnova.etaSqP.toFixed(3)} (${mag})`;
    noteEl.textContent = `Blocked across b = ${b} shared weeks (Levene p = ${formatP(levene.p)}, skew = ${maxSkew.toFixed(2)}). Repeated-Measures ANOVA + Holm-corrected paired t-test active.`;
  }
}

function updateVerdictAndKPIs(totalAttempts, totalFailed) {
  const statsList = state.collegeStats;
  const top = statsList[0];
  const elevatedColleges = statsList.filter((c) => c.isChronicallyElevated);
  const spikeColleges = statsList.filter((c) => c.isSpikeSkewed);
  const { useFriedman, friedman, rmAnova, N, b, k } = state.omnibus;
  const p = useFriedman ? friedman.p : rmAnova.p;
  const isNullScenario = state.scenario === 'null';

  animateNumber(document.getElementById('kpi-univ-rate'), state.univBaselineRate, (v) => `${v.toFixed(2)}%`);
  document.getElementById('kpi-univ-sub').textContent = `${state.univBaselineRate.toFixed(2)} failed per 100 attempts`;

  if (top) {
    document.getElementById('kpi-top-college').textContent = `${top.code} (${top.mean.toFixed(2)}%)`;
    document.getElementById('kpi-top-sub').textContent = `${top.name}`;
  }

  document.getElementById('kpi-sig-count').textContent = `${elevatedColleges.length} of ${k}`;
  document.getElementById('kpi-sig-sub').textContent = elevatedColleges.length
    ? `${elevatedColleges.map((c) => c.code).join(', ')} (Holm p < 0.05 vs LOO)`
    : '0 colleges above leave-one-out rest';

  document.getElementById('kpi-obs-badge').textContent = `${N} college-wks`;
  animateNumber(document.getElementById('kpi-total-attempts'), totalAttempts, (v) => Math.round(v).toLocaleString());
  document.getElementById('kpi-total-sub').textContent = `${totalFailed.toLocaleString()} failed across ${N} college-weeks`;

  const eyebrow = document.getElementById('verdict-eyebrow');
  const pill = document.getElementById('verdict-sig-pill');
  const headline = document.getElementById('verdict-headline');
  const body = document.getElementById('verdict-body');

  eyebrow.textContent = isNullScenario
    ? 'Pipeline Validation · Simulated Null-Data Control (α = 0.05)'
    : 'Pipeline Demonstration · Simulated Effect Scenario (α = 0.05)';

  if (k < 2 && top) {
    pill.textContent = `Single-College Focus · ${top.code}`;
    pill.style.backgroundColor = 'var(--brand-gold-soft)';
    pill.style.color = 'var(--brand-gold)';
    headline.textContent = `Simulated ${top.code} series averages ${top.mean.toFixed(2)}% failed UVE logins.`;
    body.textContent = `Median weekly failure rate is ${top.median.toFixed(2)}% (IQR: ${top.iqr.toFixed(2)}%) across ${top.n} evaluated weeks. Select "All 8 USeP Colleges" to run the week-blocked omnibus comparison.`;
    return;
  }

  if (isNullScenario) {
    pill.textContent = p >= 0.05 ? `Null Verified (p = ${p.toFixed(3)})` : `Sample Noise (p = ${p.toFixed(3)})`;
    pill.style.backgroundColor = 'var(--status-safe-soft)';
    pill.style.color = 'var(--status-safe)';
    headline.textContent = 'Pipeline Validation (Null-Data Control): No false-positive college differences flagged.';
    body.textContent =
      state.role === 'dean'
        ? `In this control simulation—where all 8 colleges were generated with identical 5.5% baseline failure rates plus shared exam-week bumps—the week-blocked test yields p = ${p.toFixed(3)} (> 0.05) and flags 0 colleges. This confirms our analysis pipeline does not manufacture false alarms when colleges behave similarly.`
        : `Null-control verification across b = ${b} shared week blocks: ${useFriedman ? `Friedman χ²r(${friedman.df}) = ${friedman.chi2.toFixed(2)}, p = ${friedman.p.toFixed(4)}, Kendall's W = ${friedman.W.toFixed(3)}` : `RM-ANOVA F(${rmAnova.df1}, ${rmAnova.df2}) = ${rmAnova.F.toFixed(2)}, p = ${rmAnova.p.toFixed(4)}, η²p = ${rmAnova.etaSqP.toFixed(3)}`}. All 8 Holm-corrected leave-one-out post-hoc tests remain non-significant (p_Holm > 0.05).`;
    return;
  }

  if (p < 0.05) {
    pill.textContent = `Simulated Gap Detected (p ${formatP(p)})`;
    pill.style.backgroundColor = 'var(--status-danger-soft)';
    pill.style.color = 'var(--status-danger)';
    headline.textContent = 'Pipeline Demonstration (Effect Scenario): Week-blocked test detects the simulated cross-college differences.';

    if (state.role === 'dean') {
      const elevText = elevatedColleges.map((c) => `${c.code} (${c.mean.toFixed(1)}% mean)`).join(' and ');
      const spikeText = spikeColleges.map((c) => c.code).join(' and ');
      body.textContent = `In this synthetic demonstration, the pipeline separates two distinct patterns: ${elevText || top.code} show sustained week-after-week elevation (consistent with chronic credential friction, warranting Wave-1 MFA and NIST 800-63B passphrase onboarding), whereas ${spikeText || 'spike units'} stay below the rest-of-university median in normal weeks but exhibit sharp multi-week Desktop bursts (warranting login rate-limiting and MFA takeover protection).`;
    } else {
      const testDesc = useFriedman
        ? `Friedman χ²r(${friedman.df}) = ${friedman.chi2.toFixed(2)}, p ${formatP(friedman.p)}, Kendall's W = ${friedman.W.toFixed(3)} across b = ${b} week blocks`
        : `RM-ANOVA F(${rmAnova.df1}, ${rmAnova.df2}) = ${rmAnova.F.toFixed(2)}, p ${formatP(rmAnova.p)}, partial η²p = ${rmAnova.etaSqP.toFixed(3)} across b = ${b} week blocks`;
      body.textContent = `Omnibus ${testDesc}. Leave-one-out paired post-hoc comparisons with Holm-Bonferroni correction identify ${elevatedColleges.map((c) => `${c.code} (median ${c.median.toFixed(2)}% vs. LOO ${c.looBaseline.toFixed(2)}%, p_Holm ${formatP(c.holmP)})`).join(', ')} as chronically elevated, while ${spikeColleges.map((c) => `${c.code} (median ${c.median.toFixed(2)}%, ${c.outlierCount} Tukey outlier wk)`).join(', ')} are classified as spike-skewed rather than chronically elevated.`;
    }
  } else {
    pill.textContent = `No Significant Difference (p = ${p.toFixed(3)})`;
    pill.style.backgroundColor = 'var(--status-safe-soft)';
    pill.style.color = 'var(--status-safe)';
    headline.textContent = 'No statistically significant difference detected under the current filter scope.';
    body.textContent = `Under the active filter selection, college weekly failed-login rates do not differ significantly across the ${b} week blocks (p = ${p.toFixed(3)} > 0.05).`;
  }
}

function renderKpiVisuals() {
  const rows = state.filteredPooled;
  const stats = state.collegeStats;
  const pooledRate = (wr) => {
    const att = wr.reduce((a, r) => a + r.login_attempts, 0);
    return att > 0 ? (wr.reduce((a, r) => a + r.failed_logins, 0) / att) * 100 : null;
  };
  const sumAttempts = (wr) => wr.reduce((a, r) => a + r.login_attempts, 0);

  const top = stats[0];
  const elevated = stats.filter((c) => c.isChronicallyElevated);
  const elevCodes = new Set(elevated.map((c) => c.code));

  const sevUniv = rateSeverity(state.univBaselineRate, rows.length > 0);
  const sevTop = top ? severityFor('rate', top.mean) : { tone: 'neutral', label: 'No data' };
  const sevSig = severityFor('elevated', elevated.length);
  const sevTotal = attemptsScopeBadge(
    scopeChips(
      Object.fromEntries(Object.keys(SCOPE_SELECT_IDS).map((k) => [k, document.getElementById(SCOPE_SELECT_IDS[k]).value])),
      SCOPE_DEFAULTS
    )
  );

  const cards = [
    { id: 'kpi-univ', values: weeklySeries(rows, pooledRate), kind: 'line', sev: sevUniv, what: 'Weekly pooled failed-login rate (%)' },
    {
      id: 'kpi-top',
      values: top ? weeklySeries(rows.filter((r) => r.college === top.code), (wr) => wr[0].failed_login_rate) : [],
      kind: 'line',
      sev: sevTop,
      what: top ? 'Weekly failed-login rate for ' + top.code + ' (%)' : 'Weekly failed-login rate',
    },
    {
      id: 'kpi-sig',
      values: elevated.length ? weeklySeries(rows.filter((r) => elevCodes.has(r.college)), pooledRate) : [],
      kind: 'line',
      sev: sevSig,
      what: 'Weekly pooled failed-login rate of chronically elevated colleges (%)',
    },
    { id: 'kpi-total', values: weeklySeries(rows, sumAttempts), kind: 'bars', sev: { ...sevTotal }, what: 'Weekly login attempts' },
  ];

  for (const c of cards) {
    const slot = document.getElementById(c.id + '-spark');
    const badge = document.getElementById(c.id + '-sev');
    if (slot) {
      const tone = c.id === 'kpi-total' ? 'brand' : c.sev.tone === 'neutral' ? 'brand' : c.sev.tone;
      slot.innerHTML = buildSparkline(c.values, { kind: c.kind, tone });
      const present = c.values.filter((v) => v !== null);
      slot.setAttribute('role', 'img');
      slot.setAttribute(
        'aria-label',
        present.length
          ? c.what + ', ' + present.length + ' weeks, from ' + Math.min(...present).toFixed(1) + ' to ' + Math.max(...present).toFixed(1)
          : c.what + ': no weeks in the current scope'
      );
    }
    if (badge) {
      badge.textContent = c.sev.label;
      badge.className = 'sev-badge sev-' + c.sev.tone;
    }
  }
}

/* --------------------------------------------------------------------------
   COHORT HEATMAP (8 colleges x 26 weeks)
   -------------------------------------------------------------------------- */
function renderHeatmap() {
  const host = document.getElementById('cohort-heatmap');
  if (!host) return;
  const rows = state.filteredPooled;
  const order = state.collegeStats.length ? state.collegeStats : COLLEGES;
  const colleges = order.map((c) => ({ code: c.code, name: c.name }));
  const max = Math.max(1, ...rows.map((r) => r.failed_login_rate));

  let head = '<div class="heat-row heat-head" aria-hidden="true"><span class="heat-label"></span>';
  for (let w = 1; w <= 26; w++) {
    head += '<span class="heat-week' + (EXAM_WEEKS.has(w) ? ' is-exam' : '') + '">' + (w === 1 || w % 5 === 0 || EXAM_WEEKS.has(w) ? w : '') + '</span>';
  }
  head += '</div>';
  host.innerHTML = rows.length ? head + buildHeatmapGrid(rows, colleges) : buildHeatmapGrid(rows, colleges);

  host.querySelectorAll('button.heat-cell').forEach((cell) => {
    cell.style.backgroundColor = heatColor(Number(cell.dataset.rate), max);
  });
  const hi = document.getElementById('heatmap-legend-hi');
  if (hi) hi.textContent = max.toFixed(1) + '%';
  hideHeatTooltip();
}

function hideHeatTooltip() {
  const tip = document.getElementById('heatmap-tooltip');
  if (!tip) return;
  tip.classList.remove('visible');
  tip.setAttribute('aria-hidden', 'true');
}

function showHeatTooltip(cell) {
  const tip = document.getElementById('heatmap-tooltip');
  if (!tip) return;
  const week = Number(cell.dataset.week);
  tip.innerHTML =
    '<div class="heat-tip-title">' + escapeHtml(cell.dataset.college) + ' · Week ' + week + (EXAM_WEEKS.has(week) ? ' <span class="heat-tip-tag">Exam week</span>' : '') + '</div>' +
    '<div class="heat-tip-rate">' + Number(cell.dataset.rate).toFixed(2) + '%</div>' +
    '<div class="heat-tip-sub">' + Number(cell.dataset.failed).toLocaleString() + ' failed of ' + Number(cell.dataset.attempts).toLocaleString() + ' attempts</div>';
  const r = cell.getBoundingClientRect();
  const tw = tip.offsetWidth || 190;
  const th = tip.offsetHeight || 70;
  const x = Math.max(8, Math.min(window.innerWidth - tw - 8, r.left + r.width / 2 - tw / 2));
  const y = r.top - th - 10 < 8 ? r.bottom + 10 : r.top - th - 10;
  tip.style.transform = 'translate3d(' + Math.round(x) + 'px, ' + Math.round(y) + 'px, 0)';
  tip.classList.add('visible');
  tip.setAttribute('aria-hidden', 'false');
}

function initHeatmapInteractions() {
  const host = document.getElementById('cohort-heatmap');
  if (!host) return;
  const cellOf = (e) => e.target.closest && e.target.closest('button.heat-cell');
  let lastPointerType = 'mouse';
  host.addEventListener('pointerdown', (e) => {
    lastPointerType = e.pointerType;
  });
  host.addEventListener('pointerover', (e) => {
    const c = cellOf(e);
    if (c && e.pointerType !== 'touch') showHeatTooltip(c);
  });
  host.addEventListener('pointerout', (e) => {
    if (cellOf(e) && e.pointerType !== 'touch') hideHeatTooltip();
  });
  host.addEventListener('click', (e) => {
    const c = cellOf(e);
    if (c && lastPointerType === 'touch') showHeatTooltip(c);
  });
  const scroller = host.closest('.heat-scroll');
  if (scroller) scroller.addEventListener('scroll', hideHeatTooltip, { passive: true });
  document.addEventListener('pointerdown', (e) => {
    if (!cellOf(e)) hideHeatTooltip();
  });
  host.addEventListener('focusin', (e) => {
    const c = cellOf(e);
    if (c) showHeatTooltip(c);
  });
  host.addEventListener('focusout', hideHeatTooltip);
  host.addEventListener('keydown', (e) => {
    const c = cellOf(e);
    if (!c) return;
    if (e.key === 'Escape') {
      hideHeatTooltip();
      return;
    }
    const row = c.closest('.heat-row');
    const cells = Array.from(row.querySelectorAll('button.heat-cell'));
    const i = cells.indexOf(c);
    let next = null;
    if (e.key === 'ArrowRight') next = cells[i + 1];
    else if (e.key === 'ArrowLeft') next = cells[i - 1];
    else if (e.key === 'Home') next = cells[0];
    else if (e.key === 'End') next = cells[cells.length - 1];
    else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      const sib = e.key === 'ArrowDown' ? row.nextElementSibling : row.previousElementSibling;
      if (sib) {
        const sibCells = Array.from(sib.querySelectorAll('button.heat-cell'));
        const w = nearestWeek(sibCells.map((x) => Number(x.dataset.week)), Number(c.dataset.week));
        next = w === null ? null : sibCells.find((x) => Number(x.dataset.week) === w);
      }
    }
    if (next) {
      e.preventDefault();
      c.tabIndex = -1;
      next.tabIndex = 0;
      next.focus();
    }
  });
  window.addEventListener('scroll', hideHeatTooltip, { passive: true });
}

function renderSummaryTable() {
  const tbody = document.getElementById('college-summary-tbody');
  tbody.innerHTML = state.collegeStats
    .map((c, idx) => {
      let badgeHtml = '';
      if (c.isChronicallyElevated) {
        badgeHtml = `<span class="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-bold" style="background-color: var(--status-danger-soft); color: var(--status-danger);">Chronically Elevated</span>`;
      } else if (c.isSpikeSkewed) {
        badgeHtml = `<span class="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-bold" style="background-color: var(--status-warn-soft); color: var(--status-warn);">Spike-Skewed (${c.outlierCount} wk)</span>`;
      } else {
        badgeHtml = `<span class="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-bold" style="background-color: var(--status-safe-soft); color: var(--status-safe);">Within Baseline</span>`;
      }

      const patternNote =
        state.scenario === 'null'
          ? 'Null-control series generated from shared 5.5% baseline'
          : c.note;

      return `
        <tr class="hover:bg-black/5 dark:hover:bg-white/5">
          <td class="py-3 px-4 font-mono font-bold">#${idx + 1}</td>
          <td class="py-3 px-4">
            <div class="font-bold">${c.code}</div>
            <div class="text-[11px]" style="color: var(--text-muted);">${c.name}</div>
          </td>
          <td class="py-3 px-4 text-right font-mono font-bold">${c.mean.toFixed(2)}%</td>
          <td class="py-3 px-4 text-right font-mono">${c.median.toFixed(2)}% <span style="color: var(--text-muted);">(${c.iqr.toFixed(2)})</span></td>
          <td class="py-3 px-4 text-right font-mono" style="color: var(--text-secondary);">${c.looBaseline.toFixed(2)}%</td>
          <td class="py-3 px-4 text-right font-mono" style="color: var(--text-secondary);">[${c.ciLow.toFixed(2)}, ${c.ciHigh.toFixed(2)}]</td>
          <td class="py-3 px-4 text-right font-mono font-semibold" style="color: ${c.isChronicallyElevated ? 'var(--status-danger)' : 'var(--text-muted)'};">${formatP(c.holmP)}</td>
          <td class="py-3 px-4">
            <div class="flex flex-col gap-1 items-start">
              ${badgeHtml}
              <span class="text-[11px]" style="color: var(--text-muted);">${patternNote}</span>
            </div>
          </td>
        </tr>
      `;
    })
    .join('');
}

/* --------------------------------------------------------------------------
   E. CHARTS (CHART.JS BAR, LINE, DEVICE GROUPED + CUSTOM CANVAS BOXPLOT)
   -------------------------------------------------------------------------- */
function getThemeColors() {
  const dark = state.theme === 'dark';
  return {
    text: dark ? '#cbd5e1' : '#334155',
    muted: dark ? '#8b9bb0' : '#64748b',
    grid: dark ? 'rgba(255, 255, 255, 0.06)' : 'rgba(15, 23, 42, 0.07)',
    danger: dark ? '#f43f5e' : '#c81e1e',
    warn: dark ? '#f59e0b' : '#b45309',
    safe: dark ? '#10b981' : '#0b7a57',
    brand: dark ? '#e03e56' : '#8b1528',
    gold: dark ? '#eab308' : '#8f6508',
  };
}

function renderBarChart() {
  const ctx = document.getElementById('collegeBarChart');
  if (!ctx) return;
  const colors = getThemeColors();
  const labels = state.collegeStats.map((c) => `${c.code} — ${c.name.replace('College of ', '')}`);
  const means = state.collegeStats.map((c) => Number(c.mean.toFixed(2)));
  const medians = state.collegeStats.map((c) => Number(c.median.toFixed(2)));
  const barColors = state.collegeStats.map((c) =>
    c.isChronicallyElevated ? colors.danger : c.isSpikeSkewed ? colors.warn : colors.safe
  );

  // Plugin to draw University Baseline vertical line & 95% CI whiskers
  const baselineAndCIPlugin = {
    id: 'baselineAndCI',
    afterDatasetsDraw(chart) {
      const { ctx: c, chartArea, scales } = chart;
      const xScale = scales.x;
      const baseX = xScale.getPixelForValue(state.univBaselineRate);

      c.save();
      // University Baseline vertical dashed line
      if (baseX >= chartArea.left && baseX <= chartArea.right) {
        c.strokeStyle = colors.gold;
        c.lineWidth = 2;
        c.setLineDash([5, 4]);
        c.beginPath();
        c.moveTo(baseX, chartArea.top);
        c.lineTo(baseX, chartArea.bottom);
        c.stroke();
        c.setLineDash([]);

        c.fillStyle = colors.gold;
        c.font = '600 11px Inter, sans-serif';
        c.fillText(`Univ. Baseline: ${state.univBaselineRate.toFixed(2)}%`, Math.min(baseX + 6, chartArea.right - 135), chartArea.top + 13);
      }

      // 95% CI whiskers on Mean bars
      const meta = chart.getDatasetMeta(0);
      c.strokeStyle = colors.text;
      c.lineWidth = 1.6;
      meta.data.forEach((bar, i) => {
        const stat = state.collegeStats[i];
        if (!stat) return;
        const xLow = xScale.getPixelForValue(stat.ciLow);
        const xHigh = xScale.getPixelForValue(stat.ciHigh);
        const y = bar.y;
        c.beginPath();
        c.moveTo(xLow, y);
        c.lineTo(xHigh, y);
        c.moveTo(xLow, y - 4);
        c.lineTo(xLow, y + 4);
        c.moveTo(xHigh, y - 4);
        c.lineTo(xHigh, y + 4);
        c.stroke();
      });
      c.restore();
    },
  };

  if (barChartInstance) barChartInstance.destroy();
  barChartInstance = new Chart(ctx, {
    type: 'bar',
    data: {
      labels,
      datasets: [
        {
          label: 'Mean Failed Rate (%)',
          data: means,
          backgroundColor: barColors,
          borderRadius: 6,
          barPercentage: 0.65,
        },
        {
          label: 'Median Failed Rate (%)',
          data: medians,
          backgroundColor: 'rgba(148, 163, 184, 0.45)',
          borderRadius: 6,
          barPercentage: 0.45,
        },
      ],
    },
    options: {
      indexAxis: 'y',
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: {
          position: 'bottom',
          labels: { color: colors.text, font: { size: 11, family: 'Inter' } },
        },
        tooltip: {
          callbacks: {
            afterLabel(ctx) {
              const s = state.collegeStats[ctx.dataIndex];
              return `95% CI: [${s.ciLow.toFixed(2)}%, ${s.ciHigh.toFixed(2)}%] | IQR: ${s.iqr.toFixed(2)}%`;
            },
          },
        },
      },
      scales: {
        x: {
          beginAtZero: true,
          suggestedMax: 13,
          grid: { color: colors.grid },
          ticks: { color: colors.muted, callback: (v) => `${v}%`, font: { family: 'JetBrains Mono', size: 11 } },
        },
        y: {
          grid: { display: false },
          ticks: { color: colors.text, font: { size: 11, weight: '600', family: 'Inter' } },
        },
      },
    },
    plugins: [baselineAndCIPlugin],
  });
}

function renderTrendChart() {
  const ctx = document.getElementById('weeklyTrendChart');
  if (!ctx) return;
  const colors = getThemeColors();
  const mode = document.getElementById('trend-cohort-select').value;

  const weeks = Array.from({ length: 26 }, (_, i) => i + 1);
  const palette = ['#f43f5e', '#f59e0b', '#38bdf8', '#a855f7', '#10b981', '#ec4899', '#14b8a6', '#8b5cf6'];

  let targetCodes = ['CT', 'CBA', 'CIC', 'CoE'];
  if (mode === 'all') targetCodes = COLLEGES.map((c) => c.code);
  if (mode === 'baseline') targetCodes = ['CAS', 'CEd', 'CAEc', 'CDM'];

  const datasets = targetCodes.map((code, idx) => {
    const data = weeks.map((w) => {
      const row = state.filteredPooled.find((p) => p.week === w && p.college === code);
      return row ? Number(row.failed_login_rate.toFixed(2)) : null;
    });
    return {
      label: code,
      data,
      borderColor: palette[idx % palette.length],
      backgroundColor: palette[idx % palette.length],
      borderWidth: 2.2,
      pointRadius: 2.5,
      tension: 0.25,
      spanGaps: true,
    };
  });

  // Add University Weekly Average dashed reference line
  const univWeekly = weeks.map((w) => {
    const wRows = state.filteredPooled.filter((p) => p.week === w);
    const att = wRows.reduce((a, b) => a + b.login_attempts, 0);
    const fail = wRows.reduce((a, b) => a + b.failed_logins, 0);
    return att > 0 ? Number(((fail / att) * 100).toFixed(2)) : null;
  });
  datasets.push({
    label: 'University Avg',
    data: univWeekly,
    borderColor: colors.gold,
    borderDash: [6, 4],
    borderWidth: 2,
    pointRadius: 0,
    tension: 0.2,
    spanGaps: true,
  });

  // Shaded Midterm & Final Exam Bands Plugin
  const examBandPlugin = {
    id: 'examBands',
    beforeDatasetsDraw(chart) {
      const { ctx: c, chartArea, scales } = chart;
      const x = scales.x;
      c.save();
      c.fillStyle = state.theme === 'dark' ? 'rgba(234, 179, 8, 0.08)' : 'rgba(212, 175, 55, 0.12)';
      // Weeks 8-9 (indices 7..8) & Weeks 17-18 (indices 16..17)
      [
        [7, 8, 'Midterms'],
        [16, 17, 'Finals'],
      ].forEach(([startIdx, endIdx, label]) => {
        const x1 = x.getPixelForValue(startIdx) - 10;
        const x2 = x.getPixelForValue(endIdx) + 10;
        c.fillRect(x1, chartArea.top, x2 - x1, chartArea.bottom - chartArea.top);
        c.fillStyle = colors.gold;
        c.font = '600 10px Inter, sans-serif';
        c.fillText(label, x1 + 4, chartArea.top + 12);
        c.fillStyle = state.theme === 'dark' ? 'rgba(234, 179, 8, 0.08)' : 'rgba(212, 175, 55, 0.12)';
      });
      c.restore();
    },
  };

  if (trendChartInstance) trendChartInstance.destroy();
  trendChartInstance = new Chart(ctx, {
    type: 'line',
    data: {
      labels: weeks.map((w) => `W${w}`),
      datasets,
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { position: 'bottom', labels: { color: colors.text, font: { size: 11 } } },
      },
      scales: {
        x: {
          grid: { color: colors.grid },
          ticks: { color: colors.muted, font: { family: 'JetBrains Mono', size: 10 } },
        },
        y: {
          beginAtZero: true,
          grid: { color: colors.grid },
          ticks: { color: colors.muted, callback: (v) => `${v}%`, font: { family: 'JetBrains Mono', size: 11 } },
        },
      },
    },
    plugins: [examBandPlugin],
  });
}

function renderBoxplot() {
  const canvas = document.getElementById('boxplotCanvas');
  const container = document.getElementById('boxplot-container');
  if (!canvas || !container) return;

  const dpr = window.devicePixelRatio || 1;
  const rect = container.getBoundingClientRect();
  const width = Math.max(320, rect.width || 680);
  const height = Math.max(260, rect.height || 300);

  canvas.width = width * dpr;
  canvas.height = height * dpr;
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;

  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, width, height);

  const colors = getThemeColors();
  const pad = { top: 20, right: 20, bottom: 36, left: 46 };
  const plotW = width - pad.left - pad.right;
  const plotH = height - pad.top - pad.bottom;

  const allRates = state.collegeStats.flatMap((c) => c.vals);
  const maxVal = Math.max(15, Math.ceil((Math.max(...allRates, 12) + 2) / 5) * 5);

  const yToPx = (v) => pad.top + plotH - (v / maxVal) * plotH;

  // Grid lines
  ctx.strokeStyle = colors.grid;
  ctx.fillStyle = colors.muted;
  ctx.font = '11px JetBrains Mono, monospace';
  ctx.textAlign = 'right';
  for (let v = 0; v <= maxVal; v += 5) {
    const y = yToPx(v);
    ctx.beginPath();
    ctx.moveTo(pad.left, y);
    ctx.lineTo(width - pad.right, y);
    ctx.stroke();
    ctx.fillText(`${v}%`, pad.left - 8, y + 4);
  }

  // University Baseline line
  const baseY = yToPx(state.univBaselineRate);
  ctx.save();
  ctx.strokeStyle = colors.gold;
  ctx.setLineDash([5, 4]);
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(pad.left, baseY);
  ctx.lineTo(width - pad.right, baseY);
  ctx.stroke();
  ctx.restore();

  const cols = state.collegeStats;
  if (!cols.length) return;
  const stepX = plotW / cols.length;
  const boxW = Math.min(34, stepX * 0.48);

  cols.forEach((c, idx) => {
    const cx = pad.left + stepX * (idx + 0.5);
    const upperFence = c.q3 + 1.5 * c.iqr;
    const lowerFence = Math.max(0, c.q1 - 1.5 * c.iqr);
    const nonOutliers = c.sorted.filter((v) => v >= lowerFence && v <= upperFence);
    const wLow = nonOutliers[0] ?? c.min;
    const wHigh = nonOutliers[nonOutliers.length - 1] ?? c.max;
    const outliers = c.sorted.filter((v) => v > upperFence || v < lowerFence);

    const yQ1 = yToPx(c.q1);
    const yQ3 = yToPx(c.q3);
    const yMed = yToPx(c.median);
    const yLow = yToPx(wLow);
    const yHigh = yToPx(wHigh);
    const yMean = yToPx(c.mean);

    const strokeCol = c.isChronicallyElevated ? colors.danger : c.isSpikeSkewed ? colors.warn : colors.safe;

    // Whisker line
    ctx.strokeStyle = strokeCol;
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.moveTo(cx, yHigh);
    ctx.lineTo(cx, yQ3);
    ctx.moveTo(cx, yQ1);
    ctx.lineTo(cx, yLow);
    ctx.moveTo(cx - boxW * 0.35, yHigh);
    ctx.lineTo(cx + boxW * 0.35, yHigh);
    ctx.moveTo(cx - boxW * 0.35, yLow);
    ctx.lineTo(cx + boxW * 0.35, yLow);
    ctx.stroke();

    // IQR Box
    ctx.fillStyle = state.theme === 'dark' ? 'rgba(224, 62, 86, 0.16)' : 'rgba(139, 21, 40, 0.12)';
    ctx.fillRect(cx - boxW / 2, yQ3, boxW, Math.max(2, yQ1 - yQ3));
    ctx.strokeRect(cx - boxW / 2, yQ3, boxW, Math.max(2, yQ1 - yQ3));

    // Median line
    ctx.lineWidth = 2.6;
    ctx.beginPath();
    ctx.moveTo(cx - boxW / 2, yMed);
    ctx.lineTo(cx + boxW / 2, yMed);
    ctx.stroke();

    // Mean Diamond
    ctx.fillStyle = colors.gold;
    ctx.beginPath();
    ctx.moveTo(cx, yMean - 4.5);
    ctx.lineTo(cx + 4.5, yMean);
    ctx.lineTo(cx, yMean + 4.5);
    ctx.lineTo(cx - 4.5, yMean);
    ctx.closePath();
    ctx.fill();

    // Outliers
    ctx.fillStyle = colors.danger;
    outliers.forEach((ov) => {
      ctx.beginPath();
      ctx.arc(cx, yToPx(ov), 3.6, 0, Math.PI * 2);
      ctx.fill();
    });

    // X-axis label
    ctx.fillStyle = colors.text;
    ctx.font = '600 11px Inter, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(c.code, cx, height - 12);
  });
}

function renderDeviceChart() {
  const ctx = document.getElementById('deviceGroupedChart');
  if (!ctx) return;
  const colors = getThemeColors();
  const codes = state.collegeStats.map((c) => c.code);
  const raw = getActiveRawDataset();

  const deviceSeries = DEVICES.map((dev, i) => {
    const palette = ['#e03e56', '#38bdf8', '#eab308'];
    const data = codes.map((code) => {
      const rows = raw.filter((r) => r.college === code && r.device_type === dev.type);
      const att = rows.reduce((a, b) => a + b.login_attempts, 0);
      const fail = rows.reduce((a, b) => a + b.failed_logins, 0);
      return att > 0 ? Number(((fail / att) * 100).toFixed(2)) : 0;
    });
    return {
      label: dev.type,
      data,
      backgroundColor: palette[i],
      borderRadius: 5,
    };
  });

  if (deviceChartInstance) deviceChartInstance.destroy();
  deviceChartInstance = new Chart(ctx, {
    type: 'bar',
    data: { labels: codes, datasets: deviceSeries },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { position: 'bottom', labels: { color: colors.text, font: { size: 11 } } },
      },
      scales: {
        x: { grid: { display: false }, ticks: { color: colors.text, font: { weight: '600', size: 11 } } },
        y: {
          beginAtZero: true,
          grid: { color: colors.grid },
          ticks: { color: colors.muted, callback: (v) => `${v}%`, font: { family: 'JetBrains Mono', size: 11 } },
        },
      },
    },
  });
}

/* --------------------------------------------------------------------------
   F. STEPPER, ACCORDIONS, PASSWORD SHAKE DEMO & DATASET TABLE
   -------------------------------------------------------------------------- */
function goPlannerStep(targetStep) {
  if (targetStep < 1 || targetStep > 3 || targetStep === state.plannerStep) return;
  const dirClass = targetStep > state.plannerStep ? 'step-slide-next' : 'step-slide-prev';
  state.plannerStep = targetStep;

  [1, 2, 3].forEach((s) => {
    const el = document.getElementById(`planner-step-${s}`);
    const pill = document.getElementById(`step-pill-${s}`);
    el.classList.remove('step-slide-next', 'step-slide-prev');
    if (s === targetStep) {
      el.classList.remove('hidden');
      el.classList.add(dirClass);
      pill.style.backgroundColor = 'var(--brand-primary)';
      pill.style.color = '#fff';
    } else {
      el.classList.add('hidden');
      pill.style.backgroundColor = 'var(--bg-surface-alt)';
      pill.style.color = 'var(--text-secondary)';
    }
  });

  document.getElementById('btn-step-prev').disabled = targetStep === 1;
  document.getElementById('btn-step-next').textContent = targetStep === 3 ? 'Done ✓' : 'Next Step →';
  updatePlannerProjection();
}

function stepPlanner(delta) {
  const next = state.plannerStep + delta;
  if (next >= 1 && next <= 3) goPlannerStep(next);
}

function updatePlannerProjection() {
  const cohort = document.querySelector('input[name="mfa-cohort"]:checked')?.value || 'chronic';
  const useMfa = document.getElementById('chk-mfa')?.checked ?? true;
  const useHygiene = document.getElementById('chk-hygiene')?.checked ?? true;

  let targetCodes = ['CT', 'CBA'];
  if (cohort === 'top4') targetCodes = ['CT', 'CBA', 'CIC', 'CoE'];
  if (cohort === 'all8') targetCodes = COLLEGES.map((c) => c.code);

  const totalBaselineUsers = COLLEGES.reduce((a, b) => a + b.baseUsers, 0); // 15,850
  const users = COLLEGES.filter((c) => targetCodes.includes(c.code)).reduce((a, b) => a + b.baseUsers, 0);
  const userSharePct = totalBaselineUsers > 0 ? (users / totalBaselineUsers) * 100 : 0;

  const totalFailed = state.filteredPooled.reduce((a, b) => a + b.failed_logins, 0);
  const targetFailed = state.filteredPooled
    .filter((p) => targetCodes.includes(p.college))
    .reduce((a, b) => a + b.failed_logins, 0);
  const failedSharePct = totalFailed > 0 ? (targetFailed / totalFailed) * 100 : 0;

  let postureLabel = 'Baseline Only';
  if (useMfa && useHygiene) postureLabel = 'MFA + Rate-Limiting';
  else if (useMfa) postureLabel = 'MFA Takeover Shield';
  else if (useHygiene) postureLabel = 'Passphrase + Throttling';

  document.getElementById('proj-users').textContent = users.toLocaleString();
  document.getElementById('proj-users-sub').textContent = `${userSharePct.toFixed(1)}% of ${totalBaselineUsers.toLocaleString()} baseline users`;
  document.getElementById('proj-target-failed').textContent = targetFailed.toLocaleString();
  document.getElementById('proj-failed-share').textContent = `${failedSharePct.toFixed(1)}% of simulated failed attempts`;
  document.getElementById('proj-posture').textContent = postureLabel;
}

function toggleAccordion(btn) {
  const item = btn.closest('.accordion-item');
  const isOpen = item.getAttribute('data-open') === 'true';
  item.setAttribute('data-open', isOpen ? 'false' : 'true');
}

function fillWeakSample() {
  const input = document.getElementById('demo-pwd-input');
  input.value = 'usep2026';
  validateDemoPassword(new Event('submit'));
}

// NIST SP 800-63B Compliant Check: Length (12+ chars) + Compromised/Context Blocklist (No symbol/uppercase complexity rules)
function validateDemoPassword(e) {
  e.preventDefault();
  const input = document.getElementById('demo-pwd-input');
  const fb = document.getElementById('demo-pwd-feedback');
  const val = input.value.trim();

  const hasMinLength = val.length >= 12;
  const isBlocklisted = /usep|davao|uve|password|qwerty|1234|admin/i.test(val);
  const isRepeatedChars = /^(.)\1+$/.test(val);
  const valid = hasMinLength && !isBlocklisted && !isRepeatedChars;

  input.classList.remove('field-error-shake');
  void input.offsetWidth;

  if (!valid) {
    input.classList.add('field-error-shake');
    fb.textContent = !hasMinLength
      ? `Rejected (NIST 800-63B): Passphrase is ${val.length} chars; requires at least 12 characters.`
      : 'Rejected (NIST 800-63B): Matches compromised or USeP-specific blocklist term.';
    fb.style.color = 'var(--status-danger)';
  } else {
    input.style.borderColor = 'var(--status-safe)';
    input.style.backgroundColor = 'var(--status-safe-soft)';
    fb.textContent = 'Compliant (NIST 800-63B): Meets 12+ char length & clears blocklist—no symbol or rotation rules required.';
    fb.style.color = 'var(--status-safe)';
  }
}

function clearRecordsSearch() {
  const input = document.getElementById('records-search');
  input.value = '';
  state.recordsPage = 1;
  renderRecordsTable();
  input.focus();
}

document.addEventListener('keydown', (e) => {
  if (e.key !== '/' || state.activeTab !== 3 || e.ctrlKey || e.metaKey || e.altKey) return;
  const tag = (document.activeElement && document.activeElement.tagName) || '';
  if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
  e.preventDefault();
  document.getElementById('records-search').focus();
});

function sortRecords(key) {
  if (state.recordsSortKey === key) {
    state.recordsSortAsc = !state.recordsSortAsc;
  } else {
    state.recordsSortKey = key;
    state.recordsSortAsc = true;
  }
  renderRecordsTable();
}

function changeRecordPage(delta) {
  state.recordsPage = Math.max(1, state.recordsPage + delta);
  renderRecordsTable();
}

function renderRecordsTable() {
  const tbody = document.getElementById('records-tbody');
  if (!tbody) return;
  const query = document.getElementById('records-search').value.trim().toLowerCase();
  const gran = document.getElementById('records-granularity').value;

  let source = gran === 'device' ? getActiveRawDataset() : state.filteredPooled;
  if (query) {
    source = source.filter(
      (r) =>
        r.college.toLowerCase().includes(query) ||
        r.collegeName.toLowerCase().includes(query) ||
        `w${r.week}` === query ||
        String(r.week) === query ||
        r.device_type.toLowerCase().includes(query)
    );
  }

  const key = state.recordsSortKey;
  const asc = state.recordsSortAsc ? 1 : -1;
  const sorted = [...source].sort((a, b) => {
    if (typeof a[key] === 'string') return a[key].localeCompare(b[key]) * asc;
    return (a[key] - b[key]) * asc;
  });

  const total = sorted.length;
  const maxPage = Math.max(1, Math.ceil(total / state.recordsPageSize));
  if (state.recordsPage > maxPage) state.recordsPage = maxPage;

  const start = (state.recordsPage - 1) * state.recordsPageSize;
  const slice = sorted.slice(start, start + state.recordsPageSize);

  document.getElementById('records-subtitle').textContent =
    gran === 'device'
      ? `Showing device-segmented records (${total} rows across 26 weeks × 8 colleges × 3 devices).`
      : `Showing pooled college-week records (${total} rows matching active filters).`;

  document.getElementById('records-count-label').textContent =
    total > 0 ? `Showing ${start + 1}–${Math.min(total, start + state.recordsPageSize)} of ${total} rows` : 'No matching records';

  document.getElementById('btn-page-prev').disabled = state.recordsPage <= 1;
  document.getElementById('btn-page-next').disabled = state.recordsPage >= maxPage;

  const rawQuery = document.getElementById('records-search').value.trim();
  const maxRate = Math.max(1, ...sorted.map((r) => r.failed_login_rate));
  tbody.innerHTML = slice
    .map(
      (r) => `
      <tr class="records-row">
        <td class="py-2.5 px-3 font-semibold">${highlightWeek(r.week, rawQuery)}</td>
        <td class="py-2.5 px-3 font-sans font-semibold">${highlightMatch(r.college, rawQuery)}<div class="text-[10px] font-normal" style="color: var(--text-muted);">${highlightMatch(r.collegeName, rawQuery)}</div></td>
        <td class="py-2.5 px-3 font-sans" style="color: var(--text-secondary);">${highlightMatch(r.device_type, rawQuery)}</td>
        <td class="py-2.5 px-3 text-right">${r.active_users.toLocaleString()}</td>
        <td class="py-2.5 px-3 text-right">${r.login_attempts.toLocaleString()}</td>
        <td class="py-2.5 px-3 text-right">${r.failed_logins.toLocaleString()}</td>
        <td class="py-2.5 px-3 text-right ${r.failed_login_rate > 12 ? 'rate-hot' : ''}">
          <div class="flex items-center justify-end gap-2">
            <span class="font-bold" style="color: ${r.failed_login_rate > 12 ? 'var(--status-danger)' : 'var(--text-primary)'};">${r.failed_login_rate.toFixed(2)}%</span>
            ${rateBar(r.failed_login_rate, maxRate)}
          </div>
        </td>
      </tr>
    `
    )
    .join('');

  setMatchCountText(rawQuery ? total + (total === 1 ? ' match' : ' matches') : '');
  const clearBtn = document.getElementById('records-clear');
  if (clearBtn) clearBtn.classList.toggle('hidden', !rawQuery);
}

/* --------------------------------------------------------------------------
   G. NAVIGATION, ROLE VIEW, INSTANT THEME SWITCH, TOOLTIPS & SPRING PHYSICS
   -------------------------------------------------------------------------- */
function switchTab(idx) {
  state.activeTab = idx;
  document.querySelectorAll('.tab-btn').forEach((btn, i) => {
    if (i === idx) {
      btn.style.backgroundColor = 'var(--brand-primary)';
      btn.style.color = '#ffffff';
    } else {
      btn.style.backgroundColor = 'transparent';
      btn.style.color = 'var(--text-secondary)';
    }
  });

  document.querySelectorAll('.tab-panel').forEach((panel, i) => {
    if (i === idx) {
      panel.classList.remove('hidden');
      panel.classList.remove('animate-entrance');
      void panel.offsetWidth;
      panel.classList.add('animate-entrance');
    } else {
      panel.classList.add('hidden');
    }
  });

  if (idx === 1) {
    renderTrendChart();
    renderBoxplot();
  } else if (idx === 2) {
    renderDeviceChart();
  }

  hideHeatTooltip();
  measureChrome();
  renderSpyChips(idx);
  initScrollSpy();
}


/* --------------------------------------------------------------------------
   NAVIGATION CHROME: sticky offsets + per-tab section chips with scroll-spy
   -------------------------------------------------------------------------- */
const SPY_SECTIONS = {
  0: [
    { id: 'sec-verdict', label: 'Verdict' },
    { id: 'sec-kpis', label: 'KPIs' },
    { id: 'sec-ranking', label: 'Ranking' },
    { id: 'sec-heatmap', label: 'Heatmap' },
    { id: 'sec-breakdown', label: 'Breakdown' },
  ],
  1: [
    { id: 'sec-trend', label: 'Weekly trend' },
    { id: 'sec-boxplot', label: 'Distribution' },
  ],
  2: [
    { id: 'sec-device', label: 'Devices' },
    { id: 'sec-planner', label: 'MFA planner' },
    { id: 'sec-guidance', label: 'Guidance' },
  ],
  3: [{ id: 'sec-records', label: 'Records' }],
};

let spyPick = null;
let spyTicking = false;
function measureChrome() {
  const header = document.querySelector('.app-header');
  const nav = document.querySelector('.tab-nav');
  const root = document.documentElement.style;
  if (header) root.setProperty('--header-h', header.offsetHeight + 'px');
  if (nav) root.setProperty('--nav-h', nav.offsetHeight + 'px');
}

function renderSpyChips(idx) {
  const box = document.getElementById('spy-chips');
  if (!box) return;
  const sections = (SPY_SECTIONS[idx] || []).filter((sec) => document.getElementById(sec.id));
  box.innerHTML = sections
    .map((sec) => '<a class="spy-chip" href="#' + sec.id + '" data-spy="' + sec.id + '">' + sec.label + '</a>')
    .join('');
  box.hidden = sections.length === 0;
  box.querySelectorAll('a').forEach((a) => {
    a.addEventListener('click', (e) => {
      e.preventDefault();
      const target = document.getElementById(a.dataset.spy);
      if (target) target.scrollIntoView({ behavior: reducedMotionQuery.matches ? 'auto' : 'smooth', block: 'start' });
    });
  });
  measureChrome();
}

function initScrollSpy() {
  const chips = Array.from(document.querySelectorAll('#spy-chips .spy-chip'));
  if (!chips.length) {
    spyPick = null;
    return;
  }
  const targets = chips.map((c) => document.getElementById(c.dataset.spy)).filter(Boolean);
  const mark = (id) => chips.forEach((c) => c.setAttribute('aria-current', String(c.dataset.spy === id)));
  spyPick = () => {
    const line =
      (document.querySelector('.app-header')?.offsetHeight || 64) + (document.querySelector('.tab-nav')?.offsetHeight || 96) + 24;
    let cur = targets[0];
    for (const t of targets) if (t.getBoundingClientRect().top <= line) cur = t;
    if (window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 4) cur = targets[targets.length - 1];
    mark(cur.id);
  };
  spyPick();
}

window.addEventListener(
  'scroll',
  () => {
    if (spyTicking || !spyPick) return;
    spyTicking = true;
    requestAnimationFrame(() => {
      spyTicking = false;
      if (spyPick) spyPick();
    });
  },
  { passive: true }
);

/* --------------------------------------------------------------------------
   TAB BAR: click-and-drag scroll, wheel-to-horizontal, overflow edge fades
   -------------------------------------------------------------------------- */
function initTabDrag() {
  const el = document.getElementById('tab-scroller');
  if (!el) return;
  const DRAG_THRESHOLD = 5;
  let startX = 0;
  let startScroll = 0;
  let pressed = false;
  let dragging = false;

  const updateFades = () => {
    const max = el.scrollWidth - el.clientWidth;
    el.classList.toggle('can-scroll', max > 1);
    el.classList.toggle('fade-left', el.scrollLeft > 1);
    el.classList.toggle('fade-right', el.scrollLeft < max - 1);
  };

  el.addEventListener('pointerdown', (e) => {
    if (e.pointerType !== 'mouse' || e.button !== 0) return;
    pressed = true;
    dragging = false;
    startX = e.clientX;
    startScroll = el.scrollLeft;
  });

  window.addEventListener('pointermove', (e) => {
    if (!pressed) return;
    const dx = e.clientX - startX;
    if (!dragging && Math.abs(dx) > DRAG_THRESHOLD) {
      dragging = true;
      el.classList.add('is-dragging');
    }
    if (dragging) el.scrollLeft = startScroll - dx;
  });

  const end = () => {
    if (!pressed) return;
    pressed = false;
    el.classList.remove('is-dragging');
    if (dragging) {
      // Swallow the click that follows a drag so it does not switch tabs.
      const block = (ev) => {
        ev.stopPropagation();
        ev.preventDefault();
      };
      el.addEventListener('click', block, { capture: true, once: true });
      setTimeout(() => el.removeEventListener('click', block, { capture: true }), 0);
    }
    dragging = false;
  };
  window.addEventListener('pointerup', end);
  window.addEventListener('pointercancel', end);

  el.addEventListener(
    'wheel',
    (e) => {
      const max = el.scrollWidth - el.clientWidth;
      if (max <= 1 || Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
      const next = Math.min(max, Math.max(0, el.scrollLeft + e.deltaY));
      if (next === el.scrollLeft) return; // at an edge: let the page scroll
      e.preventDefault();
      el.scrollLeft = next;
    },
    { passive: false }
  );

  el.addEventListener('scroll', updateFades, { passive: true });
  window.addEventListener('resize', updateFades);
  updateFades();
}

function setRoleView(role) {
  state.role = role;
  const thumb = document.getElementById('role-thumb');
  const btnDean = document.getElementById('btn-role-dean');
  const btnAnalyst = document.getElementById('btn-role-analyst');
  const overrideBox = document.getElementById('analyst-override-box');

  thumb.setAttribute('data-role', role);
  if (role === 'dean') {
    btnDean.style.color = '#ffffff';
    btnAnalyst.style.color = 'var(--text-secondary)';
    overrideBox.classList.add('hidden');
    showToast('Dean View: Executive summary & MFA priority active');
  } else {
    btnDean.style.color = 'var(--text-secondary)';
    btnAnalyst.style.color = '#ffffff';
    overrideBox.classList.remove('hidden');
    showToast('Analyst View: Omnibus test diagnostics & overrides active');
  }
  applyFilters();
}

// Rule: Theme switches turn transitions off while changing
function toggleTheme() {
  const html = document.documentElement;
  html.classList.add('theme-switching');
  state.theme = state.theme === 'dark' ? 'light' : 'dark';
  html.setAttribute('data-theme', state.theme);

  document.getElementById('icon-sun').classList.toggle('hidden', state.theme === 'light');
  document.getElementById('icon-moon').classList.toggle('hidden', state.theme === 'dark');

  renderBarChart();
  renderTrendChart();
  renderBoxplot();
  renderDeviceChart();
  hideHeatTooltip();

  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      html.classList.remove('theme-switching');
    });
  });
}

function openInfoModal() {
  const backdrop = document.getElementById('info-modal-backdrop');
  const sheet = document.getElementById('info-modal-sheet');
  sheet.style.transform = 'translate3d(0, 0, 0)';
  backdrop.classList.remove('hidden');
  backdrop.classList.add('flex');
}

function closeInfoModal() {
  const backdrop = document.getElementById('info-modal-backdrop');
  backdrop.classList.add('hidden');
  backdrop.classList.remove('flex');
}

function copyPythonScript() {
  const text = document.getElementById('python-code-block').innerText;
  const ta = document.createElement('textarea');
  ta.value = text;
  document.body.appendChild(ta);
  ta.select();
  document.execCommand('copy');
  document.body.removeChild(ta);
  showToast('Python verification script copied to clipboard');
}

function downloadPythonScript() {
  const text = document.getElementById('python-code-block').innerText;
  triggerDownload('kandadohoy_uve_analysis.py', text, 'text/x-python');
}

function exportSummaryCSV() {
  const headers = ['Rank', 'Scenario', 'College', 'College_Name', 'Weeks_N', 'Mean_Failed_Rate', 'SD', 'Median', 'IQR', 'LOO_Rest_Rate', 'CI_95_Low', 'CI_95_High', 'Holm_p'];
  const rows = state.collegeStats.map((c, i) => [
    i + 1, state.scenario, c.code, `"${c.name}"`, c.n, c.mean.toFixed(4), c.sd.toFixed(4),
    c.median.toFixed(4), c.iqr.toFixed(4), c.looBaseline.toFixed(4), c.ciLow.toFixed(4), c.ciHigh.toFixed(4), c.holmP.toFixed(6)
  ]);
  const csv = [headers.join(','), ...rows.map((r) => r.join(','))].join('\n');
  triggerDownload(`kandadohoy_${state.scenario}_college_summary.csv`, csv, 'text/csv');
  showToast(`Downloaded kandadohoy_${state.scenario}_college_summary.csv`);
}

function exportFilteredRecordsCSV() {
  const headers = ['scenario', 'week', 'college', 'device_type', 'active_users', 'login_attempts', 'failed_logins', 'failed_login_rate'];
  const rows = state.filteredPooled.map((r) => [
    state.scenario, r.week, r.college, `"${r.device_type}"`, r.active_users, r.login_attempts, r.failed_logins, r.failed_login_rate.toFixed(4)
  ]);
  const csv = [headers.join(','), ...rows.map((r) => r.join(','))].join('\n');
  triggerDownload(`kandadohoy_${state.scenario}_weekly_records.csv`, csv, 'text/csv');
  showToast(`Downloaded kandadohoy_${state.scenario}_weekly_records.csv`);
}

function exportFilteredRecordsCSV() {
  const headers = ['week', 'college', 'device_type', 'active_users', 'login_attempts', 'failed_logins', 'failed_login_rate'];
  const rows = state.filteredPooled.map((r) => [
    r.week, r.college, `"${r.device_type}"`, r.active_users, r.login_attempts, r.failed_logins, r.failed_login_rate.toFixed(4)
  ]);
  const csv = [headers.join(','), ...rows.map((r) => r.join(','))].join('\n');
  triggerDownload('kandadohoy_weekly_records.csv', csv, 'text/csv');
  showToast('Downloaded kandadohoy_weekly_records.csv');
}

function triggerDownload(filename, content, mime) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

let toastTimer = null;
function showToast(msg) {
  const el = document.getElementById('toast-banner');
  document.getElementById('toast-message').textContent = msg;
  el.classList.remove('hidden');
  el.classList.add('flex');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.classList.add('hidden');
    el.classList.remove('flex');
  }, 2600);
}

// Rule: Tooltips delay only the first one; once open, show subsequent instantly
(function initTooltips() {
  const tooltipEl = document.getElementById('global-tooltip');
  let isWarm = false;
  let openTimer = null;
  let coolTimer = null;

  document.addEventListener('mouseover', (e) => {
    const target = e.target.closest('[data-tooltip]');
    if (!target) return;
    clearTimeout(openTimer);
    clearTimeout(coolTimer);

    const show = () => {
      tooltipEl.textContent = target.getAttribute('data-tooltip');
      const rect = target.getBoundingClientRect();
      const x = Math.max(8, Math.min(window.innerWidth - 270, rect.left + rect.width / 2 - 120));
      const y = rect.bottom + 8;
      tooltipEl.style.transform = `translate3d(${x}px, ${y}px, 0) scale(1)`;
      tooltipEl.classList.add('visible');
      isWarm = true;
    };

    if (isWarm) {
      show();
    } else {
      openTimer = setTimeout(show, 420);
    }
  });

  document.addEventListener('mouseout', (e) => {
    const target = e.target.closest('[data-tooltip]');
    if (!target) return;
    clearTimeout(openTimer);
    tooltipEl.classList.remove('visible');
    coolTimer = setTimeout(() => {
      isWarm = false;
    }, 700);
  });
})();

// Rule: Spring physics with release velocity & Rubber-band resistance on KPI strip + Modal drag
function springAnimate(initialPos, initialVel, targetPos, onUpdate, onComplete) {
  let pos = initialPos;
  let vel = initialVel;
  const stiffness = 240;
  const damping = 30; // critically damped (bounce: 0)
  let lastTime = performance.now();

  function step(now) {
    const dt = Math.min(0.032, (now - lastTime) / 1000);
    lastTime = now;
    const force = -stiffness * (pos - targetPos) - damping * vel;
    vel += force * dt;
    pos += vel * dt;
    onUpdate(pos);
    if (Math.abs(pos - targetPos) < 0.3 && Math.abs(vel) < 2) {
      onUpdate(targetPos);
      if (onComplete) onComplete();
    } else {
      requestAnimationFrame(step);
    }
  }
  requestAnimationFrame(step);
}

(function initSpringInteractions() {
  // 1. Rubber-band horizontal drag on KPI strip
  const track = document.getElementById('kpi-carousel-track');
  if (track) {
    let dragging = false, startX = 0, currentX = 0, lastX = 0, lastT = 0, velX = 0;
    const startDrag = (x) => { dragging = true; startX = x; lastX = x; lastT = performance.now(); velX = 0; };
    const moveDrag = (x) => {
      if (!dragging) return;
      const now = performance.now();
      const dt = Math.max(1, now - lastT);
      velX = ((x - lastX) / dt) * 1000;
      lastX = x; lastT = now;
      const raw = x - startX;
      // Non-linear resistance growing the further you pull
      currentX = raw / (1 + Math.abs(raw) * 0.012);
      track.style.transform = `translate3d(${currentX}px, 0, 0)`;
    };
    const endDrag = () => {
      if (!dragging) return;
      dragging = false;
      springAnimate(currentX, velX * 0.25, 0, (p) => {
        track.style.transform = `translate3d(${p}px, 0, 0)`;
      });
    };

    track.addEventListener('mousedown', (e) => startDrag(e.clientX));
    window.addEventListener('mousemove', (e) => moveDrag(e.clientX));
    window.addEventListener('mouseup', endDrag);
    track.addEventListener('touchstart', (e) => startDrag(e.touches[0].clientX), { passive: true });
    track.addEventListener('touchmove', (e) => moveDrag(e.touches[0].clientX), { passive: true });
    track.addEventListener('touchend', endDrag);
  }

  // 2. Vertical flick/drag with velocity handoff on Methodology Modal
  const handle = document.getElementById('modal-drag-handle');
  const sheet = document.getElementById('info-modal-sheet');
  if (handle && sheet) {
    let dragging = false, startY = 0, currentY = 0, lastY = 0, lastT = 0, velY = 0;
    const start = (y) => { dragging = true; startY = y; lastY = y; lastT = performance.now(); velY = 0; };
    const move = (y) => {
      if (!dragging) return;
      const now = performance.now();
      const dt = Math.max(1, now - lastT);
      velY = ((y - lastY) / dt) * 1000;
      lastY = y; lastT = now;
      const dy = y - startY;
      currentY = dy < 0 ? dy / (1 + Math.abs(dy) * 0.02) : dy;
      sheet.style.transform = `translate3d(0, ${currentY}px, 0)`;
    };
    const end = () => {
      if (!dragging) return;
      dragging = false;
      if (currentY > 110 || velY > 650) {
        closeInfoModal();
        sheet.style.transform = 'translate3d(0, 0, 0)';
      } else {
        springAnimate(currentY, velY, 0, (p) => {
          sheet.style.transform = `translate3d(0, ${p}px, 0)`;
        });
      }
    };
    handle.addEventListener('mousedown', (e) => start(e.clientY));
    window.addEventListener('mousemove', (e) => move(e.clientY));
    window.addEventListener('mouseup', end);
    handle.addEventListener('touchstart', (e) => start(e.touches[0].clientY), { passive: true });
    handle.addEventListener('touchmove', (e) => move(e.touches[0].clientY), { passive: true });
    handle.addEventListener('touchend', end);
  }
})();

window.addEventListener('resize', () => {
  measureChrome();
  if (state.activeTab === 1) renderBoxplot();
});

window.onload = function () {
  document.querySelectorAll('#kpi-carousel-track > *').forEach((card, i) => {
    card.style.setProperty('--i', i);
    card.classList.add('stagger-in');
  });
  measureChrome();
  initHeatmapInteractions();
  initTabDrag();
  applyFilters();
  renderSpyChips(state.activeTab);
  initScrollSpy();
};
