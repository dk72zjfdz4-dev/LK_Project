import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';

const source = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
function section(first, next) {
  return source.slice(source.indexOf(first), source.indexOf(next));
}

test('home lists a next-week cancellation as a change, and not as an upcoming lesson', () => {
  const lists = {};
  runInNewContext(section('function lessonOrder(', 'function selectDay(') + `
    renderHome([{date:'2026-11-18', change:'Перенос'}], [cancelled], '2026-11-22');
  `, {
    cancelled: { date: '2026-11-23', cancelled: true },
    moscowTimeFormat: { format: () => '00:05' },
    byId: (id) => id,
    renderList: (id, entries) => { lists[id] = entries.map((entry) => entry.date).join(','); },
  });
  assert.equal(lists['changed-lessons'], '2026-11-23');
  assert.equal(lists['upcoming-lessons'], '');
});

test('an open student cabinet refreshes the schedule through midnight', async () => {
  let tick;
  let today = '2026-11-22';
  let shown;
  const node = {};
  const context = {
    byId: () => node, profileFields: {}, roleNames: { student: 'Студент' }, roleBrand: {},
    route() {}, loadCabinet() {}, selectedDialogue: undefined, activeView: 'home', signingOut: false,
    document: {}, window: { setInterval(callback) { tick = callback; } },
    showScheduleStatus() {}, renderHome() {}, renderDashboard() {}, lessonOrder() {},
    renderWeek: (_lessons, date) => { shown = date; },
    setHeaderDate() {}, moscowTimeFormat: { format: () => "00:05" },
    request: async () => ({ today, weekStart: today, lessons: [] }),
    profile: undefined, selectedDay: undefined, schedule: undefined, pollTimer: undefined, scheduleLoad: undefined,
    renders: new Map(),
  };
  runInNewContext(section('function showApp(', 'function dateAt(')
    + section('async function loadSchedule(', 'const requestStatuses')
    + "showApp({role:'student', fullName:'Нюша Романова'});", context);
  await new Promise(setImmediate);
  assert.equal(shown, today);
  today = '2026-11-23';
  await tick();
  await new Promise(setImmediate);
  assert.equal(shown, today);
});

test('the next deadline disappears when time passes without a change in cabinet data', () => {
  let shown;
  const container = { replaceChildren(...children) { shown = children; } };
  const state = {
    byId: (id) => id === 'home-cabinet' ? container : { replaceChildren() {} },
    profile: { role: 'student' }, schedule: undefined,
    cabinet: { requests: [], assignments: [{ title: 'Работа', dueAt: '2026-11-22T21:00:00Z' }] },
    renders: new Map(), document: {},
    stat: (hash) => ({ hash, addEventListener() {} }),
    panel: (_title, contents) => contents,
    listFor: (items) => items.map(({ title }) => title).join(','),
  };
  const render = runInNewContext(`let clock; Date.now = () => clock;`
    + section('function renderDashboard(', 'function renderGrades(')
    + '(time) => { clock = time; renderDashboard(); }', state);
  render(Date.parse('2026-11-22T20:59:00Z'));
  assert.deepEqual(shown, ['Работа']);
  render(Date.parse('2026-11-22T21:01:00Z'));
  assert.deepEqual(shown, ['']);
});

test('a request list updates while remaining form fields preserve the draft', () => {
  const oldNote = { value: 'Черновик', name: 'note' };
  const newNote = { value: '', name: 'note' };
  const oldStatus = { value: 'processing', name: 'status' };
  const newStatus = { tagName: 'SELECT', options: [{ value: 'ready' }], selectedIndex: 0 };
  const draft = { id: 'request-status-1', elements: [oldNote, oldStatus] };
  const newFields = { note: newNote, status: newStatus };
  const newForm = { dataset: {}, elements: { namedItem: (name) => newFields[name] } };
  let entries;
  const root = {
    contains: () => false,
    querySelector: (selector) => selector === 'form[data-dirty]' ? draft : null,
    querySelectorAll: (selector) => selector === 'form[data-dirty]' ? [draft] : [],
    replaceChildren(...next) { entries = next; },
  };
  runInNewContext(section('function renderSection(', 'function panel(')
    + 'renderSection("requests-content", [1, 2], (items) => items, false);', {
    byId: (id) => id === draft.id ? newForm : root,
    renders: new Map(), document: {},
  });
  assert.deepEqual(entries, [1, 2]);
  assert.equal(newNote.value, 'Черновик');
  assert.equal(newStatus.selectedIndex, -1);
});

test('grade rendering displays fractional results without floating-point tails', () => {
  let score;
  runInNewContext(section('const dateFormat', 'const profileFields')
    + section('function renderGrades(', 'function metadata(')
    + "renderGrades([{semester: 2, subject:'Зельеварение', points:48.019999999999996, maxPoints:100.5}]);", {
    profile: { role: 'student' },
    panel() {}, metadata() {},
    listFor(items, draw) { items.forEach(draw); },
    element(_tag, className, text) {
      if (className === 'grade-score') score = text;
      return { append() {}, setAttribute() {} };
    },
  });
  assert.equal(score, '48,02 / 100,5');
});
