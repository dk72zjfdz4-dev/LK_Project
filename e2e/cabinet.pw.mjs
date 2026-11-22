import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test as base } from '@playwright/test';

const test = base.extend({
  // eslint-disable-next-line no-empty-pattern -- Playwright fixtures require a destructured first argument.
  cabinet: [async ({}, use) => {
    const directory = await mkdtemp(join(tmpdir(), 'cabinet-browser-'));
    const student = randomBytes(18).toString('base64url');
    const other = randomBytes(18).toString('base64url');
    const dean = randomBytes(18).toString('base64url');
    const teacher = randomBytes(18).toString('base64url');
    const server = spawn(process.execPath, ['server.mjs'], {
      env: {
        HOST: '127.0.0.1', PORT: '0', DB_PATH: join(directory, 'test.sqlite'),
        DEMO_PASSWORD_1: student, DEMO_PASSWORD_2: other, DEMO_PASSWORD_TEACHER: teacher, DEMO_PASSWORD_DEKANAT1: dean,
      },
    });
    const stopped = new Promise((resolve) => server.once('close', resolve));
    let output = '';
    let stderr = '';
    server.stderr.on('data', (chunk) => { stderr += chunk; });
    try {
      const origin = await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.once('exit', (code) => reject(new Error(`Test server exited (${code}): ${stderr}`)));
        server.stdout.on('data', (chunk) => {
          output += chunk;
          const url = output.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0];
          if (url) resolve(url);
        });
      });
      await use({ origin, student, other, teacher, dean });
    } finally {
      if (server.pid && server.exitCode === null && server.signalCode === null) {
        server.kill();
        await once(server, 'exit');
      }
      await stopped;
      await rm(directory, { recursive: true, force: true });
    }
  }, { scope: 'worker' }],
});

