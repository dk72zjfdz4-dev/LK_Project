import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

test('student accounts, schedule ownership and session revocation', { timeout: 20000 }, async (t) => {
  const data = await mkdtemp(join(tmpdir(), 'student-cabinet-test-'));
  const passwords = [0, 1].map(() => randomBytes(18).toString('base64url'));
  const server = spawn(process.execPath, ['server.mjs'], {
    env: {
      ...process.env,
      HOST: '127.0.0.1',
      PORT: '0',
      DB_PATH: join(data, 'cabinet.sqlite'),
      DEMO_PASSWORD_1: passwords[0],
      DEMO_PASSWORD_2: passwords[1],
    },
  });
  const exit = once(server, 'exit');
  t.after(async () => {
    server.kill();
    await exit;
    await rm(data, { recursive: true, force: true });
  });

  let output = '';
  let diagnostics = '';
  server.stderr.on('data', (chunk) => { diagnostics += chunk; });
  const origin = await new Promise((resolve, reject) => {
    server.stdout.on('data', (chunk) => {
      output += chunk;
      const url = output.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0];
      if (url) resolve(url);
    });
    server.once('error', reject);
    server.once('exit', (code) => reject(new Error(`Server exited (${code}) before listening\n${diagnostics}`)));
  });

  async function request(path, { cookie, body, method = 'GET', requestOrigin = origin } = {}) {
    const headers = {};
    if (cookie) headers.Cookie = cookie;
    if (method === 'POST') headers.Origin = requestOrigin;
    if (body) headers['Content-Type'] = 'application/json';
    return fetch(origin + path, { method, headers, body: JSON.stringify(body) });
  }

  const home = await request('/');
  assert.equal(home.status, 200);
  const html = await home.text();
  assert.match(html, /Конкурсный прототип\. Неофициальный сервис/);
  for (const file of ['mobile.css', 'desktop-tablet.css']) {
    assert.ok(html.includes(`href="/${file}"`));
    const asset = await request('/' + file);
    assert.equal(asset.status, 200, file);
    assert.match(asset.headers.get('content-type'), /^text\/css(?:;|$)/i, file);
    assert.equal(asset.headers.get('x-content-type-options'), 'nosniff');
    assert.deepEqual(Buffer.from(await asset.arrayBuffer()), await readFile(new URL('../public/' + file, import.meta.url)));
  }
  for (const path of ['/app.js', '/styles.css']) assert.equal((await request(path)).status, 200);
  const loginStyles = await request('/login.css');
  assert.equal(loginStyles.status, 200);
  assert.match(loginStyles.headers.get('content-type'), /^text\/css\b/);
  for (const season of ['winter', 'spring', 'summer', 'autumn']) {
    for (const tone of ['day', 'evening']) {
      const asset = await request(`/assets/auth/${season}-${tone}.png`, { method: 'HEAD' });
      assert.equal(asset.status, 200);
      assert.equal(asset.headers.get('content-type'), 'image/png');
      assert.equal(asset.headers.get('x-content-type-options'), 'nosniff');
    }
  }
  for (const path of ['/server.mjs', '/data/local-demo.env', '/data/student-cabinet.sqlite']) {
    assert.equal((await request(path)).status, 404);
  }
  for (const path of ['/api/me', '/api/schedule', '/api/lessons/1']) {
    assert.equal((await request(path)).status, 401);
  }

  const attempt = (login, password) => request('/api/login', { method: 'POST', body: { login, password } });
  assert.equal((await attempt('student1', 'incorrect')).status, 401);
  const users = [];
  for (const [index, password] of passwords.entries()) {
    const response = await attempt(`student${index + 1}`, password);
    assert.equal(response.status, 200);
    const session = response.headers.get('set-cookie');
    assert.match(session, /HttpOnly/i);
    const cookie = session.split(';')[0];
    const profile = await request('/api/me', { cookie });
    assert.equal(profile.status, 200);
    assert.equal(profile.headers.get('cache-control'), 'no-store');
    const { profile: student } = await profile.json();
    assert.deepEqual(Object.keys(student).sort(), ['faculty', 'firstName', 'fullName', 'group', 'lastName', 'program', 'role', 'year']);
    const schedule = await request('/api/schedule', { cookie });
    assert.equal(schedule.status, 200);
    const { weekStart, lessons, nextWeekLessons } = await schedule.json();
    assert.ok(lessons.length);
    assert.ok(nextWeekLessons[0].date > lessons.at(-1).date);
    let monthLesson;
    for (const month of ['2026-11', '2026-12']) {
      const monthly = await request('/api/schedule?month=' + month, { cookie });
      assert.equal(monthly.status, 200);
      const payload = await monthly.json();
      assert.equal(payload.month, month);
      assert.ok(payload.lessons.length > lessons.length);
      assert.ok(payload.lessons.every(({ date }) => date.startsWith(month + '-')));
      assert.equal(new Set(payload.lessons.map(({ id }) => id)).size, payload.lessons.length);
      if (month === '2026-12') monthLesson = payload.lessons.at(-1).id;
    }
    assert.equal((await request('/api/schedule?month=2026-13', { cookie })).status, 400);
    const week = await request('/api/schedule?week=2026-11-23', { cookie });
    assert.equal(week.status, 200);
    const selected = await week.json();
    assert.equal(selected.weekStart, weekStart);
    assert.equal(selected.selectedWeek.weekStart, '2026-11-23');
    assert.ok(selected.selectedWeek.lessons.every(({ date }) => date >= '2026-11-23' && date <= '2026-11-29'));
    assert.equal(selected.selectedWeek.lessons.some(({ cancelled }) => cancelled), users.length === 0);
    const weekLesson = selected.selectedWeek.lessons[0].id;
    for (const query of ['week=2026-12-01', 'week=2026-02-30', 'week=2026-11-23&month=2026-11']) {
      assert.equal((await request('/api/schedule?' + query, { cookie })).status, 400);
    }
    users.push({ cookie, name: student.fullName, lesson: lessons[0].id, nextLesson: nextWeekLessons[0].id, monthLesson, weekLesson });
  }

  assert.notEqual(users[0].name, users[1].name);
  assert.notEqual(users[0].lesson, users[1].lesson);
  for (const [index, user] of users.entries()) {
    assert.equal((await request(`/api/lessons/${user.lesson}`, user)).status, 200);
    assert.equal((await request(`/api/lessons/${users[1 - index].lesson}`, user)).status, 404);
    assert.equal((await request(`/api/lessons/${user.nextLesson}`, user)).status, 200);
    assert.equal((await request(`/api/lessons/${users[1 - index].nextLesson}`, user)).status, 404);
    assert.equal((await request(`/api/lessons/${user.monthLesson}`, user)).status, 200);
    assert.equal((await request(`/api/lessons/${users[1 - index].monthLesson}`, user)).status, 404);
    assert.equal((await request(`/api/lessons/${user.weekLesson}`, user)).status, 200);
    assert.equal((await request(`/api/lessons/${users[1 - index].weekLesson}`, user)).status, 404);
    const rejected = await request('/api/logout', { ...user, method: 'POST', requestOrigin: 'https://example.invalid' });
    assert.equal(rejected.status, 403);
    assert.equal((await request('/api/logout', { ...user, method: 'POST' })).status, 204);
    assert.equal((await request('/api/me', user)).status, 401);
  }
});
