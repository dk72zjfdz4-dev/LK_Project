'use strict';

const byId = (id) => document.getElementById(id);
const views = {
  home: 'Главная',
  schedule: 'Расписание',
  grades: 'Успеваемость',
  assignments: 'Задания',
  requests: 'Справки',
  messages: 'Сообщения',
  contacts: 'Контакты',
  updates: 'Уведомления',
  campus: 'Карта кампуса',
  profile: 'Профиль',
};
const roleViews = {
  student: Object.keys(views),
  teacher: ['home', 'grades', 'assignments', 'messages', 'contacts', 'updates', 'campus', 'profile'],
  dean: ['home', 'requests', 'messages', 'contacts', 'updates', 'campus', 'profile'],
};
const roleNames = { student: 'Студент', teacher: 'Преподаватель', dean: 'Деканат' };
const roleBrand = { student: 'студента', teacher: 'преподавателя', dean: 'деканата' };
const weekdays = ['Понедельник', 'Вторник', 'Среда', 'Четверг', 'Пятница', 'Суббота', 'Воскресенье'];
const shortWeekdays = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];
const dateFormat = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long', timeZone: 'UTC' });
const dayFormat = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long', weekday: 'long', timeZone: 'UTC' });
const moscowTimeFormat = new Intl.DateTimeFormat('ru-RU', {
  timeZone: 'Europe/Moscow', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
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
let schedule;
let scheduleLoad;
let cabinet;
let cabinetLoad;
let pollTimer;
let selectedDay;
let selectedDialogue;
let dialogueLoad;
let lessonOpen;
let pendingTarget;
let drawerDestination;
let searchTimer;
let searchLoad;
let composingMessage = false;
const messageStates = new Map();
const renderedMessages = new Map();
const renders = new Map();

const mobileMenu = byId('mobile-menu');
const mobileAvatar = byId('mobile-avatar');
const messageText = byId('message-text');
const messageForm = byId('message-form');
const emojiOptions = byId('emoji-options');
const emojiToggle = byId('emoji-toggle');
const mobileLayout = window.matchMedia('(max-width: 680px)');

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
  const active = permitted.includes(requested) ? requested : 'home';
  pendingTarget = active === requested && targetId ? targetId : undefined;
  activeView = active;
  byId('app-error').textContent = '';
  for (const name of Object.keys(views)) {
    byId('view-' + name).hidden = active !== name;
  }
  for (const link of document.querySelectorAll('[data-view]')) {
    link.hidden = !permitted.includes(link.dataset.view);
    if (link.dataset.view === active) {
      link.setAttribute('aria-current', 'page');
    } else {
      link.removeAttribute('aria-current');
    }
  }
  const heading = byId('page-heading');
  heading.textContent = views[active];
  byId('header-inbox').hidden = active === 'messages';
  document.title = views[active] + ' — Личный кабинет';
  renderCabinet();
  const fromDrawer = drawerDestination === window.location.hash;
  drawerDestination = undefined;
  if (focusHeading || pendingTarget) {
    window.scrollTo(0, 0);
    if (!fromDrawer) heading.focus({ preventScroll: true });
  }
  revealTarget();
  if (active === 'messages' && selectedDialogue !== undefined) refreshDialogue();
}

function revealTarget() {
  if (!pendingTarget) return;
  const target = byId(pendingTarget);
  if (!target || !byId('view-' + activeView).contains(target)) return;
  pendingTarget = undefined;
  if (target.tagName === 'DETAILS') target.open = true;
  const day = target.closest('.calendar-day');
  if (day) selectDay(day.dataset.date);
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
  profile = undefined;
  schedule = scheduleLoad = cabinet = cabinetLoad = selectedDay = selectedDialogue = dialogueLoad = lessonOpen = undefined;
  window.clearInterval(pollTimer);
  renders.clear();
  messageStates.clear();
  renderedMessages.clear();
  pendingTarget = drawerDestination = undefined;
  composingMessage = false;
  clearSearch();
  if (mobileMenu.open) mobileMenu.close();
  document.documentElement.classList.remove('menu-open');
  byId('lesson-dialog').close();
  byId('session-loading').hidden = true;
  byId('app').hidden = true;
  byId('login-screen').hidden = false;
  byId('login-form').reset();
  byId('login-error').textContent = message;
  byId('app-error').textContent = '';
  byId('cabinet-status').hidden = true;
  byId('home-stats').hidden = true;
  byId('home-staff').hidden = true;
  byId('messaging').hidden = true;
  messageForm.hidden = true;
  messageForm.reset();
  syncComposer();
  setEmojiPanel(false);
  byId('dialogue-heading').textContent = 'Переписка';
  byId('dialogue-error').textContent = '';
  byId('messages-content').replaceChildren(element('p', 'empty-state', 'Выберите диалог.'));
  updateUnread(0);
  byId('day-picker').querySelectorAll('label').forEach((label) => label.remove());
  for (const id of [
    'week-grid', 'upcoming-lessons', 'changed-lessons', 'home-week', 'home-week-label', 'home-stats',
    'home-cabinet', 'home-staff', 'grades-content', 'assignments-content', 'requests-content',
    'dialogues-content', 'updates-content', 'contacts-content', 'dialogue-contact', 'lesson-dialog-content', 'action-status',
  ]) byId(id).replaceChildren();
  for (const id of [
    ...Object.keys(profileFields),
    'sidebar-name', 'sidebar-initials', 'profile-initials', 'welcome-name', 'welcome-summary',
    'mobile-avatar', 'mobile-menu-name', 'mobile-menu-role', 'mobile-logout-error',
  ]) {
    byId(id).textContent = '';
  }
  document.title = 'Вход — Личный кабинет';
  if (focusHeading) byId('login-heading').focus();
}

function showApp(account, focusHeading = false) {
  profile = { ...account, role: account.role || 'student' };
  for (const [id, field] of Object.entries(profileFields)) {
    const fieldNode = byId(id);
    fieldNode.textContent = account[field] ?? '';
    if (fieldNode.tagName === 'DD') fieldNode.parentElement.hidden = !account[field];
  }
  const names = account.fullName.trim().split(/\s+/);
  const initials = names.slice(0, 2).map((part) => part[0]).join('');
  const roleName = roleNames[profile.role];
  byId('mobile-avatar').textContent = initials;
  byId('mobile-menu-name').textContent = account.fullName;
  byId('mobile-menu-role').textContent = roleName;
  byId('sidebar-initials').textContent = initials;
  byId('profile-initials').textContent = initials;
  byId('sidebar-name').textContent = account.fullName;
  byId('welcome-name').textContent = (profile.role === 'student' ? 'Привет, ' : 'Здравствуйте, ') + names[0] + '!';
  byId('welcome-summary').textContent = profile.role === 'student'
    ? [account.group, account.year && account.year + ' курс'].filter(Boolean).join(' · ')
    : [roleName, account.faculty].filter(Boolean).join(' · ');
  byId('brand-role').textContent = roleBrand[profile.role];
  byId('profile-role').textContent = roleName;
  byId('sidebar-group').textContent = profile.role === 'student' ? account.group : roleName;
  byId('home-status').hidden = true;
  byId('home-schedule').hidden = true;
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
    element('span', 'lesson-room', 'Демо-ауд. ' + lesson.room),
    element('span', 'lesson-teacher', lesson.teacher),
  );
  return details;
}