async function login(page, cabinet, role = 'student') {
  await page.goto(cabinet.origin);
  await page.getByLabel('Логин', { exact: true }).fill({ student: 'student1', other: 'student2', teacher: 'teacher1', dean: 'dekanat1' }[role]);
  await page.getByLabel('Пароль', { exact: true }).fill(cabinet[role]);
  await page.getByRole('button', { name: 'Войти', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Главная', exact: true })).toBeVisible();
}

async function expandGroup(navigation, name) {
  const button = navigation.getByRole('button', { name, exact: true });
  if (await button.getAttribute('aria-expanded') === 'false') await button.click();
}

test('home shows two upcoming changes until expanded', async ({ page, cabinet }) => {
  const changes = [24, 25, 26].map((day) => ({
    id: String(day), date: `2026-11-${day}`, start: '10:40', end: '12:00',
    title: `Занятие ${day}`, room: 'А-204', teacher: 'Преподаватель', change: 'Аудитория изменена.',
  }));
  let nextWeekLessons = [...changes].reverse();
  await page.route('**/api/schedule', (route) => route.fulfill({
    json: { today: '2026-11-22', weekStart: '2026-11-16', lessons: [], nextWeekLessons },
  }));
  await login(page, cabinet);
  const panel = page.locator('#home-changes');
  const rows = panel.getByRole('listitem');
  const toggle = panel.getByRole('button', { name: 'Показать все' });
  const requests = page.locator('#stat-requests');
  const bottom = (locator) => locator.evaluate((element) => element.getBoundingClientRect().bottom);
  const bottomGap = async () => (await bottom(panel)) - (await bottom(requests));
  await expect(requests).toBeVisible();
  await expect(rows).toHaveCount(2);
  await expect.poll(bottomGap).toBeCloseTo(0, 0);
  await expect(rows.first()).toContainText('Занятие 24');
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  const week = page.locator('.home-calendar');
  const top = (locator) => locator.evaluate((element) => element.getBoundingClientRect().top);
  const weekBox = await week.boundingBox();
  const deadlines = page.locator('#home-cabinet');
  const deadlinesTop = await top(deadlines);
  await toggle.press('Enter');
  await expect(rows).toHaveCount(3);
  await expect(rows.last()).toContainText('Занятие 26');
  expect(await week.boundingBox()).toEqual(weekBox);
  expect(await top(deadlines)).toBeGreaterThan(deadlinesTop);
  const collapse = panel.getByRole('button', { name: 'Свернуть' });
  await expect(collapse).toHaveAttribute('aria-expanded', 'true');
  await collapse.click();
  await expect(rows).toHaveCount(2);
  expect(await week.boundingBox()).toEqual(weekBox);

  nextWeekLessons = changes.slice(0, 2);
  await page.reload();
  await expect(rows).toHaveCount(2);
  await expect(panel.locator('#home-changes-toggle')).toBeHidden();
  await expect.poll(bottomGap).toBeCloseTo(0, 0);
  await page.setViewportSize({ width: 390, height: 844 });
  expect((await panel.boundingBox()).y).toBeGreaterThan(await bottom(requests));
  expect(await top(week)).toBeGreaterThan(await bottom(panel));
  expect(await top(deadlines)).toBeGreaterThan(await bottom(week));
});

for (const width of [360, 1440]) {
  test(`week arrows switch both calendars at ${width} px`, async ({ page, cabinet }) => {
    await page.setViewportSize({ width, height: 820 });
    await login(page, cabinet);
    const api = cabinet.origin + '/api/schedule';
    const { weekStart } = await (await page.request.get(api)).json();
    const offset = (days) => new Date(Date.parse(weekStart) + days * 86_400_000).toISOString().slice(0, 10);
    const home = page.locator('.home-calendar');
    const schedule = page.locator('#schedule-week-view');
    const previous = (panel) => panel.getByRole('button', { name: 'Предыдущая неделя' });
    const next = (panel) => panel.getByRole('button', { name: 'Следующая неделя' });
    const homeDay = page.locator('#home-week input').first();
    const scheduleDay = page.locator('#week-grid .calendar-day').first();
    const upcoming = page.locator('#upcoming-lessons');
    const changes = page.locator('#changed-lessons');
    await expect(homeDay).toHaveValue(weekStart);
    const announcements = [await upcoming.innerText(), await changes.innerText()];
    await previous(home).press('Enter');
    await expect(homeDay).toHaveValue(offset(-7));
    await expect(previous(home)).toBeFocused();
    expect([await upcoming.innerText(), await changes.innerText()]).toEqual(announcements);
    await fits(page);
    await page.getByRole('link', { name: 'Всё расписание' }).click();
    await expect(scheduleDay).toHaveAttribute('data-date', offset(-7));
    await next(schedule).click();
    await expect(scheduleDay).toHaveAttribute('data-date', weekStart);
    await page.route(api + '?week=' + offset(7), (route) => route.abort(), { times: 1 });
    await next(schedule).click();
    await expect(schedule.locator('[data-week-status]')).toContainText('Не удалось открыть неделю');
    await expect(scheduleDay).toHaveAttribute('data-date', weekStart);
    await next(schedule).click();
    await expect(scheduleDay).toHaveAttribute('data-date', offset(7));
    await expect(schedule.locator('[data-week-status]')).toBeEmpty();
    await next(schedule).click();
    await expect(scheduleDay).toHaveAttribute('data-date', offset(14));
    await fits(page);
    const mainNav = width <= 680 ? page.locator('.mobile-tabs') : page.locator('.sidebar');
    await mainNav.getByRole('link', { name: 'Главная', exact: true }).click();
    await expect(homeDay).toHaveValue(offset(14));
  });
}

async function fits(page) {
  expect(await page.evaluate(() => globalThis.document.documentElement.scrollWidth)).toBeLessThanOrEqual(page.viewportSize().width);
}

async function capture(page, name) {
  await page.screenshot({ path: `test-results/screenshots/${name}-360.png`, animations: 'disabled' });
}

for (const width of [360, 741, 1440]) {
  test(`seasonal login at ${width} px`, async ({ page, cabinet }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.clock.setFixedTime(new Date('2026-11-21T16:00:00Z'));
    await page.goto(cabinet.origin);
    const scene = page.locator('.login-scene img');
    await expect(scene).toHaveAttribute('src', '/assets/auth/winter-evening.png');
    await expect(page.locator('.login-layout')).toHaveCSS('display', 'grid');
    await fits(page);
    await page.screenshot({ path: `test-results/screenshots/seasonal-login-${width}.png`, animations: 'disabled' });
    await page.locator('#login-theme input[value="light"]').check();
    await expect(scene).toHaveAttribute('src', '/assets/auth/winter-day.png');
    const headline = page.locator('.login-header .login-headline');
    await expect(headline).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
    const slogan = headline.locator('.login-headline-text');
    await expect(slogan).toHaveText('Твоя университетская жизнь — ближе!');
    await expect(slogan).toHaveCSS('white-space', 'nowrap');
    const sloganBox = await slogan.boundingBox();
    const headlineBox = await headline.boundingBox();
    const brandBox = await page.locator('.login-brand').boundingBox();
    expect(sloganBox.x).toBeGreaterThan(brandBox.x + brandBox.width);
    expect(sloganBox.x + sloganBox.width).toBeLessThanOrEqual(headlineBox.x + headlineBox.width);
    await fits(page);
    await page.screenshot({ path: `test-results/screenshots/seasonal-login-light-${width}.png`, animations: 'disabled' });
    await page.reload();
    await expect(scene).toHaveAttribute('src', '/assets/auth/winter-day.png');
    await page.getByRole('button', { name: 'Показать пароль' }).click();
    await expect(page.locator('#password')).toHaveAttribute('type', 'text');
    await page.getByRole('button', { name: 'Скрыть пароль' }).click();
    await expect(page.locator('#password')).toHaveAttribute('type', 'password');
    await login(page, cabinet);
  });
}

for (const width of [360, 390, 440]) {
  test(`mobile tabs, focus and layout at ${width} px`, async ({ page, cabinet }) => {
    await page.setViewportSize({ width, height: width === 440 ? 450 : 800 });
    await login(page, cabinet);
    const avatar = page.getByRole('link', { name: 'Открыть профиль' });
    await expect(avatar).toHaveText('НР');
    expect((await avatar.boundingBox()).x).toBeLessThan(32);
    await expect(page.getByRole('heading', { name: 'Учебная неделя' })).toBeVisible();
    await fits(page);
    await expect(page.locator('#stat-assignments')).toBeVisible();
    await expect(page.locator('#stat-requests')).toBeVisible();
    await expect(page.locator('#stat-messages')).toHaveCount(0);
    await expect(page.locator('#header-inbox [data-unread]')).toBeVisible();
    if (width === 360) await capture(page, 'home');
    await page.locator('#home-week').locator('label').first().click();
    await expect(page.locator('#home-day')).toContainText(/зельеварение|заклинания/i);
    await expect(page.getByRole('heading', { name: 'Главная', exact: true })).toBeVisible();
    const tabs = page.locator('.mobile-tabs');
    await expect(tabs.getByRole('link')).toHaveCount(5);
    await expect(page.locator('.sidebar')).toBeHidden();
    await avatar.click();
    await expect(page.locator('#page-heading')).toHaveText('Профиль');
    await expect(tabs.getByRole('link', { name: 'Профиль' })).toHaveAttribute('aria-current', 'page');
    const menuTab = tabs.getByRole('link', { name: 'Меню' });
    await menuTab.focus();
    await page.keyboard.press('Tab');
    await expect(tabs.getByRole('link', { name: 'Профиль' })).toBeFocused();
    await expect(tabs.getByRole('link', { name: 'Профиль' })).toHaveCSS('outline-style', 'solid');
    await menuTab.click();
    const menu = page.locator('#view-menu');
    await expect(menu).toBeVisible();
    await expandGroup(menu, 'Сервисы');
    await expandGroup(menu, 'Кампус');
    await expect(menu.getByRole('link', { name: 'Справки и документы' })).toBeVisible();
    if (width === 360) await capture(page, 'menu');
    await expect(menu.getByRole('button', { name: /Выйти/ })).toHaveCount(0);
    await expect(menu.getByText('Нюша Мироновна Романова')).toHaveCount(0);
    const contacts = menu.getByRole('link', { name: 'Контакты' });
    await contacts.scrollIntoViewIfNeeded();
    const menuPosition = await page.evaluate(() => globalThis.scrollY);
    await contacts.click();
    await expect(menuTab).toHaveAttribute('aria-current', 'page');
    await page.goBack();
    await expect(menu).toBeVisible();
    await expect.poll(() => page.evaluate(() => globalThis.scrollY)).toBeGreaterThanOrEqual(menuPosition - 120);
    await page.locator('#help-launcher').click();
    const helper = page.locator('#help-dialog');
    await expect(helper).toBeVisible();
    if (width === 360) await capture(page, 'helper');
    await expect(helper.getByRole('combobox', { name: 'Вопрос о кабинете' })).toBeVisible();
    await helper.getByRole('button', { name: 'Закрыть помощника' }).click();
    await expect(helper).toBeHidden();
    await tabs.getByRole('link', { name: 'Профиль' }).click();
    const profile = page.locator('#view-profile');
    const logout = profile.getByRole('button', { name: 'Выйти из аккаунта' });
    await logout.scrollIntoViewIfNeeded();
    await expect(logout).toBeInViewport();
    if (width === 360) {
      await page.route('**/api/logout', (route) => route.fulfill({ status: 500, json: { error: 'Не удалось выйти.' } }), { times: 1 });
      await logout.click();
      await expect(profile.getByRole('alert')).toHaveText('Не удалось выйти.');
      await logout.click();
      await expect(page.getByRole('heading', { name: 'Вход в кабинет' })).toBeVisible();
    }
  });
}

for (const width of [360, 1440]) {
  test(`month schedule at ${width} px`, async ({ page, cabinet }) => {
    await page.setViewportSize({ width, height: 900 });
    await login(page, cabinet);
    const nav = width === 360 ? page.locator('.mobile-tabs') : page.locator('.sidebar nav');
    if (width !== 360) await expandGroup(nav, 'Учёба');
    await nav.getByRole('link', { name: 'Расписание', exact: true }).click();
    await expect(page.locator('#week-grid')).toBeVisible();
    await expect(page.locator('#week-grid .calendar-day:visible').first()).toHaveCSS('border-top-width', '0px');
    await page.getByRole('button', { name: 'Месяц', exact: true }).click();
    const month = page.getByLabel('Месяц расписания', { exact: true });
    const grid = page.locator('#month-grid');
    await expect(month).toHaveCSS('border-top-width', '0px');
    for (const [value, days, label] of [
      ['2026-09', 30, /, 1 сентября, занятий: [1-9]/],
      ['2026-10', 31, /, 1 октября, занятий: [1-9]/],
    ]) {
      await month.selectOption(value);
      await expect(grid.locator('.month-cell')).toHaveCount(days);
      await expect(grid.getByRole('button', { name: label })).toBeVisible();
      await expect(grid.locator('.month-cell').first()).toHaveCSS('border-top-width', '0px');
    }
    await month.selectOption('2026-11');
    await expect(grid.locator('.month-cell')).toHaveCount(30);
    const changedDay = grid.getByRole('button', { name: /, 24 ноября,.*есть изменения/ });
    await expect(changedDay.locator('..')).toHaveClass(/month-changed/);
    for (const date of [3, 4, 10, 11, 17, 18, 19]) {
      await expect(grid.getByRole('button', { name: new RegExp(', ' + date + ' ноября,') }).locator('..'))
        .not.toHaveClass(/month-changed/);
    }
    await changedDay.click();
    await expect(changedDay).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('#month-day')).toContainText('Аудитория изменена.');
    await expect(page.locator('#month-day .change-label')).toBeVisible();
    const cancelledDay = grid.getByRole('button', { name: /, 26 ноября,.*есть изменения/ });
    await cancelledDay.click();
    await expect(page.locator('#month-day .change-label')).toHaveText('Занятие отменено.');
    await month.selectOption('2026-12');
    await expect(grid.locator('.month-cell')).toHaveCount(31);
    await expect(grid.locator('.month-changed')).toHaveCount(0);
    const schoolSaturday = grid.getByRole('button', { name: /, 12 декабря,.*занятий: 2/ }).locator('..');
    const freeSaturday = grid.getByRole('button', { name: /, 5 декабря,.*занятий: 0/ }).locator('..');
    const schoolFriday = grid.getByRole('button', { name: /, 11 декабря,/ }).locator('..');
    const schoolBackground = await schoolFriday.evaluate((cell) => globalThis.getComputedStyle(cell).backgroundColor);
    await expect(schoolSaturday).toHaveCSS('background-color', schoolBackground);
    await expect(freeSaturday).not.toHaveCSS('background-color', schoolBackground);
    await expect(page.locator('#week-grid')).toBeHidden();
    await fits(page);
    await page.screenshot({ path: `test-results/screenshots/schedule-month-${width}.png`, animations: 'disabled' });
    if (width === 360) await grid.getByRole('button', { name: /1 декабря,/ }).first().click();
    const lesson = (width === 360 ? page.locator('#month-day') : grid).locator('.lesson-link').first();
    await lesson.click();
    await expect(page.locator('#lesson-dialog')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(lesson).toBeFocused();
    await page.getByRole('button', { name: 'Неделя', exact: true }).click();
    await expect(page.locator('#week-grid')).toBeVisible();
    await expect(grid).toBeHidden();
  });
}

test('teacher login and role-specific navigation', async ({ page, cabinet }) => {
  await login(page, cabinet, 'teacher');
  const navigation = page.locator('.sidebar nav');
  await expect(page.locator('#sidebar-initials')).toHaveText('СС');
  await expandGroup(navigation, 'Учёба');
  await expect(navigation.getByRole('link', { name: 'Задания' })).toBeVisible();
  await expect(navigation.getByRole('link', { name: 'Справки и документы' })).toHaveCount(0);
});

test('header search matches word prefixes and links to the chosen semester', async ({ page, cabinet }) => {
  await login(page, cabinet);
  const search = page.getByRole('searchbox', { name: 'Поиск по кабинету' });
  const results = page.locator('#search-results');
  await search.fill('рас');
  await expect(results.getByRole('link')).toHaveCount(2);
  await expect(results.getByRole('link', { name: /Где посмотреть расписание/ })).toBeVisible();
  await expect(results).toHaveCSS('background-color', 'rgb(249, 252, 255)');

  await search.fill('р');
  await expect(results.getByRole('link', { name: /^Расписание/ })).toBeVisible();
  await expect(results.getByRole('link', { name: /Астрономия/ })).toHaveCount(0);

  for (const semester of [1, 2]) {
    await search.fill('трав');
    await expect(results.getByRole('link')).toHaveCount(2);
    const link = results.getByRole('link', { name: new RegExp(`Травология · Семестр ${semester}`) });
    const target = await link.getAttribute('href');
    await link.click();
    await expect(page.locator(`#grade-semester-${semester}`)).toHaveJSProperty('open', true);
    await expect(page.locator('#' + target.split('/').at(-1))).toHaveJSProperty('open', true);
  }
});

test('mobile search opens the document form and campus opens the chosen card', async ({ page, cabinet }) => {
  await page.setViewportSize({ width: 360, height: 800 });
  await login(page, cabinet);
  await page.getByRole('searchbox', { name: 'Поиск по кабинету' }).fill('справ');
  const results = page.locator('#search-results');
  await expect(results.getByRole('link', { name: /Справки и документы/ })).toBeVisible();
  await expect(results.locator('mark').first()).toHaveText(/справ/i);
  await fits(page);
  await capture(page, 'search');
  await results.getByRole('link', { name: /^Справка об обучении\s+Документ$/ }).click();
  const form = page.locator('#document-enrollment');
  await expect(form.getByRole('button', { name: 'Подать заявку' })).toBeVisible();

  await page.locator('.mobile-tabs').getByRole('link', { name: 'Меню' }).click();
  await expandGroup(page.locator('#mobile-nav'), 'Кампус');
  await page.locator('#view-menu').getByRole('link', { name: 'Карта кампуса' }).click();
  await page.getByRole('button', { name: 'Корпус Б', exact: true }).click();
  const card = page.locator('#campus-card');
  await expect(card.getByRole('heading', { name: 'Корпус Б' })).toBeVisible();
  await expect(page.locator('#campus-card-shape')).toHaveAttribute('href', '#campus-shape-b');
  await expect(page.locator('#help-launcher')).toBeHidden();
  await fits(page);
  await capture(page, 'campus');
  await card.getByRole('button', { name: 'Закрыть' }).click();
  await expect(card).toBeHidden();
});

for (const width of [360, 440, 1440]) {
  test(`messenger layout, independent drafts and emoji at ${width} px`, async ({ page, cabinet }) => {
    await page.setViewportSize({ width, height: width === 440 ? 450 : 820 });
    await login(page, cabinet);
    const launcher = page.locator('#help-launcher');
    const homePosition = await launcher.boundingBox();
    await page.locator('#header-inbox').click();
    await expect(page.locator('.mobile-header .brand [aria-hidden="true"]')).toHaveText('ЛК');
    const search = page.getByRole('searchbox', { name: 'Поиск диалогов' });
    const captureChat = (part) => page.screenshot({ path: `test-results/screenshots/messages-${part}-${width}.png`, animations: 'disabled' });
    await expect(page.locator('#dialogues-content button')).toHaveCount(2);
    await captureChat('list');
    await search.fill('дека');
    const contact = page.locator('#dialogues-content').getByRole('button', { name: /Деканат/ });
    await expect(contact).toHaveCount(1);
    await contact.click();
    const composer = page.getByRole('textbox', { name: 'Сообщение', exact: true });
    await expect(composer).toBeInViewport();
    const send = page.locator('#message-submit');
    await expect(send).toBeDisabled();
    await expect(send).toHaveCSS('cursor', 'default');
    await expect(launcher).toBeInViewport();
    expect(await launcher.boundingBox()).toEqual(homePosition);
    await page.evaluate(() => globalThis.scrollTo(0, globalThis.document.documentElement.scrollHeight));
    expect(await launcher.boundingBox()).toEqual(homePosition);
    await page.evaluate(() => globalThis.scrollTo(0, 0));
    if (width === 360) {
      await composer.fill('Добрый день! Подскажите, пожалуйста, статус справки.');
      await composer.press('Enter');
      await expect(composer).toHaveValue('');
    }
    await composer.fill('Привет мир');
    await expect(composer).toHaveCSS('outline-style', 'none');
    await expect(launcher).toBeInViewport();
    await expect(page.locator('.help-dock')).toHaveCSS('position', 'fixed');
    await page.locator('#message-submit').click({ trial: true });
    await launcher.click();
    const helper = page.locator('#help-dialog');
    await expect(helper).toBeVisible();
    await helper.getByRole('button', { name: 'Закрыть помощника' }).click();
    await expect(launcher).toBeFocused();
    await expect(composer).toHaveValue('Привет мир');
    await composer.press('Home');
    await composer.press('ArrowRight');
    await page.getByRole('button', { name: 'Эмодзи', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Учёба', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Улыбка', exact: true }).click();
    await expect(composer).toHaveValue('П🙂ривет мир');
    await fits(page);
    await captureChat('thread');
    if (width < 681) {
      await expect(search).toBeHidden();
      await page.getByRole('button', { name: 'Назад к диалогам' }).click();
      await expect(search).toHaveValue('дека');
      await expect(search).toBeVisible();
      await contact.click();
      await expect(composer).toHaveValue('П🙂ривет мир');
    } else {
      await expect(search).toBeVisible();
      const contactInfo = page.locator('#dialogue-info');
      await contactInfo.getByText('Контакты', { exact: true }).click();
      await expect(contactInfo.getByText('dekanat1@example.com', { exact: true })).toBeVisible();
      const mailSummary = contactInfo.locator('.contact-mail-picker > summary');
      await mailSummary.press('Enter');
      await expect(contactInfo.getByRole('link', { name: 'Почтовое приложение' })).toHaveAttribute('href', 'mailto:dekanat1@example.com');
      await page.getByRole('button', { name: 'Назад к диалогам' }).click();
      await expect(page.locator('#dialogue-heading')).toHaveText('Переписка');
      await expect(page.getByText('Выберите диалог.', { exact: true })).toBeVisible();
      await expect(composer).toBeHidden();
      await expect(contact).toBeFocused();
      await search.fill('');
      await page.locator('#dialogues-content button').filter({ hasNotText: 'Деканат' }).first().click();
      await expect(composer).toHaveValue('');
      await page.locator('#dialogue-info').getByText('Контакты', { exact: true }).click();
      const details = page.locator('#dialogue-contact');
      await expect(details.getByText('Северус Снегг', { exact: true })).toHaveCount(1);
      await expect(details.getByText('Открыть почту', { exact: true })).toBeVisible();
      await contact.click();
      await expect(composer).toHaveValue('П🙂ривет мир');
    }
  });
}

test('new conversation restores the search and opens a teacher contact', async ({ page, cabinet }) => {
  await login(page, cabinet, 'other');
  await page.locator('#header-inbox').click();
  const entries = page.locator('#dialogues-content button');
  await expect(entries).toHaveCount(1);
  await expect(entries.first()).toContainText('Деканат');
  const search = page.locator('#dialogue-search');
  const create = page.getByRole('button', { name: 'Новый диалог' });
  const tooltip = page.locator('#dialogue-new-tooltip');
  await search.fill('дека');
  await create.hover();
  await expect(tooltip).toBeVisible();
  await create.click();
  const back = page.locator('.dialogue-panel').getByRole('button', { name: 'Назад к диалогам' });
  await expect(back).toBeFocused();
  await expect(tooltip).toHaveText('Назад к диалогам');
  await page.locator('#dialogues-heading').hover();
  await expect(tooltip).toBeHidden();
  await page.keyboard.press('Tab');
  await expect(search).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(back).toBeFocused();
  await expect(tooltip).toBeVisible();
  await expect(search).toHaveValue('');
  await back.press('Enter');
  await expect(create).toBeFocused();
  await expect(search).toHaveValue('дека');
  await expect(entries.first()).toContainText('Деканат');
  await search.clear();
  await create.click();
  await page.getByLabel('Категория контактов').selectOption('teacher');
  await search.fill('Снегг');
  await expect(entries).toHaveCount(1);
  await expect(entries.first()).toContainText('Преподаватель');
  await entries.first().click();
  const composer = page.locator('#message-text');
  await composer.fill('Первый вопрос преподавателю');
  await composer.press('Enter');
  await expect(composer).toHaveValue('');
  await expect(entries).toHaveCount(2);
  await expect(entries.first()).toContainText('Вы: Первый вопрос преподавателю');
});

test('student finds contacts by category and opens a teacher conversation', async ({ page, cabinet }) => {
  await page.setViewportSize({ width: 360, height: 800 });
  await login(page, cabinet);
  await page.locator('.mobile-tabs [data-view=messages]').click();
  await page.getByRole('button', { name: 'Новый диалог' }).click();
  const category = page.getByLabel('Категория контактов');
  const search = page.locator('#dialogue-search');
  const entries = page.locator('#dialogues-content button');
  for (const [role, query, name] of [
    ['student', 'Речин', 'Крош Речин'],
    ['student', 'Ёжик', 'Ёжик Иголкин'],
    ['dean', 'Деканат', 'Деканат'],
    ['teacher', 'Снегг', 'Северус Снегг'],
    ['teacher', 'Флитвик', 'Филиус Флитвик'],
    ['teacher', 'Стебль', 'Помона Стебль'],
    ['teacher', 'Синистра', 'Аврора Синистра'],
    ['teacher', 'Макгонагалл', 'Минерва Макгонагалл'],
    ['teacher', 'Люпин', 'Римус Люпин'],
  ]) {
    await category.selectOption(role);
    await search.fill(query);
    await expect(entries).toHaveCount(1);
    await expect(entries.first()).toContainText(name);
  }
  await fits(page);
  await entries.first().click();
  await expect(page.locator('#dialogue-heading')).toHaveText('Римус Люпин');
  await expect(page.locator('#message-text')).toBeVisible();
});

for (const width of [360, 1440]) {
  test(`student contacts show school details at ${width} px`, async ({ page, cabinet }) => {
    await page.setViewportSize({ width, height: 800 });
    await login(page, cabinet);
    await page.locator('#header-inbox').click();
    await page.getByRole('button', { name: 'Новый диалог' }).click();
    await page.getByLabel('Категория контактов').selectOption('student');
    await page.locator('#dialogue-search').fill('Речин');
    const entry = page.locator('#dialogues-content button').filter({ hasText: 'Крош Речин' });
    await expect(entry.locator('.dialogue-role')).toHaveText('Студент');
    await entry.click();
    await expect(page.locator('#dialogue-role')).toHaveText('Студент');
    await page.locator('#dialogue-info summary').press('Enter');
    const card = page.locator('#dialogue-contact');
    await expect(card.getByRole('heading')).toHaveText('Крош Андреевич Речин');
    await expect(card.locator('dt')).toHaveText(['Факультет', 'Направление', 'Группа', 'Курс']);
    await expect(card.locator('dd')).toHaveText(['Слизерин', 'Зельеварение и алхимия', 'СЛ-23-04', '3']);
    await expect(card.getByText('Открыть почту', { exact: true })).toHaveCount(0);
    await fits(page);
  });
}

test('teacher can search all categories and start a conversation with the dean’s office', async ({ page, cabinet }) => {
  await login(page, cabinet, 'teacher');
  await page.locator('#header-inbox').click();
  await page.getByRole('button', { name: 'Новый диалог' }).click();
  const category = page.getByLabel('Категория контактов');
  const search = page.locator('#dialogue-search');
  const entries = page.locator('#dialogues-content button');
  for (const [role, query] of [['student', 'Речин'], ['teacher', 'Макгонагалл'], ['dean', 'Деканат']]) {
    await category.selectOption(role);
    await search.fill(query);
    await expect(entries).toHaveCount(1);
    await expect(entries.first()).toContainText(query);
  }
  await entries.first().click();
  await expect(page.locator('#dialogue-heading')).toHaveText('Деканат');
  await expect(page.locator('#message-text')).toBeVisible();
});

test('message receipt visibility and retry after lost response in independent sessions', async ({ page, browser, cabinet }) => {
  test.setTimeout(65000);
  await login(page, cabinet);
  const receiver = await browser.newContext({ viewport: { width: 360, height: 490 } });
  try {
    const dean = await receiver.newPage();
    await login(dean, cabinet, 'dean');
    await page.locator('#header-inbox').click();
    await page.locator('#dialogues-content button').filter({ hasText: 'Деканат' }).click();
    const composer = page.locator('#message-text');
    const routePattern = '**/api/dialogues/*/messages';
    let lost = false;
    await page.route(routePattern, async (route) => {
      if (lost) return route.continue();
      const response = await route.fetch();
      expect(response.ok()).toBe(true);
      lost = true;
      await route.abort('failed');
    });
    const text = 'Повтор после потери ответа ' + randomBytes(5).toString('hex');
    await composer.fill(text);
    await composer.press('Enter');
    await expect(page.getByRole('img', { name: 'Отправка не подтверждена' })).toBeVisible();
    await page.getByRole('button', { name: 'Повторить', exact: true }).click();
    await expect(composer).toHaveValue('');
    const row = page.locator('.record-row').filter({ hasText: text });
    await expect(row).toHaveCount(1);
    await expect(row.getByRole('img', { name: 'Сохранено на сервере' })).toBeVisible();

    const threadId = await page.locator('#dialogues-content button[aria-pressed="true"]').getAttribute('id');
    const url = cabinet.origin + '/api/dialogues/' + threadId.split('-').at(-1);
    for (let index = 0; index < 12; index++) {
      const result = await page.request.post(url + '/messages', {
        headers: { Origin: cabinet.origin },
        data: { text: 'Длинная переписка ' + index + '\n' + 'Строка сообщения. '.repeat(28), clientId: text + '-' + index },
      });
      expect(result.ok()).toBe(true);
    }

    await dean.locator('#header-inbox').click();
    await dean.locator('#dialogues-content button').filter({ hasText: 'Нюша' }).click();
    const receiverRow = dean.locator('.record-row').filter({ hasText: text });
    await expect(receiverRow).not.toBeInViewport();
    await expect(row.getByRole('img', { name: 'Доставлено', exact: true })).toBeVisible({ timeout: 15000 });
    await receiverRow.scrollIntoViewIfNeeded();
    await expect(receiverRow).toBeInViewport();
    await expect(row.getByRole('img', { name: 'Прочитано', exact: true })).toBeVisible({ timeout: 15000 });
    const readReceipt = row.getByRole('img', { name: 'Прочитано', exact: true });
    await expect(readReceipt).toHaveCSS('color', 'rgb(36, 118, 61)');
    await expect(readReceipt.locator('svg path')).toHaveCount(1);
    await expect(dean.locator('#message-text')).toBeInViewport();
    const history = dean.locator('#messages-content');
    const scrollPosition = await history.evaluate((node) => node.scrollTop);
    await composer.fill('Новое сообщение в длинной истории');
    await composer.press('Enter');
    await expect(dean.getByRole('button', { name: 'Новые сообщения' })).toBeVisible({ timeout: 15000 });
    expect(await history.evaluate((node) => node.scrollTop)).toBe(scrollPosition);
    await dean.getByRole('button', { name: 'Новые сообщения' }).click();
    await expect(dean.locator('.record-row').filter({ hasText: 'Новое сообщение в длинной истории' })).toBeInViewport();
    const thread = await (await page.request.get(url)).json();
    expect(thread.messages.filter((message) => message.text === text)).toHaveLength(1);
    await fits(dean);
  } finally {
    await receiver.close();
  }
});

test('message deletion distinguishes delivery from reading and respects ownership', async ({ page, browser, cabinet }) => {
  const recipient = await browser.newContext({ viewport: { width: 360, height: 720 } });
  const outsider = await browser.newContext();
  try {
    const dean = await recipient.newPage();
    const otherStudent = await outsider.newPage();
    await login(page, cabinet);
    await login(dean, cabinet, 'dean');
    await login(otherStudent, cabinet, 'other');

    for (const [asset, mime] of [['styles.css', 'text/css'], ['app.js', 'text/javascript']]) {
      const response = await page.request.get(cabinet.origin + '/' + asset);
      expect(response.status()).toBe(200);
      expect(response.headers()['content-type']).toContain(mime);
    }
    await page.locator('#header-inbox').click();
    const dialogue = page.locator('#dialogues-content button').filter({ hasText: 'Деканат' });
    await dialogue.click();
    const id = (await dialogue.getAttribute('id')).split('-').at(-1);
    const thread = '/api/dialogues/' + id;
    const get = async (client, path) => (await client.get(cabinet.origin + path)).json();
    const post = async (client, path, data, status = 200) => {
      const response = await client.post(cabinet.origin + path, { headers: { Origin: cabinet.origin }, data });
      expect(response.status(), await response.text()).toBe(status);
      return response.json();
    };
    const remove = (client, item, scope, status) => post(client, thread + '/messages/' + item.id + '/delete', { scope }, status);
    const send = async (text) => {
      const outgoing = { text, clientId: randomBytes(12).toString('hex') };
      const { message } = await post(page.request, thread + '/messages', outgoing);
      return { message, outgoing };
    };
    const row = (tab, item) => tab.locator('[data-message-id="' + item.id + '"]');
    const menu = (tab, item) => row(tab, item).getByLabel('Действия сообщения');
    const visibleTo = async (client, item) => (await get(client, thread)).messages.some(({ id }) => id === item.id);
    const previewFor = async (client) => (await get(client, '/api/cabinet')).dialogues.find((dialogue) => dialogue.id === Number(id));

    const { message: delivered, outgoing } = await send('Удалить после доставки');
    await post(dean.request, thread + '/delivered', { messageIds: [delivered.id] });
    await page.evaluate(() => globalThis.document.dispatchEvent(new Event('visibilitychange')));
    await expect(row(page, delivered).getByRole('img', { name: 'Доставлено' })).toBeVisible();
    await remove(dean.request, delivered, 'all', 403);
    await remove(otherStudent.request, delivered, 'self', 404);
    await menu(page, delivered).focus();
    await menu(page, delivered).press('Enter');
    const removeForAll = row(page, delivered).getByRole('button', { name: 'Удалить у всех' });
    await expect(removeForAll).toHaveCSS('min-height', '44px');
    page.once('dialog', (confirmation) => confirmation.accept());
    await removeForAll.click();
    await expect(row(page, delivered)).toHaveCount(0);
    expect(await visibleTo(dean.request, delivered)).toBe(false);
    expect((await previewFor(dean.request)).lastText).not.toBe(outgoing.text);
    await remove(page.request, delivered, 'all');
    await post(page.request, thread + '/messages', outgoing, 410);
    await post(dean.request, thread + '/read', { messageIds: [delivered.id] });

    const { message: read } = await send('Останется у автора после удаления у получателя');
    await dean.locator('#header-inbox').click();
    await dean.locator('#dialogues-content button').filter({ hasText: 'Нюша' }).click();
    await expect.poll(async () => (await get(page.request, thread)).messages.find(({ id }) => id === read.id)?.read).toBe(true);
    await page.evaluate(() => globalThis.document.dispatchEvent(new Event('visibilitychange')));
    await expect(row(page, read).getByRole('img', { name: 'Прочитано' })).toBeVisible();
    await remove(page.request, read, 'all', 409);
    await menu(page, read).click();
    await expect(row(page, read).getByRole('button', { name: 'Удалить у меня' })).toBeVisible();
    await expect(row(page, read).getByRole('button', { name: 'Удалить у всех' })).toHaveCount(0);
    await menu(page, read).press('Escape');
    await expect(menu(page, read)).toBeFocused();
    await menu(dean, read).click();
    await expect(row(dean, read).getByRole('button', { name: 'Удалить у всех' })).toHaveCount(0);
    await row(dean, read).getByRole('button', { name: 'Удалить у меня' }).click();
    await expect(row(dean, read)).toHaveCount(0);
    expect(await visibleTo(dean.request, read)).toBe(false);
    expect(await visibleTo(page.request, read)).toBe(true);
    await fits(dean);
  } finally {
    await outsider.close();
    await recipient.close();
  }
});

for (const width of [360, 440]) {
  test(`teacher chat, grades and ready certificate at ${width} px`, async ({ page, browser, cabinet }) => {
    await page.setViewportSize({ width, height: 800 });
    await login(page, cabinet);
    const data = async (path) => (await page.request.get(cabinet.origin + '/api' + path)).json();
    const post = (client, path, body) => client.post(cabinet.origin + '/api' + path, {
      headers: { Origin: cabinet.origin }, data: body,
    });
    const current = await data('/cabinet');
    const schedule = await data('/schedule');
    const lesson = schedule.lessons.find(({ contact }) => Number.isSafeInteger(contact?.teacherId));
    expect(lesson).toBeDefined();
    const teacher = current.contacts.find(({ teacherId }) => teacherId === lesson.contact.teacherId);
    await page.locator('.mobile-tabs [data-view=schedule]').click();
    await page.locator('#day-picker label').filter({ has: page.locator('input[value="' + lesson.date + '"]') }).click();
    await page.locator('#lesson-' + lesson.id + ' .lesson-link').click();
    const lessonCard = page.locator('#lesson-dialog');
    const write = lessonCard.getByRole('button', { name: 'Написать', exact: true });
    await expect(write).toBeVisible();
    await lessonCard.getByText('Открыть почту', { exact: true }).click();
    const expectedMailto = 'mailto:' + teacher.email;
    await expect(lessonCard.getByRole('link', { name: 'Почтовое приложение' })).toHaveAttribute('href', expectedMailto);
    for (const [label, origin, key, recipient] of [
      ['Gmail', 'https://mail.google.com', 'to', teacher.email],
      ['Почта Mail', 'https://e.mail.ru', 'mailto', expectedMailto],
    ]) {
      await page.context().route(origin + '/**', (route) => route.fulfill({ body: 'Почтовый сервис' }));
      const opened = page.waitForEvent('popup');
      await lessonCard.getByRole('link', { name: label, exact: true }).click();
      const mailTab = await opened;
      await mailTab.waitForLoadState();
      const url = new URL(mailTab.url());
      expect(url.origin).toBe(origin);
      expect(url.searchParams.get(key)).toBe(recipient);
      await mailTab.close();
    }
    await write.click();
    await expect(lessonCard).toBeHidden();
    await expect(page.locator('#dialogue-heading')).toHaveText(teacher.name);
    await expect(page.locator('#message-text')).toBeVisible();
    await expect(page.locator('#dialogues-content')).toBeHidden();
    await fits(page);
    await page.getByRole('button', { name: 'Назад к диалогам' }).click();
    await expect(page.locator('#dialogues-content')).toBeVisible();

    const menu = page.locator('.mobile-tabs [data-view=menu]');
    await menu.click();
    await expandGroup(page.locator('#mobile-nav'), 'Кампус');
    await page.locator('#view-menu').getByRole('link', { name: 'Контакты', exact: true }).click();
    const contacts = page.locator('#contacts-content .contact-card');
    const linked = contacts.filter({ has: page.getByRole('heading', { name: teacher.name, exact: true }) });
    const sinistra = contacts.filter({ has: page.getByRole('heading', { name: 'Аврора Синистра', exact: true }) });
    await expect(sinistra).toHaveCount(1);
    await sinistra.getByRole('button', { name: 'Написать', exact: true }).click();
    await expect(page.locator('#dialogue-heading')).toHaveText('Аврора Синистра');
    await menu.click();
    await page.locator('#view-menu').getByRole('link', { name: 'Контакты', exact: true }).click();
    const deanCard = contacts.filter({ has: page.getByRole('heading', { name: 'Деканат', exact: true }) });
    await deanCard.getByRole('button', { name: 'Написать', exact: true }).click();
    await expect(page.locator('#dialogue-heading')).toHaveText('Деканат');
    await menu.click();
    await page.locator('#view-menu').getByRole('link', { name: 'Контакты', exact: true }).click();
    await linked.getByRole('button', { name: 'Написать', exact: true }).click();
    await expect(page.locator('#dialogue-heading')).toHaveText(teacher.name);
    expect((await data('/cabinet')).dialogues.filter(({ fullName }) => fullName === teacher.name)).toHaveLength(1);

    await menu.click();
    await expandGroup(page.locator('#mobile-nav'), 'Учёба');
    await page.locator('#view-menu').getByRole('link', { name: 'Успеваемость', exact: true }).click();
    await expect(page.getByRole('combobox', { name: 'Семестр' })).toHaveCount(0);
    const currentSemester = page.locator('#grade-semester-2');
    const previous = page.locator('#grade-semester-1');
    await expect(currentSemester).toHaveJSProperty('open', true);
    await expect(previous).toHaveJSProperty('open', false);
    const subject = currentSemester.locator('details.grade').filter({ hasText: 'Зельеварение' });
    const summary = subject.locator(':scope > summary');
    await expect(summary).toContainText('48 / 100');
    await expect(subject.getByText('Экзамен', { exact: true })).toBeVisible();
    await subject.getByText('Из чего складываются баллы', { exact: true }).click();
    await expect(subject).toContainText('36 / 40');
    await expect(subject).toContainText('12 / 15');
    await expect(subject.getByRole('link', { name: 'Разбор рецепта' }).first()).toBeVisible();
    await fits(page);
    const previousGrade = previous.locator('details.grade').filter({ hasText: 'Зельеварение' });
    const previousId = await previousGrade.getAttribute('id');
    await page.evaluate((id) => { globalThis.location.hash = '#grades/' + id; }, previousId);
    await expect(previous).toHaveJSProperty('open', true);
    await expect(previousGrade).toHaveJSProperty('open', true);
    await expect(previousGrade.getByText(/^(Отлично|Хорошо)$/)).toBeVisible();
    await expect(currentSemester).toHaveJSProperty('open', true);

    const submitted = await post(page.request, '/requests', { type: 'Справка об обучении' });
    expect(submitted.ok()).toBe(true);
    const request = (await data('/cabinet')).requests[0];
    const dean = await browser.newContext();
    try {
      const deanPage = await dean.newPage();
      await login(deanPage, cabinet, 'dean');
      const status = await post(deanPage.request, '/requests/' + request.id + '/status', { status: 'ready', note: '' });
      expect(status.ok()).toBe(true);
    } finally {
      await dean.close();
    }
    await menu.click();
    await expandGroup(page.locator('#mobile-nav'), 'Сервисы');
    await page.locator('#view-menu').getByRole('link', { name: 'Справки и документы', exact: true }).click();
    const ready = page.locator('#request-' + request.id);
    await ready.locator('summary').click();
    const downloadPromise = page.waitForEvent('download');
    await ready.getByRole('link', { name: 'Скачать PDF' }).click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toBe('certificate-' + request.id + '.pdf');
    if (width === 360) await download.saveAs('test-results/certificate-download.pdf');
    await page.context().addInitScript(() => {
      globalThis.print = () => { globalThis.document.documentElement.dataset.printRequested = 'true'; };
    });
    const [print] = await Promise.all([
      page.waitForEvent('popup'),
      ready.getByRole('link', { name: 'Печать', exact: true }).click(),
    ]);
    await expect(print.locator('html')).toHaveAttribute('data-print-requested', 'true');
    await expect(print.getByRole('heading', { name: request.type })).toBeVisible();
    await expect(print.locator('main')).toContainText('Демонстрационный документ. Не является официальной справкой');
    await expect(print.locator('main')).toContainText('Нюша Мироновна Романова');
    await expect(print.locator('nav, button, a, dialog')).toHaveCount(0);
    await print.emulateMedia({ media: 'print' });
    if (width === 360) {
      await print.screenshot({ path: 'test-results/certificate-print.png' });
      const printed = await print.pdf({ path: 'test-results/certificate-print.pdf', preferCSSPageSize: true });
      expect(printed.toString('latin1')).toMatch(/MediaBox \[0 0 59[45]\.\d+ 84[12]\.\d+\]/);
    }
    await print.close();
    await fits(page);
  });
}

test('composer handles Enter and Shift+Enter; helper routes known and unknown queries', async ({ page, cabinet }) => {
  await login(page, cabinet);
  await page.locator('#header-inbox').click();
  await page.getByRole('button', { name: /Деканат/ }).click();
  const composer = page.getByRole('textbox', { name: 'Сообщение', exact: true });
  const first = 'Проверка Enter';
  const second = 'Новая строка';
  const isMessagePost = (request) => /\/dialogues\/\d+\/messages$/.test(request.url()) && request.method() === 'POST';
  let postedMessages = 0;
  page.on('request', (request) => {
    if (isMessagePost(request)) postedMessages++;
  });
  await composer.fill(first);
  await composer.press('Shift+Enter');
  await expect(composer).toHaveValue(first + '\n');
  expect(postedMessages).toBe(0);
  await composer.pressSequentially(second);
  const sent = page.waitForResponse((response) => isMessagePost(response.request()));
  await composer.press('Enter');
  expect((await sent).ok()).toBe(true);
  await expect(page.locator('.message-mine .record-copy').filter({ hasText: first })).toHaveCount(1);
  await expect(page.locator('.message-mine .record-copy').filter({ hasText: first })).toHaveJSProperty('textContent', first + '\n' + second);
  await expect(composer).toHaveValue('');

  await page.locator('.sidebar [data-view="home"]').click();
  await page.locator('#help-launcher').click();
  const question = page.getByRole('combobox', { name: 'Вопрос о кабинете' });
  const answer = page.locator('#help-answer');
  await question.fill('Как получить справку об обучении?');
  await question.press('Enter');
  await expect(answer.getByRole('heading', { name: 'Справка об обучении' })).toBeVisible();
  await expect(answer.getByRole('link')).toHaveAttribute('href', '#requests/document-enrollment');
  await question.fill('Как вырастить герань?');
  await question.press('Enter');
  await expect(answer.getByRole('heading', { name: 'Ответа пока нет' })).toBeVisible();
  await expect(answer.getByRole('link', { name: 'Написать в деканат' })).toHaveAttribute('href', '#messages');
  expect(postedMessages).toBe(1);
});

test('dean navigation and library access', async ({ page, cabinet }) => {
  await login(page, cabinet, 'dean');
  const nav = page.locator('.sidebar nav');
  await expect(page.locator('#sidebar-initials')).toHaveText('ИЯ');
  await expandGroup(nav, 'Сервисы');
  await expandGroup(nav, 'Учёба');
  await expect(nav.getByRole('link', { name: 'Справки и документы' })).toBeVisible();
  await expect(nav.getByRole('link', { name: 'Расписание' })).toHaveCount(0);
  await nav.getByRole('link', { name: 'Библиотека' }).click();
  await expect(page.getByRole('heading', { name: 'Библиотека', exact: true })).toBeVisible();
  await expect(page.getByText('Архив звёздных карт', { exact: true })).toBeVisible();
});

test('library searches titles and authors, filters disciplines and remembers a favorite', async ({ page, cabinet }) => {
  await login(page, cabinet);
  await expandGroup(page.locator('.sidebar nav'), 'Учёба');
  await page.locator('.sidebar nav').getByRole('link', { name: 'Библиотека' }).click();
  const query = page.locator('#library-query');
  const books = page.locator('#library-results');
  await query.fill('Архив');
  await expect(books.getByText('Архив звёздных карт', { exact: true })).toBeVisible();
  await query.fill('Лучина');
  await expect(books.getByText('Архив звёздных карт', { exact: true })).toBeVisible();
  await expect(books.getByText('Теплица под стеклом', { exact: true })).toHaveCount(0);
  await page.locator('#library-subject').selectOption({ label: 'Травология' });
  await expect(books.getByText('По вашему запросу ничего не найдено')).toBeVisible();
  await page.locator('#library-subject').selectOption({ label: 'Астрономия' });
  await books.getByRole('button', { name: 'В избранное: Архив звёздных карт' }).click();
  await expect(books.getByRole('button', { name: 'Убрать из избранного: Архив звёздных карт' })).toHaveAttribute('aria-pressed', 'true');
  await page.reload();
  await page.locator('#library-favorites').check();
  await expect(books.getByText('Архив звёздных карт', { exact: true })).toBeVisible();
  await expect(books.getByText('Наблюдения за ночным небом', { exact: true })).toHaveCount(0);
});

for (const [label, width, height] of [['desktop', 1440, 980], ['360', 360, 800], ['440', 440, 800]]) {
  test(`glass surfaces and assistant at ${label}`, async ({ page, cabinet }) => {
    await page.setViewportSize({ width, height });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await login(page, cabinet);
    await expect(page.getByRole('heading', { name: 'Учебная неделя' })).toBeVisible();
    await fits(page);
    await page.screenshot({ path: `test-results/glass/home-${label}.png`, animations: 'disabled' });

    const mainWidth = (await page.locator('.workspace').boundingBox()).width;
    const launcher = page.locator('#help-launcher');
    await launcher.focus();
    await page.keyboard.press('Enter');
    const dialog = page.locator('#help-dialog');
    const input = dialog.getByRole('combobox', { name: 'Вопрос о кабинете' });
    await expect(dialog).toBeVisible();
    await expect(input).toBeInViewport();
    await expect(dialog.getByRole('button', { name: 'Отправить сообщение' })).toBeDisabled();
    for (const name of ['Закрыть помощника', 'Отправить сообщение']) {
      const control = await dialog.getByRole('button', { name }).boundingBox();
      expect(control.width).toBeGreaterThanOrEqual(44);
      expect(control.height).toBeGreaterThanOrEqual(44);
    }
    await expect(dialog.getByRole('button', { name: 'Отправить сообщение' })).toBeInViewport();
    const { backdrop, box } = await dialog.evaluate((element) => {
      const window = element.ownerDocument.defaultView;
      const bounds = element.getBoundingClientRect();
      return {
        backdrop: window.getComputedStyle(element, '::backdrop').backgroundColor,
        box: { left: bounds.left, top: bounds.top, right: bounds.right, bottom: bounds.bottom },
      };
    });
    expect(backdrop).toBe('rgba(0, 0, 0, 0)');
    expect(box.left).toBeGreaterThanOrEqual(0);
    expect(box.top).toBeGreaterThanOrEqual(0);
    expect(box.right).toBeLessThanOrEqual(width);
    expect(box.bottom).toBeLessThanOrEqual(height);
    expect(box.bottom - box.top).toBeLessThanOrEqual(480);
    expect(box.top).toBeGreaterThan(height / 3);
    expect((await page.locator('.workspace').boundingBox()).width).toBeCloseTo(mainWidth, 0);
    await page.keyboard.press('Tab');
    await expect(dialog.getByRole('button', { name: 'Закрыть помощника' })).toBeFocused();
    await expect(dialog.getByRole('button', { name: 'Закрыть помощника' })).toHaveCSS('outline-style', 'solid');
    await page.screenshot({ path: `test-results/glass/helper-${label}.png`, animations: 'disabled' });
    await page.keyboard.press('Shift+Tab');
    await expect(launcher).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(dialog.getByRole('button', { name: 'Закрыть помощника' })).toBeFocused();
    const options = dialog.getByRole('option');
    for (const value of ['сп', 'справ', 'статус справ']) {
      await input.fill(value);
      await expect(options.first()).toBeVisible();
      expect(await options.count()).toBeLessThanOrEqual(4);
      if (value === 'сп' || value === 'справ') {
        for (const item of await options.allTextContents()) expect(item).toMatch(/справк|статус заявки/i);
      }
      if (value === 'статус справ') {
        await expect(options).toHaveCount(1);
        await expect(options.first()).toContainText(/статус/i);
      }
    }
    for (const value of ['', 'ъ', 'зюзюкалка']) {
      await input.fill(value);
      await expect(options).toHaveCount(0);
    }
    for (const [letter, pattern] of [['Г', /(?:^|\s)г/iu], ['р', /(?:^|\s)р/iu]]) {
      await input.fill(letter);
      await expect(options.first()).toBeVisible();
      for (const item of await options.allTextContents()) expect(item).toMatch(pattern);
    }
    await expect(dialog.getByRole('option', { name: 'Где посмотреть расписание?' })).toBeVisible();
    await input.fill('ра');
    await expect(options.first()).toContainText(/расписан/i);
    for (const item of await options.allTextContents()) expect(item).toMatch(/(?:^|\s)ра/i);
    await expect(dialog.getByRole('option', { name: 'Где найти задания?' })).toHaveCount(0);
    await input.fill('расп');
    await expect(options.first()).toContainText(/расписан/i);
    for (const item of await options.allTextContents()) expect(item).toMatch(/расписан/i);
    await input.press('Escape');
    await expect(options).toHaveCount(0);
    await expect(dialog).toBeVisible();
    await input.fill('спарвка');
    await expect(options.first()).toContainText(/справк/i);
    let questions = 0;
    page.on('request', (request) => {
      if (new URL(request.url()).pathname === '/api/help' && new URL(request.url()).searchParams.has('q')) questions++;
    });
    await input.press('ArrowDown');
    await expect(input).toHaveAttribute('aria-activedescendant', 'help-option-0');
    const chosen = await options.first().textContent();
    await input.press('Enter');
    await expect(dialog.locator('.help-question')).toHaveText(chosen);
    expect(questions).toBe(1);
    await page.screenshot({ path: `test-results/glass/helper-${label}.png`, animations: 'disabled' });
    await input.fill('Черновик вопроса');
    expect(await dialog.evaluate((node) => node.matches(':modal'))).toBe(false);
    const initialScroll = await page.evaluate(() => globalThis.scrollY);
    await page.mouse.move(width > 1100 ? 350 : 30, 180);
    await page.mouse.wheel(0, 350);
    await expect.poll(() => page.evaluate(() => globalThis.scrollY)).toBeGreaterThan(initialScroll);
    for (const name of ['Главная', 'Успеваемость', 'Расписание', 'Справки и документы', 'Библиотека', 'Главная']) {
      const tabs = page.locator('.mobile-tabs');
      const mainTab = ['Главная', 'Расписание'].includes(name);
      const navigation = width > 680 ? page.locator('.sidebar nav') : mainTab ? tabs : page.locator('#mobile-nav');
      if (width <= 680 && !mainTab) {
        await tabs.getByRole('link', { name: 'Меню' }).click();
        await expect(dialog).toBeHidden();
      }
      if (name !== 'Главная' && (width > 680 || !mainTab)) {
        // Opening a disclosure leaves an open helper alone.
        await expandGroup(navigation, name === 'Справки и документы' ? 'Сервисы' : 'Учёба');
      }
      await navigation.getByRole('link', { name, exact: true }).click();
      await expect(page.locator('#page-heading')).toHaveText(name);
      await expect(dialog).toBeHidden();
      await expect(page.locator('#page-heading')).toBeFocused();
      await expect(page.locator('#page-heading')).toHaveCSS('outline-style', 'none');
      await launcher.click();
      await expect(input).toHaveValue('Черновик вопроса');
      await expect(dialog.locator('.help-question')).toHaveText(chosen);
      await fits(page);
    }
    await page.locator('#page-heading').focus();
    await page.keyboard.press('Escape');
    await expect(dialog).toBeVisible();
    await input.focus();
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(launcher).toBeFocused();
  });
}

test('appeal withdrawal uses one click and keeps the grade, including on failure', async ({ page, cabinet }) => {
  await login(page, cabinet);
  const snapshot = async () => (await page.request.get(cabinet.origin + '/api/cabinet')).json();
  const before = await snapshot();
  const graded = before.assignments.find(({ submission }) => submission?.status === 'reviewed');
  const created = await page.request.post(cabinet.origin + '/api/submissions/' + graded.submission.id + '/appeal', {
    headers: { Origin: cabinet.origin }, data: { reason: 'Проверка отзыва' },
  });
  expect(created.ok()).toBe(true);
  const appeal = (await snapshot()).appeals.find(({ submissionId }) => submissionId === graded.submission.id);
  await page.reload();
  await expandGroup(page.locator('.sidebar nav'), 'Учёба');
  await page.locator('.sidebar nav').getByRole('link', { name: 'Задания' }).click();
  const card = page.locator('#appeal-' + appeal.id);
  await card.locator('summary').click();
  const withdraw = card.getByRole('button', { name: 'Отозвать', exact: true });
  let dialogs = 0;
  page.on('dialog', async (dialog) => { dialogs++; await dialog.dismiss(); });
  const url = '**/api/appeals/' + appeal.id + '/withdraw';
  const reject = (route) => route.fulfill({ status: 503, json: { error: 'Не удалось отозвать.' } });
  await page.route(url, reject);
  await withdraw.click();
  await expect(card.getByRole('alert')).toHaveText('Не удалось отозвать.');
  await expect(card.locator('summary')).not.toContainText('Отозвано');
  expect((await snapshot()).appeals.find(({ id }) => id === appeal.id).status).toBe('pending');
  await page.unroute(url, reject);

  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let requests = 0;
  await page.route(url, async (route) => {
    requests++;
    await gate;
    await route.continue();
  });
  try {
    await withdraw.click();
    await expect(withdraw).toBeDisabled();
  } finally {
    release();
  }
  await expect(card.locator('summary')).toContainText('Отозвано');
  expect(dialogs).toBe(0);
  expect(requests).toBe(1);
  const after = await snapshot();
  expect(after.appeals.find(({ id }) => id === appeal.id).history.at(-1).status).toBe('withdrawn');
  expect(after.assignments.find(({ id }) => id === graded.id).submission.points).toBe(graded.submission.points);
  expect(after.grades).toEqual(before.grades);
});

test('assistant icon controls respond to touch and navigation actions preserve history', async ({ browser, cabinet }) => {
  const context = await browser.newContext({ viewport: { width: 360, height: 800 }, hasTouch: true });
  try {
    const page = await context.newPage();
    await login(page, cabinet);
    const launcher = page.locator('#help-launcher');
    const dialog = page.locator('#help-dialog');
    const input = page.locator('#help-query');
    await expect(page.locator('#header-inbox')).toHaveAccessibleName(/Сообщения, непрочитанных: \d+/);
    await launcher.tap();
    await input.fill('Где расписание?');
    await dialog.getByRole('button', { name: 'Отправить сообщение' }).tap();
    await expect(dialog.locator('.help-question')).toHaveText('Где расписание?');
    await dialog.getByRole('link', { name: /Расписание/ }).tap();
    await expect(dialog).toBeHidden();
    await expect(page.locator('#page-heading')).toHaveText('Расписание');
    await launcher.tap();
    await expect(dialog.locator('.help-question')).toHaveText('Где расписание?');
    await page.locator('#search-query').fill('Библиотека');
    await page.locator('#search-results').getByRole('link', { name: /Библиотека/ }).tap();
    await expect(dialog).toBeHidden();
    await expect(page.locator('#page-heading')).toHaveText('Библиотека');
    await launcher.tap();
    await dialog.getByRole('button', { name: 'Закрыть помощника' }).tap();
    await expect(dialog).toBeHidden();
    await expect(launcher).toBeFocused();
  } finally {
    await context.close();
  }
});

for (const [width, height] of [[768, 1024], [1024, 768], [1440, 980]]) {
  test(`sidebar tablet and desktop at ${width}×${height}`, async ({ page, cabinet }) => {
    await page.setViewportSize({ width, height });
    await login(page, cabinet);
    const nav = page.locator('.sidebar nav');
    await expect(nav).toBeVisible();
    await expect(page.locator('.mobile-tabs')).toBeHidden();
    await expect(page.locator('#sidebar-name')).toHaveJSProperty('innerText', 'Нюша\nМироновна\nРоманова');
    await expect(page.locator('.sidebar').getByRole('button', { name: 'Выйти', exact: true })).toBeVisible();
    await expandGroup(nav, 'Учёба');
    await expandGroup(nav, 'Сервисы');
    await expect(nav.getByRole('link', { name: 'Расписание' })).toBeVisible();
    await expect(page.locator('#header-inbox')).toBeVisible();
    const heading = page.locator('#page-heading');
    await nav.getByRole('link', { name: 'Успеваемость' }).click();
    await expect(page.locator('.grade-stats')).toContainText('Средний балл');
    await expect(page.locator('#grade-semester-2')).toHaveJSProperty('open', true);
    const previous = page.locator('#grade-semester-1');
    await expect(previous).toHaveJSProperty('open', false);
    await fits(page);
    if (width === 1440) {
      await page.screenshot({ path: 'test-results/screenshots/grades-1440.png', animations: 'disabled' });
    }
    await previous.locator(':scope > summary').click();
    await expect(previous).toHaveJSProperty('open', true);
    for (const [view, name, selector] of [['schedule', 'Расписание', '#week-grid'], ['requests', 'Справки и документы', '#document-enrollment'], ['messages', 'Сообщения', '#dialogues-content']]) {
      await nav.locator('[data-view="' + view + '"]').click();
      await expect(heading).toHaveText(name);
      await expect(page.locator(selector)).toBeVisible();
      await expect(page.locator('#header-inbox')).toBeHidden();
      if (view === 'schedule') {
        await expect(nav.locator('[data-view="schedule"]')).toHaveCSS('caret-color', 'rgba(0, 0, 0, 0)');
        await expect(page.locator('.search-submit')).toHaveCSS('caret-color', 'rgba(0, 0, 0, 0)');
        const search = page.locator('#search-query');
        await expect(search).not.toHaveCSS('caret-color', 'rgba(0, 0, 0, 0)');
        await page.locator('.search-field').click({ position: { x: 1, y: 20 } });
        await expect(page.locator('.search-submit')).toBeFocused();
        await expect(search).not.toBeFocused();
        await expect(heading).toHaveCSS('caret-color', 'rgba(0, 0, 0, 0)');
        await heading.dblclick();
        await expect.poll(() => page.evaluate(() => globalThis.getSelection().toString())).toBe('Расписание');
      }
      await fits(page);
    }
    await page.getByRole('button', { name: /Деканат/ }).click();
    await expect(page.locator('#message-text')).toBeVisible();
    await expect(page.locator('#message-text')).not.toHaveCSS('caret-color', 'rgba(0, 0, 0, 0)');
    await fits(page);
    await nav.getByRole('link', { name: 'Главная' }).click();
    await page.screenshot({ path: `test-results/screenshots/home-${width}.png`, animations: 'disabled' });
  });
}

test('mobile and sidebar navigation do not duplicate at the transition', async ({ page, cabinet }) => {
  await page.setViewportSize({ width: 680, height: 760 });
  await login(page, cabinet);
  await expect(page.locator('.mobile-tabs')).toBeVisible();
  await page.locator('.mobile-tabs').getByRole('link', { name: 'Меню' }).click();
  await page.setViewportSize({ width: 681, height: 760 });
  await expect(page.locator('.mobile-tabs')).toBeHidden();
  await expect(page.locator('.sidebar nav')).toBeVisible();
  await expect(page.locator('#view-menu')).toBeHidden();
  await fits(page);
});

for (const [role, unavailable] of [['teacher', 'Справки и документы'], ['dean', 'Успеваемость']]) {
  test(`mobile navigation respects ${role} role`, async ({ page, cabinet }) => {
    await page.setViewportSize({ width: 390, height: 650 });
    await login(page, cabinet, role);
    const tabs = page.locator('.mobile-tabs');
    await expect(tabs.getByRole('link', { name: 'Расписание' })).toHaveCount(0);
    await tabs.getByRole('link', { name: 'Меню' }).click();
    await expandGroup(page.locator('#mobile-nav'), 'Учёба');
    await expandGroup(page.locator('#mobile-nav'), 'Сервисы');
    await expect(page.locator('#mobile-nav').getByRole('link', { name: unavailable })).toHaveCount(0);
    await expect(page.locator('#mobile-nav').getByRole('link', { name: 'Библиотека' })).toBeVisible();
    await fits(page);
  });
}

test('Chromium loads and applies both responsive stylesheets', async ({ page, cabinet }) => {
  const assets = ['/mobile.css', '/desktop-tablet.css'];
  const responses = assets.map((path) => page.waitForResponse((response) => new URL(response.url()).pathname === path));
  await page.setViewportSize({ width: 390, height: 760 });
  await login(page, cabinet);
  for (const response of await Promise.all(responses)) {
    expect(response.status()).toBe(200);
    expect(response.headers()['content-type']).toMatch(/^text\/css(?:;|$)/i);
  }
  const loaded = await page.evaluate(() => [...globalThis.document.styleSheets]
    .filter((sheet) => sheet.href && sheet.cssRules.length)
    .map((sheet) => new URL(sheet.href).pathname));
  expect(loaded).toEqual(expect.arrayContaining(assets));
  await expect(page.locator('.mobile-tabs')).toHaveCSS('position', 'fixed');
  await page.setViewportSize({ width: 768, height: 1024 });
  await expect(page.locator('.sidebar')).toHaveCSS('width', '164px');
  await expect(page.locator('.mobile-tabs')).toBeHidden();
});

test('mobile menu back restores the original link and scroll position', async ({ page, cabinet }) => {
  await page.setViewportSize({ width: 360, height: 500 });
  await login(page, cabinet);
  const tabs = page.locator('.mobile-tabs');
  const menu = page.locator('#mobile-nav');
  const back = page.getByRole('link', { name: 'Назад в меню' });
  const heading = page.locator('#page-heading');
  const scroll = () => page.evaluate(() => globalThis.scrollY);
  await tabs.getByRole('link', { name: 'Расписание' }).click();
  await expect(heading).toHaveText('Расписание');
  await expect(back).toBeHidden();
  await tabs.getByRole('link', { name: 'Меню' }).click();
  for (const group of ['Учёба', 'Сервисы', 'Кампус']) await expandGroup(menu, group);

  for (const name of ['Расписание', 'Библиотека']) {
    const source = menu.getByRole('link', { name, exact: true });
    await source.focus();
    await page.evaluate(() => globalThis.scrollTo(0, 140));
    const position = await scroll();
    expect(position).toBeGreaterThan(0);
    await source.press('Enter');
    await expect(heading).toHaveText(name);
    await expect(back).toBeVisible();
    await expect(back).toHaveCSS('width', '44px');
    await back.press('Enter');
    await expect(heading).toHaveText('Меню');
    await expect(back).toBeHidden();
    await expect(source).toBeFocused();
    expect(await scroll()).toBe(position);
  }
  await page.goForward();
  await expect(heading).toHaveText('Библиотека');
  await expect(back).toBeVisible();
  await page.setViewportSize({ width: 768, height: 800 });
  await expect(back).toBeHidden();
});

for (const width of [360, 440, 768, 1440]) {
  test(`navigation disclosures and lesson dismissal at ${width} px`, async ({ page, cabinet }) => {
    const mobile = width < 681;
    await page.setViewportSize({ width, height: 800 });
    await login(page, cabinet);
    const tabs = page.locator('.mobile-tabs');
    const nav = mobile ? page.locator('#mobile-nav') : page.locator('.sidebar nav');
    if (mobile) await tabs.getByRole('link', { name: 'Меню' }).click();
    const groups = ['Учёба', 'Сервисы', 'Кампус'].map((name) => nav.getByRole('button', { name, exact: true }));
    for (const group of groups) {
      await expect(group).toHaveAttribute('aria-expanded', 'false');
      await expect(group).toHaveCSS('cursor', 'pointer');
    }
    await page.screenshot({ path: `test-results/navigation/closed-${width}.png` });
    await groups[0].focus();
    await page.keyboard.press('Tab');
    await expect(groups[1]).toBeFocused();
    await expect(groups[1]).toHaveCSS('outline-style', 'solid');
    const hash = new URL(page.url()).hash;
    for (const group of groups) {
      await group.click();
      await expect(group).toHaveAttribute('aria-expanded', 'true');
    }
    expect(new URL(page.url()).hash).toBe(hash);
    await page.screenshot({ path: `test-results/navigation/open-${width}.png` });
    for (const group of groups) {
      await group.focus();
      await page.keyboard.press('Space');
      await expect(group).toHaveAttribute('aria-expanded', 'false');
      await page.keyboard.press('Enter');
      await expect(group).toHaveAttribute('aria-expanded', 'true');
    }
    const profile = mobile ? tabs.getByRole('link', { name: 'Профиль' }) : page.locator('.sidebar-profile');
    await groups[0].click();
    await expect(groups[0]).toHaveAttribute('aria-expanded', 'false');
    await profile.click();
    await expect(profile).toHaveAttribute('aria-current', 'page');
    await page.goto(cabinet.origin + '/#schedule');
    await expect(nav.getByRole('button', { name: 'Учёба', includeHidden: true })).toHaveAttribute('aria-expanded', 'true');
    await expect(nav.locator('[data-view=schedule]')).toHaveAttribute('aria-current', 'page');

    await expect(page.locator('#week-schedule')).toBeVisible();
    const firstDay = page.locator('#day-picker label').first();
    if (await firstDay.isVisible()) await firstDay.click();
    const lesson = page.locator('#week-grid .lesson-link:visible').first();
    const dialog = page.locator('#lesson-dialog');
    for (const action of ['button', 'Escape', 'outside']) {
      await lesson.scrollIntoViewIfNeeded();
      const position = await page.evaluate(() => globalThis.scrollY);
      await lesson.click();
      await expect(dialog.locator('.lesson-details')).toBeVisible();
      await dialog.locator('h2').dblclick();
      await expect(dialog).toBeVisible();
      if (action === 'button') {
        await dialog.getByRole('button', { name: /^Скопировать почту/ }).click();
        await expect(dialog).toBeVisible();
      }
      const url = page.url();
      if (action === 'button') await dialog.getByRole('button', { name: 'Закрыть' }).click();
      if (action === 'Escape') await page.keyboard.press('Escape');
      if (action === 'outside') {
        const target = await profile.boundingBox();
        const x = target.x + target.width / 2;
        const y = target.y + target.height / 2;
        if (width === 440) {
          const touch = await page.context().newCDPSession(page);
          await touch.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 });
          await touch.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
          await touch.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
          await touch.detach();
        } else {
          await page.mouse.click(x, y);
        }
      }
      await expect(dialog).toBeHidden();
      await expect(lesson).toBeFocused();
      expect(await page.evaluate(() => globalThis.scrollY)).toBe(position);
      expect(page.url()).toBe(url);
    }
    const query = page.getByRole('searchbox', { name: 'Поиск по кабинету' });
    await query.fill('расп');
    await expect(page.locator('#search-results')).toContainText('Расписание');
    await fits(page);
  });
}

