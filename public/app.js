'use strict';

const byId = (id) => document.getElementById(id);
const views = {
  home: 'Главная',
  schedule: 'Расписание',
  grades: 'Успеваемость',
  assignments: 'Задания',
  library: 'Библиотека',
  requests: 'Справки и документы',
  messages: 'Сообщения',
  contacts: 'Контакты',
  updates: 'Уведомления',
  campus: 'Карта кампуса',
  profile: 'Профиль',
  menu: 'Меню',
};
const roleViews = {
  student: Object.keys(views),
  teacher: ['home', 'schedule', 'grades', 'assignments', 'library', 'messages', 'contacts', 'updates', 'campus', 'profile', 'menu'],
  dean: ['home', 'requests', 'library', 'messages', 'contacts', 'updates', 'campus', 'profile', 'menu'],
};
const roleNames = { student: 'Студент', teacher: 'Преподаватель', dean: 'Деканат' };
const weekdays = ['Понедельник', 'Вторник', 'Среда', 'Четверг', 'Пятница', 'Суббота', 'Воскресенье'];
const shortWeekdays = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];
const dateFormat = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long', timeZone: 'UTC' });
const shortWeekDateFormat = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'short', timeZone: 'UTC' });
const dayFormat = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long', weekday: 'long', timeZone: 'UTC' });
const moscowTimeFormat = new Intl.DateTimeFormat('ru-RU', {
  timeZone: 'Europe/Moscow', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});
const loginTimeFormat = new Intl.DateTimeFormat('en', {
  timeZone: 'Europe/Moscow', month: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric', hourCycle: 'h23',
});
const pointsFormat = new Intl.NumberFormat('ru-RU', { maximumSignificantDigits: 15, useGrouping: false });
const profileFields = {
  'profile-name': 'fullName',
  'profile-full-name': 'fullName',
  'profile-faculty': 'faculty',
  'profile-program': 'program',
  'profile-year': 'year',
  'profile-group': 'group',
  'sidebar-group': 'group',
};
const scheduleAreas = [
  [byId('home-status'), ...document.querySelectorAll('[data-student-schedule]')],
  [byId('week-status'), byId('week-schedule')],
];

let profile;
let signingOut = false;
let activeView;
let teacherSchedule;
let teacherViewLoad;
let schedule;
let scheduleLoad;
let monthScheduleLoad;
let selectedMonth;
let cabinet;
let cabinetLoad;
let pollTimer;
let selectedDay;
let selectedHomeDay;
let selectedDialogue;
let dialogueLoad;
let lessonOpen;
const openNavGroups = new Set();
let pendingTarget;
let menuScroll = 0;
let pointerNavigation = false;
let helpNavigationClose = false;
let searchTimer;
let searchLoad;
let helpCatalog;
let helpCatalogLoad;
let helpQuestionLoad;
let helpTarget;
let helpSuggestions = [];
let helpSelection = -1;
let pageHash = '';
let library;
let libraryLoad;
const librarySaves = new Set();
let portfolio;
let portfolioLoad;
let portfolioExportStudent = '';
const portfolioExportSelection = new Set();
let composingMessage = false;
const messageStates = new Map();
const renderedMessages = new Map();
const renders = new Map();

const helpDialog = byId('help-dialog');
const helpLauncher = byId('help-launcher');
const messageText = byId('message-text');
const messageForm = byId('message-form');
const emojiOptions = byId('emoji-options');
const emojiToggle = byId('emoji-toggle');
const mobileLayout = window.matchMedia('(max-width: 680px)');
const mobileMessenger = window.matchMedia('(max-width: 680px), (orientation: landscape) and (max-height: 500px) and (any-pointer: coarse)');

function element(tag, className, content) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (content !== undefined) node.textContent = content;
  return node;
}

async function request(path, options) {
  let response;
  try {
    response = await fetch(path, options);
  } catch {
    throw new Error('Не удалось связаться с сервером. Попробуйте ещё раз.');
  }

  if (response.status === 204) return;
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const error = new Error(payload?.error || 'Сервис временно недоступен. Попробуйте ещё раз.');
    error.status = response.status;
    throw error;
  }
  if (!payload) throw new Error('Сервис временно недоступен. Попробуйте ещё раз.');
  return payload;
}

function route(focusHeading = false) {
  const [requested, targetId] = window.location.hash.slice(1).split('/');
  const permitted = roleViews[profile.role];
  if (requested === 'help' && activeView) {
    openHelp(targetId);
    return;
  }
  const active = permitted.includes(requested) && (requested !== 'menu' || mobileMessenger.matches) ? requested : 'home';
  if (requested !== 'help' && helpDialog.open) {
    helpNavigationClose = true;
    helpDialog.close();
  }
  if (lessonOpen && active !== activeView) closeLesson(false);
  pageHash = requested === 'help' ? '#home' : window.location.hash;
  if (active !== 'campus') closeCampusCard();
  pendingTarget = active === requested && targetId ? targetId : undefined;
  activeView = active;
  if (active === 'messages' && !targetId && selectedDialogue !== undefined && mobileMessenger.matches) closeDialogue();
  byId('app-error').textContent = '';
  for (const name of Object.keys(views)) {
    byId('view-' + name).hidden = active !== name;
  }
  for (const link of document.querySelectorAll('[data-view]')) {
    link.hidden = !permitted.includes(link.dataset.view);
    const tab = link.closest('.mobile-tabs');
    const activeTab = ['home', 'schedule', 'messages', 'profile'].includes(active) ? active : 'menu';
    if (link.dataset.view === (tab ? activeTab : active)) {
      link.setAttribute('aria-current', 'page');
    } else {
      link.removeAttribute('aria-current');
    }
  }
  const group = document.querySelector('.sidebar .nav-group [data-view="' + active + '"]')?.closest('.nav-group');
  if (group) openNavGroups.add(group.dataset.navGroup);
  renderNavGroups();
  const heading = byId('page-heading');
  const menuBack = byId('mobile-menu-back');
  const menuItem = active === 'menu' && !menuBack.hidden ? history.state?.menuItem : undefined;
  menuBack.hidden = history.state?.fromMenu !== active;
  heading.textContent = views[active];
  byId('header-inbox').hidden = active !== 'home';
  document.title = views[active] + ' — Личный кабинет';
  renderCabinet();
  if (profile.role === 'teacher') loadTeacherView(active, targetId);
  if (active === 'requests' && profile.role === 'student') loadHelpCatalog();
  if (active === 'library') loadLibrary();
  if (active === 'profile') loadPortfolio();
  heading.classList.toggle('pointer-navigation', pointerNavigation);
  pointerNavigation = false;
  if ((focusHeading || pendingTarget) && !(active === 'messages' && mobileMessenger.matches)) {
    window.scrollTo(0, active === 'menu' ? (menuItem ? history.state.menuScroll : menuScroll) : 0);
    const previousLink = menuItem && byId('mobile-nav').querySelector('[data-view="' + CSS.escape(menuItem) + '"]');
    (previousLink || heading).focus({ preventScroll: true });
  }
  revealTarget();
  if (requested === 'help') openHelp(targetId);
  if (active === 'messages' && selectedDialogue !== undefined) refreshDialogue();
}

function revealTarget() {
  if (!pendingTarget) return;
  if (activeView === 'messages') {
    const dialogue = cabinet?.dialogues.find(({ id }) => 'dialogue-' + id === pendingTarget);
    if (!dialogue) return;
    pendingTarget = undefined;
    if (!mobileMessenger.matches || !history.state?.messengerThread) setNewDialogueMode(!dialogue.lastAt);
    if (!dialogue.lastAt) {
      byId('dialogue-category').value = dialogue.partnerRole;
      refreshDialogueList();
    }
    openDialogue(dialogue, byId('page-heading').classList.contains('pointer-navigation'));
    return;
  }
  const target = byId(pendingTarget);
  if (!target || !byId('view-' + activeView).contains(target)) return;
  pendingTarget = undefined;
  if (activeView === 'grades') {
    const semester = target.closest('.grade-semester');
    if (semester) semester.open = true;
  }
  if (target.tagName === 'DETAILS') target.open = true;
  const day = target.closest('.calendar-day');
  if (day) {
    setScheduleMode(false);
    selectDay(day.dataset.date);
  }
  const focus = target.querySelector('summary, button, [tabindex="-1"]') || target;
  focus.focus({ preventScroll: true });
  focus.scrollIntoView({ block: 'nearest' });
}

function preservePagePosition(update) {
  const position = window.scrollY;
  update();
  if (window.scrollY !== position) window.scrollTo(0, position);
}

function showLogin(message = '', focusHeading = false) {
  teacherSchedule = teacherViewLoad = undefined;
  closeLesson(false);
  monthScheduleLoad = selectedMonth = undefined;
  setScheduleMode(false);
  openNavGroups.clear();
  profile = undefined;
  activeView = schedule = scheduleLoad = cabinet = cabinetLoad = selectedDay = selectedHomeDay = selectedDialogue = dialogueLoad = lessonOpen = undefined;
  showWeekNavigation();
  window.clearInterval(pollTimer);
  renders.clear();
  messageStates.clear();
  receiptSync = undefined;
  receivedMessages = [];
  newDialogueMode = false;
  dialogueListScroll = 0;
  dialogueListQuery = '';
  closeDialogue();
  byId('dialogue-search').value = '';
  byId('dialogue-filter').selectedIndex = 0;
  byId('dialogue-category').selectedIndex = 0;
  byId('dialogue-category').hidden = true;
  byId('dialogue-start-error').textContent = '';
  byId('dialogues-content').replaceChildren();
  byId('messages-content').scrollTop = 0;
  messageText.value = '';
  byId('message-error').textContent = '';
  renderedMessages.clear();
  pendingTarget = undefined;
  menuScroll = 0;
  pointerNavigation = false;
  composingMessage = false;
  clearSearch();
  helpCatalog = helpCatalogLoad = undefined;
  helpTarget = undefined;
  pageHash = '';
  if (helpDialog.open) helpDialog.close();
  resetHelpQuestion();
  library = libraryLoad = undefined;
  librarySaves.clear();
  portfolio = portfolioLoad = undefined;
  portfolioExportStudent = '';
  portfolioExportSelection.clear();
  byId('portfolio-refresh').disabled = false;
  for (const id of ['portfolio-achievements', 'portfolio-recommendations', 'portfolio-export']) {
    byId(id).hidden = true;
  }
  byId('library-filters').reset();
  byId('library-subject').options.length = 1;
  byId('library-retry').hidden = true;
  closeCampusCard();
  byId('campus-room-form').reset();
  byId('campus-room-result').textContent = '';
  byId('session-loading').hidden = true;
  byId('app').hidden = true;
  byId('login-screen').hidden = false;
  byId('login-form').reset();
  setLoginPasswordVisible(false);
  syncLoginTheme();
  byId('login-error').textContent = message;
  byId('app-error').textContent = '';
  byId('cabinet-status').hidden = true;
  byId('home-stats').hidden = true;
  byId('home-staff-stats').hidden = true;
  byId('home-staff').hidden = true;
  byId('home-cabinet').hidden = true;
  byId('messaging').hidden = true;
  messageForm.hidden = true;
  messageForm.reset();
  syncComposer();
  setEmojiPanel(false);
  byId('dialogue-heading').textContent = 'Переписка';
  byId('dialogue-error').textContent = '';
  byId('messages-content').replaceChildren(element('p', 'empty-state', 'Выберите диалог.'));
  updateUnread(0);
  for (const picker of [byId('day-picker'), byId('home-week')]) {
    picker.querySelectorAll('label').forEach((label) => label.remove());
  }
  for (const id of [
    'week-grid', 'upcoming-lessons', 'changed-lessons', 'home-day', 'home-week-label', 'home-stats',
    'home-cabinet', 'home-staff', 'home-staff-stats', 'grades-content', 'assignments-content', 'requests-content',
    'dialogues-content', 'updates-content', 'contacts-content', 'dialogue-contact', 'lesson-dialog-content', 'action-status',
    'documents-content', 'document-catalog-status', 'faq-status',
    'library-results', 'library-status', 'library-error',
    'portfolio-status', 'portfolio-achievement-create', 'portfolio-achievement-list',
    'portfolio-recommendation-create', 'portfolio-recommendation-list', 'portfolio-export',
  ]) byId(id).replaceChildren();
  for (const id of [
    ...Object.keys(profileFields),
    'sidebar-name', 'sidebar-initials', 'profile-initials', 'welcome-name',
    'mobile-avatar', 'mobile-logout-error',
  ]) {
    byId(id).textContent = '';
  }
  document.title = 'Вход — Личный кабинет';
  if (focusHeading) byId('login-heading').focus();
}

function showApp(account, focusHeading = false) {
  profile = { ...account, role: account.role || 'student' };
  byId('teacher-schedule').hidden = profile.role !== 'teacher';
  if (profile.role === 'teacher') {
    byId('week-status').hidden = true;
    byId('week-schedule').hidden = true;
  }
  for (const [id, field] of Object.entries(profileFields)) {
    const fieldNode = byId(id);
    fieldNode.textContent = account[field] ?? '';
    if (fieldNode.tagName === 'DD') fieldNode.parentElement.hidden = !account[field];
  }
  const initials = [account.firstName, account.lastName]
    .map((name) => Array.from(name?.trim() ?? '')[0] ?? '')
    .join('')
    .toLocaleUpperCase('ru-RU');
  const roleName = roleNames[profile.role];
  const groupOrRole = profile.role === 'student' ? account.group || roleName : roleName;
  byId('mobile-avatar').textContent = initials;
  byId('sidebar-initials').textContent = initials;
  byId('profile-initials').textContent = initials;
  byId('sidebar-name').textContent = account.fullName.trim().replace(/\s+/g, '\n');
  byId('welcome-name').textContent = (profile.role === 'student' ? 'Привет, ' : 'Здравствуйте, ') + (account.firstName || account.fullName) + '!';
  byId('profile-role').textContent = roleName;
  byId('sidebar-group').textContent = groupOrRole;
  byId('document-catalog').hidden = profile.role !== 'student';
  byId('home-status').hidden = true;
  byId('home-upcoming').hidden = true;
  byId('home-changes').hidden = true;
  byId('home-changes-toggle').ariaExpanded = 'false';
  byId('home-week').closest('section').hidden = true;
  byId('session-loading').hidden = true;
  byId('login-screen').hidden = true;
  byId('app').hidden = false;
  route(focusHeading);
  if (profile.role === 'student') loadSchedule();
  loadCabinet();
  pollTimer = window.setInterval(() => {
    if (document.hidden || signingOut) return;
    if (profile.role === 'student') loadSchedule({ quiet: true });
    loadCabinet({ quiet: true });
    if (activeView === 'messages' && selectedDialogue !== undefined) refreshDialogue(true);
    if (activeView === 'profile') loadPortfolio({ quiet: true });
  }, 12000);
}

function dateAt(day) {
  return new Date(day + 'T00:00:00Z');
}

function weekDates(start) {
  const startTime = dateAt(start).getTime();
  return weekdays.map((_, index) => new Date(startTime + index * 86400000));
}

function lessonTimes(lesson) {
  return lesson.start + '–' + lesson.end;
}

function lessonDetails(lesson) {
  const details = element('div', 'lesson-details');
  details.append(
    element('span', 'lesson-room', lesson.room ? (lesson.group || lesson.status ? '' : 'Демо-ауд. ') + lesson.room : 'Аудитория не указана'),
    element('span', 'lesson-teacher', lesson.group || lesson.teacher),
  );
  return details;
}

function lessonChange(lesson) {
  if (lesson.status === 'moved') {
    return 'Перенесено · ранее ' + dateFormat.format(dateAt(lesson.originalDate)) + ', '
      + lesson.originalStart + '–' + lesson.originalEnd + (lesson.comment ? ' · ' + lesson.comment : '');
  }
  if (lesson.status === 'cancelled') return 'Отменено' + (lesson.comment ? ' · ' + lesson.comment : '');
  return lesson.change || (lesson.cancelled ? 'Отменено' : '');
}

function lessonTitle(lesson, level) {
  const heading = element(level, 'lesson-title');
  const button = element('button', 'lesson-link', lesson.title);
  button.type = 'button';
  button.addEventListener('click', () => openLesson(lesson.id, button));
  heading.append(button);
  return heading;
}

function closeLesson(restore = true) {
  const dialog = byId('lesson-dialog');
  const opened = lessonOpen;
  lessonOpen = undefined;
  if (dialog.open) dialog.close();
  if (!restore || !opened) return;
  const trigger = opened.trigger.isConnected ? opened.trigger : byId('lesson-' + opened.id)?.querySelector('.lesson-link');
  trigger?.focus({ preventScroll: true });
  window.scrollTo(opened.x, opened.y);
}

const lessonDialog = byId('lesson-dialog');
let lessonOutsidePointer;
function outsideLesson(event) {
  const bounds = lessonDialog.getBoundingClientRect();
  return event.target === lessonDialog && (event.clientX < bounds.left || event.clientX >= bounds.right
    || event.clientY < bounds.top || event.clientY >= bounds.bottom);
}

byId('lesson-close').addEventListener('click', () => closeLesson());
lessonDialog.addEventListener('cancel', (event) => {
  event.preventDefault();
  closeLesson();
});
lessonDialog.addEventListener('pointerdown', (event) => {
  lessonOutsidePointer = event.button === 0 && outsideLesson(event);
});
lessonDialog.addEventListener('pointerup', (event) => {
  lessonOutsidePointer &&= outsideLesson(event);
});
lessonDialog.addEventListener('pointercancel', () => { lessonOutsidePointer = false; });
lessonDialog.addEventListener('click', (event) => {
  if (lessonOutsidePointer && outsideLesson(event)) {
    event.preventDefault();
    closeLesson();
  }
  lessonOutsidePointer = false;
});

async function openLesson(id, trigger) {
  const dialog = byId('lesson-dialog');
  const content = byId('lesson-dialog-content');
  const load = { account: profile, id, trigger, x: window.scrollX, y: window.scrollY };
  lessonOutsidePointer = false;
  lessonOpen = load;
  byId('lesson-dialog-heading').textContent = 'Занятие';
  content.replaceChildren(element('p', 'muted', 'Загружаем занятие…'));
  if (!dialog.open) dialog.showModal();
  try {
    const { lesson } = profile.role === 'teacher'
      ? { lesson: teacherSchedule.lessons.find((item) => item.id === id) }
      : await request(resource('/api/lessons', id));
    if (!dialog.open || lessonOpen !== load || profile !== load.account) return;
    byId('lesson-dialog-heading').textContent = lesson.title;
    content.replaceChildren(element('p', 'muted', dateFormat.format(dateAt(lesson.date)) + ' · ' + lessonTimes(lesson)), lessonDetails(lesson));
    if (profile.role === 'teacher') content.append(teacherLessonActions(lesson, load));
    else if (lesson.contact) content.append(contactCard(lesson.contact, { canMessage: true }));
    else content.append(element('p', 'muted', 'Контакты преподавателя пока недоступны.'));
    if (lessonChange(lesson)) content.append(element('p', 'change-label', lessonChange(lesson)));
  } catch (error) {
    if (profile !== load.account || lessonOpen !== load) return;
    if (!endSession(error)) content.replaceChildren(element('p', 'local-error', error.message));
  }
}

function upcomingRow(lesson, today) {
  const row = element('li', 'upcoming-row');
  const slot = element('div', 'upcoming-slot');
  const date = element('time', 'upcoming-date', lesson.date === today ? 'Сегодня' : dateFormat.format(dateAt(lesson.date)));
  date.dateTime = lesson.date;
  slot.append(date, element('span', 'lesson-time', lessonTimes(lesson)));
  const info = element('div', 'upcoming-info');
  info.append(lessonTitle(lesson, 'h3'), lessonDetails(lesson));
  if (lessonChange(lesson)) info.append(element('p', 'change-label', lessonChange(lesson)));
  row.append(slot, info);
  return row;
}

function changeRow(lesson, today) {
  const row = element('li', 'change-row');
  row.append(
    lessonTitle(lesson, 'h3'),
    element('p', 'change-date', (lesson.date === today ? 'Сегодня' : dateFormat.format(dateAt(lesson.date))) + ' · ' + lesson.start),
    element('p', 'change-label', lessonChange(lesson)),
  );
  return row;
}

function renderList(container, lessons, rowFor, emptyText) {
  if (!lessons.length) {
    container.replaceChildren(element('p', 'empty-state', emptyText));
    return;
  }
  const list = element('ul', 'lesson-list');
  list.append(...lessons.map(rowFor));
  container.replaceChildren(list);
}

function lessonOrder(first, second) {
  return first.date.localeCompare(second.date) || first.start.localeCompare(second.start);
}

function renderHome(lessons, nextWeekLessons, today) {
  const now = moscowTimeFormat.format(new Date());
  const upcoming = [...lessons, ...nextWeekLessons]
    .filter((lesson) => !lesson.cancelled && (lesson.date > today || (lesson.date === today && lesson.end > now)))
    .sort(lessonOrder);
  renderList(
    byId('upcoming-lessons'), upcoming.slice(0, 1), (lesson) => upcomingRow(lesson, today),
    'Ближайших занятий в расписании нет.',
  );
  const changed = [...lessons, ...nextWeekLessons]
    .filter((lesson) => lesson.date >= today && (lesson.change || lesson.cancelled))
    .sort(lessonOrder);
  renderList(
    byId('changed-lessons'), changed, (lesson) => changeRow(lesson, today),
    'Предстоящих изменений нет.',
  );
}

function selectDay(date) {
  selectedDay = date;
  for (const input of byId('day-picker').querySelectorAll('input')) input.checked = input.value === date;
  for (const column of byId('week-grid').children) {
    column.dataset.selected = String(column.dataset.date === date);
  }
}

