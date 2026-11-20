import { crc32, inflateRawSync } from 'node:zlib';
import { answerFor, documents, faqFor } from './knowledge.mjs';

const PDF = 'application/pdf';
const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const maxUpload = 10 * 1024 * 1024;
const currentSemester = 2;

const demoTeacherIds = new Map([
  ['Мария Ланская', 'maria-lanskaya'],
  ['Павел Вересов', 'pavel-veresov'],
  ['Ольга Листова', 'olga-listova'],
  ['Кира Волина', 'kira-volina'],
  ['Лидия Ольшина', 'lidia-olshina'],
  ['Сергей Вельский', 'sergey-velsky'],
]);

export function demoContact(name) {
  const id = demoTeacherIds.get(name);
  return id ? { id, name, email: `${id.replace('-', '.')}@example.com` } : null;
}

const subjects = [
  ['Зельеварение', 'Мария Ланская', 'Экзамен', 'Техника приготовления, точность измерений и оформление наблюдений.'],
  ['Трансфигурация', 'Павел Вересов', 'Зачёт', 'Точность преобразования и соблюдение последовательности действий.'],
  ['Заклинания', 'Ольга Листова', 'Экзамен', 'Точность произношения, исполнение и объяснение результата.'],
  ['Травология', 'Кира Волина', 'Зачёт', 'Определение видов, описание свойств и оформление полевых заметок.'],
  ['Астрономия', 'Лидия Ольшина', 'Зачёт', 'Точность наблюдений, расчёты и полнота отчёта.'],
  ['Защита от тёмных искусств', 'Сергей Вельский', 'Экзамен', 'Выбор защитного приёма, исполнение и обоснование решения.'],
];

const studentFixtures = [
  {
    login: 'student1',
    name: 'Нюша Мироновна Романова',
    titles: [
      ['История международных отношений', 'Мировая экономика'],
      ['Международное право'],
      ['Английский язык', 'Основы дипломатического протокола'],
      ['Региональные исследования'],
      ['Французский язык'],
      ['Мировая политика'],
    ],
  },
  {
    login: 'student2',
    name: 'Даниил Андреевич Речин',
    titles: [
      ['Эконометрика'],
      ['Международные финансы'],
      ['Микроэкономика', 'Английский язык для экономистов'],
      ['Управленческий учёт'],
      ['Практикум по анализу данных'],
      ['Международная торговля'],
    ],
  },
];

export function installCabinet(db) {
  if (db.prepare('PRAGMA user_version').get().user_version < 1) db.exec(`
    ALTER TABLE students ADD COLUMN role TEXT NOT NULL DEFAULT 'student'
      CHECK (role IN ('student', 'teacher', 'dean'));
    CREATE TABLE enrollments (
      id INTEGER PRIMARY KEY,
      student_id INTEGER NOT NULL REFERENCES students(id),
      teacher_id INTEGER REFERENCES students(id),
      subject TEXT NOT NULL,
      semester INTEGER NOT NULL,
      coursework_points REAL NOT NULL CHECK (coursework_points >= 0 AND coursework_points <= coursework_max),
      coursework_max REAL NOT NULL CHECK (coursework_max > 0),
      control TEXT NOT NULL,
      result TEXT,
      criteria TEXT NOT NULL,
      UNIQUE (student_id, subject, semester)
    ) STRICT;
    CREATE TABLE requests (
      id INTEGER PRIMARY KEY,
      student_id INTEGER NOT NULL REFERENCES students(id),
      type TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('submitted', 'processing', 'ready', 'rejected')),
      created_at TEXT NOT NULL
    ) STRICT;
    CREATE TABLE request_history (
      id INTEGER PRIMARY KEY,
      request_id INTEGER NOT NULL REFERENCES requests(id),
      status TEXT NOT NULL,
      note TEXT NOT NULL,
      created_at TEXT NOT NULL
    ) STRICT;
    CREATE INDEX request_history_request ON request_history(request_id, id);
    CREATE TABLE dialogues (
      id INTEGER PRIMARY KEY,
      student_id INTEGER NOT NULL REFERENCES students(id),
      staff_id INTEGER NOT NULL REFERENCES students(id),
      student_read_id INTEGER NOT NULL DEFAULT 0,
      staff_read_id INTEGER NOT NULL DEFAULT 0,
      UNIQUE (student_id, staff_id)
    ) STRICT;
    CREATE TABLE messages (
      id INTEGER PRIMARY KEY,
      dialogue_id INTEGER NOT NULL REFERENCES dialogues(id),
      sender_id INTEGER NOT NULL REFERENCES students(id),
      text TEXT NOT NULL,
      created_at TEXT NOT NULL
    ) STRICT;
    CREATE INDEX messages_dialogue ON messages(dialogue_id, id);
    CREATE TABLE notifications (
      id INTEGER PRIMARY KEY,
      account_id INTEGER NOT NULL REFERENCES students(id),
      title TEXT NOT NULL,
      text TEXT NOT NULL,
      created_at TEXT NOT NULL
    ) STRICT;
    CREATE TABLE assignments (
      id INTEGER PRIMARY KEY,
      enrollment_id INTEGER NOT NULL REFERENCES enrollments(id),
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      due_at TEXT NOT NULL,
      max_points REAL NOT NULL CHECK (max_points > 0)
    ) STRICT;
    CREATE INDEX assignments_enrollment ON assignments(enrollment_id);
    CREATE TABLE submissions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      assignment_id INTEGER NOT NULL UNIQUE REFERENCES assignments(id),
      filename TEXT NOT NULL,
      media_type TEXT NOT NULL,
      contents BLOB NOT NULL,
      points REAL CHECK (points >= 0),
      comment TEXT,
      status TEXT NOT NULL CHECK (status IN ('submitted', 'reviewed'))
    ) STRICT;
    CREATE TABLE appeals (
      id INTEGER PRIMARY KEY,
      submission_id INTEGER NOT NULL UNIQUE REFERENCES submissions(id),
      reason TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending', 'decided')),
      comment TEXT,
      old_points REAL NOT NULL,
      new_points REAL,
      created_at TEXT NOT NULL,
      decided_at TEXT
    ) STRICT;
    PRAGMA user_version = 1;
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS lesson_cancellations (
      lesson_id INTEGER NOT NULL REFERENCES lessons(id) ON DELETE CASCADE,
      date TEXT NOT NULL,
      change TEXT NOT NULL,
      PRIMARY KEY (lesson_id, date)
    ) STRICT;
  `);
}

