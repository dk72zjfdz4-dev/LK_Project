import { randomBytes, createHash, scrypt, scryptSync, timingSafeEqual } from 'node:crypto';
import { lstatSync, mkdirSync, realpathSync } from 'node:fs';
import { readFile, realpath } from 'node:fs/promises';
import { createServer } from 'node:http';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { createCabinet, installCabinet, seedCabinet } from './cabinet.mjs';

const root = realpathSync(fileURLToPath(new URL('.', import.meta.url)));
const publicDirectory = realpathSync(resolve(root, 'public'));
const databasePath = resolve(process.env.DB_PATH || resolve(root, 'data', 'student-cabinet.sqlite'));
const host = process.env.HOST || '127.0.0.1';
const port = Number(process.env.PORT ?? 3000);
const appOrigin = process.env.APP_ORIGIN ? new URL(process.env.APP_ORIGIN) : null;
const loopbackHosts = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);
const sessionCookie = 'student_session';
const sessionSeconds = 12 * 60 * 60;
const passwordOptions = { N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 };
const hashPassword = promisify(scrypt);
const dummySalt = randomBytes(16);
const dummyHash = randomBytes(64);
const moscowDate = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Europe/Moscow', year: 'numeric', month: '2-digit', day: '2-digit',
});

const demos = [
  {
    login: 'student1',
    firstName: 'Нюша',
    lastName: 'Романова',
    passwordEnv: 'DEMO_PASSWORD_1',
    role: 'student',
    profile: ['Алина Воронцова', 'Факультет международных отношений', 'Международные отношения', 2, 'МО-24-02'],
    lessons: [
      [1, '09:00', '10:20', 'История международных отношений', 'А-204', 'Мария Ланская', null],
      [1, '10:40', '12:00', 'Английский язык', 'Б-312', 'Ольга Листова', null],
      [2, '10:40', '12:00', 'Мировая политика', 'А-418', 'Сергей Вельский', 'Аудитория изменена. Занятие пройдёт в А-418.'],
      [2, '12:30', '13:50', 'Основы дипломатического протокола', 'В-207', 'Ирина Яровая', null],
      [3, '09:00', '10:20', 'Английский язык', 'Б-312', 'Ольга Листова', null],
      [3, '10:40', '12:00', 'Международное право', 'А-205', 'Павел Вересов', null],
      [3, '14:10', '15:30', 'Региональные исследования', 'В-304', 'Кира Волина', 'Начало занятия перенесено на 14:10.'],
      [4, '10:40', '12:00', 'История международных отношений', 'А-204', 'Мария Ланская', null],
      [4, '12:30', '13:50', 'Французский язык', 'Б-226', 'Лидия Ольшина', null],
      [5, '09:00', '10:20', 'Мировая экономика', 'А-310', 'Максим Стрельцов', null],
      [5, '10:40', '12:00', 'Международное право', 'А-205', 'Павел Вересов', null],
    ],
  },
  {
    login: 'student2',
    firstName: 'Крош',
    lastName: 'Речин',
    passwordEnv: 'DEMO_PASSWORD_2',
    role: 'student',
    profile: ['Крош Андреевич Речин', 'Факультет международной экономики', 'Экономика', 3, 'МЭ-23-04'],
    lessons: [
      [1, '10:40', '12:00', 'Эконометрика', 'В-201', 'Артём Озёрский', null],
      [1, '12:30', '13:50', 'Международные финансы', 'А-314', 'Елена Светлова', null],
      [2, '09:00', '10:20', 'Микроэкономика', 'А-310', 'Виктор Лесков', null],
      [2, '10:40', '12:00', 'Английский язык для экономистов', 'Б-215', 'София Луговая', null],
      [3, '10:40', '12:00', 'Эконометрика', 'В-208', 'Артём Озёрский', 'Аудитория изменена. Занятие пройдёт в В-208.'],
      [3, '12:30', '13:50', 'Управленческий учёт', 'А-212', 'Анна Ладина', null],
      [4, '09:00', '10:20', 'Международная торговля', 'А-314', 'Михаил Радин', null],
      [4, '14:10', '15:30', 'Практикум по анализу данных', 'В-209', 'Яна Забелина', 'Начало занятия перенесено на 14:10.'],
      [5, '10:40', '12:00', 'Международные финансы', 'А-314', 'Елена Светлова', null],
      [5, '12:30', '13:50', 'Английский язык для экономистов', 'Б-215', 'София Луговая', null],
    ],
  },
  {
    login: 'teacher1',
    firstName: 'Северус',
    lastName: 'Снегг',
    passwordEnv: 'DEMO_PASSWORD_TEACHER',
    role: 'teacher',
    profile: ['Северус Снегг', 'Кафедра практических дисциплин', 'Зельеварение', 0, ''],
    lessons: [],
  },
  {
    login: 'teacher2',
    firstName: 'Минерва',
    lastName: 'Макгонагалл',
    passwordEnv: 'DEMO_PASSWORD_MCGONAGALL',
    role: 'teacher',
    profile: ['Минерва Макгонагалл', 'Кафедра практических дисциплин', 'Трансфигурация', 0, ''],
    lessons: [],
  },
  {
    login: 'dekanat1',
    firstName: 'Ирина',
    lastName: 'Яровая',
    passwordEnv: 'DEMO_PASSWORD_DEKANAT1',
    role: 'dean',
    profile: ['Ирина Яровая', 'Деканат', 'Учебная служба', 0, ''],
    lessons: [],
  },
  ...[
    ['teacher3', 'DEMO_PASSWORD_FLITWICK', 'Филиус', 'Флитвик', 'Заклинания'],
    ['teacher4', 'DEMO_PASSWORD_SPROUT', 'Помона', 'Стебль', 'Травология'],
    ['teacher5', 'DEMO_PASSWORD_SINISTRA', 'Аврора', 'Синистра', 'Астрономия'],
    ['teacher6', 'DEMO_PASSWORD_LUPIN', 'Римус', 'Люпин', 'Защита от тёмных искусств'],
  ].map(([login, passwordEnv, firstName, lastName, subject]) => ({
    login, passwordEnv, firstName, lastName,
    role: 'teacher',
    profile: [firstName + ' ' + lastName, 'Кафедра практических дисциплин', subject, 0, ''],
    lessons: [],
  })),
];