function selectHomeDay(date) {
  selectedHomeDay = date;
  for (const input of byId('home-week').querySelectorAll('input')) input.checked = input.value === date;
  const day = byId('home-day');
  const heading = element('h3', 'home-day-heading', dayFormat.format(dateAt(date)));
  const lessons = schedule.lessons.filter((lesson) => lesson.date === date);
  const contents = element('div');
  renderList(contents, lessons, (lesson) => {
    const row = element('li', 'home-day-row');
    row.append(element('p', 'lesson-time', lessonTimes(lesson)), lessonTitle(lesson, 'h4'), lessonDetails(lesson));
    if (lesson.cancelled) row.classList.add('calendar-cancelled');
    if (lessonChange(lesson)) row.append(element('p', 'change-label', lessonChange(lesson)));
    return row;
  }, 'В этот день занятий нет.');
  day.replaceChildren(heading, contents);
}

function calendarDay(date, day, today, lessons, cardPrefix = 'lesson-') {
  const column = element('section', 'calendar-day');
  column.dataset.date = date;
  const header = element('div', 'day-header');
  const heading = element('h3', '', weekdays[day]);
  const label = element('time', '', dateFormat.format(dateAt(date)));
  label.dateTime = date;
  header.append(heading, label);
  if (date === today) {
    column.classList.add('calendar-today');
    label.append(element('span', 'visually-hidden', ', сегодня'));
  }
  column.append(header);
  renderList(column.appendChild(element('div', 'day-lessons')), lessons, (lesson) => {
    const card = element('li', 'calendar-card' + (lesson.status === 'moved' || lesson.status === 'cancelled' ? ' calendar-changed' : ''));
    card.id = cardPrefix + lesson.id;
    card.append(
      element('p', 'lesson-time', lessonTimes(lesson)),
      lessonTitle(lesson, 'h4'),
      lessonDetails(lesson),
    );
    if (lesson.cancelled) card.classList.add('calendar-cancelled');
    if (lessonChange(lesson)) card.append(element('p', 'change-label', lessonChange(lesson)));
    return card;
  }, 'Нет занятий');
  return column;
}

function renderHomeWeekLabel() {
  if (!schedule) return;
  const dates = weekDates(schedule.weekStart);
  const first = dates[0];
  const last = dates.at(-1);
  const label = byId('home-week-label');
  const full = dateFormat.formatRange(first, last);
  label.classList.remove('compact-week-label');
  label.removeAttribute('title');
  label.textContent = full;
  if (!mobileLayout.matches || first.getUTCFullYear() === last.getUTCFullYear() || !label.getClientRects().length) return;
  const range = label.parentElement;
  if (range.getBoundingClientRect().top < range.previousElementSibling.getBoundingClientRect().bottom) return;
  label.classList.add('compact-week-label');
  label.title = full;
  label.textContent = shortWeekDateFormat.formatRange(first, last)
    .replace(/\s*г\./g, '')
    .replace(/\s*–\s*/g, '–')
    .replace(/\s+/g, '\u200a');
}

function renderWeek(lessons, today, start) {
  const dates = weekDates(start);
  const isoDates = dates.map((day) => day.toISOString().slice(0, 10));
  const active = isoDates.includes(today) ? today : start;
  byId('week-label').textContent = dateFormat.formatRange(dates[0], dates.at(-1));
  const picker = byId('day-picker');
  const grid = byId('week-grid');
  const homeWeek = byId('home-week');
  const focusedHomeDay = homeWeek.contains(document.activeElement) ? document.activeElement.value : undefined;
  picker.querySelectorAll('label').forEach((label) => label.remove());
  grid.replaceChildren();
  homeWeek.querySelectorAll('label').forEach((label) => label.remove());
  renderHomeWeekLabel();

  for (const [index, isoDate] of isoDates.entries()) {
    const dayLessons = lessons.filter((lesson) => lesson.date === isoDate);
    const hasChanges = dayLessons.some(({ change, cancelled }) => change || cancelled);
    const dayName = dayFormat.format(dates[index]) + (isoDate === today ? ', сегодня' : '');
    const label = element('label', 'day-option');
    const input = element('input', 'visually-hidden');
    input.type = 'radio';
    input.name = 'visible-day';
    input.value = isoDate;
    input.checked = isoDate === active;
    input.setAttribute('aria-label', dayName + (hasChanges ? ', есть изменения' : ''));
    const chip = element('span', hasChanges ? 'day-chip day-chip-changed' : 'day-chip');
    chip.setAttribute('aria-hidden', 'true');
    chip.append(element('span', '', shortWeekdays[index]), element('strong', '', dates[index].getUTCDate()));
    label.append(input, chip);
    picker.append(label);
    grid.append(calendarDay(isoDate, index, today, dayLessons));
    const count = dayLessons.filter((lesson) => !lesson.cancelled).length;
    const homeLabel = label.cloneNode(true);
    const homeInput = homeLabel.querySelector('input');
    homeInput.name = 'home-visible-day';
    homeInput.setAttribute('aria-label', dayName + ', занятий: ' + count);
    homeInput.setAttribute('aria-controls', 'home-day');
    if (isoDate === today) homeInput.setAttribute('aria-current', 'date');
    const homeChip = homeLabel.querySelector('.day-chip');
    homeChip.className = 'mini-day';
    homeChip.append(element('span', 'mini-day-count', count ? String(count) : '—'));
    homeWeek.append(homeLabel);
  }
  selectDay(isoDates.includes(selectedDay) ? selectedDay : active);
  selectHomeDay(isoDates.includes(selectedHomeDay) ? selectedHomeDay : active);
  if (focusedHomeDay) {
    [...homeWeek.querySelectorAll('input')].find((input) => input.value === focusedHomeDay)?.focus({ preventScroll: true });
  }
}

function setScheduleMode(monthly) {
  byId('schedule-week-mode').setAttribute('aria-pressed', String(!monthly));
  byId('schedule-month-mode').setAttribute('aria-pressed', String(monthly));
  byId('schedule-week-view').hidden = monthly;
  byId('schedule-month-view').hidden = !monthly;
  if (!monthly || selectedMonth) return;
  const current = schedule?.today.slice(0, 7);
  const month = byId('schedule-month');
  month.value = [...month.options].some(({ value }) => value === current) ? current : '2026-11';
  loadMonthSchedule();
}

function renderMonth({ month, today, lessons }) {
  const grid = byId('month-grid');
  const first = dateAt(month + '-01');
  const days = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
  const offset = (first.getUTCDay() + 6) % 7;
  const cells = shortWeekdays.map((name) => element('span', 'month-weekday', name));
  const dayButtons = [];
  for (let index = 0; index < offset; index++) cells.push(element('span', 'month-blank'));
  for (let day = 1; day <= days; day++) {
    const date = month + '-' + String(day).padStart(2, '0');
    const weekday = (offset + day - 1) % 7;
    const entries = lessons.filter((lesson) => lesson.date === date);
    const hasChanges = entries.some(({ change, cancelled }) => change || cancelled);
    const cell = element('div', 'month-cell');
    if (weekday >= 5 && !entries.length) cell.classList.add('month-weekend');
    if (date === today) cell.classList.add('calendar-today');
    if (hasChanges) cell.classList.add('month-changed');
    const button = element('button', 'month-day-choice');
    button.type = 'button';
    button.setAttribute('aria-label', dayFormat.format(dateAt(date)) + ', занятий: ' + entries.length
      + (hasChanges ? ', есть изменения' : ''));
    button.setAttribute('aria-pressed', 'false');
    button.setAttribute('aria-controls', 'month-day');
    if (date === today) button.setAttribute('aria-current', 'date');
    button.append(element('span', 'month-choice-date', day));
    if (entries.length) button.append(element('span', 'month-choice-count', entries.length));
    if (hasChanges) button.append(element('span', 'month-change-mark', 'Изменения'));
    const select = (scroll = false) => {
      for (const item of dayButtons) item.button.setAttribute('aria-pressed', String(item.button === button));
      const agenda = calendarDay(date, weekday, today, entries, 'month-lesson-');
      byId('month-day').replaceChildren(agenda);
      if (scroll) agenda.scrollIntoView({ block: 'nearest' });
    };
    button.addEventListener('click', () => select(true));
    dayButtons.push({ button, date, select });
    const list = element('ul', 'month-lessons');
    for (const lesson of entries) {
      const row = element('li', 'month-lesson' + (lesson.cancelled ? ' calendar-cancelled' : '')
        + (lesson.status === 'moved' || lesson.status === 'cancelled' ? ' calendar-changed' : ''));
      const link = element('button', 'lesson-link');
      link.type = 'button';
      link.append(element('span', 'lesson-time', lesson.start), element('span', '', lesson.title));
      if (lesson.cancelled) link.append(element('span', 'visually-hidden', ', отменено'));
      link.addEventListener('click', () => openLesson(lesson.id, link));
      row.append(link);
      if (lesson.status === 'moved' || lesson.status === 'cancelled') row.append(element('p', 'change-label', lessonChange(lesson)));
      list.append(row);
    }
    cell.append(button, list);
    cells.push(cell);
  }
  grid.replaceChildren(...cells);
  if (window.matchMedia('(max-width: 960px)').matches) {
    (dayButtons.find(({ date }) => date === today) ?? dayButtons[0]).select();
  }
}

async function loadMonthSchedule() {
  const account = profile;
  const month = byId('schedule-month').value;
  selectedMonth = month;
  const load = {};
  monthScheduleLoad = load;
  const current = () => profile === account && monthScheduleLoad === load;
  const status = byId('month-schedule-status');
  const retry = byId('month-schedule-retry');
  retry.hidden = true;
  byId('month-grid').replaceChildren();
  byId('month-day').replaceChildren();
  status.textContent = 'Загружаем расписание…';
  try {
    const data = await request('/api/schedule?month=' + encodeURIComponent(month));
    if (!current()) return;
    renderMonth(data);
    status.textContent = '';
  } catch (error) {
    if (!current() || endSession(error)) return;
    status.textContent = error.message;
    retry.hidden = false;
  } finally {
    if (monthScheduleLoad === load) monthScheduleLoad = undefined;
  }
}

function showScheduleStatus(message = '', canRetry = false) {
  for (const [status, ...contents] of scheduleAreas) {
    if (status.hidden !== !message) status.hidden = !message;
    for (const content of contents) {
      if (content.hidden !== Boolean(message)) content.hidden = Boolean(message);
    }
    const label = status.querySelector('[data-status]');
    if (label.textContent !== message) label.textContent = message;
    const retry = status.querySelector('[data-schedule-retry]');
    if (retry.hidden !== !canRetry) retry.hidden = !canRetry;
  }
}

function showWeekNavigation(pending = false, message = '') {
  for (const button of document.querySelectorAll('[data-week-step]')) {
    if (pending) button.setAttribute('aria-disabled', 'true');
    else button.removeAttribute('aria-disabled');
  }
  for (const status of document.querySelectorAll('[data-week-status]')) status.textContent = message;
}

async function loadSchedule({ quiet = false, week } = {}) {
  const student = profile;
  const browsing = week !== undefined;
  if (!student || (scheduleLoad && (!browsing || scheduleLoad.browsing))) return;
  const load = { browsing };
  scheduleLoad = load;
  const selected = week ?? (schedule?.weekStart !== schedule?.currentWeek ? schedule.weekStart : undefined);
  const current = () => profile === student && scheduleLoad === load;
  let weekError = '';
  if (browsing) showWeekNavigation(true);
  else if (!quiet || !schedule) showScheduleStatus('Загружаем расписание…');
  try {
    const path = '/api/schedule' + (selected ? '?week=' + encodeURIComponent(selected) : '');
    const { today, weekStart, lessons, nextWeekLessons = [], selectedWeek } = await request(path);
    if (!current()) return;
    lessons.sort(lessonOrder);
    const visibleWeek = selectedWeek?.weekStart ?? weekStart;
    const visibleLessons = selectedWeek ? selectedWeek.lessons.sort(lessonOrder) : lessons;
    const update = () => {
      const calendarKey = JSON.stringify([today, visibleWeek, visibleLessons]);
      if (renders.get('calendar') !== calendarKey) {
        if (visibleWeek === weekStart) {
          if (selectedDay === schedule?.today) selectedDay = today;
          if (selectedHomeDay === schedule?.today) selectedHomeDay = today;
        }
        schedule = { today, weekStart: visibleWeek, currentWeek: weekStart, lessons: visibleLessons };
        renderWeek(visibleLessons, today, visibleWeek);
        renders.set('calendar', calendarKey);
      } else {
        schedule.currentWeek = weekStart;
      }
      const now = moscowTimeFormat.format(new Date());
      const ended = lessons.filter((lesson) => lesson.date === today && !lesson.cancelled && lesson.end <= now).length;
      const homeKey = JSON.stringify([today, weekStart, lessons, nextWeekLessons, ended]);
      if (renders.get('schedule-home') !== homeKey) {
        renderHome(lessons, nextWeekLessons, today);
        renders.set('schedule-home', homeKey);
      }
      showScheduleStatus();
      if (activeView === 'home') renderDashboard();
    };
    if (quiet || browsing) preservePagePosition(update);
    else update();
    revealTarget();
  } catch (error) {
    if (!current()) return;
    if (error.status === 401) {
      showLogin('Сессия завершена. Войдите снова.', true);
    } else if (browsing) {
      weekError = 'Не удалось открыть неделю. Нажмите стрелку ещё раз.';
    } else if (!quiet || !schedule) {
      showScheduleStatus(error.message, true);
    }
  } finally {
    if (current()) {
      scheduleLoad = undefined;
      if (browsing) showWeekNavigation(false, weekError);
    }
  }
}

const requestStatuses = {
  submitted: 'Подана', processing: 'В обработке', ready: 'Готова', rejected: 'Отклонена',
};
const appealStatuses = {
  pending: ['На рассмотрении', 'processing'],
  decided: ['Решение принято', 'ready'],
  withdrawn: ['Отозвано', 'withdrawn'],
};
const searchTypes = {
  section: 'Раздел', grade: 'Дисциплина', lesson: 'Занятие', assignment: 'Задание',
  contact: 'Контакт', notification: 'Объявление', request: 'Заявка', document: 'Документ', faq: 'Частый вопрос',
};
const eventFormat = new Intl.DateTimeFormat('ru-RU', {
  day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Moscow',
});

function resource(base, id, suffix = '') {
  return base + '/' + encodeURIComponent(id) + suffix;
}

function anchor(href, className, text) {
  const link = element('a', className, text);
  link.href = href;
  return link;
}

function endSession(error) {
  if (error.status !== 401) return false;
  showLogin('Сессия завершена. Войдите снова.', true);
  return true;
}