function demoPdf() {
  const contents = 'BT /F1 18 Tf 48 700 Td (Cabinet demo work) Tj ET\n';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${contents.length} >>\nstream\n${contents}endstream`,
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [];
  for (const [index, object] of objects.entries()) {
    offsets.push(pdf.length);
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = pdf.length;
  pdf += 'xref\n0 6\n0000000000 65535 f \n';
  pdf += offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('');
  pdf += `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf);
}

function seedCabinetFixtures(db) {
  const account = db.prepare('SELECT id FROM students WHERE login = ?');
  const teacherId = account.get('teacher1').id;
  const deanId = account.get('dean1').id;
  const rename = db.prepare('UPDATE students SET full_name = ? WHERE id = ?');
  const changeLesson = db.prepare('UPDATE lessons SET title = ?, teacher = ? WHERE student_id = ? AND title = ?');
  const enroll = db.prepare(`
    INSERT INTO enrollments (student_id, teacher_id, subject, semester, coursework_points, coursework_max, control, result, criteria)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const makeDialogue = db.prepare('INSERT INTO dialogues (student_id, staff_id) VALUES (?, ?)');
  const message = db.prepare('INSERT INTO messages (dialogue_id, sender_id, text, created_at) VALUES (?, ?, ?, ?)');
  const notice = db.prepare('INSERT INTO notifications (account_id, title, text, created_at) VALUES (?, ?, ?, ?)');
  const request = db.prepare("INSERT INTO requests (student_id, type, status, created_at) VALUES (?, ?, 'submitted', ?)");
  const history = db.prepare("INSERT INTO request_history (request_id, status, note, created_at) VALUES (?, 'submitted', '', ?)");
  const assignment = db.prepare('INSERT INTO assignments (enrollment_id, title, description, due_at, max_points) VALUES (?, ?, ?, ?, ?)');
  const submission = db.prepare(`
    INSERT INTO submissions (assignment_id, filename, media_type, contents, points, comment, status)
    VALUES (?, ?, ?, ?, ?, ?, 'reviewed')
  `);
  const now = Date.now();
  const createdAt = new Date(now).toISOString();
  const deadline = (days) => new Date(now + days * 86_400_000).toISOString();
  const document = demoPdf();

  for (const [index, fixture] of studentFixtures.entries()) {
    const studentId = account.get(fixture.login).id;
    rename.run(fixture.name, studentId);
    for (const [subjectIndex, [title, teacher, control, criteria]] of subjects.entries()) {
      for (const oldTitle of fixture.titles[subjectIndex]) changeLesson.run(title, teacher, studentId, oldTitle);
      const previousPoints = 74 + (subjectIndex * 3 + index * 5) % 23;
      const result = control === 'Зачёт' ? 'Зачтено' : previousPoints >= 85 ? 'Отлично' : 'Хорошо';
      const completion = control === 'Зачёт' ? 'Для зачёта' : 'Для сдачи экзамена';
      const courseCriteria = `${criteria} ${completion} нужны не менее 60% баллов и подтверждённый итог контроля.`;
      enroll.run(studentId, null, title, 1, previousPoints, 100, control, result, courseCriteria);
      const assigned = subjectIndex === 0;
      const { lastInsertRowid: enrollmentId } = enroll.run(
        studentId, assigned ? teacherId : null, title, currentSemester,
        36 + subjectIndex * 3 + index * 4, assigned ? 40 : 100, control, null, courseCriteria,
      );
      if (assigned) {
        const { lastInsertRowid: reviewedId } = assignment.run(
          enrollmentId, 'Журнал практических наблюдений',
          'Опишите последовательность работы, отметьте изменения и сформулируйте вывод.', deadline(-2), 15,
        );
        submission.run(reviewedId, 'Демонстрационная работа.pdf', PDF, document, 12 + index,
          'Последовательность описана верно. Уточните, чем подтверждается вывод.');
        assignment.run(enrollmentId, index === 0 ? 'Разбор рецепта' : 'Таблица свойств ингредиентов',
          'Приведите ход работы и объясните, как свойства ингредиентов влияют на результат.', deadline(index + 1), 25);
        assignment.run(enrollmentId, 'Отчёт по практикуму',
          'Сопоставьте ожидаемый и фактический результаты и объясните расхождения.', deadline(index + 3), 20);
      }
    }
    const { lastInsertRowid: deanDialogue } = makeDialogue.run(studentId, deanId);
    const { lastInsertRowid: teacherDialogue } = makeDialogue.run(studentId, teacherId);
    message.run(deanDialogue, deanId, 'Демо-сообщение. Здесь можно написать в деканат и уточнить статус справки.', createdAt);
    notice.run(studentId, 'Доступны задания', 'Откройте раздел «Задания», чтобы посмотреть сроки и комментарии.', createdAt);
    if (index === 0) {
      message.run(teacherDialogue, teacherId,
        'Демо-сообщение. Журнал наблюдений проверен. Комментарий доступен в задании.', createdAt);
      const { lastInsertRowid: requestId } = request.run(studentId, 'Справка об обучении', createdAt);
      history.run(requestId, createdAt);
    }
  }
}

function seedLessonCancellation(db, { today, monday }) {
  const todayWeekday = new Date(`${today}T00:00:00Z`).getUTCDay() || 7;
  const nextLesson = db.prepare(`
    SELECT l.id, l.student_id, l.title, l.start_time, l.weekday FROM lessons l
    JOIN students s ON s.id = l.student_id WHERE s.login = 'student1'
    ORDER BY l.weekday <= ?, l.weekday, l.start_time, l.id LIMIT 1
  `).get(todayWeekday);
  if (nextLesson) {
    const lessonDate = new Date(monday);
    const offset = nextLesson.weekday <= todayWeekday ? 7 : 0;
    lessonDate.setUTCDate(lessonDate.getUTCDate() + nextLesson.weekday - 1 + offset);
    const date = lessonDate.toISOString().slice(0, 10);
    const displayDate = date.split('-').reverse().join('.');
    db.prepare('INSERT INTO lesson_cancellations (lesson_id, date, change) VALUES (?, ?, ?)')
      .run(nextLesson.id, date, 'Занятие отменено.');
    db.prepare('INSERT INTO notifications (account_id, title, text, created_at) VALUES (?, ?, ?, ?)')
      .run(nextLesson.student_id, 'Занятие отменено',
        `${nextLesson.title} · ${displayDate} · ${nextLesson.start_time}.`, new Date().toISOString());
  }
}

function migrateAppeals(db) {
  db.exec(`
    ALTER TABLE appeals RENAME TO previous_appeals;
    CREATE TABLE appeals (
      id INTEGER PRIMARY KEY,
      submission_id INTEGER NOT NULL UNIQUE REFERENCES submissions(id),
      reason TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending', 'decided', 'withdrawn')),
      comment TEXT,
      old_points REAL NOT NULL,
      new_points REAL,
      created_at TEXT NOT NULL,
      decided_at TEXT,
      withdrawn_at TEXT
    ) STRICT;
    INSERT INTO appeals (id, submission_id, reason, status, comment, old_points, new_points, created_at, decided_at)
      SELECT id, submission_id, reason, status, comment, old_points, new_points, created_at, decided_at
      FROM previous_appeals;
    DROP TABLE previous_appeals;
    CREATE TABLE appeal_history (
      id INTEGER PRIMARY KEY,
      appeal_id INTEGER NOT NULL REFERENCES appeals(id),
      status TEXT NOT NULL CHECK (status IN ('pending', 'decided', 'withdrawn')),
      created_at TEXT NOT NULL
    ) STRICT;
    CREATE INDEX appeal_history_appeal ON appeal_history(appeal_id, id);
    INSERT INTO appeal_history (appeal_id, status, created_at) SELECT id, 'pending', created_at FROM appeals;
    INSERT INTO appeal_history (appeal_id, status, created_at)
      SELECT id, 'decided', decided_at FROM appeals WHERE status = 'decided' AND decided_at IS NOT NULL;
    PRAGMA user_version = 4;
  `);
}

const libraryBooks = [
  ['Архив звёздных карт', 'Вера Лучина', 'Астрономия', 'Учебные заметки о наблюдении звёзд.'],
  ['Наблюдения за ночным небом', 'Павел Сумеркин', 'Астрономия', 'Демонстрационный журнал наблюдений.'],
  ['Записки о лунных травах', 'Лада Ветрина', 'Травология', 'Заметки по распознаванию учебных образцов.'],
  ['Теплица под стеклом', 'Анна Родникова', 'Травология', 'Введение в уход за растениями.'],
  ['Основы зельеварения', 'Илья Туманцев', 'Зельеварение', 'Справочник по работе с учебными рецептами.'],
  ['Лабораторный журнал зельевара', 'Марина Полевица', 'Зельеварение', 'Как записывать измерения и наблюдения.'],
  ['Грамматика заклинаний', 'Ольга Перелесова', 'Заклинания', 'Учебные примеры произношения.'],
  ['Форма и превращение', 'Егор Клинок', 'Трансфигурация', 'Разбор последовательностей преобразования.'],
  ['Практика защитных чар', 'Виктор Вересин', 'Защита от тёмных искусств', 'Разбор вымышленных учебных ситуаций.'],
].map(([title, author, subject, description], index) => ({ id: index + 1, title, author, subject, description }));

export function seedCabinet(db, week) {
  const version = db.prepare('PRAGMA user_version').get().user_version;
  if (version < 2) seedCabinetFixtures(db);
  if (version < 3) seedLessonCancellation(db, week);
  if (version < 4) migrateAppeals(db);
  if (version < 5) db.exec(`
    CREATE TABLE library_favorites (
      account_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
      book_id INTEGER NOT NULL,
      PRIMARY KEY (account_id, book_id)
    ) STRICT;
    PRAGMA user_version = 5;
  `);
  if (version < 6) db.exec(`
    ALTER TABLE messages ADD COLUMN client_id TEXT;
    ALTER TABLE messages ADD COLUMN is_delivered INTEGER NOT NULL DEFAULT 0 CHECK (is_delivered IN (0, 1));
    ALTER TABLE messages ADD COLUMN is_read INTEGER NOT NULL DEFAULT 0 CHECK (is_read IN (0, 1) AND is_read <= is_delivered);
    UPDATE messages AS m SET is_delivered = 1, is_read = 1
    FROM dialogues AS d WHERE d.id = m.dialogue_id
      AND m.id <= CASE WHEN m.sender_id = d.student_id THEN d.staff_read_id ELSE d.student_read_id END;
    ALTER TABLE dialogues DROP COLUMN student_read_id;
    ALTER TABLE dialogues DROP COLUMN staff_read_id;
    CREATE UNIQUE INDEX messages_client_id ON messages(dialogue_id, sender_id, client_id);
    PRAGMA user_version = 6;
  `);
}

function isPdf(contents) {
  if (!/^%PDF-(?:1\.[0-7]|2\.0)[\r\n]/.test(contents.toString('latin1', 0, 10))) return false;
  const end = contents.toString('latin1', Math.max(0, contents.length - 4096));
  const reference = /startxref\s+(\d+)\s+%%EOF\s*$/.exec(end);
  if (!reference) return false;
  const offset = Number(reference[1]);
  if (!Number.isSafeInteger(offset) || offset < 9 || offset >= contents.length) return false;
  const table = contents.toString('latin1', offset, Math.min(offset + 4096, contents.length));
  return /^xref\s+\d+\s+\d+\s+/.test(table)
    || /^\d+\s+\d+\s+obj\s*<<[\s\S]*?\/Type\s*\/XRef\b[\s\S]*?\bstream[\r\n]/.test(table);
}

function zipDirectory(contents) {
  for (let end = contents.length - 22; end >= Math.max(0, contents.length - 65_557); end--) {
    if (contents.readUInt32LE(end) !== 0x06054b50
      || end + 22 + contents.readUInt16LE(end + 20) !== contents.length) continue;
    const count = contents.readUInt16LE(end + 10);
    const offset = contents.readUInt32LE(end + 16);
    if (contents.readUInt32LE(end + 4) !== 0 || contents.readUInt16LE(end + 8) !== count
      || offset + contents.readUInt32LE(end + 12) !== end) return null;
    return { count, offset, end };
  }
  return null;
}

const docxParts = [
  '[Content_Types].xml',
  '_rels/.rels',
  'word/document.xml',
];

function docxXml(contents, entry) {
  const { method, size, checksum, originalSize, offset } = entry;
  const maxXmlBytes = 32 * 1024 * 1024;
  if (originalSize < 1 || originalSize > maxXmlBytes) return null;
  const compressed = contents.subarray(offset, offset + size);
  const xml = method === 0 ? compressed : inflateRawSync(compressed, { maxOutputLength: maxXmlBytes });
  if (xml.length !== originalSize || crc32(xml) !== checksum) return null;
  const mark = xml.subarray(0, 2);
  const encoding = mark[0] === 0xff && mark[1] === 0xfe ? 'utf-16le'
    : mark[0] === 0xfe && mark[1] === 0xff ? 'utf-16be' : 'utf-8';
  return new TextDecoder(encoding, { fatal: true }).decode(xml);
}

function hasXmlRoot(xml, name) {
  const root = new RegExp(`^\\s*(?:<\\?xml[\\s\\S]*?\\?>\\s*)?<(?:[\\w.-]+:)?${name}(?=\\s|>)`);
  const close = new RegExp(`<\\/(?:[\\w.-]+:)?${name}\\s*>\\s*$`);
  return Boolean(xml && root.test(xml) && close.test(xml));
}

function isDocx(contents) {
  const directory = zipDirectory(contents);
  if (!directory) return false;
  const parts = new Map();
  let cursor = directory.offset;
  for (let entry = 0; entry < directory.count; entry++) {
    if (cursor + 46 > directory.end || contents.readUInt32LE(cursor) !== 0x02014b50) return false;
    const flags = contents.readUInt16LE(cursor + 8);
    const method = contents.readUInt16LE(cursor + 10);
    const checksum = contents.readUInt32LE(cursor + 16);
    const size = contents.readUInt32LE(cursor + 20);
    const originalSize = contents.readUInt32LE(cursor + 24);
    const nameSize = contents.readUInt16LE(cursor + 28);
    const extraSize = contents.readUInt16LE(cursor + 30);
    const commentSize = contents.readUInt16LE(cursor + 32);
    const local = contents.readUInt32LE(cursor + 42);
    const nameStart = cursor + 46;
    cursor = nameStart + nameSize + extraSize + commentSize;
    if (cursor > directory.end || nameSize === 0 || local + 30 > directory.offset
      || contents.readUInt32LE(local) !== 0x04034b50 || flags & 1
      || contents.readUInt16LE(local + 6) !== flags || contents.readUInt16LE(local + 8) !== method) return false;
    const filename = contents.subarray(nameStart, nameStart + nameSize);
    const localNameSize = contents.readUInt16LE(local + 26);
    const offset = local + 30 + localNameSize + contents.readUInt16LE(local + 28);
    if (offset + size > directory.offset || nameSize !== localNameSize
      || !filename.equals(contents.subarray(local + 30, local + 30 + localNameSize))) return false;
    const name = filename.toString('utf8');
    if (!docxParts.includes(name)) continue;
    if (parts.has(name) || ![0, 8].includes(method)) return false;
    parts.set(name, { method, checksum, size, originalSize, offset });
  }
  if (cursor !== directory.end || parts.size !== docxParts.length) return false;
  try {
    const [types, relationships, document] = docxParts.map((name) => docxXml(contents, parts.get(name)));
    return hasXmlRoot(types, 'Types') && types.includes('wordprocessingml.document.main+xml')
      && hasXmlRoot(relationships, 'Relationships') && relationships.includes('/officeDocument')
      && hasXmlRoot(document, 'document') && /wordprocessingml\/(?:2006\/main|main)/.test(document)
      && /<(?:[\w.-]+:)?body(?=\s|\/?>)/.test(document);
  } catch {
    return false;
  }
}

function filenameHeader(filename) {
  const encoded = encodeURIComponent(filename).replace(/[!'()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename*=UTF-8''${encoded}`;
}

const searchSections = [
  ['home', 'Главная'],
  ['schedule', 'Расписание', ['student']],
  ['grades', 'Успеваемость', ['student', 'teacher'], 'оценки баллы'],
  ['assignments', 'Задания', ['student', 'teacher']],
  ['requests', 'Справки и документы', ['student', 'dean'], 'заявки'],
  ['messages', 'Сообщения'],
  ['updates', 'Уведомления'],
  ['contacts', 'Контакты', null, 'преподаватели'],
  ['library', 'Библиотека'],
  ['campus', 'Карта кампуса', null, 'кампус'],
  ['help', 'Помощник по кабинету', null, 'FAQ частые вопросы'],
  ['profile', 'Профиль'],
];

function searchText(value) {
  return value.normalize('NFC').toLowerCase().replaceAll('ё', 'е').replace(/\s+/g, ' ').trim();
}

export function createCabinet(db, { transaction, HttpError, bytesBody, jsonBody, json }) {
  const prepare = (sql) => db.prepare(sql);
  const grades = prepare(`
    SELECT e.id, subject, semester,
      coursework_points + COALESCE(SUM(s.points), 0) AS points,
      coursework_max + COALESCE(SUM(a.max_points), 0) AS maxPoints,
      control, result, criteria, student.full_name AS studentName
    FROM enrollments e JOIN students student ON student.id = e.student_id
    LEFT JOIN assignments a ON a.enrollment_id = e.id
    LEFT JOIN submissions s ON s.assignment_id = a.id AND s.status = 'reviewed'
    WHERE (e.student_id = ? AND ? = 'student') OR (e.teacher_id = ? AND ? = 'teacher')
    GROUP BY e.id
    ORDER BY semester DESC, studentName, e.id
  `);
  const requests = prepare(`
    SELECT r.id, type, status, created_at AS createdAt, student.full_name AS studentName
    FROM requests r JOIN students student ON student.id = r.student_id
    WHERE r.student_id = ? OR ? = 'dean'
    ORDER BY r.id DESC
  `);
  const requestHistory = prepare(`
    SELECT status, note, created_at AS createdAt FROM request_history WHERE request_id = ? ORDER BY id
  `);
  const requestById = prepare('SELECT student_id, status, type FROM requests WHERE id = ?');
  const createRequest = prepare("INSERT INTO requests (student_id, type, status, created_at) VALUES (?, ?, 'submitted', ?)");
  const createHistory = prepare('INSERT INTO request_history (request_id, status, note, created_at) VALUES (?, ?, ?, ?)');
  const updateRequest = prepare('UPDATE requests SET status = ? WHERE id = ?');
  const dean = prepare("SELECT id FROM students WHERE role = 'dean'");
  const dialogues = prepare(`
    SELECT d.id,
      CASE WHEN partner.role = 'dean' THEN 'Деканат' ELSE partner.full_name END AS title,
      CASE WHEN partner.role = 'teacher' THEN partner.full_name END AS teacherName,
      partner.full_name AS fullName,
      CASE partner.role WHEN 'dean' THEN 'Деканат' WHEN 'teacher' THEN 'Преподаватель'
        ELSE COALESCE(NULLIF(TRIM(partner.student_group), ''), 'Студент') END AS roleLabel,
      last.text AS lastText, last.sender_id = :viewerId AS lastMine, last.created_at AS lastAt,
      (SELECT COUNT(*) FROM messages m WHERE m.dialogue_id = d.id AND m.sender_id <> :viewerId
        AND m.is_read = 0) AS unreadCount
    FROM dialogues d
    JOIN students partner ON partner.id = CASE WHEN d.student_id = :viewerId THEN d.staff_id ELSE d.student_id END
    LEFT JOIN messages last ON last.id = (SELECT m.id FROM messages m WHERE m.dialogue_id = d.id ORDER BY m.id DESC LIMIT 1)
    WHERE d.student_id = :viewerId OR d.staff_id = :viewerId
    ORDER BY last.created_at DESC, last.id DESC, d.id
  `);
  const contactNames = prepare(`
    SELECT teacher AS name FROM lessons WHERE student_id = :viewerId
    UNION
    SELECT staff.full_name FROM dialogues d JOIN students staff ON staff.id = d.staff_id
    WHERE d.student_id = :viewerId AND staff.role = 'teacher'
    UNION
    SELECT staff.full_name FROM enrollments e JOIN students staff ON staff.id = e.teacher_id
    WHERE e.student_id = :viewerId AND staff.role = 'teacher'
  `);
  const dialogueById = prepare('SELECT id FROM dialogues WHERE id = ? AND (student_id = ? OR staff_id = ?)');
  const messageFields = `
    SELECT m.id, m.sender_id = :viewerId AS mine, sender.full_name AS sender, m.text, m.created_at AS createdAt,
      m.is_delivered AS delivered, m.is_read AS read,
      CASE WHEN m.sender_id = :viewerId THEN m.client_id END AS clientId
    FROM messages m JOIN students sender ON sender.id = m.sender_id
    WHERE m.dialogue_id = :dialogueId
  `;
  const messages = prepare(`${messageFields} ORDER BY m.id`);
  const writtenMessage = prepare(`${messageFields} AND m.id = :messageId`);
  const sentWithClientId = prepare(`${messageFields} AND m.sender_id = :viewerId AND m.client_id = :clientId`);
  const setReceipt = prepare(`
    UPDATE messages SET is_delivered = 1, is_read = MAX(is_read, ?)
    WHERE id = ? AND dialogue_id = ? AND sender_id <> ?
  `);
  const sendMessage = prepare(`
    INSERT INTO messages (dialogue_id, sender_id, text, created_at, client_id) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(dialogue_id, sender_id, client_id) DO NOTHING RETURNING id
  `);
  const notifications = prepare(`
    SELECT id, title, text, created_at AS createdAt FROM notifications WHERE account_id = ? ORDER BY id DESC
  `);
  const createNotice = prepare('INSERT INTO notifications (account_id, title, text, created_at) VALUES (?, ?, ?, ?)');
  const assessments = prepare(`
    SELECT a.id, e.subject, student.full_name AS studentName, a.title, a.description,
      a.due_at AS dueAt, a.max_points AS maxPoints,
      s.id AS submissionId, s.filename, s.points, s.comment, s.status
    FROM assignments a JOIN enrollments e ON e.id = a.enrollment_id
    JOIN students student ON student.id = e.student_id
    LEFT JOIN submissions s ON s.assignment_id = a.id
    WHERE e.student_id = ? OR e.teacher_id = ?
    ORDER BY a.due_at, a.id
  `);
  const teacherEnrollment = prepare(`
    SELECT student_id FROM enrollments WHERE id = ? AND teacher_id = ? AND semester = ?
  `);
  const createAssignment = prepare(`
    INSERT INTO assignments (enrollment_id, title, description, due_at, max_points) VALUES (?, ?, ?, ?, ?)
  `);
  const studentAssignment = prepare(`
    SELECT a.title, e.teacher_id, s.status FROM assignments a JOIN enrollments e ON e.id = a.enrollment_id
    LEFT JOIN submissions s ON s.assignment_id = a.id WHERE a.id = ? AND e.student_id = ?
  `);
  const saveSubmission = prepare(`
    INSERT INTO submissions (assignment_id, filename, media_type, contents, status) VALUES (?, ?, ?, ?, 'submitted')
    ON CONFLICT (assignment_id) DO UPDATE SET id = excluded.id, filename = excluded.filename,
      media_type = excluded.media_type, contents = excluded.contents
    WHERE submissions.filename <> excluded.filename OR submissions.media_type <> excluded.media_type
      OR submissions.contents <> excluded.contents
  `);
  const file = prepare(`
    SELECT s.filename, s.media_type, s.contents FROM submissions s JOIN assignments a ON a.id = s.assignment_id
    JOIN enrollments e ON e.id = a.enrollment_id WHERE s.id = ? AND (e.student_id = ? OR e.teacher_id = ?)
  `);
  const submissionById = prepare(`
    SELECT s.status, s.points, a.title, a.max_points, e.student_id, e.teacher_id
    FROM submissions s JOIN assignments a ON a.id = s.assignment_id JOIN enrollments e ON e.id = a.enrollment_id
    WHERE s.id = ? AND (e.student_id = ? OR e.teacher_id = ?)
  `);
  const review = prepare("UPDATE submissions SET points = ?, comment = ?, status = 'reviewed' WHERE id = ?");
  const appeals = prepare(`
    SELECT p.id, p.submission_id AS submissionId, a.title, p.reason, p.status, p.comment,
      p.old_points AS oldPoints, p.new_points AS newPoints, p.created_at AS createdAt,
      p.decided_at AS decidedAt, p.withdrawn_at AS withdrawnAt,
      (SELECT json_group_array(json_object('status', h.status, 'createdAt', h.created_at) ORDER BY h.id)
       FROM appeal_history h WHERE h.appeal_id = p.id) AS history
    FROM appeals p JOIN submissions s ON s.id = p.submission_id JOIN assignments a ON a.id = s.assignment_id
    JOIN enrollments e ON e.id = a.enrollment_id WHERE e.student_id = ? OR e.teacher_id = ?
    ORDER BY p.id DESC
  `);
  const createAppealEvent = prepare('INSERT INTO appeal_history (appeal_id, status, created_at) VALUES (?, ?, ?)');
  const openAppeal = prepare(`
    INSERT INTO appeals (submission_id, reason, status, old_points, created_at)
    VALUES (?, ?, 'pending', ?, ?) ON CONFLICT (submission_id) DO NOTHING
  `);
  const studentAppeal = prepare(`
    SELECT p.id FROM appeals p JOIN submissions s ON s.id = p.submission_id
    JOIN assignments a ON a.id = s.assignment_id JOIN enrollments e ON e.id = a.enrollment_id
    WHERE p.id = ? AND e.student_id = ?
  `);
  const teacherAppeal = prepare(`
    SELECT p.submission_id, p.status, s.points, a.title, a.max_points, e.student_id
    FROM appeals p JOIN submissions s ON s.id = p.submission_id JOIN assignments a ON a.id = s.assignment_id
    JOIN enrollments e ON e.id = a.enrollment_id WHERE p.id = ? AND e.teacher_id = ?
  `);
  const decideAppeal = prepare(`
    UPDATE appeals SET status = 'decided', comment = ?, new_points = ?, decided_at = ?
    WHERE id = ? AND status = 'pending'
  `);
  const withdrawAppeal = prepare(`
    UPDATE appeals SET status = 'withdrawn', withdrawn_at = ? WHERE id = ? AND status = 'pending'
  `);
  const updatePoints = prepare('UPDATE submissions SET points = ? WHERE id = ?');

  function found(resource, message) {
    if (!resource) throw new HttpError(404, message);
    return resource;
  }

  function text(value, label, max, required = true) {
    if (value === undefined && !required) return '';
    if (typeof value !== 'string' || value.length > max || (required && !value.trim())) {
      throw new HttpError(400, `${label}. Допустимо до ${max} символов.`);
    }
    return value.trim();
  }

  function score(value, min, max) {
    if (!Number.isFinite(value) || value < min || value > max) {
      throw new HttpError(400, `Укажите количество баллов от ${min} до ${max}.`);
    }
    return value;
  }

  function deadline(value) {
    if (typeof value !== 'string'
      || !/^\d{4}-\d{2}-\d{2}(?:T(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})?)?$/.test(value)) {
      throw new HttpError(400, 'Укажите дату сдачи.');
    }
    const date = value.slice(0, 10);
    const calendar = new Date(`${date}T00:00:00Z`);
    const zoned = value === date ? `${date}T23:59:59.999+03:00`
      : /(?:Z|[+-]\d{2}:\d{2})$/.test(value) ? value : `${value}+03:00`;
    const timestamp = new Date(zoned);
    if (!Number.isFinite(calendar.getTime()) || calendar.toISOString().slice(0, 10) !== date
      || !Number.isFinite(timestamp.getTime())) throw new HttpError(400, 'Укажите действительную дату сдачи.');
    return timestamp.toISOString();
  }

  function now() {
    return new Date().toISOString();
  }

  function contacts(viewer) {
    return viewer.role === 'student' ? contactNames.all({ viewerId: viewer.id })
      .map(({ name }) => demoContact(name)).filter(Boolean)
      .sort((first, second) => first.name.localeCompare(second.name, 'ru')) : [];
  }

  function cabinet(viewer) {
    const { id, role } = viewer;
    const conversations = dialogues.all({ viewerId: id })
      .map(({ teacherName, lastMine, ...dialogue }) => ({
        ...dialogue, lastMine: lastMine === null ? null : Boolean(lastMine), contact: demoContact(teacherName),
      }));
    return {
      grades: role === 'dean' ? [] : grades.all(id, role, id, role),
      requests: role === 'teacher' ? [] : requests.all(id, role)
        .map((row) => ({ ...row, history: requestHistory.all(row.id) })),
      dialogues: conversations,
      assignments: role === 'dean' ? [] : assessments.all(id, id)
        .map(({ submissionId, filename, points, comment, status, ...assignment }) => ({
          ...assignment,
          submission: submissionId === null ? null : { id: submissionId, filename, points, comment, status },
        })),
      appeals: role === 'dean' ? [] : appeals.all(id, id)
        .map(({ history, ...appeal }) => ({ ...appeal, history: JSON.parse(history) })),
      notifications: notifications.all(id),
      contacts: contacts(viewer),
      unreadCount: conversations.reduce((total, dialogue) => total + dialogue.unreadCount, 0),
    };
  }

  function search(viewer, query) {
    const results = [];
    const normalized = searchText(query);
    if (!normalized) return { results };
    const words = normalized.split(' ');
    const { id, role } = viewer;

    function add(type, title, view, target, ...fields) {
      if (results.length >= 30) return;
      const searchable = searchText([title, ...fields].join(' '));
      if (words.every((word) => searchable.includes(word))) results.push({ type, title, view, id: target });
    }

    for (const [view, title, roles, keywords] of searchSections) {
      if (!roles || roles.includes(role)) add('section', title, view, null, keywords);
    }
    if (role === 'student') {
      for (const item of documents) {
        add('document', item.title, 'requests', 'document-' + item.id, item.description);
      }
    }
    for (const item of faqFor(role)) {
      add('faq', item.title, 'help', 'faq-' + item.id, ...item.terms);
    }
    if (role === 'student' || role === 'teacher') {
      for (const grade of grades.all(id, role, id, role)) {
        add('grade', grade.subject, 'grades', `grade-${grade.id}`,
          grade.studentName, grade.criteria, grade.semester, grade.control, grade.result);
      }
      for (const assignment of assessments.all(id, id)) {
        add('assignment', assignment.title, 'assignments', `assignment-${assignment.id}`,
          assignment.studentName, assignment.subject, assignment.description);
      }
    }
    if (role === 'student' || role === 'dean') {
      for (const request of requests.all(id, role)) {
        add('request', request.type, 'requests', `request-${request.id}`, request.studentName);
      }
    }
    for (const notice of notifications.all(id)) {
      add('notification', notice.title, 'updates', `notice-${notice.id}`, notice.text);
    }
    for (const contact of contacts(viewer)) {
      add('contact', contact.name, 'contacts', `contact-${contact.id}`, contact.email);
    }
    return { results };
  }

  function submitRequest(viewer, _id, body) {
    const type = text(body.type, 'Укажите вид справки', 80);
    if (!documents.some((item) => item.title === type)) throw new HttpError(400, 'Выберите вид документа из каталога.');
    const createdAt = now();
    const { lastInsertRowid } = createRequest.run(viewer.id, type, createdAt);
    createHistory.run(lastInsertRowid, 'submitted', '', createdAt);
    for (const { id } of dean.all()) createNotice.run(id, 'Новая заявка на справку', type, createdAt);
  }

  function changeRequest(_viewer, id, body) {
    const request = found(requestById.get(id), 'Заявка не найдена.');
    const { status } = body;
    const allowed = ['processing', 'ready', 'rejected'];
    if (!allowed.includes(status)) throw new HttpError(400, 'Выберите статус заявки.');
    if (!['submitted', 'processing'].includes(request.status) || request.status === status) {
      throw new HttpError(409, 'Этот переход статуса недоступен.');
    }
    const note = text(body.note, 'Введите комментарий', 1500, false);
    const createdAt = now();
    updateRequest.run(status, id);
    createHistory.run(id, status, note, createdAt);
    const label = { processing: 'в обработке', ready: 'готова', rejected: 'отклонена' }[status];
    createNotice.run(request.student_id, 'Обновлён статус заявки', `${request.type} · ${label}.`, createdAt);
  }

  function ownedDialogue(viewer, id) {
    found(dialogueById.get(id, viewer.id, viewer.id), 'Диалог не найден.');
  }

  function messageView({ mine, delivered, read, clientId, ...message }) {
    return {
      ...message, mine: Boolean(mine), delivered: Boolean(delivered), read: Boolean(read),
      ...(clientId === null ? {} : { clientId }),
    };
  }

  function dialogueMessages(viewer, id) {
    ownedDialogue(viewer, id);
    return {
      messages: messages.all({ viewerId: viewer.id, dialogueId: id }).map(messageView),
    };
  }

  function markReceipts(viewer, id, messageIds, read) {
    if (!Array.isArray(messageIds) || messageIds.some((messageId) => !Number.isSafeInteger(messageId) || messageId < 1)) {
      throw new HttpError(400, 'Укажите список идентификаторов сообщений.');
    }
    for (const messageId of new Set(messageIds)) {
      if (!setReceipt.run(read, messageId, id, viewer.id).changes) throw new HttpError(404, 'Сообщение не найдено.');
    }
  }

  function deliverMessages(viewer, id, { messageIds }) {
    ownedDialogue(viewer, id);
    markReceipts(viewer, id, messageIds, 0);
  }

  function readDialogue(viewer, id, { messageIds }) {
    ownedDialogue(viewer, id);
    markReceipts(viewer, id, messageIds, 1);
  }

  function writeMessage(viewer, id, { text: input, clientId }) {
    ownedDialogue(viewer, id);
    const content = text(input, 'Введите сообщение', 2000);
    if (clientId !== undefined && (typeof clientId !== 'string' || !clientId.trim() || clientId.length > 128)) {
      throw new HttpError(400, 'Недопустимый идентификатор отправки.');
    }
    const lookup = { viewerId: viewer.id, dialogueId: id };
    const inserted = sendMessage.get(id, viewer.id, content, now(), clientId ?? null);
    const message = inserted
      ? writtenMessage.get({ ...lookup, messageId: inserted.id })
      : sentWithClientId.get({ ...lookup, clientId });
    if (message.text !== content) throw new HttpError(409, 'Идентификатор отправки уже использован.');
    return { message: messageView(message) };
  }

  function assignWork(viewer, _id, body) {
    const enrollmentId = body.enrollmentId;
    if (!Number.isSafeInteger(enrollmentId) || enrollmentId <= 0) throw new HttpError(400, 'Выберите назначение.');
    const enrollment = found(teacherEnrollment.get(enrollmentId, viewer.id, currentSemester), 'Назначение не найдено.');
    const title = text(body.title, 'Укажите название задания', 120);
    const description = text(body.description, 'Введите описание задания', 2000);
    createAssignment.run(enrollmentId, title, description, deadline(body.dueAt), score(body.maxPoints, 0.01, 1000));
    createNotice.run(enrollment.student_id, 'Новое задание', title, now());
  }

  function ownedAssignment(viewer, id) {
    const assignment = found(studentAssignment.get(id, viewer.id), 'Задание не найдено.');
    if (assignment.status === 'reviewed') throw new HttpError(409, 'Работа уже проверена.');
    return assignment;
  }

  async function upload(request, viewer, id) {
    ownedAssignment(viewer, id);
    const mediaType = request.headers['content-type']?.split(';', 1)[0].trim().toLowerCase();
    if (mediaType !== PDF && mediaType !== DOCX) throw new HttpError(415, 'Прикрепите файл PDF или DOCX.');
    let filename;
    try {
      filename = decodeURIComponent(request.headers['x-filename'] ?? '');
    } catch {
      throw new HttpError(400, 'Не удалось прочитать имя файла.');
    }
    const extension = mediaType === PDF ? '.pdf' : '.docx';
    // eslint-disable-next-line no-control-regex -- Reject control characters in uploaded filenames.
    if (!filename || filename.length > 180 || /[\u0000-\u001f\u007f/\\]/.test(filename)
      || !filename.trim().toLowerCase().endsWith(extension)) throw new HttpError(400, 'Проверьте имя и расширение файла.');
    const contents = await bytesBody(request, maxUpload);
    if (!(mediaType === PDF ? isPdf(contents) : isDocx(contents))) {
      throw new HttpError(415, 'Содержимое файла не соответствует формату PDF или DOCX.');
    }
    return { filename, mediaType, contents };
  }

  function submitWork(viewer, id, { filename, mediaType, contents }) {
    const assignment = ownedAssignment(viewer, id);
    if (saveSubmission.run(id, filename, mediaType, contents).changes) {
      createNotice.run(assignment.teacher_id, 'Работа на проверку', assignment.title, now());
    }
  }

  function workFile(viewer, id) {
    return found(file.get(id, viewer.id, viewer.id), 'Файл не найден.');
  }

  function checkWork(viewer, id, body) {
    const work = found(submissionById.get(id, viewer.id, viewer.id), 'Работа не найдена.');
    if (work.status !== 'submitted') throw new HttpError(409, 'Работа уже проверена.');
    const points = score(body.points, 0, work.max_points);
    const comment = text(body.comment, 'Введите комментарий к работе', 1500);
    review.run(points, comment, id);
    createNotice.run(work.student_id, 'Работа проверена', work.title, now());
  }

  function requestAppeal(viewer, id, body) {
    const work = found(submissionById.get(id, viewer.id, viewer.id), 'Работа не найдена.');
    if (work.status !== 'reviewed') throw new HttpError(409, 'Оценка за работу ещё не выставлена.');
    const reason = text(body.reason, 'Объясните причину пересмотра', 1500);
    const createdAt = now();
    const opened = openAppeal.run(id, reason, work.points, createdAt);
    if (!opened.changes) {
      throw new HttpError(409, 'Для этой работы уже есть запрос на пересмотр.');
    }
    createAppealEvent.run(opened.lastInsertRowid, 'pending', createdAt);
    createNotice.run(work.teacher_id, 'Запрос на пересмотр', work.title, createdAt);
  }

  function resolveAppeal(viewer, id, body) {
    const appeal = found(teacherAppeal.get(id, viewer.id), 'Обращение не найдено.');
    if (appeal.status !== 'pending') throw new HttpError(409, 'Этот переход статуса недоступен.');
    const comment = text(body.comment, 'Введите решение по пересмотру', 1500);
    const points = body.points === null ? appeal.points : score(body.points, 0, appeal.max_points);
    const decidedAt = now();
    if (!decideAppeal.run(comment, points, decidedAt, id).changes) {
      throw new HttpError(409, 'Этот переход статуса недоступен.');
    }
    updatePoints.run(points, appeal.submission_id);
    createAppealEvent.run(id, 'decided', decidedAt);
    createNotice.run(appeal.student_id, 'Запрос на пересмотр рассмотрен', appeal.title, decidedAt);
  }

  function retractAppeal(viewer, id) {
    found(studentAppeal.get(id, viewer.id), 'Обращение не найдено.');
    const withdrawnAt = now();
    if (!withdrawAppeal.run(withdrawnAt, id).changes) {
      throw new HttpError(409, 'Этот переход статуса недоступен.');
    }
    createAppealEvent.run(id, 'withdrawn', withdrawnAt);
  }

  const favoriteBooks = prepare('SELECT book_id FROM library_favorites WHERE account_id = ?');
  const addFavorite = prepare('INSERT OR IGNORE INTO library_favorites (account_id, book_id) VALUES (?, ?)');
  const removeFavorite = prepare('DELETE FROM library_favorites WHERE account_id = ? AND book_id = ?');

  function library(viewer) {
    const favorites = new Set(favoriteBooks.all(viewer.id).map(({ book_id }) => book_id));
    return { books: libraryBooks.map((book) => ({ ...book, favorite: favorites.has(book.id) })) };
  }

  function setFavorite(viewer, id, { favorite }) {
    if (!libraryBooks.some((book) => book.id === id)) throw new HttpError(404, 'Книга не найдена.');
    if (typeof favorite !== 'boolean') throw new HttpError(400, 'Укажите состояние избранного.');
    (favorite ? addFavorite : removeFavorite).run(viewer.id, id);
  }

  const routes = [
    { method: 'GET', path: /^\/api\/library$/, action: library },
    { method: 'POST', path: /^\/api\/library\/([^/]+)\/favorite$/, action: setFavorite },
    { method: 'GET', path: /^\/api\/cabinet$/, action: cabinet },
    { method: 'POST', path: /^\/api\/requests$/, role: 'student', action: submitRequest },
    { method: 'POST', path: /^\/api\/requests\/([^/]+)\/status$/, role: 'dean', action: changeRequest },
    { method: 'GET', path: /^\/api\/dialogues\/([^/]+)$/, action: dialogueMessages },
    { method: 'POST', path: /^\/api\/dialogues\/([^/]+)\/delivered$/, action: deliverMessages },
    { method: 'POST', path: /^\/api\/dialogues\/([^/]+)\/read$/, action: readDialogue },
    { method: 'POST', path: /^\/api\/dialogues\/([^/]+)\/messages$/, action: writeMessage },
    { method: 'POST', path: /^\/api\/assignments$/, role: 'teacher', action: assignWork },
    { method: 'POST', path: /^\/api\/assignments\/([^/]+)\/submission$/, role: 'student', parse: upload, action: submitWork },
    { method: 'GET', path: /^\/api\/submissions\/([^/]+)\/file$/, download: true, action: workFile },
    { method: 'POST', path: /^\/api\/submissions\/([^/]+)\/review$/, role: 'teacher', action: checkWork },
    { method: 'POST', path: /^\/api\/submissions\/([^/]+)\/appeal$/, role: 'student', action: requestAppeal },
    { method: 'POST', path: /^\/api\/appeals\/([^/]+)\/decision$/, role: 'teacher', action: resolveAppeal },
    { method: 'POST', path: /^\/api\/appeals\/([^/]+)\/withdraw$/, role: 'student', action: retractAppeal },
  ];

  function match(method, path) {
    for (const route of routes) {
      if (route.method !== method) continue;
      const matched = route.path.exec(path);
      if (matched) return { route, identifier: matched[1] };
    }
    return null;
  }

  async function handle({ route, identifier }, request, response, viewer, authenticate) {
    if (route.role && route.role !== viewer.role) throw new HttpError(403, 'Действие недоступно для вашей роли.');
    const id = identifier === undefined ? undefined : Number(identifier);
    if (identifier !== undefined && (!/^[1-9]\d*$/.test(identifier) || !Number.isSafeInteger(id))) {
      throw new HttpError(404, 'Запись не найдена.');
    }
    if (route.method === 'POST') {
      const data = route.parse ? await route.parse(request, viewer, id) : await jsonBody(request, 16 * 1024);
      if (!data || typeof data !== 'object' || Array.isArray(data)) throw new HttpError(400, 'Ожидается объект JSON.');
      const result = transaction(() => {
        const authenticated = authenticate();
        if (route.role && route.role !== authenticated.role) {
          throw new HttpError(403, 'Действие недоступно для вашей роли.');
        }
        return route.action(authenticated, id, data);
      });
      return json(response, 200, { ok: true, ...result });
    }
    const result = route.action(viewer, id);
    if (!route.download) return json(response, 200, result);
    response.writeHead(200, {
      'Content-Type': result.media_type,
      'Content-Disposition': filenameHeader(result.filename),
      'Content-Length': result.contents.length,
    });
    response.end(result.contents);
  }

  function help({ role }, query) {
    if (query === null) return { documents: role === 'student' ? documents : [], faq: faqFor(role) };
    if (query.length > 300) throw new HttpError(400, 'Вопрос должен содержать не более 300 символов.');
    return answerFor(role, query);
  }

  return { match, handle, search, help };
}