const staticFiles = new Map([
  ['/', ['index.html', 'text/html']],
  ['/index.html', ['index.html', 'text/html']],
  ['/app.js', ['app.js', 'text/javascript']],
  ['/styles.css', ['styles.css', 'text/css']],
  ['/desktop-tablet.css', ['desktop-tablet.css', 'text/css']],
  ['/mobile.css', ['mobile.css', 'text/css']],
  ['/login.css', ['login.css', 'text/css']],
  ['/certificate-print.css', ['certificate-print.css', 'text/css']],
  ['/certificate-print.js', ['certificate-print.js', 'text/javascript']],
]);

function isPublicPath(path) {
  const location = relative(publicDirectory, path);
  return !isAbsolute(location) && location !== '..' && !location.startsWith(`..${sep}`);
}

if (!Number.isInteger(port) || port < 0 || port > 65535) {
  throw new Error('PORT должен быть целым числом от 0 до 65535.');
}
if (appOrigin && (!['http:', 'https:'].includes(appOrigin.protocol) || appOrigin.href !== appOrigin.origin + '/')) {
  throw new Error('APP_ORIGIN должен содержать только схему, хост и порт.');
}
if (isPublicPath(databasePath)) throw new Error('Файл базы данных должен находиться вне public.');
process.umask(0o077);
mkdirSync(dirname(databasePath), { recursive: true, mode: 0o700 });
const storagePath = resolve(realpathSync(dirname(databasePath)), basename(databasePath));
const existingStorage = lstatSync(storagePath, { throwIfNoEntry: false });
if (isPublicPath(storagePath) || (existingStorage && !existingStorage.isFile())) {
  throw new Error('Укажите обычный файл базы данных вне public.');
}

const db = new DatabaseSync(storagePath, { timeout: 5000 });
db.exec(`
  PRAGMA foreign_keys = ON;
  CREATE TABLE IF NOT EXISTS students (
    id INTEGER PRIMARY KEY,
    login TEXT UNIQUE NOT NULL,
    password_salt BLOB NOT NULL,
    password_hash BLOB NOT NULL,
    full_name TEXT NOT NULL,
    faculty TEXT NOT NULL,
    program TEXT NOT NULL,
    year INTEGER NOT NULL,
    student_group TEXT NOT NULL
  ) STRICT;
  CREATE TABLE IF NOT EXISTS lessons (
    id INTEGER PRIMARY KEY,
    student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
    weekday INTEGER NOT NULL CHECK (weekday BETWEEN 1 AND 7),
    start_time TEXT NOT NULL,
    end_time TEXT NOT NULL,
    title TEXT NOT NULL,
    room TEXT NOT NULL,
    teacher TEXT NOT NULL,
    change TEXT
  ) STRICT;
  CREATE INDEX IF NOT EXISTS lessons_student_weekday ON lessons(student_id, weekday, start_time);
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL
  ) STRICT;
  CREATE INDEX IF NOT EXISTS sessions_expires_at ON sessions(expires_at);
`);
transaction(() => installCabinet(db));