function post(path, data) {
  return request(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
}

function showCabinetStatus(message = '', retry = false) {
  const status = byId('cabinet-status');
  const text = byId('cabinet-status-text');
  const button = byId('cabinet-retry');
  if (status.hidden !== !message) status.hidden = !message;
  if (text.textContent !== message) text.textContent = message;
  if (button.hidden !== !retry) button.hidden = !retry;
}

function updateUnread(count) {
  byId('header-inbox').setAttribute('aria-label', 'Сообщения, непрочитанных: ' + count);
  for (const badge of document.querySelectorAll('[data-unread]')) {
    const hidden = !count && badge.classList.contains('nav-count');
    if (badge.hidden !== hidden) badge.hidden = hidden;
    if (badge.textContent !== String(count) || !badge.hasAttribute('aria-label')) {
      badge.textContent = count;
      badge.setAttribute('aria-label', 'Непрочитанных сообщений: ' + count);
    }
  }
}

async function loadCabinet({ quiet = false, fresh = false, refreshView, afterRender } = {}) {
  const account = profile;
  if (!account || (cabinetLoad && !fresh)) return;
  const load = {};
  cabinetLoad = load;
  if (!quiet && !cabinet) showCabinetStatus('Загружаем кабинет…');
  try {
    const payload = await request('/api/cabinet');
    if (profile !== account || cabinetLoad !== load) return;
    cabinet = payload;
    const update = () => {
      showCabinetStatus();
      updateUnread(cabinet.unreadCount);
      renderCabinet(refreshView === activeView);
    };
    if (quiet) preservePagePosition(update);
    else update();
    revealTarget();
    afterRender?.();
    return payload;
  } catch (error) {
    if (profile !== account || cabinetLoad !== load || endSession(error)) return;
    if (!quiet || !cabinet) showCabinetStatus(error.message, true);
  } finally {
    if (cabinetLoad === load) cabinetLoad = undefined;
  }
}

function renderCabinet(force = false) {
  if (activeView === 'home') renderDashboard();
  if (!cabinet) return;
  switch (activeView) {
    case 'grades':
      if (profile.role === 'student') {
        renderSection('grades-content', [cabinet.grades, cabinet.assignments, cabinet.appeals], renderStudentGrades, force);
      } else if (byId('teacher-enrollment-grades')) {
        renderSection('teacher-enrollment-grades', cabinet.grades, renderGrades, force);
      }
      break;
    case 'assignments':
      renderSection('assignments-content', [cabinet.grades, cabinet.assignments, cabinet.appeals], renderAssignments, force);
      break;
    case 'requests':
      renderSection('requests-content', cabinet.requests, renderRequests, force);
      break;
    case 'messages':
      byId('messaging').hidden = false;
      refreshDialogueList();
      renderDialogueContact(cabinet.dialogues.find((item) => item.id === selectedDialogue));
      break;
    case 'contacts':
      if (profile.role !== 'teacher') renderSection('contacts-content', cabinet.contacts ?? [], renderContacts, force);
      break;
    case 'updates':
      renderSection('updates-content', cabinet.notifications, renderUpdates, force);
      break;
  }
}

function renderSection(id, data, draw, force) {
  const root = byId(id);
  const signature = JSON.stringify(data);
  if (renders.get(id) === signature && !force) return;
  const focused = document.activeElement;
  const formInUse = root.contains(focused) && focused?.closest('form');
  const dirtyForm = root.querySelector('form[data-dirty]');
  const editingRequests = id === 'requests-content';
  const savedPortfolioRecord = force && root.hasAttribute('data-portfolio-record');
  if (editingRequests) {
    if (!force && root.querySelector('form[aria-busy="true"]')) return;
  } else if (!savedPortfolioRecord && (dirtyForm || (!force && (formInUse || root.querySelector('form[aria-busy="true"]'))))) {
    if (id === 'assignments-content') reconcileClosedAppeals(data[1], data[2]);
    return;
  }
  const drafts = editingRequests || savedPortfolioRecord
    ? [...root.querySelectorAll('form[data-dirty]')].map((form) => [form.id, [...form.elements]
      .filter((field) => field.name)
      .map((field) => [field.name, field.value, field.selectionStart, field.selectionEnd, field.type === 'file' ? field : null])])
    : [];
  if (editingRequests) {
    for (const note of root.querySelectorAll('[data-unsubmitted-note]')) {
      drafts.push([note.dataset.unsubmittedNote, [['note', note.textContent]]]);
    }
  }
  const focusedId = root.contains(focused) ? focused.id : '';
  const fallbackFocus = editingRequests && focusedId
    ? focused.closest('details')?.querySelector('summary')?.id : '';
  const openItems = [...root.querySelectorAll('details[open][id]')].map((item) => item.id);
  root.replaceChildren(...draw(data));
  for (const itemId of openItems) {
    const item = byId(itemId);
    if (item) item.open = true;
  }
  for (const [formId, fields] of drafts) {
    const form = byId(formId);
    if (!form) {
      if (!editingRequests) continue;
      const details = byId(formId.replace('request-status-', 'request-'));
      const note = fields.find(([name]) => name === 'note')?.[1];
      if (details && note) {
        const text = element('p', 'record-copy', note);
        text.dataset.unsubmittedNote = formId;
        details.append(element('h3', 'record-subheading', 'Неотправленный комментарий'), text);
      }
      continue;
    }
    for (const [name, value, start, end, fileInput] of fields) {
      const field = form.elements.namedItem(name);
      if (!field) continue;
      if (fileInput) {
        field.replaceWith(fileInput);
        continue;
      }
      if (field.tagName === 'SELECT' && ![...field.options].some((option) => option.value === value)) {
        field.selectedIndex = -1;
        continue;
      }
      field.value = value;
      if (Number.isInteger(start)) field.setSelectionRange(start, end);
      if (savedPortfolioRecord) {
        field.dispatchEvent(new Event('input', { bubbles: true }));
        field.dispatchEvent(new Event('change', { bubbles: true }));
      }
    }
    form.dataset.dirty = '';
  }
  if (focusedId) {
    const target = byId(focusedId) || (fallbackFocus ? byId(fallbackFocus) : null);
    target?.focus({ preventScroll: true });
  }
  renders.set(id, signature);
}

function panel(title, ...children) {
  const section = element('section', 'panel');
  section.append(element('h2', '', title), ...children);
  return section;
}

function listFor(items, draw, empty) {
  if (!items.length) return element('p', 'empty-state', empty);
  const list = element('ul', 'record-list');
  for (const item of items) {
    const row = element('li', 'record-row');
    row.append(draw(item));
    list.append(row);
  }
  return list;
}

function stat(href, value, label) {
  const item = anchor(href, 'panel stat');
  item.append(element('span', 'stat-label', label), element('strong', 'stat-value', value));
  return item;
}

function eventTime(value) {
  if (!value) return '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return dateFormat.format(dateAt(value));
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : eventFormat.format(date);
}

function renderDashboard() {
  const student = profile.role === 'student';
  const stats = byId(student ? 'home-stats' : 'home-staff-stats');
  const activeRequests = cabinet?.requests.filter((item) => ['submitted', 'processing'].includes(item.status)).length;
  const pendingAssignments = cabinet?.assignments.filter((item) => student
    ? !item.submission
    : item.submission?.status === 'submitted').length;
  const now = Date.now();
  const outstanding = student ? (cabinet?.assignments ?? [])
    .filter((item) => !item.submission)
    .sort((a, b) => a.dueAt.localeCompare(b.dueAt))
    .map((item) => ({ ...item, overdue: new Date(item.dueAt).getTime() < now })) : [];
  const deadlines = [
    ...outstanding.filter(({ overdue }) => overdue),
    ...outstanding.filter(({ overdue }) => !overdue).slice(0, 3),
  ];
  const recentKey = JSON.stringify([profile.role, cabinet?.requests, cabinet?.assignments, deadlines]);
  if (renders.get('dashboard') === recentKey) return;
  renders.set('dashboard', recentKey);
  const focused = document.activeElement?.id;
  const cards = [];
  if (student || profile.role === 'teacher') cards.push(stat('#assignments', pendingAssignments ?? '—', student ? 'Заданий к сдаче' : 'Работ на проверке'));
  if (student || profile.role === 'dean') cards.push(stat('#requests', activeRequests ?? '—', 'Открытых заявок'));
  for (const card of cards) card.id = 'stat-' + card.hash.slice(1);
  stats.replaceChildren(...cards);
  stats.hidden = false;
  if (focused?.startsWith('stat-')) byId(focused)?.focus({ preventScroll: true });

  if (student) {
    const deadlinePanel = panel('Ближайшие дедлайны', listFor(deadlines, (item) => {
      const row = element('div', 'record-line');
      const info = element('div');
      const title = element('h3', 'lesson-title');
      title.append(anchor('#assignments/assignment-' + item.id, 'inline-link', item.title));
      info.append(title, element('p', 'muted', item.subject));
      const deadline = element('time', 'deadline-date', eventTime(item.dueAt));
      deadline.dateTime = item.dueAt;
      const timing = element('div', 'deadline-timing');
      timing.append(deadline);
      if (item.overdue) timing.append(statusBadge('Просрочено', 'overdue'));
      row.append(info, timing);
      return row;
    }, cabinet ? 'Ближайших дедлайнов нет.' : 'Загружаем задания…'));
    byId('home-cabinet').replaceChildren(deadlinePanel);
    byId('home-cabinet').hidden = false;
    return;
  }

  const staff = byId('home-staff');
  if (!cabinet) return;
  const recent = profile.role === 'dean'
    ? cabinet.requests.filter((item) => ['submitted', 'processing'].includes(item.status)).slice(0, 4)
    : cabinet.assignments.filter((item) => item.submission?.status === 'submitted').slice(0, 4);
  const title = profile.role === 'dean' ? 'Открытые заявки' : 'Работы на проверке';
  staff.replaceChildren(panel(title, listFor(recent, (item) => {
    const row = element('div');
    row.append(element('h3', 'lesson-title', item.type || item.title), element('p', 'muted', item.studentName));
    return row;
  }, 'Новых записей нет.')));
  staff.hidden = false;
}

function renderGrades(grades) {
  if (!grades.length) return [panel('Оценки', element('p', 'empty-state', 'Оценок пока нет.'))];
  const semesters = [...new Set(grades.map((item) => item.semester))].sort((a, b) => b - a);
  return semesters.map((semester) => panel(semester + ' семестр', listFor(
    grades.filter((item) => item.semester === semester),
    gradeDetails,
    'Оценок пока нет.',
  )));
}

function gradeScore(points, maximum) {
  return pointsFormat.format(points) + ' / ' + pointsFormat.format(maximum);
}

function gradeDetails(item) {
  const student = profile.role === 'student';
  const detail = element('details', 'record-details grade');
  detail.id = 'grade-' + item.id;
  const summary = element('summary', 'record-summary');
  summary.id = detail.id + '-summary';
  const labels = element('span', 'record-labels');
  labels.append(element('strong', '', item.subject));
  if (!student) labels.append(element('span', 'muted', item.studentName));
  const score = element('span', 'grade-score', gradeScore(item.points, item.maxPoints));
  summary.append(labels, score);
  const progress = element('progress', 'grade-progress');
  progress.max = item.maxPoints;
  progress.value = item.points;
  progress.setAttribute('aria-label', 'Баллы по дисциплине «' + item.subject + '»');
  detail.append(summary, progress, metadata([
    ['Форма контроля', item.control],
    ['Итог контроля', item.result || 'Пока не зафиксирован'],
    ['Критерии', item.criteria],
  ]));
  return detail;
}

function renderStudentGrades([grades, assignments, appeals]) {
  if (!grades.length) return [panel('Оценки', element('p', 'empty-state', 'Оценок пока нет.'))];
  const semesters = [...new Set(grades.map((item) => item.semester))].sort((a, b) => b - a);
  const current = grades.filter(({ semester }) => semester === semesters[0]);
  const scored = current.filter(({ maxPoints }) => maxPoints > 0);
  const average = scored.length
    ? Math.round(scored.reduce((sum, { points, maxPoints }) => sum + points / maxPoints * 100, 0) / scored.length)
    : '—';
  const overview = element('div', 'grades-overview');
  overview.append(element('p', 'muted', 'Твой прогресс по дисциплинам'));
  const stats = element('dl', 'grade-stats');
  for (const [label, value] of [['Дисциплин', current.length], ['Средний балл из 100', average]]) {
    const stat = element('div', 'grade-stat');
    stat.append(element('dt', '', label), element('dd', '', value));
    stats.append(stat);
  }
  overview.append(stats);
  const appealsBySubmission = new Map(appeals.map((item) => [item.submissionId, item]));
  const blocks = semesters.map((semester, index) => {
    const isCurrent = index === 0;
    const block = element('details', 'panel grade-semester');
    block.id = 'grade-semester-' + semester;
    block.open = byId(block.id)?.open ?? isCurrent;
    const summary = element('summary', 'grade-semester-summary');
    summary.id = block.id + '-summary';
    summary.append(element('strong', '', semester + ' семестр'),
      statusBadge(isCurrent ? 'Текущий' : 'Завершён', isCurrent ? 'ready' : 'submitted'));
    const semesterGrades = grades.filter((item) => item.semester === semester);
    const results = listFor(semesterGrades, (item) => {
      const detail = gradeDetails(item);
      detail.open = byId(detail.id)?.open ?? (isCurrent && item === semesterGrades[0]);
      const related = assignments.filter((assignment) => assignment.enrollmentId === item.id);
      const breakdown = element('details', 'grade-breakdown');
      breakdown.id = detail.id + '-breakdown';
      const label = element('summary', '', 'Из чего складываются баллы');
      label.id = breakdown.id + '-summary';
      breakdown.append(label, studentGradeBreakdown(item, related, appealsBySubmission));
      detail.append(breakdown);
      return detail;
    }, 'Оценок пока нет.');
    block.append(summary, results);
    return block;
  });
  return [overview, ...blocks];
}

function studentGradeBreakdown(grade, assignments, appealsBySubmission) {
  const content = document.createDocumentFragment();
  content.append(metadata([
    ['Ранее учтённые баллы без детализации', gradeScore(grade.courseworkPoints, grade.courseworkMax)],
  ]));
  if (grade.lessonScores?.length) content.append(listFor(grade.lessonScores, (score) => {
    const row = element('div', 'record-line');
    row.append(element('span', '', score.title + ' · ' + eventTime(score.date)),
      element('span', 'grade-score', gradeScore(score.points, score.maxPoints)));
    return row;
  }));
  if (assignments.length) {
    content.append(listFor(assignments, (item) => {
      const row = element('div', 'record-line');
      const info = element('div');
      const assignment = anchor('#assignments/assignment-' + item.id, 'inline-link', item.title);
      assignment.id = 'grade-assignment-' + item.id;
      info.append(assignment);
      const appeal = appealsBySubmission.get(item.submission?.id);
      if (appeal) {
        const link = anchor('#assignments/appeal-' + appeal.id, 'inline-link', 'Пересмотр оценки');
        link.id = 'grade-appeal-' + appeal.id;
        info.append(element('br'), link);
      }
      const score = item.submission?.status === 'reviewed'
        ? element('span', 'grade-score', gradeScore(item.submission.points, item.maxPoints))
        : statusBadge('Не оценено · максимум ' + pointsFormat.format(item.maxPoints), 'submitted');
      row.append(info, score);
      return row;
    }, ''));
  }
  const unfinished = assignments.filter((item) => !item.submission).sort((a, b) => a.dueAt.localeCompare(b.dueAt));
  const now = Date.now();
  const upcoming = unfinished.find((item) => new Date(item.dueAt).getTime() >= now);
  const next = upcoming ?? unfinished.at(-1);
  if (next) {
    const deadline = element('time', 'deadline-date', eventTime(next.dueAt));
    deadline.dateTime = next.dueAt;
    const link = anchor('#assignments/assignment-' + next.id, 'inline-link', next.title);
    link.id = 'grade-next-assignment-' + next.id;
    const row = element('p', 'record-line');
    row.append(link, deadline);
    content.append(element('h3', 'record-subheading', upcoming ? 'Ближайшее задание к сдаче' : 'Просроченное задание к сдаче'), row);
  }
  return content;
}

function metadata(entries) {
  const list = element('dl', 'record-meta');
  for (const [label, value] of entries) {
    if (value === undefined || value === null || value === '') continue;
    list.append(element('dt', '', label), element('dd', '', value));
  }
  return list;
}

function statusBadge(text, status) {
  return element('span', 'status-badge status-' + status, text);
}

function contactCard(contact, { withId = false, canMessage = false, studentProfile } = {}) {
  const card = element('article', 'contact-card');
  if (withId) card.id = 'contact-' + contact.id;
  const name = element('h3', 'lesson-title', contact.name);
  name.tabIndex = -1;
  card.append(name);
  if (studentProfile) {
    const { faculty, program, group, year } = studentProfile;
    const details = element('dl', 'student-contact-profile');
    for (const [label, value] of [['Факультет', faculty], ['Направление', program], ['Группа', group], ['Курс', year]]) {
      if (value) details.append(element('dt', '', label), element('dd', '', String(value)));
    }
    if (details.childElementCount) card.append(details);
  }
  if (!contact.email) return card;
  const address = element('p', 'contact-address', contact.email);
  const actions = element('div', 'contact-actions');
  const copy = element('button', 'button button-secondary', 'Скопировать почту');
  copy.type = 'button';
  copy.setAttribute('aria-label', 'Скопировать почту ' + contact.name);
  const status = element('p', 'muted');
  status.setAttribute('role', 'status');
  copy.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(contact.email);
      status.textContent = 'Адрес скопирован.';
    } catch {
      status.textContent = 'Выделите и скопируйте адрес вручную.';
    }
  });
  const email = encodeURIComponent(contact.email);
  const mailto = 'mailto:' + email.replace('%40', '@');
  const mail = element('details', 'contact-mail-picker');
  const mailSummary = element('summary', 'inline-link', 'Открыть почту');
  const mailOptions = element('div', 'contact-mail-options');
  for (const [label, href] of [
    ['Gmail', 'https://mail.google.com/mail/?view=cm&fs=1&to=' + email],
    ['Почта Mail', 'https://e.mail.ru/compose/?mailto=' + encodeURIComponent(mailto)],
  ]) {
    const provider = anchor(href, 'inline-link', label);
    provider.target = '_blank';
    provider.rel = 'noopener noreferrer';
    mailOptions.append(provider);
  }
  mailOptions.append(anchor(mailto, 'inline-link', 'Почтовое приложение'));
  mail.append(mailSummary, mailOptions);
  const studentMessaging = canMessage && profile.role === 'student';
  const recipient = contact.teacherId
    ? resource('/api/dialogues/teacher', contact.teacherId)
    : contact.partnerId && resource('/api/dialogues/contact', contact.partnerId);
  const errorOutput = element('p', 'local-error');
  errorOutput.setAttribute('role', 'alert');
  if (studentMessaging && recipient) {
    const write = element('button', 'button button-secondary', 'Написать');
    write.type = 'button';
    write.addEventListener('click', (event) => startDialogue(recipient, write, errorOutput, event));
    actions.append(write);
  }
  actions.append(copy, mail);
  card.append(element('p', 'muted', 'Демо-адрес'), address, actions, status, errorOutput);
  if (studentMessaging && !recipient) {
    card.append(element('p', 'muted', 'Для этого преподавателя переписка в кабинете недоступна. Можно открыть почту.'));
  }
  return card;
}

async function startDialogue(path, button, errorOutput, event) {
  const account = profile;
  if (!account || signingOut || button.disabled) return;
  const origin = window.location.hash;
  const dialog = button.closest('dialog');
  const lesson = lessonOpen;
  const current = () => profile === account && window.location.hash === origin && (!dialog || (dialog.open && lessonOpen === lesson));
  button.disabled = true;
  errorOutput.textContent = '';
  try {
    const { dialogueId } = await post(path, {});
    if (!current()) return;
    const updated = await loadCabinet({ quiet: true, fresh: true });
    if (!current()) return;
    if (!updated?.dialogues.some(({ id }) => id === dialogueId)) {
      throw new Error('Не удалось загрузить диалог. Попробуйте ещё раз.');
    }
    if (dialog) closeLesson(false);
    navigateFromLink('#messages/dialogue-' + dialogueId, event);
  } catch (error) {
    if (current() && !endSession(error)) {
      (errorOutput.isConnected ? errorOutput : byId('app-error')).textContent = error.message;
    }
  } finally {
    button.disabled = false;
    if (current() && button.isConnected && document.activeElement === document.body) button.focus({ preventScroll: true });
  }
}

function renderContacts(contacts) {
  const card = (contact) => contactCard(contact, { withId: true, canMessage: true });
  const sections = [panel('Преподаватели', listFor(contacts.filter(({ role }) => role !== 'dean'), card, 'Доступных контактов пока нет.'))];
  const offices = contacts.filter(({ role }) => role === 'dean');
  if (offices.length) sections.push(panel('Службы университета', listFor(offices, card)));
  return sections;
}

function actionButton(text, action, primary = false) {
  const button = element('button', 'button ' + (primary ? 'button-primary' : 'button-secondary'), text);
  button.type = 'button';
  button.addEventListener('click', action);
  return button;
}

function teacherField(label, type, value = '') {
  const field = element('label', 'teacher-field', label);
  const input = element(type === 'textarea' ? 'textarea' : 'input');
  if (type !== 'textarea') input.type = type;
  input.value = value;
  field.append(input);
  return { field, input };
}

function teacherError() {
  const output = element('p', 'local-error');
  output.setAttribute('role', 'alert');
  return output;
}

function teacherFeedback(output, error) {
  if (!endSession(error)) output.textContent = error.message;
}

async function loadTeacherView(view, target, week) {
  if (!['schedule', 'grades', 'contacts'].includes(view)) return;
  const content = byId({ schedule: 'teacher-schedule', grades: 'grades-content', contacts: 'contacts-content' }[view]);
  const load = { account: profile };
  teacherViewLoad = load;
  const current = () => teacherViewLoad === load && profile === load.account && activeView === view;
  const id = target?.startsWith('journal-') ? target.slice(8) : undefined;
  const path = view === 'schedule' ? '/api/teacher/schedule' + (week ? '?week=' + encodeURIComponent(week) : '')
    : view === 'contacts' ? '/api/teacher/contacts' : id ? resource('/api/teacher/journal', id) : '/api/teacher/journal';
  content.replaceChildren(element('p', 'muted', 'Загрузка…'));
  try {
    const data = await request(path);
    if (!current()) return;
    if (view === 'schedule') {
      teacherSchedule = data;
      content.replaceChildren(renderTeacherSchedule(data));
    } else if (view === 'contacts') content.replaceChildren(renderTeacherContacts(data));
    else content.replaceChildren(...(id ? [renderTeacherJournal(data)] : renderTeacherJournalIndex(data)));
  } catch (error) {
    if (!current() || endSession(error)) return;
    content.replaceChildren(element('p', 'local-error', error.message),
      actionButton('Повторить', () => loadTeacherView(view, target, week)));
  }
}

function renderTeacherSchedule({ weekStart, lessons }) {
  const dates = weekDates(weekStart);
  const heading = element('div', 'teacher-toolbar');
  const step = (offset) => {
    const day = dateAt(weekStart);
    day.setUTCDate(day.getUTCDate() + offset);
    loadTeacherView('schedule', undefined, day.toISOString().slice(0, 10));
  };
  heading.append(actionButton('‹', () => step(-7)), element('strong', '', dateFormat.formatRange(dates[0], dates.at(-1))),
    actionButton('›', () => step(7)));
  heading.firstElementChild.setAttribute('aria-label', 'Предыдущая неделя');
  heading.lastElementChild.setAttribute('aria-label', 'Следующая неделя');
  const body = element('div', 'cabinet-layout');
  body.append(heading, listFor(lessons, (lesson) => {
    const row = element('article', 'teacher-lesson' + (lessonChange(lesson) ? ' calendar-changed' : ''));
    row.id = 'lesson-' + lesson.id;
    row.append(lessonTitle(lesson, 'h3'), element('p', 'lesson-time', eventTime(lesson.date) + ' · ' + lessonTimes(lesson)),
      lessonDetails(lesson), element('p', lessonChange(lesson) ? 'change-label' : 'muted', lessonChange(lesson) || 'Запланировано'));
    return row;
  }, 'На этой неделе назначенных занятий нет.'));
  return panel('Мои занятия', body);
}

function teacherLessonActions(lesson, load) {
  const wrapper = element('div', 'cabinet-layout');
  const actions = element('div', 'teacher-toolbar');
  const edit = element('div');
  actions.append(actionButton('Перенести', () => showChange('move')),
    actionButton('Отменить занятие', () => showChange('cancel')),
    actionButton('Выставить баллы', (event) => {
      closeLesson(false);
      navigateFromLink('#grades/journal-' + lesson.id, event);
    }, true));
  if (lesson.status === 'cancelled') {
    for (const button of [...actions.children].slice(0, 2)) button.disabled = true;
  }
  wrapper.append(actions, edit);
  function showChange(action) {
    const form = element('form', 'cabinet-form teacher-change-form');
    const summary = element('p', 'muted');
    const { field: commentField, input: comment } = teacherField('Комментарий для студентов', 'textarea');
    comment.maxLength = 500;
    const fields = action === 'move' ? [
      teacherField('Новая дата', 'date', lesson.date),
      teacherField('Начало', 'time', lesson.start),
      teacherField('Окончание', 'time', lesson.end),
      teacherField('Аудитория или формат', 'text', lesson.room),
    ] : [];
    const [day, start, end, room] = fields.map(({ input }) => input);
    const oldSlot = eventTime(lesson.date) + ', ' + lessonTimes(lesson);
    function describe() {
      summary.textContent = action === 'move'
        ? 'Было: ' + oldSlot + '. Новый слот: ' + (eventTime(day.value) || '—') + ', ' + start.value + '–' + end.value + '.'
        : 'Отменяется «' + lesson.title + '», ' + oldSlot + '. Группа: ' + lesson.group + '.';
    }
    const submit = element('button', 'button button-primary', action === 'move' ? 'Подтвердить перенос' : 'Подтвердить отмену');
    submit.type = 'submit';
    const error = teacherError();
    if (room) room.maxLength = 100;
    for (const { field, input } of fields) {
      input.required = input !== room;
      form.append(field);
    }
    form.append(commentField, summary, submit, error);
    describe();
    form.addEventListener('input', describe);
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      if (submit.disabled) return;
      submit.disabled = true;
      error.textContent = '';
      try {
        const { lesson: updated } = await post(resource('/api/teacher/lessons', lesson.id, '/change'), {
          action, comment: comment.value,
          ...(day && { date: day.value, start: start.value, end: end.value, room: room.value }),
        });
        if (profile !== load.account) return;
        if (lessonOpen === load) closeLesson(false);
        if (activeView === 'schedule') {
          const week = dateAt(updated.date);
          week.setUTCDate(week.getUTCDate() - (week.getUTCDay() + 6) % 7);
          await loadTeacherView('schedule', undefined, week.toISOString().slice(0, 10));
          byId('lesson-' + updated.id)?.querySelector('.lesson-link')?.focus({ preventScroll: true });
        }
        byId('action-status').textContent = action === 'move' ? 'Занятие перенесено.' : 'Занятие отменено.';
      } catch (failure) {
        if (profile === load.account && lessonOpen === load) teacherFeedback(error, failure);
      } finally {
        submit.disabled = false;
      }
    });
    edit.replaceChildren(form);
    (day ?? comment).focus();
  }
  return wrapper;
}

function renderTeacherContacts({ groups, contacts }) {
  const search = teacherField('Поиск по имени', 'search');
  const groupLabel = element('label', 'teacher-field', 'Группа');
  const group = element('select');
  for (const value of ['', ...groups]) {
    const option = element('option', '', value || 'Все группы');
    option.value = value;
    group.append(option);
  }
  groupLabel.append(group);
  const controls = element('div', 'teacher-toolbar');
  controls.append(search.field, groupLabel);
  const results = element('div', 'cabinet-layout');
  const updateResults = () => {
    const query = search.input.value.trim().toLocaleLowerCase('ru');
    const matching = contacts.filter((contact) => contact.name.toLocaleLowerCase('ru').includes(query)
      && (!group.value || contact.group === group.value || contact.role === 'dean'));
    results.replaceChildren(listFor(matching, (contact) => {
      const row = element('article', 'teacher-contact');
      const error = teacherError();
      const write = actionButton('Написать', (event) => startDialogue(
        resource('/api/teacher/contacts', contact.partnerId ?? contact.id, '/dialogue'), write, error, event,
      ));
      row.append(element('h3', '', contact.name),
        element('p', 'muted', [contact.roleLabel, contact.group || contact.department].filter(Boolean).join(' · ')), write, error);
      return row;
    }, 'Подходящих контактов нет.'));
  };
  search.input.addEventListener('input', updateResults);
  group.addEventListener('change', updateResults);
  updateResults();
  const body = element('div', 'cabinet-layout');
  body.append(controls);
  if (!groups.length) body.append(element('p', 'muted', 'Преподавателю пока не назначены учебные группы.'));
  body.append(results);
  return panel('Студенты и деканат', body);
}

