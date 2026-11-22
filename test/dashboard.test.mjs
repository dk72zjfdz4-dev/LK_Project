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
  const node = { closest() { return this; } };
  const avatar = {};
  const context = {
    byId: (id) => id === 'mobile-avatar' ? avatar : node,
    profileFields: {}, roleNames: { student: 'Студент' }, roleBrand: {},
    route() {}, loadCabinet() {}, selectedDialogue: undefined, activeView: 'home', signingOut: false,
    document: {}, window: { setInterval(callback) { tick = callback; } },
    showScheduleStatus() {}, revealTarget() {}, preservePagePosition(update) { update(); }, renderHome() {}, renderDashboard() {}, lessonOrder() {},
    renderWeek: (_lessons, date) => { shown = date; },
    setHeaderDate() {}, moscowTimeFormat: { format: () => "00:05" },
    request: async () => ({ today, weekStart: today, lessons: [] }),
    profile: undefined, selectedHomeDay: undefined, selectedDay: undefined, schedule: undefined, pollTimer: undefined, scheduleLoad: undefined,
    renders: new Map(),
  };
  runInNewContext(section('function showApp(', 'function dateAt(')
    + section('async function loadSchedule(', 'const requestStatuses')
    + "showApp({role:'student', fullName:'Нюша Мироновна Романова', firstName:'Нюша', lastName:'Романова'});", context);
  await new Promise(setImmediate);
  assert.equal(shown, today);
  assert.equal(avatar.textContent, 'НР');
  today = '2026-11-23';
  await tick();
  await new Promise(setImmediate);
  assert.equal(shown, today);
});

