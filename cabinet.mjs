import { crc32, inflateRawSync } from 'node:zlib';
import { certificatePdf, certificatePrint } from './certificate.mjs';
import { answerFor, documents, faqFor } from './knowledge.mjs';
import { createPortfolio, migratePortfolio } from './portfolio.mjs';

const PDF = 'application/pdf';
const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const maxUpload = 10 * 1024 * 1024;
const currentSemester = 2;
const practiceReportTitle = 'Отчёт по практикуму';
const practiceReportDescription = 'Сопоставьте ожидаемый и фактический результаты и объясните расхождения.';
const practiceReportDeadline = '2026-12-20T20:59:59.000Z';

const demoTeacherIds = new Map([
  ['Северус Снегг', 'severus-snape'],
  ['Минерва Макгонагалл', 'minerva-mcgonagall'],
  ['Филиус Флитвик', 'filius-flitwick'],
  ['Помона Стебль', 'pomona-sprout'],
  ['Аврора Синистра', 'aurora-sinistra'],
  ['Римус Люпин', 'remus-lupin'],
]);

function demoContact(name) {
  const id = demoTeacherIds.get(name);
  return id ? { id, name, email: `${id.replace('-', '.')}@example.com`, teacherId: null } : null;
}

function teacherContact({ id: teacherId, login, name }) {
  const demo = login === 'teacher1' ? demoContact(name) : null;
  const id = `teacher-${teacherId}`;
  return { ...(demo ?? { id, name, email: `${id}@example.com` }), teacherId };
}

function dialogueContact(dialogue, viewerRole, teacherLogin) {
  const { partnerId, partnerRole, fullName } = dialogue;
  if (partnerRole === 'teacher') return teacherContact({ id: partnerId, login: teacherLogin, name: fullName });
  if (partnerRole === 'dean') {
    return { id: `dean-${partnerId}`, name: 'Деканат', email: 'dean-office@example.com', teacherId: null };
  }
  if (partnerRole === 'student' && (viewerRole === 'teacher' || viewerRole === 'dean')) {
    const id = `student-${partnerId}`;
    return { id, name: fullName, email: `${id}@example.com`, teacherId: null };
  }
  return null;
}