function renderTeacherJournalIndex({ lessons, recent }) {
  const choose = panel('Журнал занятий', listFor(lessons, (lesson) => {
    const link = anchor('#grades/journal-' + lesson.id, 'inline-link', lesson.title + ' · ' + lesson.group);
    const row = element('div', 'cabinet-layout');
    row.append(link, metadata([
      ['Занятие', eventTime(lesson.date) + ', ' + lessonTimes(lesson)],
      ['Черновик', lesson.draftCount ? 'Заполнено строк: ' + lesson.draftCount : '—'],
    ]));
    return row;
  }, 'Назначенных занятий пока нет.'));
  const history = panel('Недавние изменения', listFor(recent, (publication) => {
    const { id, title, group, publishedAt, count, canUndo, expiredCount, blockedCount } = publication;
    const details = element('details', 'record-details');
    details.append(element('summary', 'record-summary', title + ' · ' + group + ' · ' + eventTime(publishedAt)));
    const output = teacherError();
    const content = element('div', 'cabinet-layout');
    const undo = element('details', 'record-details');
    const undoLabel = element('summary', 'record-summary', 'Отменить публикацию');
    undo.append(undoLabel, element('p', 'muted', 'Предмет: ' + title + '. Группа: ' + group + '. Оценок: ' + count + '.'));
    if (canUndo) {
      const confirm = actionButton('Подтвердить отмену публикации', async () => {
        confirm.disabled = true;
        output.textContent = '';
        try {
          await post(resource('/api/teacher/publications', id, '/undo'), {});
          if (window.location.hash === '#grades') loadTeacherView('grades');
        } catch (error) {
          teacherFeedback(output, error);
        } finally {
          confirm.disabled = false;
        }
      }, true);
      undo.append(confirm);
    } else {
      undo.append(element('p', 'muted', expiredCount
        ? 'Срок исправления истёк для части оценок. Доступные оценки можно исправить по одной.'
        : blockedCount ? 'Публикация изменилась. Доступные оценки можно исправить по одной.' : 'Отмена публикации недоступна.'));
    }
    content.append(element('p', 'muted', publication.work + ' · максимум ' + publication.maxPoints),
      listFor(publication.rows ?? [], (row) => {
        const entry = element('div', 'cabinet-layout');
        entry.append(element('strong', '', row.name), teacherScoreHistory(row));
        return entry;
      }, 'Оценок в публикации нет.'),
      anchor('#grades/journal-' + publication.lessonId, 'inline-link', 'Открыть журнал и оценки'), undo, output);
    details.append(content);
    return details;
  }, 'Публикаций пока нет.'));
  const legacy = element('div', 'cabinet-layout');
  legacy.id = 'teacher-enrollment-grades';
  if (cabinet) legacy.append(...renderGrades(cabinet.grades));
  return [choose, history, legacy];
}

function teacherScoreHistory(row) {
  const details = element('details', 'record-details');
  details.append(element('summary', 'record-summary', 'История оценки'));
  const score = (points) => points == null ? '—' : pointsFormat.format(points);
  const actions = {
    publish: 'Опубликовано', change: 'Изменено', delete: 'Удалено',
    restore: 'Восстановлено', undo: 'Публикация отменена', unpublish: 'Публикация отменена',
  };
  details.append(listFor(row.history ?? [], (event) => element('p', 'muted',
    [eventTime(event.at), event.author, actions[event.action] ?? event.action, score(event.before) + ' → ' + score(event.after)].join(' · ')),
  'Изменений пока нет.'));
  return details;
}

function renderTeacherJournal({ lesson, work, maxPoints, rows }) {
  const wrapper = element('div', 'cabinet-layout');
  const meta = metadata([
    ['Предмет', lesson.title], ['Группа', lesson.group], ['Занятие', eventTime(lesson.date) + ' · ' + lessonTimes(lesson)],
    ['Работа', work], ['Максимальный балл', maxPoints],
  ]);
  const form = element('form', 'cabinet-form teacher-journal');
  const account = profile;
  const hash = location.hash;
  const error = teacherError();
  const summary = element('p', 'muted');
  summary.setAttribute('aria-live', 'polite');
  const publish = element('button', 'button button-primary', 'Опубликовать заполненные строки');
  publish.type = 'submit';
  let publicationKey = crypto.randomUUID();
  let publishing = false;
  const entries = [];
  const current = () => profile === account && location.hash === hash;
  const pointValue = (input) => input.value === '' ? null : input.valueAsNumber;
  const valid = (input) => input.validity.valid && !input.validity.badInput;
  const rangeError = 'Введите балл от 0 до ' + maxPoints + '.';
  const refreshSummary = () => {
    const filled = entries.filter(({ input }) => !input.disabled && valid(input) && pointValue(input) !== null).length;
    const unfinished = entries.filter(({ input }) => !input.disabled && valid(input) && pointValue(input) === null).length;
    summary.textContent = 'Заполнено для публикации: ' + filled + '. Ещё предстоит оценить: ' + unfinished + '.';
    publish.disabled = publishing || !filled || entries.some(({ input }) => !input.disabled && !valid(input));
  };
  const makePointsField = (row, value) => {
    const points = teacherField('Балл — ' + row.name, 'number', value ?? '');
    points.input.min = '0';
    points.input.max = String(maxPoints);
    points.input.step = 'any';
    points.input.inputMode = 'decimal';
    points.input.setAttribute('enterkeyhint', 'next');
    return points;
  };
  const grid = listFor(rows, (row) => {
    const card = element('article', 'teacher-score-row');
    const posted = row.firstPublishedAt != null && row.points != null && !row.deleted;
    const locked = row.firstPublishedAt != null && !row.canEdit;
    const { field, input } = makePointsField(row, row.draft);
    const output = teacherError();
    const status = element('p', 'muted');
    status.setAttribute('role', 'status');
    input.disabled = posted || locked || Boolean(row.deleted);
    let saved = row.draft ?? null;
    let pending;
    let cachedError = false;
    const retry = actionButton('Повторить сохранение', () => void save());
    retry.hidden = true;
    const save = () => {
      if (pending || input.disabled) return pending;
      if (!valid(input)) {
        output.textContent = rangeError;
        return;
      }
      if (pointValue(input) === saved && !cachedError) return;
      pending = (async () => {
        do {
          const points = pointValue(input);
          try {
            await post(resource('/api/teacher/journal', lesson.id, '/draft'), { studentId: row.studentId, points });
            saved = points;
            output.textContent = valid(input) ? '' : rangeError;
            status.textContent = points === null ? 'Не оценено' : 'Черновик сохранён';
            cachedError = false;
            retry.hidden = true;
          } catch (failure) {
            cachedError = true;
            retry.hidden = false;
            if (profile === account) teacherFeedback(output, failure);
          }
        } while (profile === account && !cachedError && valid(input) && pointValue(input) !== saved);
      })().finally(() => { pending = undefined; });
      return pending;
    };
    const entry = { input, save, get saved() { return !cachedError && pointValue(input) === saved; } };
    entries.push(entry);
    input.addEventListener('input', () => {
      output.textContent = '';
      if (!valid(input)) output.textContent = rangeError;
      else void save();
      refreshSummary();
    });
    input.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' || event.isComposing) return;
      event.preventDefault();
      entries.slice(entries.indexOf(entry) + 1).find(({ input: next }) => !next.disabled)?.input.focus();
    });
    status.textContent = posted ? 'Опубликовано: ' + pointsFormat.format(row.points)
      : row.deleted ? 'Балл удалён' : row.draft == null ? 'Не оценено' : 'Черновик сохранён';
    card.append(element('h3', '', row.name), status);
    if (!input.disabled) card.append(field, retry, output);
    if (row.editableUntil) {
      const expiry = new Date(row.editableUntil).toLocaleString('ru-RU', {
        dateStyle: 'medium', timeStyle: 'short', timeZone: 'Europe/Moscow',
      });
      card.append(element('p', 'muted', (locked ? 'Срок исправления истёк: ' : 'Исправить до: ') + expiry + ' МСК'));
      if (locked) card.append(element('p', 'muted', 'Для исправления после срока свяжитесь с деканатом.'), anchor('#contacts', 'inline-link', 'Контакты деканата'));
      else if (posted || row.deleted) {
        const actions = element('div', 'teacher-toolbar');
        const actionError = teacherError();
        async function change(action, points) {
          try {
            await post(resource('/api/teacher/journal', lesson.id, '/score'), { studentId: row.studentId, action, points });
            if (current()) loadTeacherView('grades', 'journal-' + lesson.id);
          } catch (failure) {
            if (current()) {
              teacherFeedback(actionError, failure);
              if (failure.status === 409 && failure.message.includes('24 часа')) {
                actions.replaceChildren(anchor('#contacts', 'inline-link', 'Контакты деканата'));
              }
            }
          }
        }
        if (row.deleted) actions.append(actionButton('Восстановить', () => change('restore')));
        else {
          const edit = makePointsField(row, row.points);
          actions.append(edit.field, actionButton('Сохранить исправление', () => {
            if (!edit.input.reportValidity() || pointValue(edit.input) === null) return;
            change('change', pointValue(edit.input));
          }), actionButton('Удалить балл', () => change('delete')));
        }
        card.append(actions, actionError);
      }
      card.append(teacherScoreHistory(row));
    }
    return card;
  }, 'В группе пока нет студентов.');
  form.append(grid, summary, publish, error);
  refreshSummary();
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (publish.disabled) return;
    publishing = true;
    refreshSummary();
    error.textContent = '';
    try {
      const editable = entries.filter(({ input }) => !input.disabled);
      await Promise.all(editable.map(({ save }) => save()));
      if (!current()) return;
      if (editable.some(({ saved }) => !saved)) throw new Error('Сохраните черновик во всех заполненных строках перед публикацией.');
      await post(resource('/api/teacher/journal', lesson.id, '/publish'), { clientId: publicationKey });
      publicationKey = crypto.randomUUID();
      if (current()) loadTeacherView('grades', 'journal-' + lesson.id);
    } catch (failure) {
      if (current()) teacherFeedback(error, failure);
    } finally {
      publishing = false;
      refreshSummary();
    }
  });
  wrapper.append(anchor('#grades', 'inline-link', 'К списку занятий и изменениям'), meta, form);
  return panel('Выставить баллы', wrapper);
}

function renderDialogueContact(item) {
  const signature = JSON.stringify([item?.fullName, item?.contact, item?.studentProfile]);
  if (renders.get('dialogue-contact') === signature) return;
  const content = byId('dialogue-contact');
  content.replaceChildren();
  if (item?.contact || item?.studentProfile) {
    content.append(contactCard(item.contact ?? { name: item.fullName }, { studentProfile: item.studentProfile }));
  } else if (item) {
    content.append(element('p', 'record-copy', item.fullName ?? item.title));
  }
  renders.set('dialogue-contact', signature);
}

function formFor(id, buttonText, fields, submit, { quiet = false, onSaved, reload } = {}) {
  const form = element('form', 'cabinet-form');
  form.id = id;
  for (const field of fields) {
    const wrapper = element('div', 'form-field');
    const input = element(field.options ? 'select' : field.rows ? 'textarea' : 'input');
    input.name = field.name;
    input.id = id + '-' + field.name;
    input.required = field.required ?? true;
    if (field.options) {
      for (const [value, label] of field.options) {
        const option = element('option', '', label);
        option.value = value;
        input.append(option);
      }
    } else if (field.rows) {
      input.rows = field.rows;
    } else {
      input.type = field.type || 'text';
    }
    for (const property of ['min', 'max', 'step', 'maxLength', 'accept']) {
      if (field[property] !== undefined) input[property] = field[property];
    }
    if (field.value !== undefined) {
      if (field.options) {
        for (const option of input.options) option.defaultSelected = option.value === String(field.value);
      } else {
        input.defaultValue = field.value;
      }
    }
    const label = element('label', '', field.label);
    label.htmlFor = input.id;
    wrapper.append(label, input);
    form.append(wrapper);
  }
  const error = element('p', 'local-error');
  error.setAttribute('role', 'alert');
  const button = element('button', 'button button-primary', buttonText);
  button.type = 'submit';
  button.id = id + '-submit';
  form.append(error, button);
  form.addEventListener('input', () => { form.dataset.dirty = ''; });
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    if (button.disabled) return;
    performForm(form, error, submit, { onSaved, quiet, reload });
  });
  return form;
}

async function performForm(form, output, submit, { onSaved, quiet = false, isCurrent = () => true, reload = loadCabinet } = {}) {
  const account = profile;
  const view = activeView;
  const button = form.querySelector('button[type="submit"]');
  if (!account || signingOut || button.disabled) return;
  const data = new FormData(form);
  const fallback = form.closest('details')?.querySelector('summary')?.id || 'page-heading';
  button.disabled = true;
  form.setAttribute('aria-busy', 'true');
  output.textContent = '';
  try {
    const result = await submit(data);
    if (profile !== account) return;
    if (isCurrent()) {
      form.reset();
      delete form.dataset.dirty;
      onSaved?.(result);
    }
    if (!quiet) byId('action-status').textContent = 'Изменения сохранены.';
    await reload({
      fresh: true,
      refreshView: view,
      form,
      afterRender: () => {
        if (activeView !== view || !isCurrent()) return;
        const focused = document.activeElement;
        if (focused === document.body || focused === button) {
          const target = byId(button.id) || byId(fallback);
          if (target !== button) target?.focus({ preventScroll: true });
        }
      },
    });
  } catch (error) {
    if (profile === account && !endSession(error) && isCurrent()) output.textContent = error.message;
  } finally {
    button.disabled = false;
    form.removeAttribute('aria-busy');
    if (profile === account && activeView === view && isCurrent() && button.isConnected && document.activeElement === document.body) {
      button.focus({ preventScroll: true });
    }
  }
}

function renderRequests(requests) {
  const student = profile.role === 'student';
  return [panel(student ? 'Мои заявки' : 'Заявки студентов', listFor(requests, (item) => {
    const detail = element('details', 'record-details');
    detail.id = 'request-' + item.id;
    const summary = element('summary', 'record-summary');
    summary.id = detail.id + '-summary';
    const labels = element('span', 'record-labels');
    labels.append(element('strong', '', item.type), element('span', 'muted', [!student && item.studentName, eventTime(item.createdAt)].filter(Boolean).join(' · ')));
    summary.append(labels, statusBadge(requestStatuses[item.status] || item.status, item.status));
    detail.append(summary);
    if (student && item.status === 'ready') {
      const actions = element('div', 'request-document-actions');
      const download = anchor(resource('/api/requests', item.id, '/pdf'), 'inline-link', 'Скачать PDF');
      download.id = detail.id + '-pdf';
      download.download = '';
      const print = anchor(resource('/api/requests', item.id, '/print'), 'inline-link', 'Печать');
      print.id = detail.id + '-print';
      print.target = '_blank';
      print.rel = 'noopener';
      actions.append(download, print);
      detail.append(actions);
    }
    detail.append(element('h3', 'record-subheading', 'История заявки'), listFor(item.history, (event) => {
      const entry = element('div');
      entry.append(element('strong', '', requestStatuses[event.status] || event.status), element('p', 'muted', eventTime(event.createdAt)));
      if (event.note) entry.append(element('p', 'record-copy', event.note));
      return entry;
    }, 'Записей пока нет.'));
    if (!student && ['submitted', 'processing'].includes(item.status)) {
      const options = item.status === 'submitted' ? ['processing', 'ready', 'rejected'] : ['ready', 'rejected'];
      detail.append(formFor('request-status-' + item.id, 'Обновить статус', [
        { name: 'status', label: 'Новый статус', options: options.map((status) => [status, requestStatuses[status]]) },
        { name: 'note', label: 'Комментарий', rows: 2, maxLength: 1500, required: false },
      ], (data) => post(resource('/api/requests', item.id, '/status'), {
        status: data.get('status'), note: data.get('note').trim(),
      })));
    }
    return detail;
  }, 'Заявок пока нет.'))];
}

function helpDetails(id, title, ...content) {
  const details = element('details', 'record-details');
  details.id = id;
  const summary = element('summary', 'record-summary');
  summary.append(element('strong', 'record-labels', title));
  details.append(summary, ...content);
  return details;
}

function renderDocument(item) {
  const id = 'document-' + item.id;
  const status = element('p', 'muted document-submit-status');
  status.setAttribute('role', 'status');
  const form = formFor(id + '-form', 'Подать заявку', [], () => {
    status.textContent = '';
    return post('/api/requests', { type: item.title });
  }, {
    onSaved: () => { status.textContent = 'Заявка подана. Статус появится в разделе «Мои заявки».'; },
  });
  return helpDetails(id, item.title, element('p', 'record-copy', item.description), form, status);
}

function answerContent(answer, label) {
  const text = element('p', 'record-copy', answer.text);
  if (!roleViews[profile.role].includes(answer.view)) return [text];
  const hash = '#' + answer.view + (answer.target ? '/' + encodeURIComponent(answer.target) : '');
  return [text, anchor(hash, 'button button-secondary help-link', label ?? 'Перейти в раздел «' + views[answer.view] + '»')];
}

function appendHelpTurn(question, answer, found = true) {
  const turn = element('section', 'help-turn');
  turn.append(element('p', 'help-question', question), element('h3', '', answer.title),
    ...answerContent(answer, !found && profile.role === 'student' ? 'Написать в деканат' : undefined));
  byId('help-answer').append(turn);
  const history = byId('help-history');
  history.scrollTop = history.scrollHeight;
}

function revealHelpTarget() {
  if (!helpTarget || !helpDialog.open || !helpCatalog) return;
  const entry = helpCatalog.faq.find(({ id }) => 'faq-' + id === helpTarget);
  helpTarget = undefined;
  if (entry) appendHelpTurn(entry.title, entry);
}

function sizeHelpDialog() {
  const viewport = window.visualViewport;
  if (!viewport || !helpDialog.open) return;
  helpDialog.style.setProperty('--help-height', viewport.height + 'px');
  helpDialog.style.setProperty('--help-bottom', Math.max(0, window.innerHeight - viewport.offsetTop - viewport.height) + 'px');
}

function openHelp(target) {
  if (!profile) return;
  helpTarget = target;
  if (!helpDialog.open) {
    helpDialog.show();
    helpLauncher.setAttribute('aria-expanded', 'true');
    sizeHelpDialog();
  }
  loadHelpCatalog();
  revealHelpTarget();
}

async function loadHelpCatalog() {
  if (!profile || helpCatalog || helpCatalogLoad) return;
  const account = profile;
  const load = {};
  helpCatalogLoad = load;
  const areas = ['faq', ...(account.role === 'student' ? ['document-catalog'] : [])];
  for (const area of areas) {
    byId(area + '-status').textContent = 'Загружаем…';
    byId(area + '-retry').hidden = true;
  }
  const current = () => profile === account && helpCatalogLoad === load;
  try {
    const payload = await request('/api/help');
    if (!current()) return;
    if (account.role === 'student') {
      byId('documents-content').replaceChildren(listFor(payload.documents, renderDocument, 'Каталог пока пуст.'));
    }
    for (const area of areas) byId(area + '-status').textContent = '';
    helpCatalog = payload;
    updateHelpSuggestions();
    revealTarget();
    revealHelpTarget();
  } catch (error) {
    if (!current() || endSession(error)) return;
    for (const area of areas) {
      byId(area + '-status').textContent = error.message;
      byId(area + '-retry').hidden = false;
    }
  } finally {
    if (helpCatalogLoad === load) helpCatalogLoad = undefined;
  }
}

function helpWords(text) {
  return text.normalize('NFC').toLowerCase().replaceAll('ё', 'е').match(/[\p{L}\p{N}]+/gu) ?? [];
}

function helpWordScore(query, word) {
  if (word === query) return 4;
  if (word.startsWith(query)) return 2;
  if (query.length < 5 || Math.abs(query.length - word.length) > 1) return 0;
  let index = 0;
  while (index < query.length && query[index] === word[index]) index++;
  if (query.length < word.length) return query.slice(index) === word.slice(index + 1) ? 1 : 0;
  if (query.length > word.length) return query.slice(index + 1) === word.slice(index) ? 1 : 0;
  if (query.slice(index + 1) === word.slice(index + 1)) return 1;
  return query[index] === word[index + 1] && query[index + 1] === word[index]
    && query.slice(index + 2) === word.slice(index + 2) ? 1 : 0;
}

function findHelpSuggestions(faq, text) {
  const tokens = helpWords(text);
  const singleLetter = /^\p{L}$/u.test(text.trim().normalize('NFC'));
  const words = singleLetter ? tokens : [...new Set(tokens)]
    .filter((word) => !['как', 'где', 'и', 'в', 'на', 'по', 'о', 'об', 'для'].includes(word));
  if (!words.length || (!singleLetter && words.every((word) => word.length < 2))) return [];
  const shortPrefix = words.length === 1 && words[0].length < 5;
  return faq.map((entry) => {
    const phrases = shortPrefix ? [entry.title] : [entry.title, ...entry.terms];
    const score = phrases.reduce((best, phrase) => {
      const tokens = helpWords(phrase);
      const scores = words.map((word) => tokens.reduce((max, token) => Math.max(max, helpWordScore(word, token)), 0));
      return scores.every(Boolean) ? Math.max(best, scores.reduce((sum, value) => sum + value, 0)) : best;
    }, 0);
    return { entry, score };
  }).filter(({ score }) => score > 0).sort((a, b) => b.score - a.score).slice(0, 4).map(({ entry }) => entry);
}