const studentByLogin = db.prepare('SELECT * FROM students WHERE login = ? AND directory_only = 0');
const profileBySession = db.prepare(`
  SELECT students.id, login, full_name, faculty, program, year, student_group, role
  FROM sessions JOIN students ON students.id = sessions.student_id
  WHERE token_hash = ? AND expires_at > ? AND students.directory_only = 0
`);
const allLessons = db.prepare(`
  SELECT l.*, p.parity AS week_parity FROM lessons l
  LEFT JOIN lesson_week_parity p ON p.lesson_id = l.id
  WHERE l.student_id = ? ORDER BY l.weekday, l.start_time, l.id
`);
const cancelledLessons = db.prepare(`
  SELECT c.lesson_id, c.date, c.change FROM lesson_cancellations c JOIN lessons l ON l.id = c.lesson_id
  WHERE l.student_id = ? AND c.date BETWEEN ? AND ?
`);
const ownedLesson = db.prepare(`
  SELECT l.*, c.change AS cancellation, p.parity AS week_parity FROM lessons l
  LEFT JOIN lesson_week_parity p ON p.lesson_id = l.id
  LEFT JOIN lesson_cancellations c ON c.lesson_id = l.id AND c.date = ?
  WHERE l.student_id = ? AND l.id = ? AND l.weekday = ?
`);
const removeSession = db.prepare('DELETE FROM sessions WHERE token_hash = ?');
const removeExpiredSessions = db.prepare('DELETE FROM sessions WHERE expires_at <= ?');
const insertSession = db.prepare(`
  INSERT INTO sessions (token_hash, student_id, expires_at)
  SELECT ?, id, ? FROM students WHERE id = ? AND password_hash = ? AND directory_only = 0
`);

function transaction(operation) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = operation();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function fixturePassword(login, configuredPassword) {
  if (configuredPassword !== undefined && (configuredPassword.length < 8 || configuredPassword.length > 256)) {
    throw new Error(`Пароль демо-аккаунта ${login} должен содержать от 8 до 256 символов.`);
  }
  const password = configuredPassword ?? randomBytes(18).toString('base64url');
  const salt = randomBytes(16);
  return { password, salt, hash: scryptSync(password, salt, 64, passwordOptions) };
}