const subjects = [
  ['Зельеварение', 'Северус Снегг', 'Экзамен', 'Техника приготовления, точность измерений и оформление наблюдений.'],
  ['Трансфигурация', 'Минерва Макгонагалл', 'Зачёт', 'Точность преобразования и соблюдение последовательности действий.'],
  ['Заклинания', 'Филиус Флитвик', 'Экзамен', 'Точность произношения, исполнение и объяснение результата.'],
  ['Травология', 'Помона Стебль', 'Зачёт', 'Определение видов, описание свойств и оформление полевых заметок.'],
  ['Астрономия', 'Аврора Синистра', 'Зачёт', 'Точность наблюдений, расчёты и полнота отчёта.'],
  ['Защита от тёмных искусств', 'Римус Люпин', 'Экзамен', 'Выбор защитного приёма, исполнение и обоснование решения.'],
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
    name: 'Крош Андреевич Речин',
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
    CREATE TABLE IF NOT EXISTS lesson_week_parity (
      lesson_id INTEGER PRIMARY KEY REFERENCES lessons(id) ON DELETE CASCADE,
      parity INTEGER NOT NULL CHECK (parity IN (0, 1))
    ) STRICT;
  `);
  if (!db.prepare("SELECT 1 FROM pragma_table_info('students') WHERE name = 'directory_only'").get()) {
    db.exec('ALTER TABLE students ADD COLUMN directory_only INTEGER NOT NULL DEFAULT 0 CHECK (directory_only IN (0, 1))');
  }
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
  const deanId = account.get('dekanat1').id;
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
        assignment.run(enrollmentId, practiceReportTitle, practiceReportDescription, practiceReportDeadline, 20);
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

function setNovemberCancellation(db) {
  const lesson = db.prepare(`
    SELECT l.id, l.student_id FROM lessons l JOIN students s ON s.id = l.student_id
    WHERE s.login = 'student1' AND l.weekday = 4 AND l.start_time = '10:40' AND l.title = 'Зельеварение'
  `).get();
  if (!lesson) return;
  db.prepare("DELETE FROM lesson_cancellations WHERE lesson_id = ? AND date = '2026-11-19'").run(lesson.id);
  db.prepare(`
    INSERT INTO lesson_cancellations (lesson_id, date, change)
    VALUES (?, '2026-11-26', 'Занятие отменено.') ON CONFLICT(lesson_id, date) DO NOTHING
  `).run(lesson.id);
  const title = 'Занятие отменено';
  const text = 'Зельеварение · 26.11.2026 · 10:40.';
  db.prepare('UPDATE notifications SET text = ? WHERE account_id = ? AND title = ? AND text = ?')
    .run(text, lesson.student_id, title, 'Зельеварение · 19.11.2026 · 10:40.');
  db.prepare(`
    INSERT INTO notifications (account_id, title, text, created_at)
    SELECT ?, ?, ?, ? WHERE NOT EXISTS (
      SELECT 1 FROM notifications WHERE account_id = ? AND title = ? AND text = ?
    )
  `).run(lesson.student_id, title, text, new Date().toISOString(), lesson.student_id, title, text);
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

function seedEvenLessons(db, schedule) {
  const student = db.prepare("SELECT id FROM students WHERE login = ? AND role = 'student'");
  const markOdd = db.prepare(`
    INSERT INTO lesson_week_parity (lesson_id, parity)
    SELECT id, 1 FROM lessons WHERE student_id = ? AND weekday = ? AND start_time = ?
  `);
  const insert = db.prepare(`
    INSERT INTO lessons (student_id, weekday, start_time, end_time, title, room, teacher, change)
    VALUES (?, ?, ?, ?, ?, ?, ?, NULL)
  `);
  const markEven = db.prepare('INSERT INTO lesson_week_parity (lesson_id, parity) VALUES (?, 0)');
  for (const [login, entries] of schedule) {
    const account = student.get(login);
    if (!account) continue;
    for (const [weekday, start, end, subject, room, replacedStart = start] of entries) {
      const [title, teacher] = subjects[subject];
      markOdd.run(account.id, weekday, replacedStart);
      const { lastInsertRowid } = insert.run(account.id, weekday, start, end, title, room, teacher);
      markEven.run(lastInsertRowid);
    }
  }
}

export function seedCabinet(db) {
  const version = db.prepare('PRAGMA user_version').get().user_version;
  if (version < 2) seedCabinetFixtures(db);
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
  if (version < 7) migratePortfolio(db);
  if (version < 8) {
    const renameTeacher = db.prepare("UPDATE students SET full_name = ? WHERE login = 'teacher1' AND role = 'teacher'");
    const updateLessons = db.prepare(`
      UPDATE lessons SET teacher = ? WHERE title = ? AND student_id IN (
        SELECT id FROM students WHERE login IN ('student1', 'student2') AND role = 'student'
      )
    `);
    renameTeacher.run(subjects[0][1]);
    for (const [title, teacher] of subjects) updateLessons.run(teacher, title);
    db.exec('PRAGMA user_version = 8');
  }
  if (version < 9) {
    db.prepare(`
      UPDATE assignments SET due_at = ? WHERE title = ? AND description = ? AND enrollment_id IN (
        SELECT e.id FROM enrollments e
        JOIN students student ON student.id = e.student_id
        JOIN students teacher ON teacher.id = e.teacher_id
        WHERE student.login IN ('student1', 'student2') AND teacher.login = 'teacher1'
          AND e.subject = 'Зельеварение' AND e.semester = ?
      )
    `).run(practiceReportDeadline, practiceReportTitle, practiceReportDescription, currentSemester);
    db.exec('PRAGMA user_version = 9');
  }
  if (version < 10) {
    db.prepare("UPDATE students SET full_name = ? WHERE login = 'student2' AND role = 'student'")
      .run(studentFixtures[1].name);
    const insert = db.prepare(`
      INSERT INTO students (login, password_salt, password_hash, full_name, faculty, program, year, student_group, role, directory_only)
      VALUES (?, X'', X'', ?, '', '', 0, '', 'student', 1)
      ON CONFLICT(login) DO NOTHING
    `);
    for (const [key, name] of [
      ['yozhik', 'Ёжик Павлович Иголкин'],
      ['barash', 'Бараш Семёнович Лирин'],
      ['losyash', 'Лосяш Аркадьевич Берестов'],
      ['kopatych', 'Копатыч Степанович Грядкин'],
      ['pin', 'Пин Генрихович Винтов'],
      ['kar-karych', 'Кар-Карыч Аркадьевич Воронцов'],
      ['sovunya', 'Совунья Васильевна Сычёва'],
    ]) insert.run('directory:' + key, name);
    db.exec('PRAGMA user_version = 10');
  }
  if (version < 11) {
    setNovemberCancellation(db);
    db.exec('PRAGMA user_version = 11');
  }
  if (version < 12) db.exec(`
    ALTER TABLE messages ADD COLUMN deleted_for_all INTEGER NOT NULL DEFAULT 0 CHECK (deleted_for_all IN (0, 1));
    CREATE TABLE hidden_messages (
      message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
      account_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
      PRIMARY KEY (message_id, account_id)
    ) STRICT;
    PRAGMA user_version = 12;
  `);
  if (version < 13) {
    const profiles = [
      ['student1', 'Гриффиндор', 'Защита от тёмных искусств', 2, 'ГР-24-02'],
      ['student2', 'Слизерин', 'Зельеварение и алхимия', 3, 'СЛ-23-04'],
      ['directory:yozhik', 'Когтевран', 'Древние руны', 2, 'КО-24-01'],
      ['directory:barash', 'Когтевран', 'История магии', 2, 'КО-24-01'],
      ['directory:losyash', 'Когтевран', 'Магическая астрономия', 3, 'КО-23-01'],
      ['directory:kopatych', 'Пуффендуй', 'Травология', 3, 'ПУ-23-01'],
      ['directory:pin', 'Когтевран', 'Зачарование артефактов', 3, 'КО-23-01'],
      ['directory:kar-karych', 'Гриффиндор', 'Магические искусства', 3, 'ГР-23-01'],
      ['directory:sovunya', 'Пуффендуй', 'Целительская магия', 3, 'ПУ-23-01'],
    ];
    const student = db.prepare("SELECT id, student_group FROM students WHERE login = ? AND role = 'student'");
    const update = db.prepare('UPDATE students SET faculty = ?, program = ?, year = ?, student_group = ? WHERE id = ?');
    const moveScope = db.prepare(`
      INSERT OR IGNORE INTO portfolio_dean_groups (dean_id, student_group)
      SELECT dean_id, ? FROM portfolio_dean_groups WHERE student_group = ?
    `);
    const removeUnusedScope = db.prepare(`
      DELETE FROM portfolio_dean_groups WHERE student_group = ?
        AND NOT EXISTS (SELECT 1 FROM students WHERE role = 'student' AND student_group = ?)
    `);
    for (const [login, faculty, program, year, group] of profiles) {
      const record = student.get(login);
      if (!record) continue;
      update.run(faculty, program, year, group, record.id);
      if (record.student_group && record.student_group !== group) {
        moveScope.run(group, record.student_group);
        removeUnusedScope.run(record.student_group, record.student_group);
      }
    }
    db.exec('PRAGMA user_version = 13');
  }
  if (version < 14) {
    seedEvenLessons(db, [
      ['student1', [
        [1, '10:40', '12:00', 3, 'В-304'],
        [5, '10:40', '12:00', 2, 'Б-312'],
        [6, '09:00', '10:20', 1, 'А-205'],
        [6, '10:40', '12:00', 4, 'Б-226'],
      ]],
      ['student2', [
        [2, '10:40', '12:00', 0, 'А-204'],
        [5, '12:30', '13:50', 5, 'А-418'],
        [6, '09:00', '10:20', 3, 'В-304'],
        [6, '10:40', '12:00', 2, 'Б-312'],
      ]],
    ]);
    db.exec('PRAGMA user_version = 14');
  }
  if (version < 15) {
    seedEvenLessons(db, [
      ['student1', [
        [2, '14:10', '15:30', 1, 'А-205', '12:30'],
        [3, '12:30', '13:50', 4, 'Б-226', '09:00'],
        [4, '09:00', '10:20', 2, 'Б-312', '12:30'],
      ]],
      ['student2', [
        [1, '14:10', '15:30', 4, 'Б-226', '12:30'],
        [3, '09:00', '10:20', 5, 'А-418', '12:30'],
        [4, '12:30', '13:50', 1, 'А-205', '09:00'],
      ]],
    ]);
    db.exec('PRAGMA user_version = 15');
  }
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

function searchWords(value) {
  return value.normalize('NFC').toLowerCase().replaceAll('ё', 'е').match(/[\p{L}\p{N}]+/gu) ?? [];
}

export function createCabinet(db, { transaction, HttpError, bytesBody, jsonBody, json }) {
  const prepare = (sql) => db.prepare(sql);
  const grades = prepare(`
    SELECT e.id, subject, semester,
      coursework_points + COALESCE(SUM(s.points), 0) AS points,
      coursework_max + COALESCE(SUM(a.max_points), 0) AS maxPoints,
      coursework_points AS courseworkPoints, coursework_max AS courseworkMax,
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
  const readyCertificate = prepare(`
    SELECT r.id, r.type, student.full_name AS fullName, ready.created_at AS date
    FROM requests r JOIN students student ON student.id = r.student_id
    JOIN request_history ready ON ready.id = (
      SELECT id FROM request_history WHERE request_id = r.id AND status = 'ready' ORDER BY id DESC LIMIT 1
    )
    WHERE r.id = ? AND r.student_id = ? AND r.status = 'ready'
  `);
  const createRequest = prepare("INSERT INTO requests (student_id, type, status, created_at) VALUES (?, ?, 'submitted', ?)");
  const createHistory = prepare('INSERT INTO request_history (request_id, status, note, created_at) VALUES (?, ?, ?, ?)');
  const updateRequest = prepare('UPDATE requests SET status = ? WHERE id = ?');
  const dean = prepare("SELECT id FROM students WHERE role = 'dean'");
  const messageVisibility = `m.deleted_for_all = 0 AND NOT EXISTS (
    SELECT 1 FROM hidden_messages h WHERE h.message_id = m.id AND h.account_id = :viewerId
  )`;
  const dialogues = prepare(`
    SELECT d.id,
      partner.id AS partnerId, partner.role AS partnerRole,
      CASE WHEN partner.role = 'dean' THEN 'Деканат' ELSE partner.full_name END AS title,
      CASE WHEN partner.role = 'teacher' THEN partner.login END AS teacherLogin,
      partner.full_name AS fullName,
      CASE partner.role WHEN 'dean' THEN 'Деканат' WHEN 'teacher' THEN 'Преподаватель'
        ELSE 'Студент' END AS roleLabel,
      partner.faculty, partner.program, partner.student_group AS studentGroup, partner.year,
      last.text AS lastText, last.sender_id = :viewerId AS lastMine, last.created_at AS lastAt,
      (SELECT COUNT(*) FROM messages m WHERE m.dialogue_id = d.id AND m.sender_id <> :viewerId
        AND m.is_read = 0 AND ${messageVisibility}) AS unreadCount
    FROM dialogues d
    JOIN students partner ON partner.id = CASE WHEN d.student_id = :viewerId THEN d.staff_id ELSE d.student_id END
    LEFT JOIN messages last ON last.id = (
      SELECT m.id FROM messages m WHERE m.dialogue_id = d.id AND ${messageVisibility} ORDER BY m.id DESC LIMIT 1
    )
    WHERE d.student_id = :viewerId OR d.staff_id = :viewerId
    ORDER BY last.created_at DESC, last.id DESC, d.id
  `);
  const accessibleTeachers = `
    FROM students staff WHERE staff.role = 'teacher' AND staff.id IN (
      SELECT e.teacher_id FROM enrollments e WHERE e.student_id = :studentId
      UNION
      SELECT d.staff_id FROM dialogues d WHERE d.student_id = :studentId
    )
  `;
  const teacherContacts = prepare(`SELECT staff.id, staff.login, staff.full_name AS name ${accessibleTeachers}`);
  const dialogueContacts = prepare(`
    SELECT partner.id AS partnerId, partner.role AS partnerRole,
      CASE WHEN partner.role = 'dean' THEN 'Деканат' ELSE partner.full_name END AS title,
      partner.full_name AS fullName,
      CASE partner.role WHEN 'dean' THEN 'Деканат' WHEN 'teacher' THEN 'Преподаватель'
        ELSE 'Студент' END AS roleLabel
    FROM students partner WHERE partner.id <> ?
    ORDER BY partner.full_name, partner.id
  `);
  const directoryPartner = prepare('SELECT role FROM students WHERE id = ? AND id <> ?');
  const insertDirectoryDialogue = prepare(`
    INSERT INTO dialogues (student_id, staff_id) VALUES (?, ?)
    ON CONFLICT(student_id, staff_id) DO NOTHING
  `);
  const directoryDialogue = prepare('SELECT id FROM dialogues WHERE student_id = ? AND staff_id = ?');
  const lessonContacts = prepare('SELECT DISTINCT title, teacher FROM lessons WHERE student_id = ?');
  const enrolledLessonTeacher = prepare(`
    SELECT staff.id, staff.login, staff.full_name AS name
    FROM enrollments e JOIN students staff ON staff.id = e.teacher_id
    WHERE e.student_id = ? AND e.subject = ? AND e.semester = ? AND staff.role = 'teacher' AND staff.full_name = ?
      AND NOT EXISTS (
        SELECT 1 FROM students peer WHERE peer.role = 'teacher' AND peer.full_name = staff.full_name AND peer.id <> staff.id
      )
  `);
  const createTeacherDialogue = prepare(`
    INSERT INTO dialogues (student_id, staff_id)
    SELECT :studentId, staff.id ${accessibleTeachers} AND staff.id = :teacherId
    ON CONFLICT(student_id, staff_id) DO NOTHING
  `);
  const teacherDialogue = prepare(`
    SELECT d.id FROM dialogues d JOIN students staff ON staff.id = d.staff_id
    WHERE d.student_id = ? AND d.staff_id = ? AND staff.role = 'teacher'
  `);
  const dialogueById = prepare('SELECT id FROM dialogues WHERE id = ? AND (student_id = ? OR staff_id = ?)');
  const messageFields = `
    SELECT m.id, m.sender_id = :viewerId AS mine, sender.full_name AS sender, m.text, m.created_at AS createdAt,
      m.is_delivered AS delivered, m.is_read AS read,
      CASE WHEN m.sender_id = :viewerId THEN m.client_id END AS clientId
    FROM messages m JOIN students sender ON sender.id = m.sender_id
    WHERE m.dialogue_id = :dialogueId AND ${messageVisibility}
  `;
  const messages = prepare(`${messageFields} ORDER BY m.id`);
  const writtenMessage = prepare(`${messageFields} AND m.id = :messageId`);
  const sentWithClientId = prepare(`${messageFields} AND m.sender_id = :viewerId AND m.client_id = :clientId`);
  const setReceipt = prepare(`
    UPDATE messages AS m SET
      is_delivered = CASE WHEN ${messageVisibility} THEN 1 ELSE is_delivered END,
      is_read = CASE WHEN ${messageVisibility} THEN MAX(is_read, :read) ELSE is_read END
    WHERE id = :messageId AND dialogue_id = :dialogueId AND sender_id <> :viewerId
  `);
  const sendMessage = prepare(`
    INSERT INTO messages (dialogue_id, sender_id, text, created_at, client_id) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(dialogue_id, sender_id, client_id) DO NOTHING RETURNING id
  `);
  const messageForDeletion = prepare(`
    SELECT sender_id, deleted_for_all FROM messages WHERE dialogue_id = ? AND id = ?
  `);
  const hideMessage = prepare(`
    INSERT INTO hidden_messages (message_id, account_id) VALUES (?, ?)
    ON CONFLICT(message_id, account_id) DO NOTHING
  `);
  const deleteMessageForAll = prepare(`
    UPDATE messages SET deleted_for_all = 1, text = ''
    WHERE dialogue_id = ? AND id = ? AND sender_id = ? AND is_read = 0 AND deleted_for_all = 0
  `);
  const notifications = prepare(`
    SELECT id, title, text, created_at AS createdAt FROM notifications WHERE account_id = ? ORDER BY id DESC
  `);
  const createNotice = prepare('INSERT INTO notifications (account_id, title, text, created_at) VALUES (?, ?, ?, ?)');
  const assessments = prepare(`
    SELECT a.id, a.enrollment_id AS enrollmentId, e.subject, student.full_name AS studentName, a.title, a.description,
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

  function lessonContact(studentId, { title, teacher }) {
    const staff = enrolledLessonTeacher.get(studentId, title, currentSemester, teacher);
    return staff ? teacherContact(staff) : demoContact(teacher);
  }

  function contacts(viewer) {
    if (viewer.role !== 'student') return [];
    const byId = new Map();
    for (const lesson of lessonContacts.all(viewer.id)) {
      const contact = lessonContact(viewer.id, lesson);
      if (contact) byId.set(contact.id, contact);
    }
    for (const staff of teacherContacts.all({ studentId: viewer.id })) {
      const contact = teacherContact(staff);
      byId.set(contact.id, contact);
    }
    return [...byId.values()].sort((first, second) => first.name.localeCompare(second.name, 'ru'));
  }

  function cabinet(viewer) {
    const { id, role } = viewer;
    const conversations = dialogues.all({ viewerId: id })
      .map(({ teacherLogin, lastMine, faculty, program, studentGroup, year, ...dialogue }) => ({
        ...dialogue, lastMine: lastMine === null ? null : Boolean(lastMine),
        contact: dialogueContact(dialogue, role, teacherLogin),
        ...(dialogue.partnerRole === 'student' && { studentProfile: { faculty, program, group: studentGroup, year } }),
      }));
    return {
      grades: role === 'dean' ? [] : grades.all(id, role, id, role),
      requests: role === 'teacher' ? [] : requests.all(id, role)
        .map((row) => ({ ...row, history: requestHistory.all(row.id) })),
      dialogues: conversations,
      dialogueContacts: dialogueContacts.all(id),
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
    const words = searchWords(query);
    if (!words.length) return { results };
    const shortPrefix = words.length === 1 && words[0].length < 5;
    const { id, role } = viewer;

    function add(type, title, view, target, ...fields) {
      if (results.length >= 30) return;
      const searchable = searchWords(shortPrefix ? title : [title, ...fields].join(' '));
      if (words.every((word) => searchable.some((candidate) => candidate.startsWith(word)))) {
        results.push({ type, title, view, id: target });
      }
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
        add('grade', `${grade.subject} · Семестр ${grade.semester}`, 'grades', `grade-${grade.id}`,
          grade.studentName, grade.criteria, grade.control, grade.result);
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

  function studentCertificate(viewer, id) {
    return found(readyCertificate.get(id, viewer.id), 'Готовая справка не найдена.');
  }

  async function requestPdf(viewer, id) {
    const contents = await certificatePdf(studentCertificate(viewer, id));
    return { filename: `certificate-${id}.pdf`, media_type: PDF, contents };
  }

  function requestPrint(viewer, id) {
    return certificatePrint(studentCertificate(viewer, id));
  }

  function openTeacherDialogue(viewer, teacherId) {
    createTeacherDialogue.run({ studentId: viewer.id, teacherId });
    const { id: dialogueId } = found(teacherDialogue.get(viewer.id, teacherId), 'Преподаватель недоступен.');
    return { dialogueId };
  }

  function openDirectoryDialogue(viewer, partnerId) {
    const partner = found(directoryPartner.get(partnerId, viewer.id), 'Контакт недоступен.');
    // Keep the student first in mixed-role threads to reuse existing conversations.
    const viewerIsStudent = viewer.role === 'student';
    const partnerIsStudent = partner.role === 'student';
    const viewerFirst = viewerIsStudent !== partnerIsStudent ? viewerIsStudent : viewer.id < partnerId;
    const participants = viewerFirst ? [viewer.id, partnerId] : [partnerId, viewer.id];
    insertDirectoryDialogue.run(...participants);
    return { dialogueId: directoryDialogue.get(...participants).id };
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
      if (!setReceipt.run({ read, messageId, dialogueId: id, viewerId: viewer.id }).changes) {
        throw new HttpError(404, 'Сообщение не найдено.');
      }
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
    if (!message) throw new HttpError(410, 'Сообщение удалено.');
    if (message.text !== content) throw new HttpError(409, 'Идентификатор отправки уже использован.');
    return { message: messageView(message) };
  }

  function deleteMessage(viewer, dialogueId, { scope }, messageId) {
    ownedDialogue(viewer, dialogueId);
    if (scope !== 'self' && scope !== 'all') throw new HttpError(400, 'Укажите, для кого удалить сообщение.');
    const message = found(messageForDeletion.get(dialogueId, messageId), 'Сообщение не найдено.');
    if (scope === 'all' && message.sender_id !== viewer.id) {
      throw new HttpError(403, 'Удалить сообщение у всех может только отправитель.');
    }
    if (message.deleted_for_all) return;
    if (scope === 'self') {
      hideMessage.run(messageId, viewer.id);
    } else if (!deleteMessageForAll.run(dialogueId, messageId, viewer.id).changes) {
      throw new HttpError(409, 'Получатель уже прочитал сообщение.');
    }
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
    ...createPortfolio(db, { HttpError, bytesBody, isPdf, now, text }),
    { method: 'GET', path: /^\/api\/library$/, action: library },
    { method: 'POST', path: /^\/api\/library\/([^/]+)\/favorite$/, action: setFavorite },
    { method: 'GET', path: /^\/api\/cabinet$/, action: cabinet },
    { method: 'POST', path: /^\/api\/requests$/, role: 'student', action: submitRequest },
    { method: 'POST', path: /^\/api\/requests\/([^/]+)\/status$/, role: 'dean', action: changeRequest },
    { method: 'GET', path: /^\/api\/requests\/([^/]+)\/pdf$/, role: 'student', download: true, action: requestPdf },
    { method: 'GET', path: /^\/api\/requests\/([^/]+)\/print$/, role: 'student', print: true, action: requestPrint },
    { method: 'GET', path: /^\/api\/dialogues\/([^/]+)$/, action: dialogueMessages },
    { method: 'POST', path: /^\/api\/dialogues\/teacher\/([^/]+)$/, role: 'student', action: openTeacherDialogue },
    { method: 'POST', path: /^\/api\/dialogues\/contact\/([^/]+)$/, action: openDirectoryDialogue },
    { method: 'POST', path: /^\/api\/dialogues\/([^/]+)\/delivered$/, action: deliverMessages },
    { method: 'POST', path: /^\/api\/dialogues\/([^/]+)\/read$/, action: readDialogue },
    { method: 'POST', path: /^\/api\/dialogues\/([^/]+)\/messages$/, action: writeMessage },
    { method: 'POST', path: /^\/api\/dialogues\/([^/]+)\/messages\/([^/]+)\/delete$/, action: deleteMessage },
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
      if (matched) return { route, identifiers: matched.slice(1) };
    }
    return null;
  }

  async function handle({ route, identifiers }, request, response, viewer, authenticate) {
    if (route.role && route.role !== viewer.role) throw new HttpError(403, 'Действие недоступно для вашей роли.');
    const [id, relatedId] = identifiers.map((identifier) => {
      const value = Number(identifier);
      if (!/^[1-9]\d*$/.test(identifier) || !Number.isSafeInteger(value)) throw new HttpError(404, 'Запись не найдена.');
      return value;
    });
    if (route.method === 'POST') {
      const data = route.parse ? await route.parse(request, viewer, id) : await jsonBody(request, 16 * 1024);
      if (!data || typeof data !== 'object' || Array.isArray(data)) throw new HttpError(400, 'Ожидается объект JSON.');
      const result = transaction(() => {
        const authenticated = authenticate();
        if (route.role && route.role !== authenticated.role) {
          throw new HttpError(403, 'Действие недоступно для вашей роли.');
        }
        return route.action(authenticated, id, data, relatedId);
      });
      return json(response, 200, { ok: true, ...result });
    }
    const query = route.query ? new URL(request.url, 'http://localhost').searchParams : undefined;
    const result = await route.action(viewer, id, query);
    if (route.print) {
      response.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Security-Policy': "default-src 'none'; style-src 'self'; script-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
      });
      return response.end(result);
    }
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

  return { match, handle, search, help, lessonContact };
}