function renderHelpSuggestions() {
  const input = byId('help-query');
  const list = byId('help-suggestions');
  list.hidden = !helpSuggestions.length;
  input.setAttribute('aria-expanded', String(!list.hidden));
  input.removeAttribute('aria-activedescendant');
  list.replaceChildren(...helpSuggestions.map((entry, index) => {
    const option = element('li', 'help-suggestion', entry.title);
    option.id = 'help-option-' + index;
    option.setAttribute('role', 'option');
    option.setAttribute('aria-selected', String(index === helpSelection));
    if (index === helpSelection) input.setAttribute('aria-activedescendant', option.id);
    option.addEventListener('mousedown', (event) => event.preventDefault());
    option.addEventListener('click', () => {
      helpSelection = index;
      byId('help-form').requestSubmit();
    });
    return option;
  }));
}

function hideHelpSuggestions() {
  helpSuggestions = [];
  helpSelection = -1;
  renderHelpSuggestions();
}

function syncHelpSend() {
  byId('help-send').disabled = Boolean(helpQuestionLoad) || !byId('help-query').value.trim();
}

function updateHelpSuggestions() {
  syncHelpSend();
  helpSuggestions = findHelpSuggestions(helpCatalog?.faq ?? [], byId('help-query').value);
  helpSelection = -1;
  renderHelpSuggestions();
}

function resetHelpQuestion() {
  helpQuestionLoad?.controller.abort();
  helpQuestionLoad = undefined;
  byId('help-form').reset();
  syncHelpSend();
  byId('help-status').textContent = '';
  byId('help-answer').replaceChildren();
  hideHelpSuggestions();
}

async function askHelp(event) {
  event.preventDefault();
  const account = profile;
  const input = byId('help-query');
  const draft = input.value;
  const selected = helpSuggestions[helpSelection];
  const query = selected?.title ?? draft.trim();
  if (!account || !query || helpQuestionLoad) return;
  const load = { controller: new AbortController() };
  helpQuestionLoad = load;
  hideHelpSuggestions();
  byId('help-send').disabled = true;
  byId('help-status').textContent = 'Ищем ответ…';
  const current = () => profile === account && helpQuestionLoad === load;
  try {
    const { answer, found } = await request('/api/help?q=' + encodeURIComponent(query), { signal: load.controller.signal });
    if (!current()) return;
    if (input.value === draft) {
      input.value = '';
      hideHelpSuggestions();
    }
    byId('help-status').textContent = '';
    appendHelpTurn(query, selected ?? answer, selected ? true : found);
  } catch (error) {
    if (current() && !endSession(error)) byId('help-status').textContent = error.message;
  } finally {
    if (helpQuestionLoad === load) {
      helpQuestionLoad = undefined;
      syncHelpSend();
    }
  }
}

function renderLibrary() {
  if (!library) return;
  const query = byId('library-query').value.trim().toLocaleLowerCase('ru-RU').replaceAll('ё', 'е');
  const subject = byId('library-subject').value;
  const favorites = byId('library-favorites').checked;
  const books = library.filter((book) => (
    (!subject || book.subject === subject) &&
    (!favorites || book.favorite) &&
    [book.title, book.author].some((text) => text.toLocaleLowerCase('ru-RU').replaceAll('ё', 'е').includes(query))
  ));
  const root = byId('library-results');
  const focusedId = root.contains(document.activeElement) ? document.activeElement.id : '';
  const results = listFor(books, (book) => {
    const card = element('article', 'library-book');
    const info = element('div', 'library-book-info');
    const favorite = element('button', 'button button-secondary library-favorite', book.favorite ? 'В избранном' : 'В избранное');
    favorite.id = 'library-favorite-' + book.id;
    favorite.type = 'button';
    favorite.setAttribute('aria-label', (book.favorite ? 'Убрать из избранного: ' : 'В избранное: ') + book.title);
    favorite.setAttribute('aria-pressed', String(book.favorite));
    if (librarySaves.has(book.id)) favorite.setAttribute('aria-disabled', 'true');
    favorite.addEventListener('click', () => saveFavorite(book, favorite));
    info.append(
      element('h3', '', book.title),
      element('p', 'muted', book.author),
      element('p', 'library-subject', book.subject),
      element('p', 'record-copy', book.description),
    );
    card.append(info, favorite);
    return card;
  }, favorites && !query && !subject ? 'В избранном пока нет книг.' : 'По вашему запросу ничего не найдено');
  root.replaceChildren(results);
  const status = byId('library-status');
  status.classList.toggle('visually-hidden', !books.length);
  status.textContent = books.length ? 'Найдено книг: ' + books.length : results.textContent;
  if (focusedId) (byId(focusedId) || byId('library-favorites')).focus({ preventScroll: true });
}

async function loadLibrary() {
  if (!profile || library || libraryLoad) return;
  const account = profile;
  const load = {};
  libraryLoad = load;
  byId('library-status').textContent = 'Загружаем каталог…';
  byId('library-error').textContent = '';
  byId('library-retry').hidden = true;
  try {
    const { books } = await request('/api/library');
    if (profile !== account || libraryLoad !== load) return;
    const subjects = [...new Set(books.map((book) => book.subject))].sort((a, b) => a.localeCompare(b, 'ru'));
    for (const subject of subjects) byId('library-subject').add(new Option(subject, subject));
    library = books;
    renderLibrary();
  } catch (error) {
    if (profile !== account || endSession(error)) return;
    byId('library-status').textContent = '';
    byId('library-error').textContent = error.message;
    byId('library-retry').hidden = false;
  } finally {
    if (libraryLoad === load) libraryLoad = undefined;
  }
}

async function saveFavorite(book, button) {
  const account = profile;
  if (!account || librarySaves.has(book.id)) return;
  const favorite = !book.favorite;
  librarySaves.add(book.id);
  button.setAttribute('aria-disabled', 'true');
  byId('library-error').textContent = '';
  try {
    await post(resource('/api/library', book.id, '/favorite'), { favorite });
    if (profile === account) book.favorite = favorite;
  } catch (error) {
    if (profile === account && !endSession(error)) byId('library-error').textContent = error.message;
  } finally {
    if (profile === account) {
      librarySaves.delete(book.id);
      renderLibrary();
    }
  }
}

const docxType = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const uploadTypes = { pdf: 'application/pdf', docx: docxType };

function uploadSubmission(id, file) {
  if (!file?.size) throw new Error('Выберите файл PDF или DOCX.');
  if (file.size > 10 * 1024 * 1024) throw new Error('Размер файла превышает 10 МБ.');
  const extension = file.name.trim().toLowerCase().match(/\.([^.]+)$/)?.[1];
  if (!Object.hasOwn(uploadTypes, extension)) throw new Error('Выберите файл PDF или DOCX.');
  return request(resource('/api/assignments', id, '/submission'), {
    method: 'POST',
    headers: { 'Content-Type': uploadTypes[extension], 'X-Filename': encodeURIComponent(file.name) },
    body: file,
  });
}

function renderAssignments([grades, assignments, appeals]) {
  const student = profile.role === 'student';
  const sections = [];
  if (!student && grades.length) {
    const semester = Math.max(...grades.map((item) => item.semester));
    const current = grades.filter((item) => item.semester === semester);
    sections.push(panel('Назначить задание', formFor('new-assignment', 'Назначить', [
      { name: 'enrollmentId', label: 'Дисциплина и студент', options: current.map((item) => [item.id, item.subject + ' · ' + item.studentName]) },
      { name: 'title', label: 'Название', maxLength: 120 },
      { name: 'description', label: 'Описание', rows: 3, maxLength: 2000 },
      { name: 'dueAt', label: 'Срок сдачи', type: 'date' },
      { name: 'maxPoints', label: 'Максимум баллов', type: 'number', min: 0.01, max: 1000, step: 'any' },
    ], (data) => post('/api/assignments', {
      enrollmentId: Number(data.get('enrollmentId')),
      title: data.get('title').trim(),
      description: data.get('description').trim(),
      dueAt: data.get('dueAt'),
      maxPoints: Number(data.get('maxPoints')),
    }))));
  }
  const appealsBySubmission = new Map(appeals.map((item) => [item.submissionId, item]));
  const assignmentsBySubmission = new Map(assignments.filter((item) => item.submission).map((item) => [item.submission.id, item]));
  sections.push(panel(student ? 'Мои задания' : 'Назначенные задания', listFor(assignments, (item) => {
    const detail = element('details', 'record-details');
    detail.id = 'assignment-' + item.id;
    const summary = element('summary', 'record-summary');
    summary.id = detail.id + '-summary';
    const labels = element('span', 'record-labels');
    labels.append(element('strong', '', item.title), element('span', 'muted', [
      item.subject, !student && item.studentName, eventTime(item.dueAt),
    ].filter(Boolean).join(' · ')));
    const submission = item.submission;
    const badge = submission?.status === 'reviewed'
      ? statusBadge(submission.points + ' / ' + item.maxPoints + ' баллов', 'ready')
      : statusBadge(submission ? 'На проверке' : 'Ожидает сдачи', submission ? 'processing' : 'submitted');
    summary.append(labels, badge);
    detail.append(summary, element('p', 'record-copy', item.description), metadata([
      ['Срок сдачи', eventTime(item.dueAt)],
      ['Максимум баллов', item.maxPoints],
      ['Комментарий преподавателя', submission?.comment],
    ]));
    if (submission) {
      const download = anchor(resource('/api/submissions', submission.id, '/file'), 'file-link', 'Скачать ' + submission.filename);
      download.id = detail.id + '-download';
      detail.append(download);
    }
    if (student && submission?.status !== 'reviewed') {
      const upload = formFor('assignment-upload-' + item.id, submission ? 'Заменить работу' : 'Отправить работу', [
        { name: 'file', label: 'Файл PDF или DOCX до 10 МБ', type: 'file', accept: '.pdf,.docx,application/pdf,' + docxType },
      ], (data) => uploadSubmission(item.id, data.get('file')));
      detail.append(upload);
    }
    if (!student && submission?.status === 'submitted') {
      detail.append(formFor('assignment-review-' + item.id, 'Сохранить оценку', [
        { name: 'points', label: 'Баллы', type: 'number', min: 0, max: item.maxPoints, step: 'any' },
        { name: 'comment', label: 'Комментарий к работе', rows: 3, maxLength: 1500 },
      ], (data) => post(resource('/api/submissions', submission.id, '/review'), {
        points: Number(data.get('points')), comment: data.get('comment').trim(),
      })));
    }
    if (student && submission?.status === 'reviewed' && !appealsBySubmission.has(submission.id)) {
      detail.append(formFor('assignment-appeal-' + item.id, 'Запросить пересмотр', [
        { name: 'reason', label: 'Причина пересмотра', rows: 3, maxLength: 1500 },
      ], (data) => post(resource('/api/submissions', submission.id, '/appeal'), {
        reason: data.get('reason').trim(),
      })));
    }
    return detail;
  }, 'Заданий пока нет.')));

  sections.push(panel('Пересмотры оценок', listFor(appeals, (item) => (
    renderAppeal(item, assignmentsBySubmission.get(item.submissionId), student)
  ), 'Запросов на пересмотр пока нет.')));
  return sections;
}

function reconcileClosedAppeals(assignments, appeals) {
  for (const appeal of appeals) {
    if (appeal.status !== 'withdrawn' && appeal.status !== 'decided') continue;
    const detail = byId('appeal-' + appeal.id);
    if (!detail?.querySelector('form')) continue;
    const focused = detail.contains(document.activeElement);
    const assignment = assignments.find((item) => item.submission?.id === appeal.submissionId);
    const replacement = renderAppeal(appeal, assignment, profile.role === 'student');
    replacement.open = detail.open;
    detail.replaceWith(replacement);
    if (focused) replacement.querySelector('summary').focus({ preventScroll: true });
  }
}

function renderAppeal(item, assignment, student) {
  const detail = element('details', 'record-details');
  detail.id = 'appeal-' + item.id;
  const summary = element('summary', 'record-summary');
  summary.id = detail.id + '-summary';
  const labels = element('span', 'record-labels');
  labels.append(element('strong', '', item.title), element('span', 'muted', [
    !student && assignment?.studentName, eventTime(item.createdAt),
  ].filter(Boolean).join(' · ')));
  summary.append(labels, statusBadge(...(appealStatuses[item.status] ?? [item.status, 'submitted'])));
  detail.append(summary, metadata([
    ['Запрос подан', eventTime(item.createdAt)],
    ['Причина', item.reason],
    ['Исходные баллы', item.oldPoints],
    ['Итоговые баллы', item.status === 'decided' ? item.newPoints ?? item.oldPoints : null],
    ['Решение принято', eventTime(item.decidedAt)],
    ['Отозвано', eventTime(item.withdrawnAt)],
    ['Ответ преподавателя', item.comment],
  ]));
  if (item.history?.length) {
    detail.append(element('h3', 'record-subheading', 'История обращения'), listFor(item.history, (event) => {
      const row = element('p', 'record-copy');
      row.append(element('strong', '', appealStatuses[event.status]?.[0] ?? event.status), ' · ' + eventTime(event.createdAt));
      return row;
    }, ''));
  }
  if (student && item.status === 'pending') {
    detail.append(formFor('appeal-withdraw-' + item.id, 'Отозвать', [],
      () => post(resource('/api/appeals', item.id, '/withdraw'), {}),
      { quiet: true }));
  }
  if (!student && item.status === 'pending') {
    detail.append(formFor('appeal-decision-' + item.id, 'Сохранить решение', [
      { name: 'comment', label: 'Ответ студенту', rows: 3, maxLength: 1500 },
      { name: 'points', label: 'Новые баллы (необязательно)', type: 'number', min: 0, max: assignment?.maxPoints, step: 'any', required: false },
    ], (data) => post(resource('/api/appeals', item.id, '/decision'), {
      comment: data.get('comment').trim(),
      points: data.get('points') === '' ? null : Number(data.get('points')),
    })));
  }
  return detail;
}