test('an unsent deadline becomes overdue without a change in cabinet data', () => {
  let shown;
  const container = { replaceChildren(...children) { shown = children; } };
  const state = {
    byId: (id) => id === 'home-cabinet' ? container : { replaceChildren() {} },
    profile: { role: 'student' }, schedule: undefined,
    cabinet: { requests: [], assignments: [{ title: 'Работа', dueAt: '2026-11-22T21:00:00Z' }] },
    renders: new Map(), document: {},
    stat: (hash) => ({ hash, addEventListener() {} }),
    panel: (_title, contents) => contents,
    listFor: (items) => items.map(({ title, overdue }) => overdue ? title + ' (просрочено)' : title).join(','),
  };
  const render = runInNewContext(`let clock; Date.now = () => clock;`
    + section('function renderDashboard(', 'function renderGrades(')
    + '(time) => { clock = time; renderDashboard(); }', state);
  render(Date.parse('2026-11-22T20:59:00Z'));
  assert.deepEqual(shown, ['Работа']);
  render(Date.parse('2026-11-22T21:01:00Z'));
  assert.deepEqual(shown, ['Работа (просрочено)']);
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

test('composer handles Enter, Shift, IME and duplicate submissions', async () => {
  const messageText = { value: '', selectionStart: 2, selectionEnd: 2, maxLength: 2000, style: {}, scrollHeight: 44 };
  const messageStates = new Map();
  let submits = 0;
  let requests = 0;
  let reject;
  const pending = new Promise((_resolve, fail) => { reject = fail; });
  const source = section('function syncComposer(', 'function clearSearch(');
  const { key, send, emoji } = runInNewContext(source
    + '({ key: handleMessageKey, send: sendMessage, emoji: chooseEmoji });', {
    messageText, messageStates, composingMessage: false,
    messageForm: { requestSubmit() { submits++; }, setAttribute() {}, removeAttribute() {} },
    selectedDialogue: 7, profile: {}, activeView: 'messages', signingOut: false,
    byId: () => ({}), post: () => { requests++; return pending; },
    resource: () => '/api/dialogues/7/messages', endSession: () => false,
    emojiOptions: {}, emojiToggle: { setAttribute() {} },
    crypto: { randomUUID: () => 'retry-token' }, receivedMessages: [],
    renderDialogueMessages() {}, scrollConversationEnd() {},
    syncMessageFiles() {},
  });
  const enter = (flags = {}) => {
    let prevented = false;
    key({ key: 'Enter', ...flags, preventDefault() { prevented = true; } });
    return prevented;
  };
  assert.equal(enter(), true);
  assert.equal(submits, 0);
  messageText.value = 'До после';
  messageText.setRangeText = (value, start, end) => {
    messageText.value = messageText.value.slice(0, start) + value + messageText.value.slice(end);
  };
  messageText.focus = () => {};
  emoji('🙂');
  assert.equal(messageText.value, 'До🙂 после');
  assert.equal(enter({ shiftKey: true }), false);
  assert.equal(enter({ isComposing: true }), false);
  assert.equal(enter({ keyCode: 229 }), false);
  assert.equal(enter(), true);
  assert.equal(submits, 1);

  const event = { preventDefault() {} };
  const first = send(event);
  assert.equal(enter(), true);
  assert.equal(submits, 1);
  await send(event);
  assert.equal(requests, 1);
  reject(new Error('Сеть недоступна'));
  await first;
  assert.equal(messageText.value, 'До🙂 после');
  assert.equal(messageStates.get(7).error, 'Не удалось подтвердить отправку.');
  assert.equal(messageStates.get(7).outgoing.clientId, 'retry-token');
  assert.equal(messageStates.get(7).sending, false);
});

test('campus lookup distinguishes documented rooms from fictional and unverified rooms', () => {
  let showBuilding;
  const query = {};
  const result = { append() {} };
  const nodes = {
    'campus-room-query': query,
    'campus-room-result': result,
  };
  const submit = runInNewContext(section('const campusRooms', 'const svgNamespace')
    + section('function findCampusRoom(', 'for (const [id, building]')
    + 'findCampusRoom;', {
    byId: (id) => nodes[id],
    element: () => ({ addEventListener(_event, handler) { showBuilding = handler; } }),
    openCampusCard: (id) => assert.equal(id, 'n'),
  });
  for (const room of ['  Зал № 314  ', 'ауд. 314']) {
    query.value = room;
    submit({ preventDefault() {} });
    assert.match(result.textContent, /Новый корпус.*3-й этаж.*2023/);
    showBuilding();
  }
  query.value = 'А-314';
  submit({ preventDefault() {} });
  assert.equal(result.textContent, 'Расположение не подтверждено.');
});

test('a withdrawn appeal replaces its stale decision form even with another dirty form', () => {
  let focused = false;
  let replacement;
  const oldCard = {
    open: true,
    querySelector: () => ({}),
    contains: () => true,
    replaceWith(card) { replacement = card; },
  };
  const updatedCard = {
    querySelector: () => ({ focus() { focused = true; } }),
  };
  const document = { activeElement: { closest: () => ({}) } };
  const root = { contains: () => true, querySelector: () => ({}) };
  runInNewContext(section('function renderSection(', 'function panel(')
    + section('function reconcileClosedAppeals(', 'function renderAppeal(')
    + 'renderSection("assignments-content", [[], [], [{ id: 3, status: "withdrawn" }]], null, false);', {
    byId: (id) => id === 'assignments-content' ? root : oldCard,
    renderAppeal: () => updatedCard,
    renders: new Map(),
    document,
    profile: { role: 'teacher' },
  });
  assert.equal(replacement, updatedCard);
  assert.equal(updatedCard.open, true);
  assert.equal(focused, true);
});

test('demo contact offers clipboard confirmation and manual copying fallback', async () => {
  const email = 'maria.lanskaya@example.com';
  const navigator = {};
  let copied;
  function node(textContent = '') {
    return {
      textContent, children: [],
      append(...children) { this.children.push(...children); },
      setAttribute() {},
      addEventListener(_type, listener) { this.click = listener; },
    };
  }
  const card = runInNewContext(section('function contactCard(', 'function renderContacts(')
    + 'contactCard({ name: "Мария Ланская", email });', {
    email, navigator, element: (_tag, _className, text) => node(text),
    anchor: (href) => ({ href }),
  });
  const [, label, address, actions, status] = card.children;
  const [button, mail] = actions.children;
  assert.equal(label.textContent, 'Демо-адрес');
  assert.equal(address.textContent, email);
  const [summary, options] = mail.children;
  assert.equal(summary.textContent, 'Открыть почту');
  const [gmail, mailRu, defaultMail] = options.children;
  assert.equal(new URL(gmail.href).searchParams.get('to'), email);
  assert.equal(new URL(mailRu.href).searchParams.get('mailto'), 'mailto:' + email);
  assert.equal(defaultMail.href, 'mailto:' + email);
  await button.click();
  assert.match(status.textContent, /вручную/);
  navigator.clipboard = { async writeText(value) { copied = value; } };
  await button.click();
  assert.equal(copied, email);
  assert.equal(status.textContent, 'Адрес скопирован.');
});

test('search highlights partial words as text and handles ё/е', () => {
  const highlight = runInNewContext(section('function highlightSearch(', 'async function runSearch(')
    + 'highlightSearch;', {
    element(tag, _className, text) {
      return { tag, text, parts: [], append(...parts) { this.parts.push(...parts); } };
    },
  });
  const highlighted = highlight('Справки и документы', 'справ');
  assert.equal(highlighted.parts[1].tag, 'mark');
  assert.equal(highlighted.parts[1].text, 'Справ');
  const literal = highlight('<b>Учёт</b>', 'учет');
  assert.equal(literal.parts[0], '<b>');
  assert.equal(literal.parts[1].text, 'Учёт');
  assert.equal(literal.parts[2], '</b>');
});

test('campus card selects each symbol, closes and returns focus', () => {
  const nodes = new Map();
  function byId(id) {
    if (!nodes.has(id)) nodes.set(id, {
      attrs: {}, classList: { add() {}, remove() {} },
      setAttribute(name, value) { this.attrs[name] = value; },
      focus() { this.focused = true; },
    });
    return nodes.get(id);
  }
  const { open, close } = runInNewContext(section('const campusBuildings', 'function findCampusRoom(')
    + '({open: openCampusCard, close: closeCampusCard});', {
    byId, mobileLayout: { matches: true },
  });
  for (const id of ['a', 'b', 'v', 'g', 'n']) {
    open(id);
    const button = byId('campus-building-' + id);
    assert.equal(button.attrs['aria-expanded'], 'true');
    assert.equal(byId('campus-card-shape').attrs.href, '#campus-shape-' + id);
    assert.equal(byId('campus-card').hidden, false);
    close(true);
    assert.equal(button.attrs['aria-expanded'], 'false');
    assert.equal(button.focused, true);
    assert.equal(byId('campus-card').hidden, true);
  }
});