function lessonTitle(lesson, level) {
  const heading = element(level, 'lesson-title');
  const button = element('button', 'lesson-link', lesson.title);
  button.type = 'button';
  button.addEventListener('click', () => openLesson(lesson.id));
  heading.append(button);
  return heading;
}

async function openLesson(id) {
  const dialog = byId('lesson-dialog');
  const content = byId('lesson-dialog-content');
  const load = { account: profile };
  lessonOpen = load;
  byId('lesson-dialog-heading').textContent = 'Занятие';
  content.replaceChildren(element('p', 'muted', 'Загружаем занятие…'));
  if (!dialog.open) dialog.showModal();
  try {
    const { lesson } = await request(resource('/api/lessons', id));
    if (!dialog.open || lessonOpen !== load || profile !== load.account) return;
    byId('lesson-dialog-heading').textContent = lesson.title;
    content.replaceChildren(element('p', 'muted', dateFormat.format(dateAt(lesson.date)) + ' · ' + lessonTimes(lesson)), lessonDetails(lesson));
    if (lesson.contact) content.append(contactCard(lesson.contact));
    if (lesson.change || lesson.cancelled) content.append(element('p', 'change-label', lesson.change || 'Занятие отменено.'));
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
  if (lesson.change) info.append(element('p', 'change-label', lesson.change));
  row.append(slot, info);
  return row;
}

function changeRow(lesson, today) {
  const row = element('li', 'change-row');
  row.append(
    lessonTitle(lesson, 'h3'),
    element('p', 'change-date', (lesson.date === today ? 'Сегодня' : dateFormat.format(dateAt(lesson.date))) + ' · ' + lesson.start),
    element('p', 'change-label', lesson.change || 'Занятие отменено.'),
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
    byId('upcoming-lessons'), upcoming.slice(0, 4), (lesson) => upcomingRow(lesson, today),
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

function calendarDay(date, day, today, lessons) {
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
    const card = element('li', 'calendar-card');
    card.id = 'lesson-' + lesson.id;
    card.append(
      element('p', 'lesson-time', lessonTimes(lesson)),
      lessonTitle(lesson, 'h4'),
      lessonDetails(lesson),
    );
    if (lesson.cancelled) card.classList.add('calendar-cancelled');
    if (lesson.change || lesson.cancelled) card.append(element('p', 'change-label', lesson.change || 'Занятие отменено.'));
    return card;
  }, 'Нет занятий');
  return column;
}

function renderWeek(lessons, today, start) {
  const dates = weekDates(start);
  const isoDates = dates.map((day) => day.toISOString().slice(0, 10));
  const active = isoDates.includes(today) ? today : start;
  byId('week-label').textContent = dateFormat.formatRange(dates[0], dates.at(-1));
  const picker = byId('day-picker');
  const grid = byId('week-grid');
  const homeWeek = byId('home-week');
  picker.querySelectorAll('label').forEach((label) => label.remove());
  grid.replaceChildren();
  homeWeek.replaceChildren();
  byId('home-week-label').textContent = byId('week-label').textContent;

  for (const [index, isoDate] of isoDates.entries()) {
    const label = element('label', 'day-option');
    const input = element('input', 'visually-hidden');
    input.type = 'radio';
    input.name = 'visible-day';
    input.value = isoDate;
    input.checked = isoDate === active;
    input.setAttribute('aria-label', dayFormat.format(dates[index]) + (isoDate === today ? ', сегодня' : ''));
    const chip = element('span', 'day-chip');
    chip.setAttribute('aria-hidden', 'true');
    chip.append(element('span', '', shortWeekdays[index]), element('strong', '', dates[index].getUTCDate()));
    label.append(input, chip);
    picker.append(label);
    grid.append(calendarDay(isoDate, index, today, lessons.filter((lesson) => lesson.date === isoDate)));
    const count = lessons.filter((lesson) => lesson.date === isoDate && !lesson.cancelled).length;
    const dayLink = anchor('#schedule', 'mini-day');
    if (isoDate === today) dayLink.setAttribute('aria-current', 'date');
    dayLink.setAttribute('aria-label', dayFormat.format(dates[index]) + ', занятий: ' + count);
    dayLink.append(element('span', '', shortWeekdays[index]), element('strong', '', dates[index].getUTCDate()), element('span', 'mini-day-count', count ? String(count) : '—'));
    dayLink.addEventListener('click', () => selectDay(isoDate));
    homeWeek.append(dayLink);
  }
  selectDay(isoDates.includes(selectedDay) ? selectedDay : active);
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

async function loadSchedule({ quiet = false } = {}) {
  const student = profile;
  if (!student || scheduleLoad) return;
  const load = {};
  scheduleLoad = load;
  if (!quiet || !schedule) showScheduleStatus('Загружаем расписание…');
  try {
    const { today, weekStart, lessons, nextWeekLessons = [] } = await request('/api/schedule');
    if (profile !== student) return;
    lessons.sort(lessonOrder);
    const update = () => {
      const calendarKey = JSON.stringify([today, weekStart, lessons]);
      if (renders.get('calendar') !== calendarKey) {
        if (selectedDay === schedule?.today) selectedDay = today;
        renderWeek(lessons, today, weekStart);
        renders.set('calendar', calendarKey);
      }
      schedule = { today, lessons };
      const now = moscowTimeFormat.format(new Date());
      const ended = lessons.filter((lesson) => lesson.date === today && !lesson.cancelled && lesson.end <= now).length;
      const homeKey = JSON.stringify([calendarKey, nextWeekLessons, ended]);
      if (renders.get('schedule-home') !== homeKey) {
        renderHome(lessons, nextWeekLessons, today);
        renders.set('schedule-home', homeKey);
      }
      showScheduleStatus();
      if (activeView === 'home') renderDashboard();
    };
    if (quiet) preservePagePosition(update);
    else update();
    revealTarget();
  } catch (error) {
    if (profile !== student) return;
    if (error.status === 401) {
      showLogin('Сессия завершена. Войдите снова.', true);
    } else if (!quiet || !schedule) {
      showScheduleStatus(error.message, true);
    }
  } finally {
    if (scheduleLoad === load) scheduleLoad = undefined;
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
  contact: 'Контакт', notification: 'Объявление', request: 'Заявка',
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
      renderSection('grades-content', cabinet.grades, renderGrades, force);
      break;
    case 'assignments':
      renderSection('assignments-content', [cabinet.grades, cabinet.assignments, cabinet.appeals], renderAssignments, force);
      break;
    case 'requests':
      renderSection('requests-content', cabinet.requests, renderRequests, force);
      break;
    case 'messages':
      byId('messaging').hidden = false;
      renderSection('dialogues-content', cabinet.dialogues, renderDialogues, force);
      renderDialogueContact(cabinet.dialogues.find((item) => item.id === selectedDialogue)?.contact);
      break;
    case 'contacts':
      renderSection('contacts-content', cabinet.contacts ?? [], renderContacts, force);
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
  if (editingRequests) {
    if (!force && root.querySelector('form[aria-busy="true"]')) return;
  } else if (dirtyForm || (!force && (formInUse || root.querySelector('form[aria-busy="true"]')))) {
    if (id === 'assignments-content') reconcileClosedAppeals(data[1], data[2]);
    return;
  }
  const drafts = editingRequests
    ? [...root.querySelectorAll('form[data-dirty]')].map((form) => [form.id, [...form.elements]
      .filter((field) => field.name)
      .map((field) => [field.name, field.value, field.selectionStart, field.selectionEnd])])
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
      const details = byId(formId.replace('request-status-', 'request-'));
      const note = fields.find(([name]) => name === 'note')?.[1];
      if (details && note) {
        const text = element('p', 'record-copy', note);
        text.dataset.unsubmittedNote = formId;
        details.append(element('h3', 'record-subheading', 'Неотправленный комментарий'), text);
      }
      continue;
    }
    for (const [name, value, start, end] of fields) {
      const field = form.elements.namedItem(name);
      if (!field) continue;
      if (field.tagName === 'SELECT' && ![...field.options].some((option) => option.value === value)) {
        field.selectedIndex = -1;
        continue;
      }
      field.value = value;
      if (Number.isInteger(start)) field.setSelectionRange(start, end);
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
  const stats = byId('home-stats');
  const activeRequests = cabinet?.requests.filter((item) => ['submitted', 'processing'].includes(item.status)).length;
  const pendingAssignments = cabinet?.assignments.filter((item) => student
    ? !item.submission
    : item.submission?.status === 'submitted').length;
  const now = Date.now();
  const deadlines = student ? (cabinet?.assignments ?? [])
    .filter((item) => !item.submission && new Date(item.dueAt).getTime() >= now)
    .sort((a, b) => a.dueAt.localeCompare(b.dueAt))
    .slice(0, 3) : [];
  const recentKey = JSON.stringify([
    profile.role, schedule?.today, schedule?.lessons, cabinet?.unreadCount, cabinet?.requests, cabinet?.assignments, deadlines,
  ]);
  if (renders.get('dashboard') === recentKey) return;
  renders.set('dashboard', recentKey);
  const focused = document.activeElement?.id;
  const cards = [];
  if (student) {
    const todayCard = stat('#schedule', schedule ? schedule.lessons.filter((lesson) => lesson.date === schedule.today && !lesson.cancelled).length : '—', 'Пар сегодня');
    todayCard.addEventListener('click', () => { if (schedule) selectDay(schedule.today); });
    cards.push(todayCard);
  }
  if (student || profile.role === 'teacher') cards.push(stat('#assignments', pendingAssignments ?? '—', student ? 'Заданий к сдаче' : 'Работ на проверке'));
  if (student || profile.role === 'dean') cards.push(stat('#requests', activeRequests ?? '—', 'Открытых заявок'));
  cards.push(stat('#messages', cabinet?.unreadCount ?? '—', 'Непрочитанных сообщений'));
  for (const card of cards) card.id = 'stat-' + card.hash.slice(1);
  stats.replaceChildren(...cards);
  stats.hidden = false;
  if (focused?.startsWith('stat-')) byId(focused)?.focus({ preventScroll: true });

  if (student) {
    const deadlinePanel = panel('Ближайшие дедлайны', listFor(deadlines, (item) => {
      const row = element('div', 'record-line');
      const info = element('div');
      info.append(element('h3', 'lesson-title', item.title), element('p', 'muted', item.subject));
      const deadline = element('time', 'deadline-date', eventTime(item.dueAt));
      deadline.dateTime = item.dueAt;
      row.append(info, deadline);
      return row;
    }, cabinet ? 'Ближайших дедлайнов нет.' : 'Загружаем задания…'));
    byId('home-cabinet').replaceChildren(deadlinePanel);
    byId('home-schedule').hidden = false;
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
    (item) => {
      const detail = element('details', 'record-details grade');
      detail.id = 'grade-' + item.id;
      const summary = element('summary', 'record-summary');
      summary.id = detail.id + '-summary';
      const labels = element('span', 'record-labels');
      labels.append(element('strong', '', item.subject));
      if (profile.role === 'teacher') labels.append(element('span', 'muted', item.studentName));
      const score = element('span', 'grade-score', pointsFormat.format(item.points) + ' / ' + pointsFormat.format(item.maxPoints));
      summary.append(labels, score);
      detail.append(summary);
      const progress = element('progress', 'grade-progress');
      progress.max = item.maxPoints;
      progress.value = item.points;
      progress.setAttribute('aria-label', 'Баллы по дисциплине «' + item.subject + '»');
      detail.append(progress, metadata([
        ['Форма контроля', item.control],
        ['Итог контроля', item.result || 'Пока не зафиксирован'],
        ['Критерии', item.criteria],
      ]));
      return detail;
    },
    '',
  )));
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

function contactCard(contact, withId = false) {
  const card = element('article', 'contact-card');
  if (withId) card.id = 'contact-' + contact.id;
  const name = element('h3', 'lesson-title', contact.name);
  name.tabIndex = -1;
  const address = element('p', 'contact-address', contact.email);
  const actions = element('div', 'contact-actions');
  const copy = element('button', 'button button-secondary', 'Скопировать');
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
  const mail = anchor('mailto:' + contact.email, 'inline-link', 'Написать письмо');
  actions.append(copy, mail);
  card.append(name, element('p', 'muted', 'Демо-адрес'), address, actions, status);
  return card;
}

function renderContacts(contacts) {
  return [panel('Преподаватели', listFor(contacts, (contact) => contactCard(contact, true), 'Доступных контактов пока нет.'))];
}

function renderDialogueContact(contact) {
  const signature = JSON.stringify(contact ?? null);
  if (renders.get('dialogue-contact') === signature) return;
  byId('dialogue-contact').replaceChildren(...(contact ? [contactCard(contact)] : []));
  renders.set('dialogue-contact', signature);
}

function formFor(id, buttonText, fields, submit, { confirmation } = {}) {
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
    if (button.disabled || (confirmation && !window.confirm(confirmation))) return;
    performForm(form, error, submit);
  });
  return form;
}