const portfolioAchievementPath = '/api/portfolio/achievements';
const portfolioRecommendationPath = '/api/portfolio/recommendations';
const achievementCategories = {
  study: 'Учёба',
  research: 'Наука',
  projects: 'Проекты',
  olympiads: 'Олимпиады и конкурсы',
  volunteering: 'Волонтёрство',
  sports: 'Спорт',
  creativity: 'Творчество',
  internships: 'Стажировки',
};
const portfolioStatuses = {
  draft: ['Черновик', 'submitted'],
  pending: ['На проверке', 'processing'],
  confirmed: ['Подтверждено', 'ready'],
  clarification: ['Нужно уточнение', 'processing'],
  rejected: ['Отклонено', 'rejected'],
  accepted: ['Принят в работу', 'processing'],
  published: ['Опубликована', 'ready'],
};
const portfolioActionLabels = {
  created: 'Создан черновик',
  edited: 'Изменены сведения',
  file_attached: 'Загружено вложение',
  file_removed: 'Удалено вложение',
  submitted: 'Отправлено на проверку',
  requested: 'Запрошена рекомендация',
  resubmitted: 'Отправлено уточнение',
  published: 'Опубликована версия',
};
const portfolioFileTypes = { pdf: 'application/pdf', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png' };
const portfolioDate = new Intl.DateTimeFormat('ru-RU', { dateStyle: 'long', timeZone: 'UTC' });

async function loadPortfolio({ quiet = false, fresh = false, afterRender, form } = {}) {
  const account = profile;
  if (!account || (portfolioLoad && !fresh)) return;
  const load = {};
  const status = byId('portfolio-status');
  const refresh = byId('portfolio-refresh');
  portfolioLoad = load;
  if (!quiet) {
    refresh.disabled = true;
    status.textContent = portfolio ? '' : 'Загружаем портфолио…';
  }
  try {
    const payload = await request('/api/portfolio');
    if (profile !== account || portfolioLoad !== load) return;
    portfolio = payload;
    status.textContent = form ? 'Изменения сохранены.' : '';
    const forceId = form?.closest('[data-portfolio-record]')?.id;
    preservePagePosition(() => renderPortfolio(forceId));
    if (activeView === 'profile') revealTarget();
    afterRender?.();
  } catch (error) {
    if (profile !== account || portfolioLoad !== load || endSession(error)) return;
    if (!quiet || !portfolio) status.textContent = error.message;
  } finally {
    if (portfolioLoad === load) {
      portfolioLoad = undefined;
      refresh.disabled = false;
    }
  }
}

function portfolioForm(id, label, fields, submit, onSaved) {
  return formFor(id, label, fields, submit, { reload: loadPortfolio, quiet: true, onSaved });
}

function portfolioDetails(id, title) {
  const details = element('details', 'record-details');
  details.id = id;
  const summary = element('summary', 'record-summary');
  summary.id = id + '-summary';
  summary.append(element('strong', 'record-labels', title));
  details.append(summary);
  return details;
}

function portfolioRecord(id, title, item, subtitle, pendingLabel = portfolioStatuses.pending[0]) {
  const detail = portfolioDetails(id, title);
  const summary = detail.firstElementChild;
  if (subtitle) summary.firstElementChild.append(element('span', 'muted portfolio-record-subtitle', subtitle));
  const [label, color] = portfolioStatuses[item.status] || [item.status, 'submitted'];
  summary.append(statusBadge(item.status === 'pending' ? pendingLabel : label, color));
  return detail;
}

function portfolioHistory(id, history) {
  const detail = portfolioDetails(id, 'История изменений');
  detail.classList.add('portfolio-action');
  detail.append(listFor(history, (event) => {
    const entry = element('div');
    entry.append(element('strong', '', portfolioActionLabels[event.action] ?? portfolioStatuses[event.status]?.[0] ?? event.status));
    entry.append(element('p', 'muted', [event.actorName, eventTime(event.createdAt)].filter(Boolean).join(' · ')));
    if (event.reviewerName && event.action === 'submitted') {
      entry.append(metadata([['Проверяющий', event.reviewerName]]));
    }
    if (event.note) entry.append(element('p', 'record-copy', event.note));
    return entry;
  }, 'Записей пока нет.'));
  return detail;
}

function portfolioPersonOptions(people) {
  return [['', 'Выберите сотрудника'], ...people.map(({ id, name, role }) => [
    id, role === 'dean' ? name + ' · Деканат' : name,
  ])];
}

function achievementForm(item = {}) {
  const existing = Boolean(item.id);
  const base = existing ? resource(portfolioAchievementPath, item.id) : portfolioAchievementPath;
  return portfolioForm(existing ? 'portfolio-achievement-edit-' + item.id : 'portfolio-new-achievement',
    existing ? 'Сохранить изменения' : 'Сохранить черновик', [
      { name: 'title', label: 'Название', maxLength: 150, value: item.title },
      { name: 'category', label: 'Категория', options: [['', 'Выберите категорию'], ...Object.entries(achievementCategories)], value: item.category },
      { name: 'date', label: 'Дата достижения', type: 'date', value: item.date },
      { name: 'organizer', label: 'Организатор', maxLength: 150, value: item.organizer },
      { name: 'description', label: 'Описание', rows: 3, maxLength: 1500, required: false, value: item.description },
    ], (data) => post(base, Object.fromEntries(data)), existing ? undefined : (result) => {
      if (activeView === 'profile') pendingTarget = 'portfolio-achievement-' + result.id;
    });
}

function uploadPortfolioFile(base, file) {
  if (!file?.size) throw new Error('Выберите файл PDF, JPG или PNG.');
  if (file.size > 10 * 1024 * 1024) throw new Error('Размер файла превышает 10 МБ.');
  const extension = file.name.trim().toLowerCase().match(/\.([^.]+)$/)?.[1];
  if (!Object.hasOwn(portfolioFileTypes, extension)) throw new Error('Выберите файл PDF, JPG или PNG.');
  return request(base + '/file', {
    method: 'POST',
    headers: { 'Content-Type': portfolioFileTypes[extension], 'X-Filename': encodeURIComponent(file.name) },
    body: file,
  });
}

function portfolioDecisionForm(id, base, statuses) {
  const form = portfolioForm(id, 'Сохранить решение', [
    { name: 'status', label: 'Решение', options: [['', 'Выберите решение'], ...statuses.map((status) => [status, portfolioStatuses[status][0]])] },
    { name: 'note', label: 'Комментарий', rows: 3, maxLength: 1500, required: false },
  ], (data) => post(base + '/review', Object.fromEntries(data)));
  const select = form.elements.namedItem('status');
  const note = form.elements.namedItem('note');
  select.addEventListener('change', () => { note.required = ['clarification', 'rejected'].includes(select.value); });
  return form;
}

function renderPortfolioAchievement(item) {
  const student = profile.role === 'student';
  const id = 'portfolio-achievement-' + item.id;
  const base = resource(portfolioAchievementPath, item.id);
  const detail = portfolioRecord(id, item.title, item, student ? achievementCategories[item.category] : item.studentName);
  detail.append(metadata([
    ['Категория', achievementCategories[item.category] ?? item.category],
    ['Дата', item.date && portfolioDate.format(dateAt(item.date))],
    ['Организатор', item.organizer],
    ['Описание', item.description],
    ['Проверяющий', item.reviewerName],
  ]));
  if (item.attachment) {
    const download = anchor(base + '/file', 'file-link', 'Скачать ' + item.attachment.filename);
    download.id = id + '-download';
    download.download = '';
    detail.append(download);
  }
  detail.append(portfolioHistory(id + '-history', item.history));
  if (student) {
    const edit = portfolioDetails(id + '-edit', 'Изменить достижение');
    edit.classList.add('portfolio-action');
    if (item.status !== 'draft') edit.append(element('p', 'muted', 'После изменения запись станет черновиком. Для подтверждения отправьте её на проверку снова.'));
    edit.append(achievementForm(item));
    detail.append(edit);
    const file = portfolioDetails(id + '-attachment', item.attachment ? 'Изменить вложение' : 'Прикрепить файл');
    file.classList.add('portfolio-action');
    if (item.status !== 'draft') file.append(element('p', 'muted', 'После изменения вложения запись станет черновиком.'));
    file.append(portfolioForm('portfolio-achievement-file-' + item.id, item.attachment ? 'Заменить файл' : 'Загрузить файл', [
      { name: 'file', label: 'Файл PDF, JPG или PNG до 10 МБ', type: 'file', accept: '.pdf,.jpg,.jpeg,.png,application/pdf,image/jpeg,image/png' },
    ], (data) => uploadPortfolioFile(base, data.get('file'))));
    if (item.attachment) {
      file.append(portfolioForm('portfolio-achievement-remove-file-' + item.id, 'Удалить вложение', [],
        () => post(base + '/remove-file', {})));
    }
    detail.append(file);
    if (['draft', 'clarification'].includes(item.status)) {
      if (portfolio.reviewers.length) {
        detail.append(portfolioForm('portfolio-achievement-submit-' + item.id, 'Отправить на проверку', [
          { name: 'reviewerId', label: 'Проверяющий', options: portfolioPersonOptions(portfolio.reviewers), value: item.reviewerId || '' },
        ], (data) => post(base + '/submit', { reviewerId: Number(data.get('reviewerId')) })));
      } else {
        detail.append(element('p', 'muted', 'Доступных проверяющих пока нет.'));
      }
    }
    if (item.status === 'draft') {
      const remove = portfolioDetails(id + '-remove', 'Удалить черновик');
      remove.classList.add('portfolio-action');
      remove.append(element('p', 'muted', 'Запись и вложение будут удалены.'), portfolioForm(
        'portfolio-achievement-delete-' + item.id, 'Удалить достижение', [], () => post(base + '/delete', {}),
        () => { if (activeView === 'profile') pendingTarget = 'portfolio-achievements-heading'; },
      ));
      detail.append(remove);
    }
  } else if (item.status === 'pending') {
    detail.append(portfolioDecisionForm('portfolio-achievement-review-' + item.id, base, ['confirmed', 'clarification', 'rejected']));
  }
  return detail;
}

function recommendationForm(item = {}) {
  const existing = Boolean(item.id);
  const fields = [
    { name: 'goal', label: 'Цель рекомендации', maxLength: 150, value: item.goal },
    { name: 'context', label: 'Контекст', rows: 3, maxLength: 1500, required: false, value: item.context },
    { name: 'deadline', label: 'Желаемый срок', type: 'date', value: item.deadline },
  ];
  if (!existing) fields.unshift({ name: 'teacherId', label: 'Преподаватель', options: portfolioPersonOptions(portfolio.teachers) });
  const base = existing ? resource(portfolioRecommendationPath, item.id, '/resubmit') : portfolioRecommendationPath;
  return portfolioForm(existing ? 'portfolio-recommendation-resubmit-' + item.id : 'portfolio-new-recommendation',
    existing ? 'Отправить уточнение' : 'Отправить запрос', fields, (data) => {
      const body = Object.fromEntries(data);
      if (!existing) body.teacherId = Number(body.teacherId);
      return post(base, body);
    }, existing ? undefined : (result) => {
      if (activeView === 'profile') pendingTarget = 'portfolio-recommendation-' + result.id;
    });
}

function recommendationVersions(id, versions) {
  const newest = versions.reduce((latest, version) => version.version > latest.version ? version : latest);
  const versionsPanel = portfolioDetails(id + '-versions', 'Предыдущие версии');
  versionsPanel.classList.add('portfolio-action');
  const published = element('section', 'portfolio-publication');
  published.append(element('h4', '', 'Опубликованная рекомендация'), metadata([
    ['Автор', newest.authorName], ['Опубликована', eventTime(newest.publishedAt)],
  ]), element('p', 'record-copy', newest.text));
  const previous = versions.filter((version) => version !== newest).sort((a, b) => b.version - a.version);
  if (previous.length) {
    versionsPanel.append(listFor(previous, (version) => {
      const entry = element('div');
      entry.append(element('strong', '', 'Версия ' + version.version), element('p', 'muted', eventTime(version.publishedAt)),
        element('p', 'record-copy', version.text));
      return entry;
    }, ''));
    published.append(versionsPanel);
  }
  return published;
}

function recommendationDraft(item, base) {
  const draft = portfolioDetails('portfolio-recommendation-' + item.id + '-editor', 'Черновик рекомендации');
  draft.classList.add('portfolio-action');
  draft.append(element('p', 'muted', 'Черновик виден только вам. Сохраните текст перед публикацией.'));
  const form = portfolioForm('portfolio-recommendation-draft-' + item.id, 'Сохранить черновик', [
    { name: 'text', label: 'Текст рекомендации', rows: 5, maxLength: 2500, value: item.draft || '' },
  ], (data) => post(base + '/draft', { text: data.get('text') }));
  const publish = portfolioForm('portfolio-recommendation-publish-' + item.id,
    item.versions.length ? 'Опубликовать новую версию' : 'Опубликовать рекомендацию', [],
    () => post(base + '/publish', {}));
  const publishButton = publish.querySelector('button');
  publishButton.disabled = !item.draft;
  const text = form.elements.namedItem('text');
  text.addEventListener('input', () => { publishButton.disabled = !item.draft || text.value !== item.draft; });
  draft.append(form, publish);
  return draft;
}

function renderPortfolioRecommendation(item) {
  const student = profile.role === 'student';
  const id = 'portfolio-recommendation-' + item.id;
  const base = resource(portfolioRecommendationPath, item.id);
  const detail = portfolioRecord(id, item.goal, item, student ? item.teacherName : item.studentName, 'На рассмотрении');
  detail.append(metadata([
    ['Запрос отправлен', eventTime(item.createdAt)],
    ['Желаемый срок', item.deadline && portfolioDate.format(dateAt(item.deadline))],
    ['Контекст', item.context],
  ]));
  if (item.versions.length) detail.append(recommendationVersions(id, item.versions));
  detail.append(portfolioHistory(id + '-history', item.history));
  if (student && item.status === 'clarification') detail.append(recommendationForm(item));
  if (profile.role === 'teacher') {
    if (['pending', 'accepted'].includes(item.status)) {
      const decisions = item.status === 'pending' ? ['accepted', 'clarification', 'rejected'] : ['clarification', 'rejected'];
      detail.append(portfolioDecisionForm('portfolio-recommendation-review-' + item.id, base, decisions));
    }
    if (['accepted', 'published'].includes(item.status)) detail.append(recommendationDraft(item, base));
  }
  return detail;
}

function exportablePortfolio() {
  const student = profile.role === 'student';
  const records = [
    ...portfolio.achievements.filter((item) => student || item.status === 'confirmed').map(({ id, studentId, studentName, title, status }) => ({
      id, studentId, studentName, type: 'achievement', label: title, statusLabel: portfolioStatuses[status]?.[0],
    })),
    ...portfolio.recommendations.filter((item) => item.versions.length).map(({ id, studentId, studentName, goal, teacherName }) => ({
      id, studentId, studentName, type: 'recommendation', label: goal, statusLabel: teacherName,
    })),
  ];
  const ids = new Set(records.map(portfolioExportId));
  for (const id of portfolioExportSelection) if (!ids.has(id)) portfolioExportSelection.delete(id);
  return records;
}

function portfolioExportId(item) {
  return 'portfolio-export-' + item.type + '-' + item.id;
}

function portfolioExport(records) {
  const isStudent = profile.role === 'student';
  const children = [element('h3', '', 'Экспорт портфолио')];
  if (!records.length) {
    return [...children, element('p', 'empty-state', 'Нет записей для экспорта.')];
  }
  const body = element('div', 'portfolio-export-body');
  children.push(body);
  if (!isStudent) {
    const students = new Map(records.map((item) => [String(item.studentId), item.studentName]));
    const field = element('div', 'form-field portfolio-student-select');
    const label = element('label', '', 'Студент');
    const select = element('select');
    label.htmlFor = select.id = 'portfolio-export-student';
    for (const [id, name] of [['', 'Выберите студента'], ...students]) {
      const option = element('option', '', name);
      option.value = id;
      select.append(option);
    }
    if (!students.has(portfolioExportStudent)) portfolioExportStudent = '';
    select.value = portfolioExportStudent;
    select.addEventListener('change', () => {
      portfolioExportStudent = select.value;
      portfolioExportSelection.clear();
      drawChoices();
    });
    field.append(label, select);
    children.splice(1, 0, field);
  }

  function drawChoices() {
    const eligible = isStudent ? records : records.filter((item) => String(item.studentId) === portfolioExportStudent);
    body.replaceChildren();
    if (!eligible.length) return;
    const pdf = anchor('', 'button button-primary', 'Скачать PDF');
    pdf.id = 'portfolio-pdf';
    pdf.download = '';
    const print = anchor('', 'button button-secondary', 'Печать');
    print.id = 'portfolio-print';
    print.target = '_blank';
    print.rel = 'noopener';
    const actions = element('div', 'portfolio-export-actions');
    pdf.setAttribute('role', 'link');
    print.setAttribute('role', 'link');
    actions.append(pdf, print);
    const fields = new Map();
    for (const [type, title] of [['achievement', 'Достижения'], ['recommendation', 'Рекомендации']]) {
      const items = eligible.filter((item) => item.type === type);
      if (!items.length) continue;
      const fieldset = element('fieldset', 'portfolio-export-choices');
      fieldset.append(element('legend', '', title));
      for (const item of items) {
        const label = element('label', 'portfolio-export-option');
        const checkbox = element('input');
        checkbox.type = 'checkbox';
        checkbox.id = portfolioExportId(item);
        checkbox.checked = portfolioExportSelection.has(checkbox.id);
        fields.set(checkbox, item);
        checkbox.addEventListener('change', () => {
          if (checkbox.checked) portfolioExportSelection.add(checkbox.id);
          else portfolioExportSelection.delete(checkbox.id);
          updateLinks();
        });
        const copy = element('span');
        copy.append(element('strong', '', item.label));
        if (item.statusLabel) copy.append(element('span', 'muted', item.statusLabel));
        label.append(checkbox, copy);
        fieldset.append(label);
      }
      body.append(fieldset);
    }
    body.prepend(element('p', 'muted', 'Отметьте записи для PDF и печати.'));
    body.append(actions);
    updateLinks();

    function updateLinks() {
      const selected = [...fields].filter(([checkbox]) => checkbox.checked).map(([, item]) => item);
      const params = new URLSearchParams();
      if (!isStudent) params.set('studentId', portfolioExportStudent);
      params.set('achievementIds', selected.filter((item) => item.type === 'achievement').map((item) => item.id).join(','));
      params.set('recommendationIds', selected.filter((item) => item.type === 'recommendation').map((item) => item.id).join(','));
      for (const [link, path] of [[pdf, 'pdf'], [print, 'print']]) {
        if (selected.length) {
          link.href = '/api/portfolio/' + path + '?' + params;
          link.removeAttribute('aria-disabled');
          link.removeAttribute('tabindex');
        } else {
          link.removeAttribute('href');
          link.setAttribute('aria-disabled', 'true');
          link.tabIndex = -1;
        }
      }
    }
  }
  drawChoices();
  return children;
}

function renderPortfolioRecords(host, type, items, draw, empty, forceId) {
  const container = byId(host);
  if (!items.length) {
    for (const row of container.querySelectorAll('[data-portfolio-record]')) renders.delete(row.id);
    if (!container.querySelector('.empty-state')) container.replaceChildren(element('p', 'empty-state', empty));
    return;
  }
  container.querySelector(':scope > .empty-state')?.remove();
  let list = container.querySelector('ul');
  if (!list) {
    list = element('ul', 'record-list');
    container.append(list);
  }
  const visible = new Set(items.map((item) => 'portfolio-' + type + '-row-' + item.id));
  for (const row of [...list.children]) {
    if (!visible.has(row.id)) {
      renders.delete(row.id);
      row.remove();
    }
  }
  items.forEach((item, index) => {
    const id = 'portfolio-' + type + '-row-' + item.id;
    let row = byId(id);
    if (!row) {
      row = element('li', 'record-row');
      row.id = id;
      row.dataset.portfolioRecord = '';
    }
    if (list.children[index] !== row) list.insertBefore(row, list.children[index] || null);
    const data = type === 'achievement' ? [item, portfolio.reviewers] : item;
    renderSection(id, data, () => [draw(item)], id === forceId);
  });
}

function renderPortfolio(forceId) {
  const student = profile.role === 'student';
  byId('portfolio-heading').textContent = student ? 'Моё портфолио' : 'Портфолио студентов';
  byId('portfolio-achievements').hidden = false;
  byId('portfolio-recommendations').hidden = profile.role === 'dean';
  byId('portfolio-export').hidden = false;
  byId('portfolio-achievements-heading').textContent = student ? 'Достижения' : 'Достижения студентов';
  byId('portfolio-recommendations-heading').textContent = student ? 'Рекомендации' : 'Запросы рекомендаций';
  if (student) {
    renderSection('portfolio-achievement-create', true, () => {
      const detail = portfolioDetails('portfolio-achievement-new', 'Добавить достижение');
      detail.classList.add('portfolio-action');
      detail.append(achievementForm());
      return [detail];
    });
    renderSection('portfolio-recommendation-create', portfolio.teachers, (teachers) => {
      if (!teachers.length) return [element('p', 'muted', 'Доступных для запроса преподавателей пока нет.')];
      const detail = portfolioDetails('portfolio-recommendation-new', 'Запросить рекомендацию');
      detail.classList.add('portfolio-action');
      detail.append(recommendationForm());
      return [detail];
    });
  }
  renderPortfolioRecords('portfolio-achievement-list', 'achievement', portfolio.achievements,
    renderPortfolioAchievement, 'Достижений пока нет.', forceId);
  renderPortfolioRecords('portfolio-recommendation-list', 'recommendation', portfolio.recommendations,
    renderPortfolioRecommendation, 'Запросов рекомендаций пока нет.', forceId);
  renderSection('portfolio-export', exportablePortfolio(), portfolioExport);
}

let newDialogueMode = false;
let dialogueListScroll = 0;
let dialogueListQuery = '';
let receivedMessages = [];
let receiptSync;

const shortMessageTime = new Intl.DateTimeFormat('ru-RU', { timeZone: 'Europe/Moscow', hour: '2-digit', minute: '2-digit' });
const dialogueDate = new Intl.DateTimeFormat('ru-RU', { timeZone: 'Europe/Moscow', day: 'numeric', month: 'short' });
const messageDay = new Intl.DateTimeFormat('ru-RU', { timeZone: 'Europe/Moscow', dateStyle: 'long' });

function dialogueName(item) {
  const parts = item.title.split(/\s+/);
  return parts.length < 3 ? item.title : parts[0] + ' ' + parts.at(-1);
}

function dialogueInitials(item) {
  return dialogueName(item).split(/\s+/).map((part) => part[0]).join('');
}

function refreshDialogueList() {
  if (!cabinet) return;
  const list = byId('dialogues-content');
  const position = list.scrollTop;
  renderSection('dialogues-content', [cabinet.dialogues, cabinet.dialogueContacts, selectedDialogue, newDialogueMode,
    byId('dialogue-search').value, byId('dialogue-filter').value, byId('dialogue-category').value], renderDialogues);
  list.scrollTop = position;
  const modeButton = byId('dialogue-new');
  const modeLabel = newDialogueMode ? 'Назад к диалогам' : 'Новый диалог';
  modeButton.setAttribute('aria-label', modeLabel);
  modeButton.querySelector('path').setAttribute('d', newDialogueMode ? 'M19 12H5m7-7-7 7 7 7' : 'M12 5v14M5 12h14');
  byId('dialogue-new-tooltip').textContent = modeLabel;
  byId('dialogues-heading').textContent = newDialogueMode ? 'Новая переписка' : mobileMessenger.matches ? 'Сообщения' : 'Диалоги';
  byId('dialogue-search').placeholder = newDialogueMode ? 'Поиск контактов' : 'Поиск диалогов';
  byId('dialogue-filter').hidden = newDialogueMode;
  byId('dialogue-category').hidden = !newDialogueMode;
}

function setNewDialogueMode(open) {
  if (newDialogueMode === open) return;
  const search = byId('dialogue-search');
  if (open) dialogueListQuery = search.value;
  search.value = open ? '' : dialogueListQuery;
  newDialogueMode = open;
  byId('dialogue-start-error').textContent = '';
  dialogueListScroll = 0;
  refreshDialogueList();
}

function renderDialogues([dialogues, directory]) {
  const query = byId('dialogue-search').value.trim().toLocaleLowerCase('ru');
  const partners = new Set(dialogues.map(({ partnerId }) => partnerId));
  const candidates = newDialogueMode
    ? [...dialogues, ...directory.filter(({ partnerId }) => !partners.has(partnerId))]
      .filter(({ partnerRole }) => partnerRole === byId('dialogue-category').value)
    : dialogues.filter(({ lastAt, unreadCount }) => lastAt && (byId('dialogue-filter').value !== 'unread' || unreadCount));
  const filtered = candidates.filter((item) => [dialogueName(item), item.fullName, item.roleLabel, newDialogueMode ? null : item.lastText]
    .some((value) => value?.toLocaleLowerCase('ru').includes(query)));
  if (!filtered.length) return [element('p', 'empty-state', query ? 'Ничего не найдено.' : newDialogueMode ? 'Новых контактов пока нет.' : 'Диалогов пока нет.')];
  return filtered.map((item) => {
    const button = element('button', 'dialogue-button');
    button.type = 'button';
    button.id = item.id === undefined ? 'dialogue-contact-' + item.partnerId : 'dialogue-' + item.id;
    if (item.id !== undefined) button.setAttribute('aria-pressed', String(selectedDialogue === item.id));
    const avatar = element('span', 'dialogue-avatar', dialogueInitials({ title: item.fullName ?? item.title }));
    avatar.setAttribute('aria-hidden', 'true');
    const summary = element('span', 'dialogue-summary');
    summary.append(element('strong', 'dialogue-name', dialogueName(item)), element('span', 'dialogue-role', item.roleLabel));
    if (item.lastText) summary.append(element('span', 'dialogue-preview', (item.lastMine ? 'Вы: ' : '') + item.lastText));
    const meta = element('span', 'dialogue-meta');
    if (item.lastAt) {
      const date = new Date(item.lastAt);
      const time = element('time', '', messageDay.format(date) === messageDay.format(new Date())
        ? shortMessageTime.format(date) : dialogueDate.format(date));
      time.dateTime = item.lastAt;
      meta.append(time);
    }
    button.append(avatar, summary, meta);
    if (item.unreadCount) {
      const badge = element('span', 'count-badge', item.unreadCount);
      badge.setAttribute('aria-label', 'Непрочитанных сообщений: ' + item.unreadCount);
      meta.append(badge);
    }
    button.addEventListener('click', (event) => {
      if (item.id === undefined) {
        startDialogue(resource('/api/dialogues/contact', item.partnerId), button, byId('dialogue-start-error'), event);
      } else openDialogue(item, event.detail > 0);
    });
    return button;
  });
}

function openDialogue(item, pointer) {
  if (mobileMessenger.matches && !history.state?.messengerThread) {
    const hash = '#messages/dialogue-' + item.id;
    if (window.location.hash !== '#messages') history.replaceState(history.state, '', '#messages');
    history.pushState({ messengerThread: true }, '', hash);
    pageHash = hash;
  }
  const list = byId('dialogues-content');
  if (list.getClientRects().length) dialogueListScroll = list.scrollTop;
  const heading = byId('dialogue-heading');
  heading.classList.toggle('pointer-navigation', pointer);
  if (helpDialog.open) {
    helpNavigationClose = true;
    helpDialog.close();
  }
  if (selectedDialogue === item.id) {
    heading.focus({ preventScroll: true });
    refreshDialogue();
    return;
  }
  selectedDialogue = item.id;
  receivedMessages = [];
  byId('messaging').classList.add('has-dialogue');
  byId('messages-new').hidden = true;
  byId('dialogue-avatar').textContent = dialogueInitials({ title: item.fullName ?? item.title });
  byId('dialogue-info')?.removeAttribute('open');
  byId('dialogue-role').textContent = item.roleLabel;
  for (const button of list.querySelectorAll('button')) {
    button.setAttribute('aria-pressed', String(button.id === 'dialogue-' + item.id));
  }
  byId('dialogue-heading').textContent = mobileMessenger.matches ? item.fullName ?? item.title : dialogueName(item);
  byId('dialogue-heading').title = item.fullName ?? item.title;
  byId('dialogue-heading').focus({ preventScroll: true });
  byId('dialogue-error').textContent = '';
  renderDialogueContact(item);
  sizeMessaging();
  composingMessage = false;
  setEmojiPanel(false);
  messageForm.hidden = false;
  syncComposer();
  byId('messages-content').replaceChildren(element('p', 'empty-state', 'Загружаем переписку…'));
  renderedMessages.clear();
  renders.delete('messages');
  refreshDialogue(false, true);
}

function closeDialogue() {
  const id = selectedDialogue;
  if (activeView === 'messages' && window.location.hash.startsWith('#messages/dialogue-')) {
    pageHash = '#messages';
    history.replaceState(null, '', pageHash);
  }
  selectedDialogue = undefined;
  dialogueLoad = undefined;
  receivedMessages = [];
  byId('messaging').classList.remove('has-dialogue');
  sizeMessaging();
  byId('dialogue-heading').textContent = 'Переписка';
  byId('dialogue-heading').removeAttribute('title');
  for (const field of ['dialogue-avatar', 'dialogue-role', 'dialogue-error']) byId(field).textContent = '';
  byId('dialogue-info').removeAttribute('open');
  renderDialogueContact();
  byId('messages-new').hidden = true;
  messageForm.hidden = true;
  setEmojiPanel(false);
  byId('messages-content').replaceChildren(element('p', 'empty-state', 'Выберите диалог.'));
  refreshDialogueList();
  byId('dialogues-content').scrollTop = dialogueListScroll;
  if (id !== undefined) (byId('dialogue-' + id) ?? byId('dialogue-search')).focus({ preventScroll: true });
}

function messageActions(item) {
  const details = element('details', 'message-actions');
  const summary = element('summary', '', '…');
  summary.setAttribute('aria-label', 'Действия сообщения');
  const actions = element('div', 'message-action-list');
  const errorOutput = element('p', 'local-error message-delete-error');
  errorOutput.setAttribute('role', 'alert');
  const buttons = [];
  for (const [scope, title] of [['self', 'Удалить у меня'], ...(item.mine ? [['all', 'Удалить у всех']] : [])]) {
    const button = element('button', '', title);
    button.type = 'button';
    button.dataset.scope = scope;
    buttons.push(button);
    button.addEventListener('click', async () => {
      if (scope === 'all' && !window.confirm('Удалить сообщение у всех участников? Это действие нельзя отменить.')) return;
      const account = profile;
      const dialogue = selectedDialogue;
      const current = () => profile === account && selectedDialogue === dialogue && activeView === 'messages';
      for (const control of buttons) control.disabled = true;
      errorOutput.textContent = '';
      try {
        await post(resource('/api/dialogues', dialogue, '/messages/' + item.id + '/delete'), { scope });
        if (profile !== account) return;
        const state = messageStates.get(dialogue);
        if (state?.outgoing && state.outgoing.clientId === item.clientId) {
          if (state.text === state.outgoingDraft) state.text = '';
          state.outgoing = undefined;
          state.error = '';
        }
        if (current()) {
          receivedMessages = receivedMessages.filter(({ id }) => id !== item.id);
          renderDialogueMessages(receivedMessages, byId('messages-content'));
          syncComposer();
          void refreshDialogue(true, true);
          byId('action-status').textContent = 'Сообщение удалено.';
        }
        void loadCabinet({ quiet: true, fresh: true });
      } catch (error) {
        if (profile === account && !endSession(error) && current()) {
          errorOutput.textContent = error.message;
          if (error.status === 409) void refreshDialogue(true, true);
        }
      } finally {
        for (const control of buttons) control.disabled = false;
      }
    });
    actions.append(button);
  }
  actions.append(errorOutput);
  details.append(summary, actions);
  details.addEventListener('toggle', () => {
    if (!details.open) return;
    for (const other of document.querySelectorAll('.message-actions[open]')) if (other !== details) other.open = false;
    if (mobileMessenger.matches) {
      const pane = byId('messages-content').getBoundingClientRect();
      const trigger = summary.getBoundingClientRect();
      const above = trigger.top - pane.top;
      const below = pane.bottom - trigger.bottom;
      details.classList.toggle('message-actions-below', above < actions.offsetHeight && below > above);
    }
    actions.scrollIntoView({ block: 'nearest' });
  });
  details.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || !details.open) return;
    event.preventDefault();
    event.stopPropagation();
    details.open = false;
    summary.focus();
  });
  return details;
}

