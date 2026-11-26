/* --------------------------------------------------------------------------
   A. DETERMINISTIC PRNG & 26-WEEK USeP UVE DATASET GENERATOR (EFFECT + NULL)
   -------------------------------------------------------------------------- */
function mulberry32(seed) {
  return function () {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const COLLEGES = [
  { code: 'CT',   name: 'College of Technology',               baseUsers: 1950, baseRate: 0.098, profile: 'chronic',  note: 'Consistent with persistent credential friction across all 26 weeks' },
  { code: 'CBA',  name: 'College of Business Administration',  baseUsers: 2200, baseRate: 0.087, profile: 'chronic',  note: 'Consistent with sustained password/lockout friction across semester' },
  { code: 'CIC',  name: 'College of Information & Computing',  baseUsers: 1650, baseRate: 0.039, profile: 'spike',    note: 'Low typical median (below LOO rest); isolated Desktop bursts (Wks 11, 19)' },
  { code: 'CoE',  name: 'College of Engineering',              baseUsers: 2650, baseRate: 0.043, profile: 'spike',    note: 'Low typical median (below LOO rest); isolated Desktop burst (Wk 14)' },
  { code: 'CAEc', name: 'College of Applied Economics',        baseUsers: 1100, baseRate: 0.051, profile: 'baseline', note: 'Within baseline; mild synchronized exam-week bump' },
  { code: 'CAS',  name: 'College of Arts and Sciences',        baseUsers: 2950, baseRate: 0.048, profile: 'baseline', note: 'Largest cohort (2,950 avg users); stable baseline behavior' },
  { code: 'CEd',  name: 'College of Education',                baseUsers: 2400, baseRate: 0.046, profile: 'baseline', note: 'Within baseline; predictable exam-week peaks' },
  { code: 'CDM',  name: 'College of Development Management',   baseUsers: 950,  baseRate: 0.044, profile: 'baseline', note: 'Lowest chronic failure rate across semester' },
];

const DEVICES = [
  { type: 'Mobile',         userShare: 0.54, attemptsPerUser: 3.4, rateMult: 1.18 },
  { type: 'Desktop/Laptop', userShare: 0.36, attemptsPerUser: 4.1, rateMult: 0.86 },
  { type: 'Tablet',         userShare: 0.10, attemptsPerUser: 2.3, rateMult: 0.96 },
];

const EXAM_WEEKS = new Set([8, 9, 17, 18]);

function generateDataset(scenario = 'effect') {
  const isNull = scenario === 'null';
  const rand = mulberry32(isNull ? 20260927 : 20260926);
  const rows = [];

  for (let week = 1; week <= 26; week++) {
    const isExam = EXAM_WEEKS.has(week);
    const examMult = isExam ? 1.26 : 1.0;

    for (const col of COLLEGES) {
      const seasonalWave = 1 + 0.05 * Math.sin((week / 26) * Math.PI * 2);
      const effectiveBaseRate = isNull ? 0.055 : col.baseRate;

      for (const dev of DEVICES) {
        const jitterUsers = 0.95 + rand() * 0.10;
        const activeUsers = Math.round(col.baseUsers * dev.userShare * seasonalWave * jitterUsers);
        const attemptMult = isExam ? 1.22 : 1.0;
        const loginAttempts = Math.max(
          activeUsers,
          Math.round(activeUsers * dev.attemptsPerUser * attemptMult * (0.94 + rand() * 0.12))
        );

        let rate = effectiveBaseRate * dev.rateMult * examMult * (0.88 + rand() * 0.24);

        // Inject multi-week credential bursts only in the Effect Scenario
        if (!isNull && col.code === 'CIC' && (week === 11 || week === 19) && dev.type === 'Desktop/Laptop') {
          rate = week === 11 ? 0.285 : 0.245;
        }
        if (!isNull && col.code === 'CoE' && week === 14 && dev.type === 'Desktop/Laptop') {
          rate = 0.225;
        }

        const failedLogins = Math.min(loginAttempts, Math.max(1, Math.round(loginAttempts * rate)));
        const failedLoginRate = (failedLogins / loginAttempts) * 100;

        rows.push({
          week,
          college: col.code,
          collegeName: col.name,
          device_type: dev.type,
          active_users: activeUsers,
          login_attempts: loginAttempts,
          failed_logins: failedLogins,
          failed_login_rate: failedLoginRate,
          isExam,
        });
      }
    }
  }
  return rows;
}

const DATASETS = {
  effect: generateDataset('effect'),
  null: generateDataset('null'),
};

/* --------------------------------------------------------------------------
   B. WEEK-BLOCKED STATISTICAL ENGINE (FRIEDMAN, RM-ANOVA, WILCOXON + HOLM)
   -------------------------------------------------------------------------- */
function mean(arr) {
  return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
}

function sd(arr) {
  if (arr.length < 2) return 0;
  const m = mean(arr);
  return Math.sqrt(arr.reduce((acc, v) => acc + (v - m) ** 2, 0) / (arr.length - 1));
}

function quantile(sorted, q) {
  if (!sorted.length) return 0;
  const pos = (sorted.length - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  return sorted[base + 1] !== undefined
    ? sorted[base] + rest * (sorted[base + 1] - sorted[base])
    : sorted[base];
}

function skewness(arr) {
  if (arr.length < 3) return 0;
  const m = mean(arr);
  const s = sd(arr);
  if (s === 0) return 0;
  const n = arr.length;
  const sum3 = arr.reduce((acc, v) => acc + ((v - m) / s) ** 3, 0);
  return (n / ((n - 1) * (n - 2))) * sum3;
}

// Standard Normal CDF (Abramowitz & Stegun)
function normCdf(z) {
  const sign = z < 0 ? -1 : 1;
  const x = Math.abs(z) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * x);
  const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741, a4 = -1.453152027, a5 = 1.061405429;
  const erf = 1 - (((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t) * Math.exp(-x * x);
  return 0.5 * (1 + sign * erf);
}

// Log-Gamma & Regularized Incomplete Beta / Gamma for exact F & Chi-Square p-values
function gammaln(xx) {
  const cof = [76.18009172947146, -86.50532032941677, 24.01409824083091,
    -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5];
  let x = xx, y = xx, tmp = x + 5.5;
  tmp -= (x + 0.5) * Math.log(tmp);
  let ser = 1.000000000190015;
  for (let j = 0; j < 6; j++) ser += cof[j] / ++y;
  return -tmp + Math.log(2.5066282746310005 * ser / x);
}

function betacf(a, b, x) {
  const MAXIT = 100, EPS = 3e-7, FPMIN = 1e-30;
  let qab = a + b, qap = a + 1, qam = a - 1;
  let c = 1, d = 1 - qab * x / qap;
  if (Math.abs(d) < FPMIN) d = FPMIN;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= MAXIT; m++) {
    let m2 = 2 * m;
    let aa = m * (b - m) * x / ((qam + m2) * (a + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    h *= d * c;
    aa = -(a + m) * (qab + m) * x / ((a + m2) * (qap + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    let del = d * c;
    h *= del;
    if (Math.abs(del - 1) < EPS) break;
  }
  return h;
}

function betai(a, b, x) {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const bt = Math.exp(gammaln(a + b) - gammaln(a) - gammaln(b) + a * Math.log(x) + b * Math.log(1 - x));
  if (x < (a + 1) / (a + b + 2)) return bt * betacf(a, b, x) / a;
  return 1 - bt * betacf(b, a, 1 - x) / b;
}

function fTestPValue(F, df1, df2) {
  if (F <= 0 || df1 <= 0 || df2 <= 0) return 1;
  const x = df2 / (df2 + df1 * F);
  return betai(df2 / 2, df1 / 2, x);
}

function tTestTwoTailedP(t, df) {
  if (df <= 0 || !isFinite(t)) return 1;
  if (t === 0) return 1;
  const x = df / (df + t * t);
  return betai(df / 2, 0.5, x);
}

function chiSqPValue(x, k) {
  if (x <= 0) return 1;
  const a = k / 2, z = x / 2;
  let sum = 1 / a, del = sum, ap = a;
  for (let n = 1; n <= 120; n++) {
    ap += 1;
    del *= z / ap;
    sum += del;
    if (Math.abs(del) < Math.abs(sum) * 1e-8) break;
  }
  const pLower = sum * Math.exp(-z + a * Math.log(z) - gammaln(a));
  return Math.max(0, Math.min(1, 1 - pLower));
}

// One-Way ANOVA used solely for Brown-Forsythe Levene variance check
function computeOneWayAnova(groups) {
  const k = groups.length;
  const allVals = groups.flat();
  const N = allVals.length;
  if (k < 2 || N <= k) return { F: 0, df1: k - 1, df2: Math.max(1, N - k), p: 1 };
  const grandMean = mean(allVals);
  let ssb = 0, ssw = 0;
  for (const g of groups) {
    if (!g.length) continue;
    const gm = mean(g);
    ssb += g.length * (gm - grandMean) ** 2;
    for (const v of g) ssw += (v - gm) ** 2;
  }
  const df1 = k - 1, df2 = N - k;
  const F = (ssw / df2) > 0 ? (ssb / df1) / (ssw / df2) : 0;
  return { F, df1, df2, p: fTestPValue(F, df1, df2) };
}

// Week-Blocked Repeated-Measures ANOVA (Two-Way Blocked without interaction)
function computeRepeatedMeasuresAnova(matrix) {
  const b = matrix.length; // week blocks
  const k = b > 0 ? matrix[0].length : 0; // colleges
  if (b < 2 || k < 2) return { F: 0, df1: Math.max(1, k - 1), df2: 1, p: 1, etaSqP: 0, b, k };

  const all = matrix.flat();
  const grandMean = mean(all);
  const colMeans = Array.from({ length: k }, (_, c) => mean(matrix.map((row) => row[c])));
  const rowMeans = matrix.map((row) => mean(row));

  let ssTotal = 0, ssCol = 0, ssBlock = 0;
  for (let r = 0; r < b; r++) {
    ssBlock += k * (rowMeans[r] - grandMean) ** 2;
    for (let c = 0; c < k; c++) {
      ssTotal += (matrix[r][c] - grandMean) ** 2;
    }
  }
  for (let c = 0; c < k; c++) {
    ssCol += b * (colMeans[c] - grandMean) ** 2;
  }
  const ssError = Math.max(1e-12, ssTotal - ssCol - ssBlock);
  const df1 = k - 1;
  const df2 = (b - 1) * (k - 1);
  const msCol = ssCol / df1;
  const msError = ssError / df2;
  const F = msError > 0 ? msCol / msError : 0;
  const p = fTestPValue(F, df1, df2);
  const etaSqP = (ssCol + ssError) > 0 ? ssCol / (ssCol + ssError) : 0;
  return { F, df1, df2, p, etaSqP, b, k };
}

// Week-Blocked Non-Parametric Friedman Test + Kendall's W
function computeFriedmanTest(matrix) {
  const b = matrix.length;
  const k = b > 0 ? matrix[0].length : 0;
  if (b < 2 || k < 2) return { chi2: 0, df: Math.max(1, k - 1), p: 1, W: 0, meanRanks: [], b, k };

  const rankSums = new Array(k).fill(0);
  let tieTerm = 0;

  for (let r = 0; r < b; r++) {
    const tagged = matrix[r].map((val, idx) => ({ val, idx })).sort((a, b) => a.val - b.val);
    let i = 0;
    while (i < k) {
      let j = i;
      while (j + 1 < k && Math.abs(tagged[j + 1].val - tagged[i].val) < 1e-9) j++;
      const avgRank = (i + j + 2) / 2;
      const t = j - i + 1;
      if (t > 1) tieTerm += t ** 3 - t;
      for (let m = i; m <= j; m++) rankSums[tagged[m].idx] += avgRank;
      i = j + 1;
    }
  }

  const sumR2 = rankSums.reduce((acc, r) => acc + r * r, 0);
  const rawChi2 = (12 / (b * k * (k + 1))) * sumR2 - 3 * b * (k + 1);
  const tieCorr = 1 - tieTerm / (b * k * (k * k - 1));
  const chi2 = tieCorr > 0 ? Math.max(0, rawChi2 / tieCorr) : Math.max(0, rawChi2);
  const df = k - 1;
  const p = chiSqPValue(chi2, df);
  const W = Math.max(0, Math.min(1, chi2 / (b * (k - 1))));
  const meanRanks = rankSums.map((r) => r / b);

  return { chi2, df, p, W, meanRanks, b, k };
}

// Paired Wilcoxon Signed-Rank Test (two-tailed, tie & continuity corrected)
function computePairedWilcoxon(xArr, yArr) {
  const diffs = [];
  for (let i = 0; i < Math.min(xArr.length, yArr.length); i++) {
    const d = xArr[i] - yArr[i];
    if (Math.abs(d) > 1e-9) diffs.push({ abs: Math.abs(d), sign: d > 0 ? 1 : -1 });
  }
  const n = diffs.length;
  if (n < 3) return { WPlus: 0, WMinus: 0, p: 1 };

  diffs.sort((a, b) => a.abs - b.abs);
  let wPlus = 0, wMinus = 0, tieSum = 0;
  let i = 0;
  while (i < n) {
    let j = i;
    while (j + 1 < n && Math.abs(diffs[j + 1].abs - diffs[i].abs) < 1e-9) j++;
    const rank = (i + j + 2) / 2;
    const t = j - i + 1;
    if (t > 1) tieSum += t ** 3 - t;
    for (let m = i; m <= j; m++) {
      if (diffs[m].sign > 0) wPlus += rank;
      else wMinus += rank;
    }
    i = j + 1;
  }

  const wMin = Math.min(wPlus, wMinus);
  const meanW = (n * (n + 1)) / 4;
  const varW = (n * (n + 1) * (2 * n + 1) - tieSum / 2) / 24;
  if (varW <= 0) return { WPlus: wPlus, WMinus: wMinus, p: 1 };
  const z = (Math.abs(wMin - meanW) - 0.5) / Math.sqrt(varW);
  const p = Math.max(0, Math.min(1, 2 * (1 - normCdf(Math.max(0, z)))));
  return { WPlus: wPlus, WMinus: wMinus, p };
}

// Paired Student's t-test (two-tailed)
function computePairedTTest(xArr, yArr) {
  const diffs = [];
  for (let i = 0; i < Math.min(xArr.length, yArr.length); i++) {
    diffs.push(xArr[i] - yArr[i]);
  }
  const n = diffs.length;
  if (n < 2) return { t: 0, p: 1 };
  const m = mean(diffs);
  const s = sd(diffs);
  if (s === 0) return { t: 0, p: 1 };
  const t = m / (s / Math.sqrt(n));
  return { t, p: tTestTwoTailedP(t, n - 1) };
}

// Holm-Bonferroni Step-Down Multiple Comparison Adjustment
function holmAdjust(rawPValues) {
  const m = rawPValues.length;
  const indexed = rawPValues.map((p, idx) => ({ p, idx })).sort((a, b) => a.p - b.p);
  const adjusted = new Array(m).fill(1);
  let runningMax = 0;
  for (let i = 0; i < m; i++) {
    const candidate = Math.min(1, (m - i) * indexed[i].p);
    runningMax = Math.max(runningMax, candidate);
    adjusted[indexed[i].idx] = runningMax;
  }
  return adjusted;
}
