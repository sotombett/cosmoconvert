import express from 'express';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PrismaClient } from '@prisma/client';

const SECRET_KEY = 'practice-project-secret-key';
const DB_DIR = path.join(process.cwd(), 'prisma');
const SQLITE_PATH = path.join(DB_DIR, 'dev.db');
const JSON_DUMP_PATH = path.join(DB_DIR, 'database.json');
const SQL_DUMP_PATH = path.join(DB_DIR, 'dump.sql');

function hashPassword(password) {
  return crypto.createHmac('sha256', SECRET_KEY).update(password).digest('hex');
}

function escapeSqlString(str) {
  return String(str ?? '').replace(/'/g, "''");
}

// Автоматическая синхронизация SQLite (dev.db) в читаемые файлы prisma/database.json и prisma/dump.sql
export async function syncDatabaseSnapshots(prisma) {
  try {
    const users = await prisma.user.findMany({
      orderBy: { id: 'asc' },
      include: { logs: { orderBy: { id: 'asc' } } }
    });
    const logs = await prisma.actionLog.findMany({
      orderBy: { id: 'asc' }
    });

    const snapshot = {
      server: 'CosmoConvert Local DB Server (SQLite3 + Prisma ORM)',
      updatedAt: new Date().toISOString(),
      databaseFile: 'prisma/dev.db',
      stats: {
        totalUsers: users.length,
        totalActionLogs: logs.length
      },
      tables: {
        User: users.map(u => ({
          id: u.id,
          email: u.email,
          passwordHash: u.passwordHash,
          credits: u.credits,
          lastReset: u.lastReset
        })),
        ActionLog: logs
      }
    };

    fs.mkdirSync(DB_DIR, { recursive: true });
    fs.writeFileSync(JSON_DUMP_PATH, JSON.stringify(snapshot, null, 2), 'utf-8');

    // Генерация текстового SQL-дампа
    const sqlLines = [
      '-- CosmoConvert — Дамп локальной базы данных SQLite',
      `-- Сгенерировано: ${new Date().toLocaleString('ru-RU')}`,
      'PRAGMA foreign_keys = ON;',
      '',
      'CREATE TABLE IF NOT EXISTS "User" (',
      '  "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,',
      '  "email" TEXT NOT NULL UNIQUE,',
      '  "passwordHash" TEXT NOT NULL,',
      '  "credits" INTEGER NOT NULL DEFAULT 15,',
      '  "lastReset" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP',
      ');',
      '',
      'CREATE TABLE IF NOT EXISTS "ActionLog" (',
      '  "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,',
      '  "userId" INTEGER NOT NULL,',
      '  "fileName" TEXT NOT NULL,',
      '  "targetFormat" TEXT NOT NULL,',
      '  "cost" INTEGER NOT NULL DEFAULT 1,',
      '  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,',
      '  CONSTRAINT "ActionLog_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE',
      ');',
      ''
    ];

    if (users.length > 0) {
      sqlLines.push('-- Данные таблицы User');
      for (const u of users) {
        const resetIso = new Date(u.lastReset).toISOString();
        sqlLines.push(
          `INSERT INTO "User" ("id", "email", "passwordHash", "credits", "lastReset") VALUES (${u.id}, '${escapeSqlString(u.email)}', '${escapeSqlString(u.passwordHash)}', ${u.credits}, '${resetIso}');`
        );
      }
      sqlLines.push('');
    }

    if (logs.length > 0) {
      sqlLines.push('-- Данные таблицы ActionLog');
      for (const l of logs) {
        const createdIso = new Date(l.createdAt).toISOString();
        sqlLines.push(
          `INSERT INTO "ActionLog" ("id", "userId", "fileName", "targetFormat", "cost", "createdAt") VALUES (${l.id}, ${l.userId}, '${escapeSqlString(l.fileName)}', '${escapeSqlString(l.targetFormat)}', ${l.cost}, '${createdIso}');`
        );
      }
      sqlLines.push('');
    }

    fs.writeFileSync(SQL_DUMP_PATH, sqlLines.join('\n'), 'utf-8');
    return snapshot;
  } catch (err) {
    console.error('[CosmoConvert DB] Ошибка синхронизации дампа:', err.message);
    return null;
  }
}

// Настройка надежного режима записи SQLite на диск
export async function initSqlitePragmas(prisma) {
  try {
    await prisma.$queryRawUnsafe('PRAGMA journal_mode = WAL;');
    await prisma.$queryRawUnsafe('PRAGMA synchronous = NORMAL;');
    await prisma.$queryRawUnsafe('PRAGMA foreign_keys = ON;');
    await syncDatabaseSnapshots(prisma);
  } catch (err) {
    console.error('[CosmoConvert DB] Ошибка инициализации PRAGMA:', err.message);
  }
}

// Создание маршрутизатора веб-панели и REST API локального сервера БД
export function createDbRouter(prisma, basePath = '') {
  const router = express.Router();

  // Главная веб-панель управления СУБД
  router.get('/', async (req, res) => {
    try {
      await syncDatabaseSnapshots(prisma);
      const users = await prisma.user.findMany({
        orderBy: { id: 'asc' },
        include: { _count: { select: { logs: true } } }
      });
      const logs = await prisma.actionLog.findMany({
        orderBy: { createdAt: 'desc' },
        include: { user: { select: { email: true } } }
      });

      let dbSizeKb = '0.0';
      if (fs.existsSync(SQLITE_PATH)) {
        dbSizeKb = (fs.statSync(SQLITE_PATH).size / 1024).toFixed(1);
      }

      res.send(renderDbDashboardHtml({ users, logs, dbSizeKb, basePath }));
    } catch (err) {
      res.status(500).send(`Ошибка сервера БД: ${err.message}`);
    }
  });

  // REST API: Получить полное состояние БД в JSON
  router.get('/api/state', async (req, res) => {
    const snapshot = await syncDatabaseSnapshots(prisma);
    res.json(snapshot);
  });

  // REST API: Создать пользователя напрямую в БД
  router.post('/api/users/create', async (req, res) => {
    try {
      const email = (req.body.email || '').trim().toLowerCase();
      const password = req.body.password || '1234';
      const credits = Math.max(0, Number(req.body.credits) || 15);
      if (!email) return res.status(400).json({ error: 'Укажите email' });

      const user = await prisma.user.create({
        data: {
          email,
          passwordHash: hashPassword(password),
          credits
        }
      });
      await syncDatabaseSnapshots(prisma);
      res.json({ ok: true, user });
    } catch (err) {
      res.status(400).json({ error: 'Пользователь с таким email уже существует или ошибка БД' });
    }
  });

  // REST API: Изменить баланс кредитов пользователя
  router.post('/api/users/:id/credits', async (req, res) => {
    try {
      const id = Number(req.params.id);
      const credits = Math.max(0, Number(req.body.credits) || 0);
      await prisma.user.update({
        where: { id },
        data: { credits, lastReset: new Date() }
      });
      await syncDatabaseSnapshots(prisma);
      res.json({ ok: true });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  // REST API: Удалить пользователя
  router.post('/api/users/:id/delete', async (req, res) => {
    try {
      const id = Number(req.params.id);
      await prisma.user.delete({ where: { id } });
      await syncDatabaseSnapshots(prisma);
      res.json({ ok: true });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  // REST API: Удалить запись из истории операций
  router.post('/api/logs/:id/delete', async (req, res) => {
    try {
      const id = Number(req.params.id);
      await prisma.actionLog.delete({ where: { id } });
      await syncDatabaseSnapshots(prisma);
      res.json({ ok: true });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  // REST API: Очистить всю историю операций
  router.post('/api/logs/clear', async (req, res) => {
    try {
      await prisma.actionLog.deleteMany({});
      await syncDatabaseSnapshots(prisma);
      res.json({ ok: true });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  // REST API: Выполнить произвольный SQL-запрос из SQL-консоли
  router.post('/api/sql', async (req, res) => {
    try {
      const query = (req.body.query || '').trim();
      if (!query) return res.status(400).json({ error: 'Пустой SQL-запрос' });

      const isSelect = /^(SELECT|PRAGMA|EXPLAIN)/i.test(query);
      if (isSelect) {
        const rawRows = await prisma.$queryRawUnsafe(query);
        const rows = JSON.parse(
          JSON.stringify(rawRows, (_, v) => (typeof v === 'bigint' ? Number(v) : v))
        );
        res.json({ type: 'rows', rows });
      } else {
        const affected = await prisma.$executeRawUnsafe(query);
        await syncDatabaseSnapshots(prisma);
        res.json({ type: 'exec', affected });
      }
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  // Скачивание дампов БД (.sql, .json, .db)
  router.get('/download/sql', async (req, res) => {
    await syncDatabaseSnapshots(prisma);
    res.download(SQL_DUMP_PATH, 'cosmoconvert-dump.sql');
  });

  router.get('/download/json', async (req, res) => {
    await syncDatabaseSnapshots(prisma);
    res.download(JSON_DUMP_PATH, 'cosmoconvert-database.json');
  });

  router.get('/download/sqlite', async (req, res) => {
    await syncDatabaseSnapshots(prisma);
    res.download(SQLITE_PATH, 'dev.db');
  });

  return router;
}

// Запуск отдельного локального сервера БД на порту 4000
export async function startLocalDbServer(prisma, port = 4000) {
  await initSqlitePragmas(prisma);

  const dbApp = express();
  dbApp.use(express.json());
  dbApp.use(express.urlencoded({ extended: true }));
  dbApp.use('/', createDbRouter(prisma, ''));

  const server = dbApp.listen(port, () => {
    console.log(`[CosmoConvert DB]  Локальный сервер БД запущен: http://localhost:${port}`);
    console.log(`[CosmoConvert DB]  Файлы БД: prisma/dev.db | prisma/database.json | prisma/dump.sql`);
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.log(`[CosmoConvert DB]  Порт ${port} уже занят другим процессом сервера БД (панель также доступна на http://localhost:3000/db-admin)`);
    } else {
      console.error('[CosmoConvert DB]  Ошибка сервера БД:', err.message);
    }
  });

  return server;
}

function renderDbDashboardHtml({ users, logs, dbSizeKb, basePath }) {
  const apiPrefix = basePath || '';
  return `<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="UTF-8">
  <title>CosmoConvert DB Server — Локальный сервер СУБД</title>
  <style>
    @import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600;700&family=JetBrains+Mono:wght@400;600;700;800&display=swap');
    :root {
      --bg-base: #07060b;
      --bg-surface: rgba(15, 13, 24, 0.94);
      --bg-panel: #13101f;
      --bg-input: #1a162b;
      --accent-primary: #9333ea;
      --accent-bright: #c084fc;
      --accent-cyan: #38bdf8;
      --border: #2e2647;
      --border-light: #4a3d73;
      --text-main: #f4f2ff;
      --text-muted: #9388b3;
      --danger: #f43f5e;
      --success: #4ade80;
      --font-sans: 'IBM Plex Sans', 'Segoe UI', sans-serif;
      --font-mono: 'JetBrains Mono', 'Consolas', monospace;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: var(--font-sans);
      background-color: var(--bg-base);
      background-image:
        linear-gradient(to right, rgba(168, 85, 247, 0.08) 1px, transparent 1px),
        linear-gradient(to bottom, rgba(168, 85, 247, 0.08) 1px, transparent 1px),
        radial-gradient(ellipse at 50% 0%, rgba(147, 51, 234, 0.15) 0%, transparent 60%);
      background-size: 36px 36px, 36px 36px, 100% 100%;
      background-attachment: fixed;
      color: var(--text-main);
      min-height: 100vh;
      padding-bottom: 40px;
    }
    header {
      background: rgba(18, 16, 27, 0.92);
      border-bottom: 1px solid var(--border);
      padding: 0 32px;
      height: 68px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      position: sticky;
      top: 0;
      z-index: 20;
    }
    .brand {
      display: flex;
      align-items: center;
      gap: 12px;
      font-weight: 800;
      font-size: 18px;
      letter-spacing: 1px;
      color: var(--text-main);
      text-decoration: none;
    }
    .brand-badge {
      background: linear-gradient(135deg, var(--accent-cyan), #6d28d9);
      padding: 6px 10px;
      border-radius: 3px;
      font-size: 12px;
      color: #fff;
    }
    .status-dot {
      display: inline-flex;
      align-items: center;
      gap: 7px;
      background: rgba(74, 222, 128, 0.12);
      border: 1px solid rgba(74, 222, 128, 0.35);
      color: var(--success);
      padding: 6px 12px;
      border-radius: 3px;
      font-size: 12px;
      font-weight: 700;
    }
    .status-dot::before {
      content: "";
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: var(--success);
      box-shadow: 0 0 8px var(--success);
    }
    .container {
      max-width: 1180px;
      margin: 28px auto;
      padding: 0 24px;
      display: grid;
      gap: 24px;
    }
    .stats-grid {
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      gap: 16px;
    }
    @media (max-width: 860px) { .stats-grid { grid-template-columns: repeat(2, 1fr); } }
    .stat-card {
      background: var(--bg-surface);
      border: 1px solid var(--border-light);
      border-radius: 4px;
      padding: 18px;
    }
    .stat-label { font-size: 12px; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.6px; margin-bottom: 6px; }
    .stat-value { font-size: 22px; font-weight: 800; color: var(--text-main); }
    .stat-sub { font-size: 12px; color: var(--accent-cyan); margin-top: 4px; }
    .card {
      background: var(--bg-surface);
      border: 1px solid var(--border-light);
      border-radius: 4px;
      padding: 22px;
    }
    .card-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      flex-wrap: wrap;
      gap: 12px;
      margin-bottom: 16px;
      padding-bottom: 12px;
      border-bottom: 1px solid var(--border);
    }
    .card-header h2 { font-size: 18px; display: flex; align-items: center; gap: 8px; }
    .btn {
      background: var(--bg-input);
      border: 1px solid var(--border-light);
      color: var(--text-main);
      padding: 8px 14px;
      border-radius: 3px;
      font-size: 12px;
      font-weight: 600;
      cursor: pointer;
      text-decoration: none;
      display: inline-flex;
      align-items: center;
      gap: 6px;
      transition: 0.15s;
    }
    .btn:hover { border-color: var(--accent-cyan); color: #fff; }
    .btn-primary {
      background: linear-gradient(135deg, var(--accent-bright), #7c3aed);
      border: none;
      color: #fff;
    }
    .btn-primary:hover { filter: brightness(1.1); }
    .btn-danger {
      background: rgba(244, 63, 94, 0.14);
      border-color: rgba(244, 63, 94, 0.4);
      color: #fda4af;
    }
    .btn-danger:hover { background: var(--danger); color: #fff; }
    table { width: 100%; border-collapse: collapse; font-size: 13px; }
    th, td { text-align: left; padding: 11px 10px; border-bottom: 1px solid var(--border); }
    th { color: var(--text-muted); font-weight: 600; font-size: 12px; text-transform: uppercase; }
    .mono { font-family: Consolas, monospace; font-size: 12px; color: #cbd5e1; }
    .input-sm {
      background: var(--bg-input);
      border: 1px solid var(--border-light);
      color: #fff;
      padding: 6px 10px;
      border-radius: 6px;
      font-size: 13px;
    }
    .create-row {
      display: flex;
      gap: 10px;
      flex-wrap: wrap;
      margin-top: 16px;
      padding-top: 16px;
      border-top: 1px solid var(--border);
    }
    textarea.sql-box {
      width: 100%;
      min-height: 92px;
      background: #06050a;
      border: 1px solid var(--border-light);
      color: var(--accent-cyan);
      font-family: Consolas, monospace;
      font-size: 13px;
      padding: 12px;
      border-radius: 8px;
      resize: vertical;
      margin-bottom: 12px;
    }
    .preset-queries { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 12px; }
    .sql-result {
      margin-top: 14px;
      background: #06050a;
      border: 1px solid var(--border-light);
      border-radius: 8px;
      padding: 12px;
      overflow-x: auto;
    }
  </style>
</head>
<body>
  <header>
    <div class="brand">
      <span class="brand-badge">DB SERVER</span>
      <span>CosmoConvert — Локальный сервер базы данных</span>
    </div>
    <div style="display:flex; align-items:center; gap:12px;">
      <span class="status-dot">SQLite3 WAL • ONLINE</span>
      <a href="http://localhost:3000/home" class="btn">← Вернуться на сайт (:3000)</a>
    </div>
  </header>

  <div class="container">
    <!-- КАРТОЧКИ СОСТОЯНИЯ СЕРВЕРА БД -->
    <div class="stats-grid">
      <div class="stat-card">
        <div class="stat-label">Движок и файлы БД</div>
        <div class="stat-value">prisma/dev.db</div>
        <div class="stat-sub">Размер: ${dbSizeKb} КБ (SQLite 3)</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Текстовые зеркала</div>
        <div class="stat-value">JSON + SQL</div>
        <div class="stat-sub">prisma/database.json • dump.sql</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Таблица User</div>
        <div class="stat-value">${users.length}</div>
        <div class="stat-sub">Зарегистрированных аккаунтов</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Таблица ActionLog</div>
        <div class="stat-value">${logs.length}</div>
        <div class="stat-sub">Записей истории за 30 дней</div>
      </div>
    </div>

    <!-- ЭКСПОРТ И РЕЗЕРВНОЕ КОПИРОВАНИЕ -->
    <div class="card">
      <div class="card-header" style="margin-bottom:0; padding-bottom:0; border-bottom:none;">
        <div>
          <h2>Экспорт и дампы базы данных</h2>
          <p style="font-size:13px; color:var(--text-muted); margin-top:4px;">Все изменения автоматически сохраняются в prisma/dev.db, prisma/database.json и prisma/dump.sql</p>
        </div>
        <div style="display:flex; gap:10px; flex-wrap:wrap;">
          <a href="${apiPrefix}/download/sql" class="btn btn-primary">Скачать SQL-дамп (.sql)</a>
          <a href="${apiPrefix}/download/json" class="btn">Скачать JSON-дамп (.json)</a>
          <a href="${apiPrefix}/download/sqlite" class="btn">Скачать файл SQLite (dev.db)</a>
        </div>
      </div>
    </div>

    <!-- ТАБЛИЦА USER -->
    <div class="card">
      <div class="card-header">
        <h2>Таблица «User» (Зарегистрированные аккаунты)</h2>
        <button class="btn" onclick="location.reload()">Обновить таблицу</button>
      </div>

      <table>
        <thead>
          <tr>
            <th>ID</th>
            <th>Электронная почта (email)</th>
            <th>Хэш пароля (HMAC-SHA256)</th>
            <th>Баланс кредитов</th>
            <th>Последний сброс</th>
            <th>Операций</th>
            <th>Действия</th>
          </tr>
        </thead>
        <tbody>
          ${users.length === 0 ? '<tr><td colspan="7" style="color:var(--text-muted);">Таблица User пуста</td></tr>' : users.map(u => `
            <tr>
              <td class="mono">#${u.id}</td>
              <td><b>${u.email}</b></td>
              <td class="mono" title="${u.passwordHash}">${u.passwordHash.slice(0, 18)}...</td>
              <td>
                <div style="display:flex; align-items:center; gap:6px;">
                  <input type="number" id="cred-${u.id}" class="input-sm" style="width:72px;" value="${u.credits}" min="0" max="999">
                  <button class="btn" onclick="updateCredits(${u.id})">Ок</button>
                  <button class="btn" onclick="setCredits(${u.id}, 15)">15/15</button>
                </div>
              </td>
              <td class="mono">${new Date(u.lastReset).toLocaleString('ru-RU')}</td>
              <td>${u._count.logs}</td>
              <td>
                <button class="btn btn-danger" onclick="deleteUser(${u.id})">Удалить</button>
              </td>
            </tr>
          `).join('')}
        </tbody>
      </table>

      <form class="create-row" onsubmit="createUser(event)">
        <input type="email" id="newEmail" class="input-sm" placeholder="Новый email пользователя" required style="flex:1; min-width:200px;">
        <input type="text" id="newPass" class="input-sm" placeholder="Пароль" required style="width:160px;">
        <input type="number" id="newCredits" class="input-sm" value="15" min="0" max="999" style="width:100px;">
        <button type="submit" class="btn btn-primary">+ Добавить аккаунт в БД</button>
      </form>
    </div>

    <!-- ТАБЛИЦА ACTIONLOG -->
    <div class="card">
      <div class="card-header">
        <h2>Таблица «ActionLog» (История операций пользователей)</h2>
        <button class="btn btn-danger" onclick="clearAllLogs()">Очистить всю историю</button>
      </div>

      <table>
        <thead>
          <tr>
            <th>ID</th>
            <th>User ID (Аккаунт)</th>
            <th>Исходный файл</th>
            <th>Выполненная операция</th>
            <th>Стоимость</th>
            <th>Дата и время</th>
            <th>Действие</th>
          </tr>
        </thead>
        <tbody>
          ${logs.length === 0 ? '<tr><td colspan="7" style="color:var(--text-muted);">Таблица ActionLog пуста</td></tr>' : logs.map(l => `
            <tr>
              <td class="mono">#${l.id}</td>
              <td><span class="mono">#${l.userId}</span> (${l.user ? l.user.email : 'удален'})</td>
              <td>${l.fileName}</td>
              <td>${l.targetFormat}</td>
              <td style="color:var(--accent-cyan); font-weight:700;">-${l.cost} кр.</td>
              <td class="mono">${new Date(l.createdAt).toLocaleString('ru-RU')}</td>
              <td><button class="btn btn-danger" onclick="deleteLog(${l.id})">Удалить</button></td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>

    <!-- SQL КОНСОЛЬ -->
    <div class="card">
      <div class="card-header">
        <h2>Интерактивная SQL-консоль (Прямые запросы к серверу БД)</h2>
      </div>
      <div class="preset-queries">
        <button type="button" class="btn" onclick="setSql('SELECT * FROM \"User\";')">SELECT * FROM "User"</button>
        <button type="button" class="btn" onclick="setSql('SELECT * FROM \"ActionLog\" ORDER BY \"createdAt\" DESC;')">SELECT * FROM "ActionLog"</button>
        <button type="button" class="btn" onclick="setSql('SELECT u.id, u.email, u.credits, COUNT(a.id) AS operationsCount FROM \"User\" u LEFT JOIN \"ActionLog\" a ON u.id = a.userId GROUP BY u.id;')">JOIN: Пользователи + Кол-во операций</button>
        <button type="button" class="btn" onclick="setSql('UPDATE \"User\" SET credits = 15;')">UPDATE: Восстановить всем 15 кредитов</button>
      </div>
      <textarea id="sqlInput" class="sql-box">SELECT u.id, u.email, u.credits, COUNT(a.id) AS operationsCount FROM "User" u LEFT JOIN "ActionLog" a ON u.id = a.userId GROUP BY u.id;</textarea>
      <button type="button" class="btn btn-primary" onclick="runSql()">Выполнить SQL-запрос</button>
      <div id="sqlOutput" class="sql-result" style="display:none;"></div>
    </div>
  </div>

  <script>
    const API = '${apiPrefix}';

    async function updateCredits(id) {
      const credits = document.getElementById('cred-' + id).value;
      await fetch(API + '/api/users/' + id + '/credits', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ credits })
      });
      location.reload();
    }

    async function setCredits(id, credits) {
      document.getElementById('cred-' + id).value = credits;
      await updateCredits(id);
    }

    async function createUser(e) {
      e.preventDefault();
      const email = document.getElementById('newEmail').value;
      const password = document.getElementById('newPass').value;
      const credits = document.getElementById('newCredits').value;
      const res = await fetch(API + '/api/users/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password, credits })
      });
      if (!res.ok) {
        const err = await res.json();
        alert(err.error || 'Ошибка');
        return;
      }
      location.reload();
    }

    async function deleteUser(id) {
      await fetch(API + '/api/users/' + id + '/delete', { method: 'POST' });
      location.reload();
    }

    async function deleteLog(id) {
      await fetch(API + '/api/logs/' + id + '/delete', { method: 'POST' });
      location.reload();
    }

    async function clearAllLogs() {
      await fetch(API + '/api/logs/clear', { method: 'POST' });
      location.reload();
    }

    function setSql(q) {
      document.getElementById('sqlInput').value = q;
    }

    async function runSql() {
      const query = document.getElementById('sqlInput').value;
      const out = document.getElementById('sqlOutput');
      out.style.display = 'block';
      out.innerHTML = 'Выполнение...';

      const res = await fetch(API + '/api/sql', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query })
      });
      const data = await res.json();
      if (!res.ok) {
        out.innerHTML = '<div style="color:#f43f5e;">Ошибка SQL: ' + data.error + '</div>';
        return;
      }

      if (data.type === 'exec') {
        out.innerHTML = '<div style="color:#4ade80;">Запрос выполнен успешно. Затронуто строк: ' + data.affected + '. Обновите страницу, чтобы увидеть изменения в таблицах.</div>';
        return;
      }

      if (!data.rows || data.rows.length === 0) {
        out.innerHTML = '<div style="color:var(--text-muted);">Запрос вернул 0 строк.</div>';
        return;
      }

      const cols = Object.keys(data.rows[0]);
      const thead = '<tr>' + cols.map(c => '<th>' + c + '</th>').join('') + '</tr>';
      const tbody = data.rows.map(r => '<tr>' + cols.map(c => '<td class="mono">' + (r[c] ?? 'NULL') + '</td>').join('') + '</tr>').join('');
      out.innerHTML = '<table><thead>' + thead + '</thead><tbody>' + tbody + '</tbody></table>';
    }
  </script>
</body>
</html>`;
}

// Если файл запущен напрямую через node db-server.js
const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isDirectRun) {
  const prisma = new PrismaClient();
  startLocalDbServer(prisma, 4000);
}