function renderDialogueMessages(messages, content) {
  let list = content.querySelector('ul');
  if (!list) {
    list = element('ul', 'record-list');
    content.replaceChildren(list);
  }
  list.querySelector('.message-pending')?.remove();
  list.querySelector('.empty-state')?.remove();
  const ids = new Set(messages.map(({ id }) => id));
  for (const [id, entry] of renderedMessages) {
    if (ids.has(id)) continue;
    if (entry.row.contains(document.activeElement)) messageText.focus({ preventScroll: true });
    entry.row.remove();
    renderedMessages.delete(id);
  }
  for (const heading of list.querySelectorAll('.message-day')) {
    if (!heading.nextElementSibling?.matches('[data-message-id]')) heading.remove();
  }
  let lastDay = list.lastElementChild?.dataset.day;
  for (const item of messages) {
    let entry = renderedMessages.get(item.id);
    if (!entry) {
      const time = new Date(item.createdAt);
      const day = messageDay.format(time);
      if (lastDay !== day) list.append(element('li', 'message-day', day));
      lastDay = day;
      const row = element('li', 'record-row');
      row.dataset.day = day;
      const message = element('article', 'message ' + (item.mine ? 'message-mine' : 'message-other'));
      const label = element('div', 'message-label');
      const sentAt = element('time', 'muted', shortMessageTime.format(time));
      sentAt.dateTime = item.createdAt;
      const receipt = item.mine ? element('span', 'message-receipt') : null;
      label.append(sentAt);
      if (receipt) label.append(receipt);
      const actions = messageActions(item);
      label.append(actions);
      if (item.text) message.append(element('p', 'record-copy', item.text));
      if (item.attachments?.length) message.append(renderMessageAttachments(item.attachments));
      message.append(label);
      row.append(message);
      entry = { row, receipt, deleteForAll: actions.querySelector('[data-scope="all"]') };
      renderedMessages.set(item.id, entry);
      row.dataset.messageId = item.id;
      list.append(row);
    }
    if (entry.receipt) {
      if (item.read && entry.deleteForAll === document.activeElement) {
        entry.deleteForAll.closest('details').querySelector('summary').focus({ preventScroll: true });
      }
      entry.deleteForAll.hidden = item.read;
      const label = item.read ? 'Прочитано' : item.delivered ? 'Доставлено' : 'Сохранено на сервере';
      const icon = document.createElementNS(svgNamespace, 'svg');
      icon.setAttribute('viewBox', '0 0 20 14');
      icon.setAttribute('aria-hidden', 'true');
      const marks = document.createElementNS(svgNamespace, 'path');
      marks.setAttribute('d', item.read || item.delivered ? 'M2 7.5 5.5 11 13 3m-3 6.5 1.5 1.5L19 3' : 'M5 7.5 8.5 11 16 3');
      icon.append(marks);
      entry.receipt.replaceChildren(icon);
      entry.receipt.title = label;
      entry.receipt.setAttribute('aria-label', label);
      entry.receipt.setAttribute('role', 'img');
      entry.receipt.classList.toggle('receipt-read', item.read);
    }
  }
  const state = messageStates.get(selectedDialogue);
  if (state?.outgoing) {
    const saved = messages.some(({ clientId }) => clientId === state.outgoing.clientId);
    const row = element('li', 'record-row message-pending');
    const message = element('article', 'message message-mine');
    const status = state.sending ? 'Отправляется' : 'Отправка не подтверждена';
    const receipt = element('span', 'message-receipt', state.sending ? '◷' : '⚠');
    receipt.setAttribute('role', 'img');
    receipt.setAttribute('aria-label', status);
    receipt.title = status;
    if (!saved) {
      if (state.outgoing.text) message.append(element('p', 'record-copy', state.outgoing.text));
      for (const file of state.outgoingFiles ?? []) message.append(element('p', 'record-copy', file.name));
    }
    message.append(receipt);
    if (!state.sending) {
      const retry = element('button', 'button button-secondary', 'Повторить');
      retry.type = 'button';
      retry.addEventListener('click', () => sendMessage(undefined, true));
      message.append(retry);
    }
    row.append(message);
    list.append(row);
  }
  if (!list.children.length) list.append(element('li', 'empty-state', 'В этом диалоге ещё нет сообщений.'));
}

function atConversationEnd(content) {
  return content.scrollHeight - content.clientHeight - content.scrollTop <= 48;
}

function scrollConversationEnd() {
  const content = byId('messages-content');
  content.scrollTop = content.scrollHeight;
  byId('messages-new').hidden = true;
}

function messageIsVisible(bubble, pane) {
  const bounds = bubble.getBoundingClientRect();
  const viewport = window.visualViewport;
  const top = Math.max(bounds.top, pane.top, viewport?.offsetTop ?? 0);
  const bottom = Math.min(bounds.bottom, pane.bottom, viewport ? viewport.offsetTop + viewport.height : window.innerHeight);
  if (bottom - top < Math.min(16, bounds.height) || !bounds.width || !bounds.height) return false;
  const x = bounds.left + bounds.width / 2;
  return [top + 1, (top + bottom) / 2, bottom - 1].some((y) => bubble.contains(document.elementFromPoint(x, y)));
}

async function acknowledgeMessages() {
  const account = profile;
  const id = selectedDialogue;
  if (!account || id === undefined || activeView !== 'messages' || receiptSync) return;
  const visible = document.visibilityState === 'visible';
  const pane = byId('messages-content').getBoundingClientRect();
  const read = [];
  const delivered = [];
  for (const item of receivedMessages) {
    if (item.mine || item.read) continue;
    if (!item.delivered) delivered.push(item);
    const bubble = renderedMessages.get(item.id)?.row.firstElementChild;
    if (visible && bubble && messageIsVisible(bubble, pane)) read.push(item);
  }
  if (!delivered.length && !read.length) return;
  const sync = {};
  receiptSync = sync;
  try {
    for (const [status, items] of [['delivered', delivered], ['read', read]]) {
      for (let index = 0; index < items.length; index += 100) {
        if (profile !== account || selectedDialogue !== id || activeView !== 'messages') return;
        const batch = items.slice(index, index + 100);
        await post(resource('/api/dialogues', id, '/' + status), { messageIds: batch.map(({ id }) => id) });
        for (const item of batch) item[status] = true;
      }
    }
    if (read.length && profile === account) loadCabinet({ quiet: true, fresh: true });
  } catch (error) {
    if (profile === account) endSession(error);
  } finally {
    if (receiptSync === sync) receiptSync = undefined;
  }
}

async function refreshDialogue(quiet = false, fresh = false) {
  const account = profile;
  const id = selectedDialogue;
  if (!account || id === undefined || activeView !== 'messages' || (dialogueLoad && !fresh)) return;
  const load = {};
  dialogueLoad = load;
  const current = () => profile === account && selectedDialogue === id && dialogueLoad === load && activeView === 'messages';
  try {
    const { messages } = await request(resource('/api/dialogues', id));
    if (!current()) return;
    const signature = JSON.stringify(messages);
    const content = byId('messages-content');
    const first = !renders.has('messages');
    const atEnd = atConversationEnd(content);
    const hasNew = messages.some(({ id }) => !renderedMessages.has(id));
    receivedMessages = messages;
    if (first || renders.get('messages') !== signature) {
      renderDialogueMessages(messages, content);
      renders.set('messages', signature);
    }
    if (first || (atEnd && hasNew)) scrollConversationEnd();
    else if (hasNew) byId('messages-new').hidden = false;
    const errorOutput = byId('dialogue-error');
    if (errorOutput.textContent) errorOutput.textContent = '';
    void acknowledgeMessages();
  } catch (error) {
    if (current() && !endSession(error) && !quiet) byId('dialogue-error').textContent = error.message;
  } finally {
    if (dialogueLoad === load) dialogueLoad = undefined;
  }
}

function renderUpdates(updates) {
  return [panel('Системные уведомления', listFor(updates, (item) => {
    const update = element('article', 'record-line');
    update.id = 'notice-' + item.id;
    const body = element('div');
    const heading = element('h3', 'lesson-title', item.title);
    heading.tabIndex = -1;
    body.append(heading, element('p', 'record-copy', item.text));
    const createdAt = element('time', 'muted', eventTime(item.createdAt));
    createdAt.dateTime = item.createdAt;
    update.append(body, createdAt);
    return update;
  }, 'Уведомлений пока нет.'))];
}

function messageFileSize(bytes) {
  return bytes < 1024 * 1024
    ? pointsFormat.format(Math.max(1, Math.round(bytes / 1024))) + ' КБ'
    : pointsFormat.format(Math.round(bytes / 1024 / 102.4) / 10) + ' МБ';
}

function renderMessageAttachments(files) {
  return listFor(files, (file) => {
    const item = element('div', 'message-attachment');
    if (file.previewUrl) {
      const preview = element('img');
      preview.src = file.previewUrl;
      preview.alt = file.filename;
      preview.loading = 'lazy';
      item.append(preview);
    }
    const download = anchor(file.url, 'inline-link', 'Скачать');
    download.setAttribute('aria-label', 'Скачать ' + file.filename);
    item.append(element('strong', '', file.filename), element('span', 'muted', messageFileSize(file.size)), download);
    return item;
  });
}

function syncMessageFiles(state) {
  const list = byId('message-files');
  const files = state?.files ?? [];
  const locked = Boolean(state?.outgoing);
  renderSection('message-files', [files.map(({ name, size, lastModified }) => [name, size, lastModified]), locked, selectedDialogue], () =>
    files.map((file, index) => {
      const item = element('div', 'message-file');
      const remove = actionButton('Убрать', () => {
        state.files.splice(index, 1);
        state.error = '';
        syncComposer();
        byId('message-attach').focus({ preventScroll: true });
      });
      remove.disabled = locked;
      remove.setAttribute('aria-label', 'Убрать ' + file.name);
      item.append(element('span', '', file.name + ' · ' + messageFileSize(file.size)), remove);
      return item;
    }));
  list.hidden = !files.length;
  byId('message-attach').disabled = locked;
  const progress = byId('message-upload');
  progress.hidden = !state?.sending || !state.outgoingFiles?.length;
  if (state?.uploadProgress == null) progress.removeAttribute('value');
  else progress.value = state.uploadProgress;
}

function selectMessageFiles(event) {
  const state = messageStates.get(selectedDialogue) ?? {};
  if (selectedDialogue === undefined || state.outgoing) return;
  const files = [...(state.files ?? []), ...event.target.files];
  event.target.value = '';
  messageStates.set(selectedDialogue, state);
  if (files.length > 5 || files.reduce((bytes, file) => bytes + file.size, 0) > 10 * 1024 ** 2) {
    state.error = 'Можно прикрепить до пяти файлов общим размером до 10 МБ.';
  } else if (files.some((file) => !file.size || !/\.(?:pdf|docx|jpe?g|png)$/i.test(file.name))) {
    state.error = 'Поддерживаются непустые файлы PDF, DOCX, JPG и PNG.';
  } else {
    state.files = files;
    state.error = '';
  }
  syncComposer();
}

function uploadMessage(path, state, current) {
  const data = new FormData();
  data.append('text', state.outgoing.text);
  data.append('clientId', state.outgoing.clientId);
  for (const file of state.outgoingFiles) data.append('files', file);
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', path);
    xhr.responseType = 'json';
    xhr.upload.addEventListener('progress', (event) => {
      if (!event.lengthComputable) return;
      state.uploadProgress = event.loaded * 100 / event.total;
      if (current()) byId('message-upload').value = state.uploadProgress;
    });
    xhr.addEventListener('load', () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve();
      else reject(Object.assign(new Error(xhr.response?.error || 'Файл не отправлен.'), { status: xhr.status }));
    });
    xhr.addEventListener('error', () => reject(new Error('Соединение прервано. Повторите отправку.')));
    xhr.send(data);
  });
}

function syncComposer() {
  const state = messageStates.get(selectedDialogue);
  const value = state?.text ?? '';
  if (messageText.value !== value) messageText.value = value;
  const button = byId('message-submit');
  button.disabled = Boolean(state?.outgoing) || (!value.trim() && !state?.files?.length);
  messageText.style.height = 'auto';
  messageText.style.height = Math.min(120, messageText.scrollHeight) + 'px';
  byId('message-error').textContent = state?.error ?? '';
  syncMessageFiles(state);
  if (state?.sending) messageForm.setAttribute('aria-busy', 'true');
  else messageForm.removeAttribute('aria-busy');
}

function updateDraft() {
  const state = messageStates.get(selectedDialogue) ?? {};
  state.text = messageText.value;
  messageStates.set(selectedDialogue, state);
  syncComposer();
}

function handleMessageKey(event) {
  if (event.key !== 'Enter' || event.shiftKey || event.isComposing || composingMessage || event.keyCode === 229) return;
  event.preventDefault();
  const state = messageStates.get(selectedDialogue);
  if ((messageText.value.trim() || state?.files?.length) && !state?.outgoing) messageForm.requestSubmit();
}

async function sendMessage(event, retry = false) {
  event?.preventDefault();
  const account = profile;
  const id = selectedDialogue;
  const draft = messageText.value;
  const state = messageStates.get(id) ?? {};
  if (!account || signingOut || id === undefined || activeView !== 'messages' || composingMessage || state.sending) return;
  if (retry ? !state.outgoing : state.outgoing || (!draft.trim() && !state.files?.length)) return;
  if (!retry) {
    state.text = draft;
    state.outgoing = { text: draft.trim(), clientId: crypto.randomUUID() };
    state.outgoingDraft = draft;
    state.outgoingFiles = state.files?.slice();
  }
  const current = () => profile === account && selectedDialogue === id && activeView === 'messages';
  state.error = '';
  state.sending = true;
  state.uploadProgress = undefined;
  messageStates.set(id, state);
  syncComposer();
  renderDialogueMessages(receivedMessages, byId('messages-content'));
  scrollConversationEnd();
  try {
    const path = resource('/api/dialogues', id, '/messages');
    if (state.outgoingFiles?.length) await uploadMessage(path, state, current);
    else await post(path, state.outgoing);
    if (profile !== account) return;
    if (state.text === state.outgoingDraft) state.text = '';
    state.outgoing = undefined;
    state.files = state.outgoingFiles = undefined;
    if (current()) {
      setNewDialogueMode(false);
      await refreshDialogue(false, true);
    }
    byId('action-status').textContent = 'Сообщение отправлено.';
    loadCabinet({ quiet: true, fresh: true });
  } catch (error) {
    if (profile === account && !endSession(error)) {
      if (error.status === 410) {
        if (state.text === state.outgoingDraft) state.text = '';
        state.outgoing = undefined;
        state.files = state.outgoingFiles = undefined;
        state.error = error.message;
        if (current()) void refreshDialogue(true, true);
      } else if (state.outgoingFiles?.length && [400, 413, 415, 422].includes(error.status)) {
        state.outgoing = state.outgoingFiles = undefined;
        state.error = error.message;
      } else {
        state.error = 'Не удалось подтвердить отправку.';
      }
    }
  } finally {
    state.sending = false;
    if (current()) {
      syncComposer();
      renderDialogueMessages(receivedMessages, byId('messages-content'));
    }
  }
}

function setEmojiPanel(open) {
  emojiOptions.hidden = !open;
  emojiToggle.setAttribute('aria-expanded', String(open));
}

function chooseEmoji(emoji) {
  const start = messageText.selectionStart;
  const end = messageText.selectionEnd;
  if (composingMessage || messageText.value.length - (end - start) + emoji.length > messageText.maxLength) return;
  messageText.setRangeText(emoji, start, end, 'end');
  updateDraft();
  messageText.focus({ preventScroll: true });
  setEmojiPanel(false);
}

function clearSearch() {
  window.clearTimeout(searchTimer);
  searchLoad?.controller.abort();
  searchLoad = undefined;
  byId('search-query').value = '';
  byId('search-results').hidden = true;
  byId('search-status').textContent = '';
  byId('search-list').replaceChildren();
}

function scheduleSearch(delay) {
  window.clearTimeout(searchTimer);
  searchLoad?.controller.abort();
  searchLoad = undefined;
  const query = byId('search-query').value.trim();
  const account = profile;
  if (!query || !account) {
    byId('search-results').hidden = true;
    byId('search-list').replaceChildren();
    return;
  }
  byId('search-results').hidden = false;
  byId('search-status').textContent = 'Ищем…';
  byId('search-list').replaceChildren();
  const load = { controller: new AbortController() };
  searchLoad = load;
  searchTimer = window.setTimeout(() => runSearch(query, account, load), delay);
}

function highlightSearch(title, query) {
  const label = element('span');
  const words = [...new Set(query.normalize('NFC').toLowerCase().replaceAll('ё', 'е').match(/[\p{L}\p{N}]+/gu))];
  if (!words.length) {
    label.textContent = title;
    return label;
  }
  words.sort((a, b) => b.length - a.length);
  const expression = words.map((word) => word.replaceAll('е', '[её]')).join('|');
  const text = title.normalize('NFC');
  let start = 0;
  for (const match of text.matchAll(new RegExp(`(?<![\\p{L}\\p{N}])(?:${expression})`, 'giu'))) {
    label.append(text.slice(start, match.index), element('mark', 'search-match', match[0]));
    start = match.index + match[0].length;
  }
  label.append(text.slice(start));
  return label;
}

async function runSearch(query, account, load) {
  const current = () => profile === account && searchLoad === load;
  try {
    const { results } = await request('/api/search?q=' + encodeURIComponent(query), { signal: load.controller.signal });
    if (!current()) return;
    const matching = results.filter((item) => item.view === 'help' || roleViews[account.role].includes(item.view));
    for (const item of matching) {
      const row = element('li');
      const hash = '#' + item.view + (item.id ? '/' + item.id : '');
      const link = anchor(hash, 'search-result');
      link.append(highlightSearch(item.title, query), element('span', 'muted', searchTypes[item.type] ?? 'Результат'));
      link.addEventListener('click', (event) => {
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        event.preventDefault();
        clearSearch();
        navigateFromLink(hash, event);
      });
      row.append(link);
      byId('search-list').append(row);
    }
    byId('search-status').textContent = matching.length ? 'Найдено: ' + matching.length : 'Ничего не найдено.';
  } catch (error) {
    if (current() && !endSession(error)) byId('search-status').textContent = 'Поиск недоступен. Попробуйте ещё раз.';
  } finally {
    if (searchLoad === load) searchLoad = undefined;
  }
}