function seedDemos(reset = false) {
  const insertStudent = db.prepare(`
    INSERT INTO students (login, password_salt, password_hash, full_name, faculty, program, year, student_group, role)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertLesson = db.prepare(`
    INSERT INTO lessons (student_id, weekday, start_time, end_time, title, room, teacher, change)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const updatePassword = db.prepare('UPDATE students SET password_salt = ?, password_hash = ? WHERE id = ?');
  const revokeSessions = db.prepare('DELETE FROM sessions WHERE student_id = ?');
  const generated = [];
  transaction(() => {
    db.prepare("UPDATE students SET login = ? WHERE login = ? AND role = 'dean'").run('dekanat1', 'dean1');
    for (const demo of demos) {
      const student = studentByLogin.get(demo.login);
      if (student && !reset) continue;
      const configuredPassword = reset ? undefined : process.env[demo.passwordEnv];
      const { password, salt, hash } = fixturePassword(demo.login, configuredPassword);
      if (student) {
        updatePassword.run(salt, hash, student.id);
        revokeSessions.run(student.id);
      } else {
        const { lastInsertRowid } = insertStudent.run(demo.login, salt, hash, ...demo.profile, demo.role);
        for (const lesson of demo.lessons) insertLesson.run(lastInsertRowid, ...lesson);
      }
      if (configuredPassword === undefined) generated.push([demo.login, password]);
    }
    seedCabinet(db);
  });
  if (generated.length && (reset || process.stdout.isTTY)) {
    for (const [login, password] of generated) console.log(`${login} ${password}`);
  }
}

function profile(student) {
  const demo = demos.find(({ login }) => login === student.login);
  return {
    fullName: student.full_name,
    firstName: demo?.firstName ?? '',
    lastName: demo?.lastName ?? '',
    faculty: student.faculty,
    program: student.program,
    year: student.year,
    group: student.student_group,
    role: student.role,
  };
}

function civilDate(date) {
  return date.toISOString().slice(0, 10);
}

function weekInMoscow() {
  const today = moscowDate.format(new Date());
  const monday = new Date(`${today}T00:00:00Z`);
  monday.setUTCDate(monday.getUTCDate() - (monday.getUTCDay() + 6) % 7);
  return { today, monday };
}

function lessonOn(row, date, cancellation) {
  const scheduledChange = date >= '2026-11-23' && date <= '2026-11-29' ? row.change : null;
  return {
    id: `${row.id}-${date}`, date,
    start: row.start_time, end: row.end_time,
    title: row.title, room: row.room, teacher: row.teacher,
    change: cancellation ?? scheduledChange,
    cancelled: Boolean(cancellation),
    contact: cabinet.lessonContact(row.student_id, row),
  };
}

function weekParity(date) {
  const thursday = new Date(date);
  thursday.setUTCDate(thursday.getUTCDate() + 4 - (thursday.getUTCDay() || 7));
  const yearStart = new Date(thursday);
  yearStart.setUTCMonth(0, 1);
  return (Math.floor((thursday - yearStart) / 604800000) + 1) % 2;
}

function matchesWeek(row, parity) {
  return row.week_parity === null || row.week_parity === parity;
}

function weekLessons(rows, monday, offset, cancellations) {
  const start = new Date(monday);
  start.setUTCDate(start.getUTCDate() + offset);
  const parity = weekParity(start);
  return rows.filter((row) => matchesWeek(row, parity)).map((row) => {
    const date = new Date(start);
    date.setUTCDate(date.getUTCDate() + row.weekday - 1);
    const day = civilDate(date);
    return lessonOn(row, day, cancellations.get(`${row.id}-${day}`));
  });
}

function schedule(studentId, week = null) {
  const selectedMonday = week === null ? null : new Date(week + 'T00:00:00Z');
  if (selectedMonday && (!/^\d{4}-\d{2}-\d{2}$/.test(week) || !Number.isFinite(selectedMonday.getTime())
    || civilDate(selectedMonday) !== week || selectedMonday.getUTCDay() !== 1
    || week < '0001-01-01' || week > '9999-12-26')) {
    throw new HttpError(400, 'Укажите дату понедельника в формате ГГГГ-ММ-ДД.');
  }
  const { today, monday } = weekInMoscow();
  const rows = allLessons.all(studentId);
  const last = new Date(monday);
  last.setUTCDate(last.getUTCDate() + 13);
  const weekStart = civilDate(monday);
  const cancellations = new Map(cancelledLessons.all(studentId, weekStart, civilDate(last))
    .map(({ lesson_id, date, change }) => [`${lesson_id}-${date}`, change]));
  const data = {
    today, weekStart,
    lessons: weekLessons(rows, monday, 0, cancellations),
    nextWeekLessons: weekLessons(rows, monday, 7, cancellations),
  };
  if (selectedMonday) {
    const nextMonday = new Date(monday);
    nextMonday.setUTCDate(nextMonday.getUTCDate() + 7);
    let lessons = data.lessons;
    if (week === civilDate(nextMonday)) {
      lessons = data.nextWeekLessons;
    } else if (week !== weekStart) {
      const sunday = new Date(selectedMonday);
      sunday.setUTCDate(sunday.getUTCDate() + 6);
      const selectedCancellations = new Map(cancelledLessons.all(studentId, week, civilDate(sunday))
        .map(({ lesson_id, date, change }) => [`${lesson_id}-${date}`, change]));
      lessons = weekLessons(rows, selectedMonday, 0, selectedCancellations);
    }
    data.selectedWeek = { weekStart: week, lessons };
  }
  return data;
}

function monthSchedule(studentId, month) {
  if (!/^2026-(?:09|10|11|12)$/.test(month)) throw new HttpError(400, 'Доступно расписание с сентября по декабрь 2026 года.');
  const first = new Date(month + '-01T00:00:00Z');
  const after = new Date(first);
  after.setUTCMonth(after.getUTCMonth() + 1);
  const last = new Date(after.getTime() - 86400000);
  const cancellations = new Map(cancelledLessons.all(studentId, civilDate(first), civilDate(last))
    .map(({ lesson_id, date, change }) => [`${lesson_id}-${date}`, change]));
  const rows = allLessons.all(studentId);
  const lessons = [];
  for (const day = new Date(first); day < after; day.setUTCDate(day.getUTCDate() + 1)) {
    const date = civilDate(day);
    const weekday = day.getUTCDay() || 7;
    const parity = weekParity(day);
    for (const row of rows.filter((row) => row.weekday === weekday && matchesWeek(row, parity))) {
      lessons.push(lessonOn(row, date, cancellations.get(`${row.id}-${date}`)));
    }
  }
  return { month, today: weekInMoscow().today, lessons };
}

function lessonById(studentId, id) {
  const match = /^([1-9]\d{0,14})-(\d{4}-\d{2}-\d{2})$/.exec(id);
  if (!match) return null;
  const [, rowId, date] = match;
  const parsedDate = new Date(`${date}T00:00:00Z`);
  if (!Number.isFinite(parsedDate.getTime()) || civilDate(parsedDate) !== date) return null;
  const row = ownedLesson.get(date, studentId, Number(rowId), parsedDate.getUTCDay() || 7);
  return row && matchesWeek(row, weekParity(parsedDate)) ? lessonOn(row, date, row.cancellation) : null;
}

function sessionHash(request) {
  const token = request.headers.cookie?.split(';').map((part) => part.trim())
    .find((part) => part.startsWith(`${sessionCookie}=`))?.slice(sessionCookie.length + 1);
  return token && /^[A-Za-z0-9_-]{43}$/.test(token) ? tokenHash(token) : null;
}

function tokenHash(token) {
  return createHash('sha256').update(token).digest('hex');
}

function cookie(token, maxAge) {
  const secure = appOrigin?.protocol === 'https:' ? '; Secure' : '';
  return `${sessionCookie}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure}`;
}

function sameOrigin(request) {
  const origin = request.headers.origin;
  if (!origin) return false;
  if (appOrigin) return origin === appOrigin.origin;
  try {
    const requestOrigin = new URL(`http://${request.headers.host}`);
    const requestPort = Number(requestOrigin.port || 80);
    return origin === requestOrigin.origin && requestPort === request.socket.localPort
      && (!loopbackHosts.has(host) || loopbackHosts.has(requestOrigin.hostname));
  } catch {
    return false;
  }
}

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function bytesBody(request, limit) {
  if (Number(request.headers['content-length']) > limit) {
    throw new HttpError(413, 'Слишком большой запрос.');
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > limit) throw new HttpError(413, 'Слишком большой запрос.');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, size);
}