async function performForm(form, output, submit, { onSaved, isCurrent = () => true } = {}) {
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
    await submit(data);
    if (profile !== account) return;
    if (isCurrent()) {
      form.reset();
      delete form.dataset.dirty;
      onSaved?.();
    }
    byId('action-status').textContent = 'Изменения сохранены.';
    await loadCabinet({
      fresh: true,
      refreshView: view,
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
  const sections = [];
  if (student) sections.push(panel('Заказать справку', formFor('new-request', 'Подать заявку', [
    { name: 'type', label: 'Вид справки', options: [['Справка об обучении', 'Справка об обучении']] },
  ], (data) => post('/api/requests', { type: data.get('type') }))));
  sections.push(panel(student ? 'Мои заявки' : 'Заявки студентов', listFor(requests, (item) => {
    const detail = element('details', 'record-details');
    detail.id = 'request-' + item.id;
    const summary = element('summary', 'record-summary');
    summary.id = detail.id + '-summary';
    const labels = element('span', 'record-labels');
    labels.append(element('strong', '', item.type), element('span', 'muted', [!student && item.studentName, eventTime(item.createdAt)].filter(Boolean).join(' · ')));
    summary.append(labels, statusBadge(requestStatuses[item.status] || item.status, item.status));
    detail.append(summary, element('h3', 'record-subheading', 'История заявки'), listFor(item.history, (event) => {
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
  }, 'Заявок пока нет.')));
  return sections;
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
    detail.append(formFor('appeal-withdraw-' + item.id, 'Отозвать обращение', [],
      () => post(resource('/api/appeals', item.id, '/withdraw'), {}),
      { confirmation: 'Отозвать обращение по оценке? Текущие баллы сохранятся.' }));
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

function renderDialogues(dialogues) {
  if (!dialogues.length) return [element('p', 'empty-state', 'Диалогов пока нет.')];
  return dialogues.map((item) => {
    const button = element('button', 'dialogue-button');
    button.type = 'button';
    button.id = 'dialogue-' + item.id;
    button.setAttribute('aria-pressed', String(selectedDialogue === item.id));
    button.append(element('span', '', item.title));
    if (item.unreadCount) {
      const badge = element('span', 'count-badge', item.unreadCount);
      badge.setAttribute('aria-label', 'Непрочитанных сообщений: ' + item.unreadCount);
      button.append(badge);
    }
    button.addEventListener('click', () => openDialogue(item));
    return button;
  });
}

function openDialogue(item) {
  if (selectedDialogue === item.id) {
    byId('dialogue-heading').focus();
    refreshDialogue();
    return;
  }
  selectedDialogue = item.id;
  const list = byId('dialogues-content');
  for (const button of list.querySelectorAll('button')) {
    button.setAttribute('aria-pressed', String(button.id === 'dialogue-' + item.id));
  }
  byId('dialogue-heading').textContent = item.title;
  byId('dialogue-heading').focus();
  byId('dialogue-error').textContent = '';
  renderDialogueContact(item.contact);
  composingMessage = false;
  syncComposer();
  setEmojiPanel(false);
  messageForm.hidden = false;
  byId('messages-content').replaceChildren(element('p', 'empty-state', 'Загружаем переписку…'));
  renderedMessages.clear();
  renders.delete('messages');
  refreshDialogue(false, true);
}

function renderDialogueMessages(messages, content) {
  if (!messages.length) {
    content.replaceChildren(element('p', 'empty-state', 'В этом диалоге ещё нет сообщений.'));
    renderedMessages.clear();
    return;
  }
  let list = content.firstElementChild;
  if (list?.tagName !== 'UL') {
    list = element('ul', 'record-list');
    content.replaceChildren(list);
  }
  let next = list.firstElementChild;
  for (const item of messages) {
    let entry = renderedMessages.get(item.id);
    if (!entry) {
      const row = element('li', 'record-row');
      const message = element('article', 'message ' + (item.mine ? 'message-mine' : 'message-other'));
      const label = element('div', 'message-label');
      const sentAt = element('time', 'muted', eventTime(item.createdAt));
      sentAt.dateTime = item.createdAt;
      label.append(element('strong', '', item.sender), sentAt);
      message.append(label, element('p', 'record-copy', item.text));
      const receipt = item.mine ? element('p', 'message-receipt muted') : null;
      if (receipt) message.append(receipt);
      row.append(message);
      entry = { row, receipt };
      renderedMessages.set(item.id, entry);
      row.dataset.messageId = item.id;
    }
    if (entry.receipt && entry.read !== item.read) {
      entry.receipt.textContent = item.read ? 'Прочитано' : 'Отправлено';
      entry.read = item.read;
    }
    if (entry.row !== next) list.insertBefore(entry.row, next);
    next = entry.row.nextElementSibling;
  }
  while (next) {
    const stale = next;
    next = next.nextElementSibling;
    renderedMessages.delete(Number(stale.dataset.messageId));
    stale.remove();
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
    const latestId = messages.at(-1)?.id;
    const hasNewMessages = renders.has('messages') && latestId !== undefined && !renderedMessages.has(latestId);
    let atEnd = false;
    if (hasNewMessages) {
      const bounds = content.getBoundingClientRect();
      atEnd = bounds.top < window.innerHeight && bounds.bottom <= window.innerHeight + 48;
    }
    const state = messageStates.get(id);
    if (renders.get('messages') !== signature) {
      renderDialogueMessages(messages, content);
      renders.set('messages', signature);
    }
    if (state?.scrollOnRefresh || (atEnd && hasNewMessages)) {
      if (state) state.scrollOnRefresh = false;
      messageForm.scrollIntoView({ block: 'nearest' });
    }
    const errorOutput = byId('dialogue-error');
    if (errorOutput.textContent) errorOutput.textContent = '';
    if (messages.some((message) => !message.mine && !message.read)) {
      await post(resource('/api/dialogues', id, '/read'), { throughId: messages.at(-1).id });
      if (current()) loadCabinet({ quiet: true, fresh: true });
    }
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

function syncComposer() {
  const state = messageStates.get(selectedDialogue);
  const value = state?.text ?? '';
  if (messageText.value !== value) messageText.value = value;
  const button = byId('message-submit');
  button.disabled = Boolean(state?.sending);
  button.textContent = state?.sending ? 'Отправляем…' : state?.error ? 'Повторить отправку' : 'Отправить';
  byId('message-error').textContent = state?.error ?? '';
  if (state?.sending) messageForm.setAttribute('aria-busy', 'true');
  else messageForm.removeAttribute('aria-busy');
}

function updateDraft() {
  const state = messageStates.get(selectedDialogue) ?? {};
  state.text = messageText.value;
  if (state.error) {
    state.error = '';
    syncComposer();
  }
  messageStates.set(selectedDialogue, state);
}

function handleMessageKey(event) {
  if (event.key !== 'Enter' || event.shiftKey || event.isComposing || composingMessage || event.keyCode === 229) return;
  event.preventDefault();
  if (messageText.value.trim() && !messageStates.get(selectedDialogue)?.sending) messageForm.requestSubmit();
}

async function sendMessage(event) {
  event.preventDefault();
  const account = profile;
  const id = selectedDialogue;
  const text = messageText.value.trim();
  const state = messageStates.get(id) ?? {};
  if (!account || signingOut || id === undefined || activeView !== 'messages' || composingMessage || state.sending || !text) return;
  const draft = messageText.value;
  const current = () => profile === account && selectedDialogue === id;
  state.text = draft;
  state.error = '';
  state.sending = true;
  messageStates.set(id, state);
  syncComposer();
  try {
    await post(resource('/api/dialogues', id, '/messages'), { text });
    if (profile !== account) return;
    if (state.text === draft) state.text = '';
    if (current() && activeView === 'messages') {
      state.scrollOnRefresh = true;
      refreshDialogue(false, true);
    }
    byId('action-status').textContent = 'Сообщение отправлено.';
    loadCabinet({ quiet: true, fresh: true });
  } catch (error) {
    if (profile === account && !endSession(error)) state.error = error.message;
  } finally {
    state.sending = false;
    if (current()) syncComposer();
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

async function runSearch(query, account, load) {
  const current = () => profile === account && searchLoad === load;
  try {
    const { results } = await request('/api/search?q=' + encodeURIComponent(query), { signal: load.controller.signal });
    if (!current()) return;
    const matching = results.filter((item) => roleViews[account.role].includes(item.view));
    for (const item of matching) {
      const row = element('li');
      const hash = '#' + item.view + (item.id ? '/' + item.id : '');
      const link = anchor(hash, 'search-result');
      link.append(element('span', '', item.title), element('span', 'muted', searchTypes[item.type] ?? 'Результат'));
      link.addEventListener('click', (event) => {
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        event.preventDefault();
        clearSearch();
        if (window.location.hash === hash) route(true);
        else window.location.hash = hash;
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
messageForm.addEventListener('submit', sendMessage);
messageText.addEventListener('keydown', handleMessageKey);
messageText.addEventListener('input', updateDraft);
messageText.addEventListener('compositionstart', () => { composingMessage = true; });
messageText.addEventListener('compositionend', () => { composingMessage = false; });
for (const [emoji, label] of [['🙂', 'Улыбка'], ['👍', 'Палец вверх'], ['👋', 'Привет'], ['🙏', 'Спасибо'], ['🎉', 'Праздник'], ['✅', 'Готово'], ['❤️', 'Сердце'], ['🤔', 'Задумчивость']]) {
  const button = element('button', 'emoji-button', emoji);
  button.type = 'button';
  button.setAttribute('aria-label', label);
  button.addEventListener('click', () => chooseEmoji(emoji));
  emojiOptions.append(button);
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

document.addEventListener('visibilitychange', () => {
  if (document.hidden || !profile || signingOut) return;
  if (profile.role === 'student') loadSchedule({ quiet: true });
  loadCabinet({ quiet: true });
  if (activeView === 'messages' && selectedDialogue !== undefined) refreshDialogue(true);
});

byId('login-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const submit = form.querySelector('button');
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
    showApp(student, true);
  } catch (error) {
    byId('login-error').textContent = error.message;
  } finally {
    submit.disabled = false;
    submit.textContent = 'Войти';
  }
});

async function logout() {
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
      (mobileMenu.open ? mobileError : byId('app-error')).textContent = error.message;
    }
  } finally {
    signingOut = false;
    for (const button of buttons) button.disabled = false;
  }
}

byId('logout').addEventListener('click', logout);
byId('mobile-logout').addEventListener('click', logout);

const mobileNav = byId('mobile-nav');
mobileNav.append(...[...document.querySelectorAll('.sidebar [data-view]')].map((link) => link.cloneNode(true)));
mobileAvatar.addEventListener('click', () => {
  if (!profile || mobileMenu.open || !mobileLayout.matches) return;
  mobileMenu.showModal();
  mobileAvatar.setAttribute('aria-expanded', 'true');
  document.documentElement.classList.add('menu-open');
});
mobileNav.addEventListener('click', (event) => {
  const link = event.target.closest('a[data-view]');
  if (!link || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  event.preventDefault();
  mobileMenu.close();
  if (window.location.hash !== link.hash) {
    drawerDestination = link.hash;
    window.location.hash = link.hash;
  }
});
mobileMenu.addEventListener('click', (event) => {
  if (event.target === mobileMenu) mobileMenu.close();
});
mobileMenu.addEventListener('close', () => {
  mobileAvatar.setAttribute('aria-expanded', 'false');
  document.documentElement.classList.remove('menu-open');
  if (profile && mobileLayout.matches) mobileAvatar.focus({ preventScroll: true });
  if (profile && !mobileLayout.matches) {
    document.querySelector('.sidebar [aria-current="page"]')?.focus({ preventScroll: true });
  }
});
mobileLayout.addEventListener('change', (event) => {
  if (!event.matches && mobileMenu.open) mobileMenu.close();
});

byId('day-picker').addEventListener('change', (event) => selectDay(event.target.value));
for (const button of document.querySelectorAll('[data-schedule-retry]')) {
  button.addEventListener('click', loadSchedule);
}

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

byId('campus-room-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const query = byId('campus-room-query').value.trim().toLocaleLowerCase('ru-RU');
  const knownRoom = /^(?:(?:зал|ауд(?:итория)?\.?)\s*)?(?:№\s*)?314$/.test(query);
  byId('campus-building-new').classList.toggle('status-ready', knownRoom);
  byId('campus-room-result').textContent = knownRoom
    ? 'Зал 314. Новый корпус, 3-й этаж по программе 2023 года.'
    : 'Расположение не подтверждено.';
});

restoreSession();