byId('cabinet-retry').addEventListener('click', () => loadCabinet({ fresh: true }));
byId('dialogue-search').addEventListener('input', refreshDialogueList);
byId('dialogue-filter').addEventListener('change', refreshDialogueList);
byId('dialogue-category').addEventListener('change', () => {
  byId('dialogue-start-error').textContent = '';
  refreshDialogueList();
});
byId('dialogue-back').addEventListener('click', () => {
  if (history.state?.messengerThread) history.back();
  else closeDialogue();
});
byId('dialogue-new').addEventListener('click', () => setNewDialogueMode(!newDialogueMode));
byId('messages-new').addEventListener('click', scrollConversationEnd);
byId('messages-content').addEventListener('scroll', () => {
  if (atConversationEnd(byId('messages-content'))) byId('messages-new').hidden = true;
  void acknowledgeMessages();
});
document.addEventListener('visibilitychange', acknowledgeMessages);
messageForm.addEventListener('submit', sendMessage);
byId('message-attach').addEventListener('click', () => byId('message-file-input').click());
byId('message-file-input').addEventListener('change', selectMessageFiles);
byId('message-submit').addEventListener('pointerdown', (event) => {
  if (mobileMessenger.matches && document.activeElement === messageText) event.preventDefault();
});
messageText.addEventListener('keydown', handleMessageKey);
messageText.addEventListener('input', updateDraft);
messageText.addEventListener('compositionstart', () => { composingMessage = true; });
messageText.addEventListener('compositionend', () => { composingMessage = false; });
const emojiCategories = [
  ['Лица', [['🙂', 'Улыбка'], ['😀', 'Радость'], ['😂', 'Смех'], ['😊', 'Довольная улыбка'],
    ['🤔', 'Задумчивость'], ['😉', 'Подмигивание'], ['😎', 'Очки'], ['🤩', 'Восторг'],
    ['😅', 'Облегчение'], ['😢', 'Грусть'], ['😮', 'Удивление'], ['😴', 'Сон']]],
  ['Жесты', [['👍', 'Палец вверх'], ['👋', 'Привет'], ['🙏', 'Спасибо'], ['👏', 'Аплодисменты'],
    ['👌', 'Хорошо'], ['🙌', 'Ура'], ['🤝', 'Рукопожатие'], ['✌️', 'Победа']]],
  ['Учёба', [['📚', 'Книги'], ['📅', 'Календарь'], ['📝', 'Заметка'], ['📌', 'Кнопка'],
    ['💡', 'Идея'], ['🎓', 'Выпуск'], ['⏰', 'Будильник'], ['📎', 'Скрепка']]],
  ['Символы', [['🎉', 'Праздник'], ['✅', 'Готово'], ['❤️', 'Сердце'], ['✨', 'Искры'],
    ['⭐', 'Звезда'], ['❗', 'Важно'], ['❓', 'Вопрос'], ['🔥', 'Огонь']]],
];
for (const [category, options] of emojiCategories) {
  const group = element('section', 'emoji-category');
  const heading = element('h3', '', category);
  const grid = element('div', 'emoji-grid');
  for (const [emoji, label] of options) {
    const button = element('button', 'emoji-button', emoji);
    button.type = 'button';
    button.setAttribute('aria-label', label);
    button.title = label;
    button.addEventListener('click', () => chooseEmoji(emoji));
    grid.append(button);
  }
  group.append(heading, grid);
  emojiOptions.append(group);
}
emojiToggle.addEventListener('click', () => setEmojiPanel(emojiOptions.hidden));
messageForm.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !emojiOptions.hidden) {
    setEmojiPanel(false);
    emojiToggle.focus();
  }
});

byId('search-query').addEventListener('input', () => scheduleSearch(250));
byId('search-form').addEventListener('submit', (event) => {
  event.preventDefault();
  scheduleSearch(0);
});
byId('search-form').addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !byId('search-results').hidden) {
    event.preventDefault();
    clearSearch();
    byId('search-query').focus();
  }
});
document.addEventListener('pointerdown', (event) => {
  if (!byId('search-results').hidden && !byId('search-form').contains(event.target)) clearSearch();
});
byId('search-form').addEventListener('focusout', (event) => {
  if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget)) clearSearch();
});
byId('document-catalog-retry').addEventListener('click', loadHelpCatalog);
byId('faq-retry').addEventListener('click', loadHelpCatalog);
byId('help-form').addEventListener('submit', askHelp);
byId('help-query').addEventListener('input', updateHelpSuggestions);
byId('help-query').addEventListener('keydown', (event) => {
  if (event.isComposing || event.keyCode === 229) return;
  if (event.key === 'Escape' && helpSuggestions.length) {
    event.preventDefault();
    hideHelpSuggestions();
    return;
  }
  if (!helpSuggestions.length || !['ArrowDown', 'ArrowUp'].includes(event.key)) return;
  event.preventDefault();
  const last = helpSuggestions.length - 1;
  helpSelection = event.key === 'ArrowDown' ? (helpSelection >= last ? 0 : helpSelection + 1)
    : (helpSelection <= 0 ? last : helpSelection - 1);
  renderHelpSuggestions();
});
helpLauncher.addEventListener('click', () => openHelp());

function navigateFromLink(hash, event) {
  if (activeView === 'menu') menuScroll = window.scrollY;
  pointerNavigation = event.detail > 0;
  if (helpDialog.open) {
    helpNavigationClose = true;
    helpDialog.close();
    if (window.location.hash.startsWith('#help')) {
      history.replaceState(null, '', window.location.pathname + window.location.search + pageHash);
    }
  }
  if (mobileMessenger.matches && hash.startsWith('#messages/dialogue-') && !history.state?.messengerThread) {
    if (window.location.hash !== '#messages') history.pushState(null, '', '#messages');
    history.pushState({ messengerThread: true }, '', hash);
    clearSearch();
    route(true);
  } else if (window.location.hash === hash || (!window.location.hash && hash === '#home')) route(true);
  else window.location.hash = hash;
}

document.addEventListener('click', (event) => {
  for (const actions of document.querySelectorAll('.message-actions[open]')) {
    if (!actions.contains(event.target)) actions.open = false;
  }
  const link = event.target.closest('.sidebar a[data-view], .mobile-tabs a, #mobile-nav a, #mobile-avatar, #mobile-menu-back, #help-dialog a[href^="#"], #header-inbox');
  if (!link || event.defaultPrevented || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  event.preventDefault();
  if (link.id === 'mobile-menu-back') {
    history.back();
    return;
  }
  if (mobileMessenger.matches && activeView === 'menu' && link.closest('#mobile-nav')) {
    const section = link.dataset.view;
    menuScroll = window.scrollY;
    history.replaceState({ menuItem: section, menuScroll }, '');
    history.pushState({ fromMenu: section }, '', link.hash);
    pointerNavigation = event.detail > 0;
    clearSearch();
    route(true);
    return;
  }
  navigateFromLink(link.hash, event);
});

helpDialog.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape' || event.defaultPrevented || event.isComposing) return;
  event.preventDefault();
  helpDialog.close();
});
helpDialog.addEventListener('close', () => {
  const viaNavigation = helpNavigationClose;
  helpNavigationClose = false;
  if (helpDialog.open) return;
  helpLauncher.setAttribute('aria-expanded', 'false');
  helpTarget = undefined;
  hideHelpSuggestions();
  if (profile && /^#help(?:\/|$)/.test(window.location.hash)) {
    history.replaceState(null, '', window.location.pathname + window.location.search + pageHash);
  }
  if (profile && !viaNavigation) helpLauncher.focus({ preventScroll: true });
});
function sizeMessaging() {
  const viewport = window.visualViewport;
  const shell = byId('app');
  if (mobileMessenger.matches && activeView === 'messages' && selectedDialogue !== undefined && viewport?.scale === 1) {
    const content = byId('messages-content');
    const atEnd = atConversationEnd(content);
    shell.style.setProperty('--messenger-viewport-height', viewport.height + 'px');
    shell.style.setProperty('--messenger-viewport-top', viewport.offsetTop + 'px');
    shell.classList.toggle('messenger-keyboard', window.innerHeight - viewport.height > 1);
    if (atEnd) content.scrollTop = content.scrollHeight;
  } else {
    shell.style.removeProperty('--messenger-viewport-height');
    shell.style.removeProperty('--messenger-viewport-top');
    shell.classList.remove('messenger-keyboard');
  }
}

window.visualViewport?.addEventListener('resize', () => {
  sizeHelpDialog();
  sizeMessaging();
});
window.visualViewport?.addEventListener('scroll', () => {
  sizeHelpDialog();
  sizeMessaging();
});
window.addEventListener('resize', sizeMessaging);
mobileMessenger.addEventListener('change', () => {
  if (profile && window.location.hash === '#menu') route(true);
  if (activeView !== 'messages') return;
  refreshDialogueList();
  const item = cabinet?.dialogues.find(({ id }) => id === selectedDialogue);
  if (item) byId('dialogue-heading').textContent = mobileMessenger.matches ? item.fullName ?? item.title : dialogueName(item);
  sizeMessaging();
});
byId('library-retry').addEventListener('click', loadLibrary);
byId('portfolio-refresh').addEventListener('click', () => loadPortfolio({ fresh: true }));
byId('library-filters').addEventListener('submit', (event) => event.preventDefault());
byId('library-query').addEventListener('input', renderLibrary);
byId('library-subject').addEventListener('change', renderLibrary);
byId('library-favorites').addEventListener('change', renderLibrary);

const loginScreen = byId('login-screen');
const loginTheme = byId('login-theme');
const loginScene = loginScreen.querySelector('.login-scene');
const loginThemeKey = 'cabinet-login-theme';
let loginThemeTimer;
let requestedLoginScene;

async function loadLoginScene(src) {
  const fallback = src.replace(/\.webp$/, '.png');
  const current = loginScene.firstElementChild?.getAttribute('src');
  if (requestedLoginScene === src) return;
  if (current === src || current === fallback) {
    requestedLoginScene = undefined;
    return;
  }
  requestedLoginScene = src;
  const image = new Image();
  image.alt = '';
  try {
    image.src = src;
    try {
      await image.decode();
    } catch {
      if (requestedLoginScene !== src || loginScreen.hidden) return;
      image.src = fallback;
      await image.decode();
    }
    if (requestedLoginScene === src && !loginScreen.hidden) loginScene.replaceChildren(image);
  } catch {
    if (requestedLoginScene === src) loginScene.replaceChildren();
  } finally {
    if (requestedLoginScene === src) requestedLoginScene = undefined;
  }
}

function syncLoginTheme() {
  window.clearTimeout(loginThemeTimer);
  if (loginScreen.hidden || document.hidden) return;
  const now = new Date();
  const { month, hour, minute, second } = Object.fromEntries(loginTimeFormat.formatToParts(now)
    .map(({ type, value }) => [type, Number(value)]));
  const season = month === 11 ? 'winter' : ['winter', 'spring', 'summer', 'autumn'][Math.floor(month % 12 / 3)];
  const mode = loginTheme.querySelector('input:checked').value;
  const daytime = hour >= 7 && hour < 18;
  const night = mode === 'dark' || (mode === 'auto' && !daytime);
  loginScreen.dataset.season = season;
  loginScreen.dataset.tone = night ? 'night' : 'day';
  const src = '/assets/auth/' + season + '-' + (night ? 'evening' : 'day') + '.webp';
  void loadLoginScene(src);
  const nextHour = mode === 'auto' && hour < 18 ? (daytime ? 18 : 7) : 24;
  const delay = (((nextHour - hour) * 60 - minute) * 60 - second) * 1000 - now.getMilliseconds();
  loginThemeTimer = window.setTimeout(syncLoginTheme, delay);
}

function setLoginPasswordVisible(visible) {
  byId('password').type = visible ? 'text' : 'password';
  const toggle = loginScreen.querySelector('[data-password-toggle]');
  toggle.toggleAttribute('data-visible', visible);
  toggle.setAttribute('aria-label', visible ? 'Скрыть пароль' : 'Показать пароль');
}

try {
  const savedMode = window.localStorage.getItem(loginThemeKey);
  for (const option of loginTheme.querySelectorAll('input')) {
    if (option.value === savedMode) option.checked = true;
  }
} catch {
  // Manual selection still works when local storage is unavailable.
}
loginTheme.addEventListener('change', (event) => {
  try {
    window.localStorage.setItem(loginThemeKey, event.target.value);
  } catch {
    // Keep the selection for this page.
  }
  syncLoginTheme();
});
loginScreen.querySelector('[data-password-toggle]').addEventListener('click', () => {
  setLoginPasswordVisible(byId('password').type === 'password');
});
window.addEventListener('pageshow', syncLoginTheme);
window.addEventListener('focus', syncLoginTheme);

document.addEventListener('visibilitychange', () => {
  syncLoginTheme();
  if (document.hidden || !profile || signingOut) return;
  if (profile.role === 'student') loadSchedule({ quiet: true });
  loadCabinet({ quiet: true });
  if (activeView === 'messages' && selectedDialogue !== undefined) refreshDialogue(true);
  if (activeView === 'profile') loadPortfolio({ quiet: true });
});

byId('login-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const submit = form.querySelector('button[type="submit"]');
  const data = new FormData(form);
  submit.disabled = true;
  submit.textContent = 'Входим…';
  byId('login-error').textContent = '';
  try {
    const { profile: student } = await request('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ login: data.get('login').trim(), password: data.get('password') }),
    });
    form.reset();
    setLoginPasswordVisible(false);
    window.clearTimeout(loginThemeTimer);
    showApp(student, true);
  } catch (error) {
    byId('login-error').textContent = error.message;
  } finally {
    submit.disabled = false;
    submit.textContent = 'Войти';
  }
});

async function logout({ currentTarget }) {
  if (signingOut) return;
  const buttons = [byId('logout'), byId('mobile-logout')];
  const mobileError = byId('mobile-logout-error');
  signingOut = true;
  for (const button of buttons) button.disabled = true;
  byId('app-error').textContent = '';
  mobileError.textContent = '';
  try {
    await request('/api/logout', { method: 'POST' });
    history.replaceState(null, '', window.location.pathname + window.location.search);
    showLogin('', true);
  } catch (error) {
    if (error.status === 401) {
      showLogin('', true);
    } else {
      const message = currentTarget.id === 'mobile-logout' && activeView === 'profile' ? mobileError : byId('app-error');
      message.textContent = error.message;
    }
  } finally {
    signingOut = false;
    for (const button of buttons) button.disabled = false;
  }
}

byId('logout').addEventListener('click', logout);
byId('mobile-logout').addEventListener('click', logout);

const mobileNav = byId('mobile-nav');
for (const group of document.querySelectorAll('.sidebar .nav-group')) {
  const copy = group.cloneNode(true);
  const children = copy.querySelector('.nav-children');
  children.id = 'mobile-' + copy.dataset.navGroup;
  copy.querySelector('.nav-toggle').setAttribute('aria-controls', children.id);
  mobileNav.append(copy);
}

function renderNavGroups() {
  for (const group of document.querySelectorAll('.nav-group')) {
    const children = group.querySelector('.nav-children');
    const open = openNavGroups.has(group.dataset.navGroup);
    group.hidden = !children.querySelector('a:not([hidden])');
    children.hidden = !open;
    group.querySelector('.nav-toggle').setAttribute('aria-expanded', String(open));
  }
}

for (const button of document.querySelectorAll('.nav-toggle')) {
  button.addEventListener('click', () => {
    const key = button.closest('.nav-group').dataset.navGroup;
    if (!openNavGroups.delete(key)) openNavGroups.add(key);
    renderNavGroups();
  });
}

byId('day-picker').addEventListener('change', (event) => selectDay(event.target.value));
byId('schedule-week-mode').addEventListener('click', () => setScheduleMode(false));
byId('schedule-month-mode').addEventListener('click', () => setScheduleMode(true));
byId('schedule-month').addEventListener('change', loadMonthSchedule);
byId('month-schedule-retry').addEventListener('click', loadMonthSchedule);

byId('home-changes-toggle').addEventListener('click', ({ currentTarget }) => {
  currentTarget.ariaExpanded = String(currentTarget.ariaExpanded !== 'true');
});
byId('home-week').addEventListener('change', (event) => selectHomeDay(event.target.value));
for (const button of document.querySelectorAll('[data-week-step]')) {
  button.addEventListener('click', () => {
    if (!schedule || scheduleLoad?.browsing) return;
    const week = dateAt(schedule.weekStart);
    week.setUTCDate(week.getUTCDate() + Number(button.dataset.weekStep));
    void loadSchedule({ week: week.toISOString().slice(0, 10) });
  });
}
for (const button of document.querySelectorAll('[data-schedule-retry]')) {
  button.addEventListener('click', loadSchedule);
}

let homeWeekHeadingWidth = 0;
new ResizeObserver(([{ contentRect: { width } }]) => {
  if (width === homeWeekHeadingWidth) return;
  homeWeekHeadingWidth = width;
  if (width) renderHomeWeekLabel();
}).observe(byId('home-week-label').closest('.panel-heading'));

mobileLayout.addEventListener('change', () => {
  renderHomeWeekLabel();
});

// Route changes restore the menu position explicitly after switching views.
history.scrollRestoration = 'manual';
window.addEventListener('scroll', () => {
  if (activeView === 'menu' && window.location.hash === '#menu') menuScroll = window.scrollY;
}, { passive: true });
window.addEventListener('hashchange', () => {
  if (profile) {
    clearSearch();
    route(true);
  }
});

async function restoreSession() {
  try {
    const { profile: student } = await request('/api/me');
    showApp(student);
  } catch (error) {
    showLogin(error.status === 401 ? '' : error.message);
  }
}

const campusBuildings = {
  a: { title: 'Корпус А', description: 'Два этажа. В корпусе находится конференц-зал МГИМО.' },
  b: { title: 'Корпус Б', description: 'Четыре этажа и цоколь. Здесь находится лекционный зал № 7.' },
  v: { title: 'Корпус В', description: 'Основное здание, четыре этажа и цоколь. Залы 1 и 2 находятся на первом этаже, залы 3–6 — на четвёртом.' },
  g: { title: 'Корпус Г', description: 'Шесть этажей и цоколь. На шестом этаже работает телестудия.' },
  n: { title: 'Корпус Н', description: 'Новый корпус, пять этажей. Залы 215 и 216 находятся на втором этаже, залы 314 и 315 — на третьем.' },
};
const campusRooms = { 215: 2, 216: 2, 314: 3, 315: 3 };
const svgNamespace = 'http://www.w3.org/2000/svg';
let selectedBuilding;

function campusSymbol(id) {
  const svg = document.createElementNS(svgNamespace, 'svg');
  svg.setAttribute('viewBox', '0 0 112 88');
  svg.setAttribute('aria-hidden', 'true');
  const shape = document.createElementNS(svgNamespace, 'use');
  shape.setAttribute('href', '#campus-shape-' + id);
  svg.append(shape);
  return svg;
}

function openCampusCard(id, focusHeading = true) {
  closeCampusCard();
  selectedBuilding = byId('campus-building-' + id);
  selectedBuilding.setAttribute('aria-expanded', 'true');
  const { title, description } = campusBuildings[id];
  const heading = byId('campus-card-title');
  heading.textContent = title;
  byId('campus-card-description').textContent = description;
  byId('campus-card-shape').setAttribute('href', '#campus-shape-' + id);
  byId('campus-card').hidden = false;
  byId('view-campus').classList.add('campus-card-open');
  if (focusHeading) {
    heading.focus({ preventScroll: true });
    if (!mobileLayout.matches) heading.scrollIntoView({ block: 'nearest' });
  }
}

function closeCampusCard(restoreFocus = false) {
  if (!selectedBuilding) return;
  selectedBuilding.setAttribute('aria-expanded', 'false');
  byId('campus-card').hidden = true;
  byId('view-campus').classList.remove('campus-card-open');
  if (restoreFocus) selectedBuilding.focus({ preventScroll: true });
  selectedBuilding = undefined;
}

function findCampusRoom(event) {
  event.preventDefault();
  const query = byId('campus-room-query').value.trim().toLocaleLowerCase('ru-RU');
  const room = /^(?:(?:зал|ауд(?:итория)?\.?)\s*)?(?:№\s*)?(\d+)$/.exec(query)?.[1];
  const floor = campusRooms[room];
  const output = byId('campus-room-result');
  if (!floor) {
    output.textContent = 'Расположение не подтверждено.';
    return;
  }
  output.textContent = 'Зал ' + room + '. Новый корпус, ' + floor + '-й этаж.' +
    (room === '314' ? ' Также указан в программе конференции 2023 года.' : '');
  const link = element('button', 'button button-secondary campus-room-building', 'Показать корпус Н');
  link.type = 'button';
  link.addEventListener('click', () => openCampusCard('n'));
  output.append(' ', link);
}

for (const [id, building] of Object.entries(campusBuildings)) {
  const button = element('button', 'campus-building');
  button.type = 'button';
  button.id = 'campus-building-' + id;
  button.setAttribute('aria-controls', 'campus-card');
  button.setAttribute('aria-expanded', 'false');
  button.append(campusSymbol(id), element('span', '', building.title));
  button.addEventListener('click', () => openCampusCard(id));
  byId('campus-buildings').append(button);
}
byId('campus-card-close').addEventListener('click', () => closeCampusCard(true));
byId('campus-room-form').addEventListener('submit', findCampusRoom);
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !event.defaultPrevented && activeView === 'campus' && selectedBuilding &&
      !document.querySelector('dialog[open]')) {
    closeCampusCard(true);
  }
});

restoreSession();
