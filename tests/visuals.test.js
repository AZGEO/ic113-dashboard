const test = require('node:test');
const assert = require('node:assert/strict');
const v = require('../js/visuals.js');

const count = (s, needle) => s.split(needle).length - 1;

test('escapeHtml escapes markup characters', () => {
  assert.equal(v.escapeHtml('<b>&"'), '&lt;b&gt;&amp;&quot;');
});

test('weeklySeries returns 26 slots with null for weeks without rows', () => {
  const rows = [{ week: 2 }, { week: 4 }, { week: 4 }];
  const s = v.weeklySeries(rows, (w) => w.length);
  assert.equal(s.length, 26);
  assert.equal(s[0], null);
  assert.equal(s[2], null);
  assert.equal(s[1], 1);
  assert.equal(s[3], 2);
});

test('buildSparkline line counts non-null points', () => {
  assert.ok(v.buildSparkline([1, null, 3], { kind: 'line' }).includes('data-points="2"'));
});

test('buildSparkline all-null renders empty state', () => {
  assert.ok(v.buildSparkline([null, null]).includes('data-empty="true"'));
});

test('buildSparkline bars renders one rect per value', () => {
  assert.equal(count(v.buildSparkline([1, 2, 3], { kind: 'bars' }), '<rect'), 3);
});

test('severityFor rate uses 6.5 / 8.5 cutoffs', () => {
  assert.equal(v.severityFor('rate', 6.35).tone, 'safe');
  assert.equal(v.severityFor('rate', 6.5).tone, 'warn');
  assert.equal(v.severityFor('rate', 8.5).label, 'Critical');
});

test('severityFor elevated maps counts', () => {
  assert.equal(v.severityFor('elevated', 0).label, 'None');
  assert.equal(v.severityFor('elevated', 3).tone, 'danger');
});

test('heatColor handles null, scale, clamp and zero max', () => {
  assert.equal(v.heatColor(null, 10), 'transparent');
  assert.ok(v.heatColor(5, 10).includes('50%'));
  assert.ok(v.heatColor(99, 10).includes('100%'));
  assert.ok(!v.heatColor(1, 0).includes('NaN'));
});

test('buildHeatmapGrid empty rows gives empty message', () => {
  assert.ok(v.buildHeatmapGrid([], [{ code: 'CT', name: 'x' }]).includes('heat-none'));
});

test('buildHeatmapGrid renders cells, gaps and one tab stop', () => {
  const rows = [
    { week: 1, college: 'CT', login_attempts: 100, failed_logins: 5, failed_login_rate: 5 },
    { week: 3, college: 'CT', login_attempts: 100, failed_logins: 6, failed_login_rate: 6 },
  ];
  const html = v.buildHeatmapGrid(rows, [{ code: 'CT', name: 'x' }], 3);
  assert.equal(count(html, 'class="heat-cell"'), 2);
  assert.equal(count(html, 'heat-empty'), 1);
  assert.equal(count(html, 'tabindex="0"'), 1);
});

test('scopeChips flags only changed filters', () => {
  const d = { scenario: 'effect', period: 'all', college: 'ALL', device: 'ALL', outliers: 'include' };
  const same = v.scopeChips(d, d);
  assert.equal(same.length, 5);
  assert.ok(same.every((c) => c.isDefault));
  const changed = v.scopeChips({ ...d, college: 'CT' }, d);
  assert.deepEqual(changed.filter((c) => !c.isDefault).map((c) => c.key), ['college']);
});

test('highlightMatch escapes, highlights literally, handles empty query', () => {
  assert.equal(v.highlightMatch('CIC <b>', 'c'), '<mark>C</mark>I<mark>C</mark> &lt;b&gt;');
  assert.equal(v.highlightMatch('a.b', '.'), 'a<mark>.</mark>b');
  assert.equal(v.highlightMatch('abc', ''), 'abc');
});

test('rateBar clamps width and survives zero max', () => {
  assert.ok(v.rateBar(5, 10).includes('width:50%'));
  assert.ok(v.rateBar(50, 10).includes('width:100%'));
  assert.ok(!v.rateBar(1, 0).includes('NaN'));
});

test('rateSeverity reports no data instead of Normal when there are no rows', () => {
  assert.deepEqual(v.rateSeverity(0, false), { tone: 'neutral', label: 'No data' });
  assert.equal(v.rateSeverity(6.35, true).label, 'Normal');
});

test('attemptsScopeBadge ignores scenario but flags any subsetting filter', () => {
  const d = { scenario: 'effect', period: 'all', college: 'ALL', device: 'ALL', outliers: 'include' };
  assert.equal(v.attemptsScopeBadge(v.scopeChips(d, d)).label, 'Full scope');
  assert.equal(v.attemptsScopeBadge(v.scopeChips({ ...d, scenario: 'null' }, d)).label, 'Full scope');
  const mobile = v.attemptsScopeBadge(v.scopeChips({ ...d, device: 'Mobile' }, d));
  assert.deepEqual(mobile, { tone: 'warn', label: 'Filtered scope' });
});

test('highlightWeek marks the label only when the query names that week', () => {
  assert.equal(v.highlightWeek(11, 'w11'), '<mark>W11</mark>');
  assert.equal(v.highlightWeek(11, '11'), '<mark>W11</mark>');
  assert.equal(v.highlightWeek(11, 'W1'), 'W11');
  assert.equal(v.highlightWeek(1, 'w1'), '<mark>W01</mark>');
  assert.equal(v.highlightWeek(5, ''), 'W05');
});

test('nearestWeek picks the closest populated week, lower on ties, null when empty', () => {
  assert.equal(v.nearestWeek([3, 14, 20], 14), 14);
  assert.equal(v.nearestWeek([3, 20], 12), 20);
  assert.equal(v.nearestWeek([4, 8], 6), 4);
  assert.equal(v.nearestWeek([], 6), null);
});