for (const width of [360, 440]) {
  test(`student portfolio and PDF at ${width} px`, async ({ page, browser, cabinet }) => {
    await page.setViewportSize({ width, height: 760 });
    await login(page, cabinet);
    await page.locator('.mobile-tabs [data-view=profile]').click();
    const portfolio = page.locator('#portfolio');
    await expect(portfolio.getByRole('heading', { name: 'Моё портфолио' })).toBeVisible();
    await portfolio.getByText('Добавить достижение', { exact: true }).click();
    const title = 'Демонстрационная обсерватория ' + width;
    const achievement = portfolio.locator('#portfolio-new-achievement');
    await achievement.locator('[name=title]').fill(title);
    await achievement.locator('[name=category]').selectOption('projects');
    await achievement.locator('[name=date]').fill('2026-10-20');
    await achievement.locator('[name=description]').fill('Проект учебной модели.');
    await achievement.locator('[name=organizer]').fill('Демо-кружок');
    await achievement.locator('button[type=submit]').click();
    const item = portfolio.locator('details[id^="portfolio-achievement-"]').filter({ hasText: title }).first();
    await expect(item).toBeVisible();
    await item.getByText('Прикрепить файл', { exact: true }).click();
    const file = item.locator('input[type=file]');
    await file.setInputFiles({
      name: 'demo.png', mimeType: 'image/png',
      buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==', 'base64'),
    });
    await item.locator('form[id^="portfolio-achievement-file-"] button[type=submit]').click();
    await expect(item.getByRole('link', { name: /demo.png/ })).toBeVisible();
    const submit = item.locator('form[id^="portfolio-achievement-submit-"]');
    await submit.locator('[name=reviewerId]').selectOption({ label: 'Северус Снегг' });
    await submit.locator('button[type=submit]').click();
    await expect(item.locator(':scope > summary')).toContainText('На проверке');
    const id = (await item.getAttribute('id')).split('-').at(-1);
    const exportPanel = portfolio.locator('#portfolio-export');
    await exportPanel.locator('#portfolio-export-achievement-' + id).check();
    const downloadEvent = page.waitForEvent('download');
    await exportPanel.locator('#portfolio-pdf').click();
    const download = await downloadEvent;
    expect(download.suggestedFilename()).toMatch(/\.pdf$/);
    if (width === 360) {
      await download.saveAs('test-results/portfolio-360.pdf');
      await page.context().addInitScript(() => { globalThis.print = () => {}; });
      const [print] = await Promise.all([page.waitForEvent('popup'), exportPanel.locator('#portfolio-print').click()]);
      await expect(print.locator('main')).toContainText('Статус подтверждения: На проверке');
      await expect(print.locator('nav, button, dialog')).toHaveCount(0);
      await print.close();
    }
    await portfolio.getByText('Запросить рекомендацию', { exact: true }).first().click();
    const recommendation = portfolio.locator('#portfolio-new-recommendation');
    const goal = 'Демонстрационный исследовательский отбор ' + width;
    await recommendation.locator('[name=teacherId]').selectOption({ label: 'Северус Снегг' });
    await recommendation.locator('[name=goal]').fill(goal);
    await recommendation.locator('[name=context]').fill('Учебный макет обсерватории');
    await recommendation.locator('[name=deadline]').fill(new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10));
    await recommendation.locator('button[type=submit]').click();
    const studentRequest = portfolio.locator('#portfolio-recommendation-list details').filter({ hasText: goal }).first();
    await expect(studentRequest).toBeVisible();
    if (width === 360) {
      const teacher = await browser.newContext({ viewport: { width, height: 760 } });
      try {
        const staff = await teacher.newPage();
        await login(staff, cabinet, 'teacher');
        await staff.locator('.mobile-tabs [data-view=profile]').click();
        const pending = staff.locator('#portfolio-recommendation-list details').filter({ hasText: goal }).first();
        await pending.locator(':scope > summary').click();
        const review = pending.locator('form[id^=portfolio-recommendation-review]');
        await review.locator('[name=status]').selectOption('accepted');
        await review.locator('button[type=submit]').click();
        await pending.getByText('Черновик рекомендации', { exact: true }).click();
        const draft = pending.locator('form[id^=portfolio-recommendation-draft]');
        await draft.locator('[name=text]').fill('Подготовила демонстрационную модель.');
        await draft.locator('button[type=submit]').click();
        await pending.getByRole('button', { name: 'Опубликовать рекомендацию', exact: true }).click();
        await expect(pending.getByText('Подготовила демонстрационную модель.', { exact: true })).toBeVisible();
        await page.locator('#portfolio-refresh').click();
        await expect(studentRequest.locator(':scope > summary')).toContainText('Опубликована');
        await fits(staff);
      } finally {
        await teacher.close();
      }
    }
    await fits(page);
  });
}