async function jsonBody(request, limit = 4096) {
  if (request.headers['content-type']?.split(';', 1)[0].trim().toLowerCase() !== 'application/json') {
    throw new HttpError(415, 'Ожидается тело запроса в формате JSON.');
  }
  const contents = await bytesBody(request, limit);
  try {
    return JSON.parse(contents.toString('utf8'));
  } catch {
    throw new HttpError(400, 'Некорректный JSON.');
  }
}

function json(response, status, body) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(body));
}

async function login(request, response) {
  const body = await jsonBody(request);
  if (typeof body?.login !== 'string' || typeof body?.password !== 'string'
    || body.login.length > 128 || body.password.length > 256) {
    throw new HttpError(400, 'Укажите логин и пароль.');
  }

  const student = studentByLogin.get(body.login.trim());
  const suppliedHash = await hashPassword(body.password, student?.password_salt ?? dummySalt, 64, passwordOptions);
  const correct = timingSafeEqual(suppliedHash, student?.password_hash ?? dummyHash);
  if (!student || !correct) throw new HttpError(401, 'Неверный логин или пароль.');

  const token = randomBytes(32).toString('base64url');
  const now = Date.now();
  const previousSession = sessionHash(request);
  transaction(() => {
    removeExpiredSessions.run(now);
    const created = insertSession.run(tokenHash(token), now + sessionSeconds * 1000, student.id, student.password_hash);
    if (!created.changes) throw new HttpError(401, 'Неверный логин или пароль.');
    if (previousSession) removeSession.run(previousSession);
  });
  response.setHeader('Set-Cookie', cookie(token, sessionSeconds));
  json(response, 200, { profile: profile(student) });
}

