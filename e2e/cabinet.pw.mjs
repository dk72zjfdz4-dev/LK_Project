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
    const dean = randomBytes(18).toString('base64url');
    const teacher = randomBytes(18).toString('base64url');
    const server = spawn(process.execPath, ['server.mjs'], {
      env: {
        HOST: '127.0.0.1', PORT: '0', DB_PATH: join(directory, 'test.sqlite'),
        DEMO_PASSWORD_1: student, DEMO_PASSWORD_TEACHER: teacher, DEMO_PASSWORD_DEAN: dean,
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
      await use({ origin, student, teacher, dean });
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
  await page.getByLabel('Логин', { exact: true }).fill({ student: 'student1', teacher: 'teacher1', dean: 'dean1' }[role]);
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

for (const width of [360, 440]) {
  test(`left mobile drawer, focus and layout at ${width} px`, async ({ page, cabinet }) => {
    await page.setViewportSize({ width, height: width === 440 ? 450 : 800 });
    await login(page, cabinet);
    const avatar = page.getByRole('button', { name: 'Открыть меню профиля' });
    await expect(avatar).toHaveText('НР');
    expect((await avatar.boundingBox()).x).toBeLessThan(32);
    await expect(page.getByRole('heading', { name: 'Учебная неделя' })).toBeVisible();
    await fits(page);
    if (width === 360) await capture(page, 'home');
    await page.locator('#home-week').locator('label').first().click();
    await expect(page.locator('#home-day')).toContainText(/зельеварение|заклинания/i);
    await expect(page.getByRole('heading', { name: 'Главная', exact: true })).toBeVisible();
    await avatar.focus();
    await page.keyboard.press('Enter');
    const menu = page.locator('#mobile-menu');
    await expect(menu).toBeVisible();
    await expect(menu.getByRole('link', { name: 'Расписание' })).toBeVisible();
    await expect.poll(async () => Math.abs((await menu.boundingBox())?.x ?? Infinity)).toBeLessThan(1);
    await fits(page);
    if (width === 360) await capture(page, 'menu');
    await menu.getByRole('button', { name: 'Выйти' }).scrollIntoViewIfNeeded();
    await expect(menu.getByRole('button', { name: 'Выйти' })).toBeInViewport();
    await page.keyboard.press('Escape');
    await expect(menu).toBeHidden();
    await expect(avatar).toBeFocused();
    await expect(avatar).toHaveCSS('outline-style', 'solid');
    await avatar.click();
    await menu.getByRole('button', { name: 'Закрыть' }).click();
    await expect(menu).toBeHidden();
    await page.locator('#help-launcher').click();
    const helper = page.locator('#help-dialog');
    await expect(helper).toBeVisible();
    if (width === 360) await capture(page, 'helper');
    await expect(helper.getByRole('textbox', { name: 'Вопрос о кабинете' })).toBeVisible();
    await helper.getByRole('button', { name: 'Закрыть' }).click();
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

  await page.getByRole('button', { name: 'Открыть меню профиля' }).click();
  await page.locator('#mobile-menu').getByRole('link', { name: 'Карта кампуса' }).click();
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

  await page.locator('#help-launcher').click();
  const question = page.getByRole('textbox', { name: 'Вопрос о кабинете' });
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

for (const [label, width, height] of [['desktop', 1440, 980], ['360', 360, 800]]) {
  test(`glass surfaces and assistant at ${label}`, async ({ page, cabinet }) => {
    await page.setViewportSize({ width, height });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await login(page, cabinet);
    await expect(page.getByRole('heading', { name: 'Учебная неделя' })).toBeVisible();
    await fits(page);
    await page.screenshot({ path: `test-results/glass/home-${label}.png`, animations: 'disabled' });

    const launcher = page.locator('#help-launcher');
    await launcher.focus();
    await page.keyboard.press('Enter');
    const dialog = page.locator('#help-dialog');
    const input = dialog.getByRole('textbox', { name: 'Вопрос о кабинете' });
    await expect(dialog).toBeVisible();
    await expect(input).toBeInViewport();
    await expect(dialog.getByRole('button', { name: 'Получить ответ' })).toBeInViewport();
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
    await page.keyboard.press('Tab');
    await expect(dialog.getByRole('button', { name: 'Закрыть' })).toBeFocused();
    await expect(dialog.getByRole('button', { name: 'Закрыть' })).toHaveCSS('outline-style', 'solid');
    await page.screenshot({ path: `test-results/glass/helper-${label}.png`, animations: 'disabled' });
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(launcher).toBeFocused();
  });
}
