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
        DEMO_PASSWORD_1: student, DEMO_PASSWORD_2: other, DEMO_PASSWORD_TEACHER: teacher, DEMO_PASSWORD_DEAN: dean,
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
  await page.getByLabel('Логин', { exact: true }).fill({ student: 'student1', other: 'student2', teacher: 'teacher1', dean: 'dean1' }[role]);
  await page.getByLabel('Пароль', { exact: true }).fill(cabinet[role]);
  await page.getByRole('button', { name: 'Войти', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Главная', exact: true })).toBeVisible();
}

async function fits(page) {
  expect(await page.evaluate(() => globalThis.document.documentElement.scrollWidth)).toBeLessThanOrEqual(page.viewportSize().width);
}

async function capture(page, name) {
  await page.screenshot({ path: `test-results/screenshots/${name}-360.png`, animations: 'disabled' });
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
    await expect(menu.getByRole('link', { name: 'Справки и документы' })).toBeVisible();
    if (width === 360) await capture(page, 'menu');
    await menu.getByRole('button', { name: 'Выйти' }).scrollIntoViewIfNeeded();
    await expect(menu.getByRole('button', { name: 'Выйти' })).toBeInViewport();
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
  });
}

test('teacher login and role-specific navigation', async ({ page, cabinet }) => {
  await login(page, cabinet, 'teacher');
  const navigation = page.locator('.sidebar nav');
  await expect(page.locator('#sidebar-initials')).toHaveText('МЛ');
  await expect(navigation.getByRole('link', { name: 'Задания' })).toBeVisible();
  await expect(navigation.getByRole('link', { name: 'Справки и документы' })).toHaveCount(0);
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
    await page.locator('#header-inbox').click();
    await expect(page.locator('.mobile-header .brand-mark [aria-hidden="true"]')).toHaveText('ЛК');
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
    if (width === 360) {
      await composer.fill('Добрый день! Подскажите, пожалуйста, статус справки.');
      await composer.press('Enter');
      await expect(composer).toHaveValue('');
    }
    await composer.fill('Привет мир');
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
      await search.fill('');
      await page.locator('#dialogues-content button').filter({ hasNotText: 'Деканат' }).first().click();
      await expect(composer).toHaveValue('');
      await contact.click();
      await expect(composer).toHaveValue('П🙂ривет мир');
    }
  });
}

test('new conversation shows only authorized contacts without history', async ({ page, cabinet }) => {
  await login(page, cabinet, 'other');
  await page.locator('#header-inbox').click();
  const entries = page.locator('#dialogues-content button');
  await expect(entries).toHaveCount(1);
  await expect(entries.first()).toContainText('Деканат');
  await page.getByRole('button', { name: 'Новый диалог' }).click();
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

for (const width of [360, 440]) {
  test(`teacher chat, grades and ready certificate at ${width} px`, async ({ page, browser, cabinet }) => {
    await page.setViewportSize({ width, height: 800 });
    await login(page, cabinet);
    const data = async (path) => (await page.request.get(cabinet.origin + '/api' + path)).json();
    const post = (client, path, body) => client.post(cabinet.origin + '/api' + path, {
      headers: { Origin: cabinet.origin }, data: body,
    });
    const current = await data('/cabinet');
    const teacher = current.contacts.find(({ teacherId }) => teacherId !== null);
    const schedule = await data('/schedule');
    const lesson = schedule.lessons.find(({ contact }) => contact?.teacherId === teacher.teacherId);
    expect(lesson).toBeDefined();
    await page.locator('.mobile-tabs [data-view=schedule]').click();
    await page.locator('#day-picker label').filter({ has: page.locator('input[value="' + lesson.date + '"]') }).click();
    await page.locator('#lesson-' + lesson.id + ' .lesson-link').click();
    const lessonCard = page.locator('#lesson-dialog');
    const write = lessonCard.getByRole('button', { name: 'Написать', exact: true });
    await expect(write).toBeVisible();
    await expect(lessonCard.getByRole('link', { name: 'Открыть почту' })).toHaveAttribute('href', /^mailto:/);
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
    await page.locator('#view-menu').getByRole('link', { name: 'Контакты', exact: true }).click();
    const contacts = page.locator('#contacts-content .contact-card');
    const linked = contacts.filter({ has: page.getByRole('heading', { name: teacher.name, exact: true }) });
    await expect(contacts.filter({ hasText: 'переписка в кабинете недоступна' }).first()
      .getByRole('button', { name: 'Написать', exact: true })).toHaveCount(0);
    await linked.getByRole('button', { name: 'Написать', exact: true }).click();
    await expect(page.locator('#dialogue-heading')).toHaveText(teacher.name);
    expect((await data('/cabinet')).dialogues.filter(({ fullName }) => fullName === teacher.name)).toHaveLength(1);

    await menu.click();
    await page.locator('#view-menu').getByRole('link', { name: 'Успеваемость', exact: true }).click();
    const semester = page.getByRole('combobox', { name: 'Семестр' });
    const subject = page.locator('#grades-content details').filter({ hasText: 'Зельеварение' });
    const summary = subject.locator('summary');
    await expect(summary).toContainText('48 / 100');
    await expect(summary).toContainText(/Зачёт|Экзамен/);
    await summary.click();
    await expect(subject).toContainText('36 / 40');
    await expect(subject).toContainText('12 / 15');
    await expect(subject.getByRole('link', { name: 'Разбор рецепта' }).first()).toBeVisible();
    await fits(page);
    await semester.selectOption('1');
    await expect(summary).toContainText(/Зачтено|Отлично|Хорошо/);
    await semester.selectOption('2');

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
  await expect(nav.getByRole('link', { name: 'Справки и документы' })).toBeVisible();
  await expect(nav.getByRole('link', { name: 'Расписание' })).toHaveCount(0);
  await nav.getByRole('link', { name: 'Библиотека' }).click();
  await expect(page.getByRole('heading', { name: 'Библиотека', exact: true })).toBeVisible();
  await expect(page.getByText('Архив звёздных карт', { exact: true })).toBeVisible();
});

test('library searches titles and authors, filters disciplines and remembers a favorite', async ({ page, cabinet }) => {
  await login(page, cabinet);
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
    for (const value of ['', 'с', 'зюзюкалка']) {
      await input.fill(value);
      await expect(options).toHaveCount(0);
    }
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
    await expect(nav.getByRole('link', { name: 'Расписание' })).toBeVisible();
    await expect(page.locator('#header-inbox')).toBeVisible();
    const heading = page.locator('#page-heading');
    for (const [view, name, selector] of [['schedule', 'Расписание', '#week-grid'], ['requests', 'Справки и документы', '#document-enrollment'], ['messages', 'Сообщения', '#dialogues-content']]) {
      await nav.locator('[data-view="' + view + '"]').click();
      await expect(heading).toHaveText(name);
      await expect(page.locator(selector)).toBeVisible();
      await expect(page.locator('#header-inbox')).toBeHidden();
      await fits(page);
    }
    await page.getByRole('button', { name: /Деканат/ }).click();
    await expect(page.locator('#message-text')).toBeVisible();
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
    await expect(page.locator('#mobile-nav').getByRole('link', { name: unavailable })).toHaveCount(0);
    await expect(page.locator('#mobile-nav').getByRole('link', { name: 'Библиотека' })).toBeVisible();
    await fits(page);
  });
}