async function api(request, response, path) {
  response.setHeader('Cache-Control', 'no-store');
  const { method } = request;
  if (method === 'POST' && (path === '/api/login' || path === '/api/logout')) {
    if (!sameOrigin(request)) throw new HttpError(403, 'Запрос с другого сайта отклонён.');
    if (path === '/api/login') return login(request, response);
    const token = sessionHash(request);
    if (token) removeSession.run(token);
    response.setHeader('Set-Cookie', cookie('', 0));
    response.writeHead(204).end();
    return;
  }

  const lessonPath = /^\/api\/lessons\/([^/]+)$/.exec(path);
  const isReadRoute = method === 'GET'
    && (path === '/api/me' || path === '/api/schedule' || path === '/api/search' || path === '/api/help' || lessonPath);
  const cabinetRoute = cabinet.match(method, path);
  if (!isReadRoute && !cabinetRoute) throw new HttpError(404, 'Страница не найдена.');
  const token = sessionHash(request);
  function authenticate() {
    const account = token ? profileBySession.get(token, Date.now()) : null;
    if (!account) throw new HttpError(401, 'Войдите в личный кабинет.');
    return account;
  }
  const account = authenticate();
  if (cabinetRoute) {
    if (method === 'POST' && !sameOrigin(request)) throw new HttpError(403, 'Запрос с другого сайта отклонён.');
    return cabinet.handle(cabinetRoute, request, response, account, authenticate);
  }
  if (path === '/api/me') return json(response, 200, { profile: profile(account) });
  if (path === '/api/search') {
    const params = new URLSearchParams(request.url.slice(path.length + 1));
    return json(response, 200, cabinet.search(account, params.get('q') ?? ''));
  }
  if (path === '/api/help') {
    const params = new URLSearchParams(request.url.slice(path.length + 1));
    return json(response, 200, cabinet.help(account, params.get('q')));
  }
  if (account.role !== 'student') throw new HttpError(403, 'Расписание доступно студентам.');
  if (path === '/api/schedule') {
    const params = new URLSearchParams(request.url.slice(path.length + 1));
    const month = params.get('month');
    const week = params.get('week');
    if (month !== null && week !== null) throw new HttpError(400, 'Выберите неделю или месяц.');
    return json(response, 200, month === null ? schedule(account.id, week) : monthSchedule(account.id, month));
  }

  const lesson = lessonById(account.id, lessonPath[1]);
  if (!lesson) throw new HttpError(404, 'Занятие не найдено.');
  return json(response, 200, { lesson });
}

async function staticResponse(request, response, path) {
  const loginScene = /^\/assets\/auth\/(?:winter|spring|summer|autumn)-(?:day|evening)\.(webp|png)$/.exec(path);
  const file = loginScene ? [path.slice(1), `image/${loginScene[1]}`] : staticFiles.get(path);
  if (!file || !['GET', 'HEAD'].includes(request.method)) return staticError(response, 404);
  const [filename, mediaType] = file;
  const location = await realpath(resolve(publicDirectory, filename));
  if (!isPublicPath(location)) return staticError(response, 404);
  const contents = await readFile(location);
  response.writeHead(200, {
    'Content-Type': loginScene ? mediaType : `${mediaType}; charset=utf-8`,
    'Content-Length': contents.length,
    'Cache-Control': 'no-cache',
    'Content-Security-Policy': "default-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
  });
  response.end(request.method === 'HEAD' ? undefined : contents);
}

function staticError(response, status) {
  response.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' })
    .end(status === 404 ? 'Страница не найдена.' : 'Внутренняя ошибка сервера.');
}

async function handleRequest(request, response) {
  response.setHeader('X-Content-Type-Options', 'nosniff');
  const path = request.url.split('?', 1)[0];
  const isApi = path === '/api' || path.startsWith('/api/');
  try {
    if (isApi) await api(request, response, path);
    else await staticResponse(request, response, path);
  } catch (error) {
    request.resume();
    if (response.destroyed) return;
    if (error instanceof HttpError) return json(response, error.status, { error: error.message });
    if (isApi) {
      console.error(error.message);
      json(response, 500, { error: 'Внутренняя ошибка сервера.' });
      return;
    }
    if (error.code !== 'ENOENT') console.error(error.message);
    staticError(response, error.code === 'ENOENT' ? 404 : 500);
  }
}

const reset = process.argv.includes('--reset-demo-passwords');
seedDemos(reset);
const cabinet = reset ? null : createCabinet(db, { transaction, HttpError, bytesBody, jsonBody, json });
if (reset) {
  db.close();
} else {
  const server = createServer({ requestTimeout: 15_000, headersTimeout: 10_000 }, handleRequest);
  server.listen(port, host, () => {
    const address = server.address();
    const logHost = host === '0.0.0.0' ? '127.0.0.1' : host === '::' ? '::1' : host;
    const urlHost = logHost.includes(':') ? `[${logHost}]` : logHost;
    console.log(`http://${urlHost}:${address.port}`);
  });
}
