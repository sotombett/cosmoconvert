import express from 'express';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PrismaClient } from '@prisma/client';

const SECRET_KEY = process.env.SECRET_KEY || 'practice-project-secret-key';
const DB_DIR = path.join(process.cwd(), 'prisma');
const SQLITE_PATH = path.join(DB_DIR, 'dev.db');
const JSON_DUMP_PATH = path.join(DB_DIR, 'database.json');
const SQL_DUMP_PATH = path.join(DB_DIR, 'dump.sql');
export const HISTORY_STORAGE_DIR = path.join(process.cwd(), 'storage', 'history');

function hashPassword(password) {
  return crypto.createHmac('sha256', SECRET_KEY).update(password).digest('hex');
}

function escapeSqlString(str) {
  return String(str ?? '').replace(/'/g, "''");
}

function normalizeDateIso(val) {
  if (val === null || val === undefined) return new Date().toISOString();
  if (typeof val === 'bigint') return new Date(Number(val)).toISOString();
  if (typeof val === 'number') return new Date(val).toISOString();
  const num = Number(val);
  if (!Number.isNaN(num) && String(val).trim() !== '') {
    return new Date(num).toISOString();
  }
  const d = new Date(val);
  return Number.isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
}

export function formatBytes(bytes) {
  const b = Number(bytes) || 0;
  if (b <= 0) return '';
  if (b >= 1024 * 1024) return `${(b / (1024 * 1024)).toFixed(2)} МБ`;
  return `${Math.max(1, Math.round(b / 1024))} КБ`;
}

export function setSafeDownloadHeaders(res, fileName, mimeType = 'application/octet-stream') {
  const cleanName = String(fileName || 'cosmoconvert-file').replace(/[\r\n"]/g, '_');
  const asciiFallback = cleanName.replace(/[^\x20-\x7E]/g, '_') || 'cosmoconvert-file';
  res.setHeader('Content-Type', mimeType || 'application/octet-stream');
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="${asciiFallback}"; filename*=UTF-8''${encodeURIComponent(cleanName)}`
  );
}

// Удаляем устаревшие файлы -wal и -shm до подключения Prisma, если dev.db находится в стандартном режиме DELETE
// Это полностью исключает ошибку "database disk image is malformed" после обновления/распаковки архива.
export function sanitizeStaleWalFiles() {
  try {
    if (!fs.existsSync(SQLITE_PATH)) return;
    const fd = fs.openSync(SQLITE_PATH, 'r');
    const hdr = Buffer.alloc(24);
    const bytesRead = fs.readSync(fd, hdr, 0, 24, 0);
    fs.closeSync(fd);

    if (bytesRead >= 20 && hdr[18] === 1 && hdr[19] === 1) {
      for (const suffix of ['-wal', '-shm']) {
        const sidecar = SQLITE_PATH + suffix;
        if (fs.existsSync(sidecar)) {
          fs.unlinkSync(sidecar);
          console.log(`[CosmoConvert DB] Удалён устаревший журнал ${path.basename(sidecar)}`);
        }
      }
    }
  } catch (err) {
    console.error('[CosmoConvert DB] Ошибка проверки WAL-файлов:', err.message);
  }
}

export function deleteStoredHistoryFile(storedFile) {
  if (!storedFile) return;
  try {
    const safeName = path.basename(String(storedFile));
    const fullPath = path.join(HISTORY_STORAGE_DIR, safeName);
    if (fs.existsSync(fullPath)) {
      fs.unlinkSync(fullPath);
    }
  } catch (err) {
    console.error('[CosmoConvert Storage] Ошибка удаления файла:', err.message);
  }
}

export function getStoredFileInfo(storedFile) {
  if (!storedFile) return { exists: false, sizeText: '' };
  const safeName = path.basename(String(storedFile));
  const fullPath = path.join(HISTORY_STORAGE_DIR, safeName);
  if (!fs.existsSync(fullPath)) return { exists: false, sizeText: '' };
  const bytes = fs.statSync(fullPath).size;
  return { exists: true, sizeText: formatBytes(bytes), fullPath };
}

async function createCoreTables(prisma) {
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "User" (
      "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
      "email" TEXT NOT NULL UNIQUE,
      "passwordHash" TEXT NOT NULL,
      "role" TEXT NOT NULL DEFAULT 'USER',
      "credits" INTEGER NOT NULL DEFAULT 15,
      "lastReset" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "ActionLog" (
      "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
      "userId" INTEGER NOT NULL,
      "fileName" TEXT NOT NULL,
      "targetFormat" TEXT NOT NULL,
      "cost" INTEGER NOT NULL DEFAULT 1,
      "storedFile" TEXT,
      "outputName" TEXT,
      "mimeType" TEXT,
      "fileSize" INTEGER,
      "fileData" TEXT,
      "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT "ActionLog_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
    );
  `);
}

// Автоматическое восстановление БД, если файл был повреждён из-за конфликта WAL-журналов
async function recoverCorruptedDatabase(prisma) {
  console.warn('[CosmoConvert DB] Обнаружено повреждение SQLite — запускаю автоматическое восстановление из резервного снимка...');
  try {
    await prisma.$disconnect();
  } catch {}

  for (const suffix of ['', '-wal', '-shm', '-journal']) {
    const p = SQLITE_PATH + suffix;
    if (fs.existsSync(p)) {
      if (suffix === '') {
        try {
          fs.copyFileSync(p, SQLITE_PATH + '.corrupted.bak');
        } catch {}
      }
      try {
        fs.unlinkSync(p);
      } catch {}
    }
  }

  await prisma.$connect();
  await prisma.$queryRawUnsafe('PRAGMA journal_mode = DELETE;');
  await prisma.$queryRawUnsafe('PRAGMA foreign_keys = ON;');
  await createCoreTables(prisma);

  // Восстанавливаем пользователей и историю из prisma/database.json, если файл существует
  if (fs.existsSync(JSON_DUMP_PATH)) {
    try {
      const snap = JSON.parse(fs.readFileSync(JSON_DUMP_PATH, 'utf-8'));
      const users = (snap && snap.tables && Array.isArray(snap.tables.User)) ? snap.tables.User : [];
      const logs = (snap && snap.tables && Array.isArray(snap.tables.ActionLog)) ? snap.tables.ActionLog : [];

      for (const u of users) {
        if (!u.email || !u.passwordHash) continue;
        const role = u.role === 'ADMIN' ? 'ADMIN' : 'USER';
        const credits = role === 'ADMIN' ? 999999 : (Number(u.credits) || 15);
        const resetMs = new Date(u.lastReset || Date.now()).getTime() || Date.now();
        await prisma.$executeRawUnsafe(
          'INSERT OR IGNORE INTO "User" ("id", "email", "passwordHash", "role", "credits", "lastReset") VALUES (?, ?, ?, ?, ?, ?);',
          Number(u.id),
          String(u.email).toLowerCase(),
          String(u.passwordHash),
          role,
          credits,
          resetMs
        );
      }

      for (const l of logs) {
        if (!l.userId || !l.fileName) continue;
        const createdMs = new Date(l.createdAt || Date.now()).getTime() || Date.now();
        await prisma.$executeRawUnsafe(
          'INSERT OR IGNORE INTO "ActionLog" ("id", "userId", "fileName", "targetFormat", "cost", "storedFile", "outputName", "mimeType", "fileSize", "createdAt") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?);',
          Number(l.id),
          Number(l.userId),
          String(l.fileName),
          String(l.targetFormat || ''),
          Number(l.cost) || 0,
          l.storedFile || null,
          l.outputName || null,
          l.mimeType || null,
          l.fileSize ? Number(l.fileSize) : null,
          createdMs
        );
      }
      console.log(`[CosmoConvert DB] База данных восстановлена из prisma/database.json (пользователей: ${users.length}, логов: ${logs.length}).`);
    } catch (restoreErr) {
      console.error('[CosmoConvert DB] Не удалось прочитать database.json при восстановлении:', restoreErr.message);
    }
  }
}

// Гарантируем целостность БД, наличие всех колонок (включая fileData) и учётку администратора
export async function ensureDbSchemaAndAdmin(prisma) {
  sanitizeStaleWalFiles();
  fs.mkdirSync(DB_DIR, { recursive: true });
  fs.mkdirSync(HISTORY_STORAGE_DIR, { recursive: true });
  if (!fs.existsSync(SQLITE_PATH)) {
    fs.writeFileSync(SQLITE_PATH, '');
  }

  // Проверка целостности SQLite
  try {
    const check = await prisma.$queryRawUnsafe('PRAGMA integrity_check;');
    const firstRow = check && check[0];
    const checkVal = firstRow ? String(Object.values(firstRow)[0] || '').toLowerCase() : '';
    if (checkVal !== 'ok') {
      await recoverCorruptedDatabase(prisma);
    }
  } catch (err) {
    const msg = String(err && err.message ? err.message : err);
    if (msg.includes('malformed') || msg.includes('Code: `11`') || msg.includes('not a database')) {
      await recoverCorruptedDatabase(prisma);
    } else {
      throw err;
    }
  }

  // Переводим в безопасный режим DELETE (без боковых файлов -wal/-shm)
  try {
    await prisma.$queryRawUnsafe('PRAGMA journal_mode = DELETE;');
    await prisma.$queryRawUnsafe('PRAGMA synchronous = NORMAL;');
    await prisma.$queryRawUnsafe('PRAGMA foreign_keys = ON;');
  } catch {}

  await createCoreTables(prisma);

  const userCols = await prisma.$queryRawUnsafe('PRAGMA table_info("User");');
  const userColNames = userCols.map(c => c.name);
  if (!userColNames.includes('role')) {
    await prisma.$executeRawUnsafe(`ALTER TABLE "User" ADD COLUMN "role" TEXT NOT NULL DEFAULT 'USER';`);
  }

  const logCols = await prisma.$queryRawUnsafe('PRAGMA table_info("ActionLog");');
  const logColNames = logCols.map(c => c.name);
  if (!logColNames.includes('storedFile')) {
    await prisma.$executeRawUnsafe('ALTER TABLE "ActionLog" ADD COLUMN "storedFile" TEXT;');
  }
  if (!logColNames.includes('outputName')) {
    await prisma.$executeRawUnsafe('ALTER TABLE "ActionLog" ADD COLUMN "outputName" TEXT;');
  }
  if (!logColNames.includes('mimeType')) {
    await prisma.$executeRawUnsafe('ALTER TABLE "ActionLog" ADD COLUMN "mimeType" TEXT;');
  }
  if (!logColNames.includes('fileSize')) {
    await prisma.$executeRawUnsafe('ALTER TABLE "ActionLog" ADD COLUMN "fileSize" INTEGER;');
  }
  if (!logColNames.includes('fileData')) {
    await prisma.$executeRawUnsafe('ALTER TABLE "ActionLog" ADD COLUMN "fileData" TEXT;');
  }

  // Автоматическое создание учётной записи администратора (admin@cosmoconvert.local / admin123)
  const adminEmail = 'admin@cosmoconvert.local';
  const adminHash = hashPassword('admin123');
  const admins = await prisma.$queryRawUnsafe('SELECT id, role FROM "User" WHERE email = ?;', adminEmail);
  if (!admins || admins.length === 0) {
    await prisma.$executeRawUnsafe(
      'INSERT INTO "User" ("email", "passwordHash", "role", "credits", "lastReset") VALUES (?, ?, ?, ?, ?);',
      adminEmail,
      adminHash,
      'ADMIN',
      999999,
      Date.now()
    );
  } else if (admins[0].role !== 'ADMIN') {
    await prisma.$executeRawUnsafe(
      'UPDATE "User" SET role = ?, credits = ? WHERE email = ?;',
      'ADMIN',
      999999,
      adminEmail
    );
  }
}

// Синхронизация метаданных SQLite в читаемые файлы prisma/database.json и prisma/dump.sql
// (Сами бинарные данные fileData остаются внутри prisma/dev.db, чтобы текстовые дампы были компактными)
export async function syncDatabaseSnapshots(prisma) {
  try {
    const rawUsers = await prisma.$queryRawUnsafe(
      'SELECT id, email, passwordHash, role, credits, lastReset FROM "User" ORDER BY id ASC;'
    );
    const rawLogs = await prisma.$queryRawUnsafe(
      'SELECT id, userId, fileName, targetFormat, cost, storedFile, outputName, mimeType, fileSize, (fileData IS NOT NULL AND length(fileData) > 0) AS hasFileData, createdAt FROM "ActionLog" ORDER BY id ASC;'
    );

    const users = rawUsers.map(u => ({
      id: Number(u.id),
      email: u.email,
      passwordHash: u.passwordHash,
      role: u.role || 'USER',
      credits: u.role === 'ADMIN' ? null : Number(u.credits),
      lastReset: normalizeDateIso(u.lastReset)
    }));

    const logs = rawLogs.map(l => ({
      id: Number(l.id),
      userId: Number(l.userId),
      fileName: l.fileName,
      targetFormat: l.targetFormat,
      cost: Number(l.cost),
      outputName: l.outputName || null,
      mimeType: l.mimeType || null,
      fileSize: l.fileSize ? Number(l.fileSize) : null,
      hasFileInDb: Boolean(Number(l.hasFileData)),
      storedFile: l.storedFile || null,
      createdAt: normalizeDateIso(l.createdAt)
    }));

    const snapshot = {
      server: 'CosmoConvert Local DB Server (SQLite3 + Prisma ORM)',
      updatedAt: new Date().toISOString(),
      databaseFile: 'prisma/dev.db',
      stats: {
        totalUsers: users.length,
        totalActionLogs: logs.length
      },
      tables: {
        User: users,
        ActionLog: logs
      }
    };

    fs.mkdirSync(DB_DIR, { recursive: true });
    fs.writeFileSync(JSON_DUMP_PATH, JSON.stringify(snapshot, null, 2), 'utf-8');

    const sqlLines = [
      '-- CosmoConvert — Дамп локальной базы данных SQLite',
      `-- Сгенерировано: ${new Date().toLocaleString('ru-RU')}`,
      'PRAGMA foreign_keys = ON;',
      '',
      'CREATE TABLE IF NOT EXISTS "User" (',
      '  "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,',
      '  "email" TEXT NOT NULL UNIQUE,',
      '  "passwordHash" TEXT NOT NULL,',
      `  "role" TEXT NOT NULL DEFAULT 'USER',`,
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
      '  "storedFile" TEXT,',
      '  "outputName" TEXT,',
      '  "mimeType" TEXT,',
      '  "fileSize" INTEGER,',
      '  "fileData" TEXT,',
      '  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,',
      '  CONSTRAINT "ActionLog_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE',
      ');',
      ''
    ];

    if (users.length > 0) {
      sqlLines.push('-- Данные таблицы User');
      for (const u of users) {
        const credVal = u.role === 'ADMIN' ? 999999 : u.credits;
        sqlLines.push(
          `INSERT INTO "User" ("id", "email", "passwordHash", "role", "credits", "lastReset") VALUES (${u.id}, '${escapeSqlString(u.email)}', '${escapeSqlString(u.passwordHash)}', '${escapeSqlString(u.role)}', ${credVal}, '${u.lastReset}');`
        );
      }
      sqlLines.push('');
    }

    if (logs.length > 0) {
      sqlLines.push('-- Данные таблицы ActionLog (бинарные файлы хранятся в prisma/dev.db)');
      for (const l of logs) {
        const sf = l.storedFile ? `'${escapeSqlString(l.storedFile)}'` : 'NULL';
        const on = l.outputName ? `'${escapeSqlString(l.outputName)}'` : 'NULL';
        const mt = l.mimeType ? `'${escapeSqlString(l.mimeType)}'` : 'NULL';
        const fz = l.fileSize !== null ? l.fileSize : 'NULL';
        sqlLines.push(
          `INSERT INTO "ActionLog" ("id", "userId", "fileName", "targetFormat", "cost", "storedFile", "outputName", "mimeType", "fileSize", "createdAt") VALUES (${l.id}, ${l.userId}, '${escapeSqlString(l.fileName)}', '${escapeSqlString(l.targetFormat)}', ${l.cost}, ${sf}, ${on}, ${mt}, ${fz}, '${l.createdAt}');`
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

export async function initSqlitePragmas(prisma) {
  try {
    await ensureDbSchemaAndAdmin(prisma);
    await syncDatabaseSnapshots(prisma);
  } catch (err) {
    console.error('[CosmoConvert DB] Ошибка инициализации БД:', err.message);
  }
}

export function createDbRouter(prisma, basePath = '') {
  const router = express.Router();

  router.get('/', async (req, res) => {
    try {
      await ensureDbSchemaAndAdmin(prisma);
      await syncDatabaseSnapshots(prisma);
      const rawUsers = await prisma.$queryRawUnsafe(`
        SELECT u.id, u.email, u.passwordHash, u.role, u.credits, u.lastReset, COUNT(a.id) AS logsCount
        FROM "User" u
        LEFT JOIN "ActionLog" a ON a.userId = u.id
        GROUP BY u.id
        ORDER BY u.id ASC;
      `);
      const rawLogs = await prisma.$queryRawUnsafe(`
        SELECT a.id, a.userId, a.fileName, a.targetFormat, a.cost, a.storedFile, a.outputName, a.mimeType, a.fileSize,
               (a.fileData IS NOT NULL AND length(a.fileData) > 0) AS hasFileData,
               a.createdAt, u.email AS userEmail, u.role AS userRole
        FROM "ActionLog" a
        LEFT JOIN "User" u ON u.id = a.userId
        ORDER BY a.createdAt DESC;
      `);

      const users = rawUsers.map(u => ({
        id: Number(u.id),
        email: u.email,
        passwordHash: u.passwordHash,
        role: u.role || 'USER',
        credits: Number(u.credits),
        lastReset: normalizeDateIso(u.lastReset),
        logsCount: Number(u.logsCount)
      }));

      const logs = rawLogs.map(l => {
        const inDb = Boolean(Number(l.hasFileData));
        const diskInfo = getStoredFileInfo(l.storedFile);
        const canDownload = inDb || diskInfo.exists;
        const sizeText = inDb ? formatBytes(l.fileSize) : diskInfo.sizeText;
        return {
          id: Number(l.id),
          userId: Number(l.userId),
          userEmail: l.userEmail || 'удален',
          userRole: l.userRole || 'USER',
          fileName: l.fileName,
          targetFormat: l.targetFormat,
          cost: Number(l.cost),
          outputName: l.outputName || l.fileName,
          canDownload,
          sizeText,
          createdAt: normalizeDateIso(l.createdAt)
        };
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

  router.get('/api/state', async (req, res) => {
    const snapshot = await syncDatabaseSnapshots(prisma);
    res.json(snapshot);
  });

  router.post('/api/users/create', async (req, res) => {
    try {
      const email = (req.body.email || '').trim().toLowerCase();
      const password = req.body.password || '1234';
      const role = req.body.role === 'ADMIN' ? 'ADMIN' : 'USER';
      const credits = role === 'ADMIN' ? 999999 : Math.max(0, Number(req.body.credits) || 15);
      if (!email) return res.status(400).json({ error: 'Укажите email' });

      await prisma.$executeRawUnsafe(
        'INSERT INTO "User" ("email", "passwordHash", "role", "credits", "lastReset") VALUES (?, ?, ?, ?, ?);',
        email,
        hashPassword(password),
        role,
        credits,
        Date.now()
      );
      await syncDatabaseSnapshots(prisma);
      res.json({ ok: true });
    } catch (err) {
      res.status(400).json({ error: 'Пользователь с таким email уже существует или ошибка БД' });
    }
  });

  router.post('/api/users/:id/credits', async (req, res) => {
    try {
      const id = Number(req.params.id);
      const credits = Math.max(0, Number(req.body.credits) || 0);
      await prisma.$executeRawUnsafe(
        'UPDATE "User" SET credits = ?, lastReset = ? WHERE id = ?;',
        credits,
        Date.now(),
        id
      );
      await syncDatabaseSnapshots(prisma);
      res.json({ ok: true });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  router.post('/api/users/:id/role', async (req, res) => {
    try {
      const id = Number(req.params.id);
      const newRole = req.body.role === 'ADMIN' ? 'ADMIN' : 'USER';
      const credits = newRole === 'ADMIN' ? 999999 : 15;
      await prisma.$executeRawUnsafe(
        'UPDATE "User" SET role = ?, credits = ?, lastReset = ? WHERE id = ?;',
        newRole,
        credits,
        Date.now(),
        id
      );
      await syncDatabaseSnapshots(prisma);
      res.json({ ok: true });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  router.post('/api/users/:id/delete', async (req, res) => {
    try {
      const id = Number(req.params.id);
      const userLogs = await prisma.$queryRawUnsafe('SELECT storedFile FROM "ActionLog" WHERE userId = ?;', id);
      for (const l of userLogs) deleteStoredHistoryFile(l.storedFile);
      await prisma.$executeRawUnsafe('DELETE FROM "User" WHERE id = ?;', id);
      await syncDatabaseSnapshots(prisma);
      res.json({ ok: true });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  router.post('/api/logs/:id/delete', async (req, res) => {
    try {
      const id = Number(req.params.id);
      const rows = await prisma.$queryRawUnsafe('SELECT storedFile FROM "ActionLog" WHERE id = ?;', id);
      if (rows[0]) deleteStoredHistoryFile(rows[0].storedFile);
      await prisma.$executeRawUnsafe('DELETE FROM "ActionLog" WHERE id = ?;', id);
      await syncDatabaseSnapshots(prisma);
      res.json({ ok: true });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  router.post('/api/logs/clear', async (req, res) => {
    try {
      const rows = await prisma.$queryRawUnsafe('SELECT storedFile FROM "ActionLog";');
      for (const l of rows) deleteStoredHistoryFile(l.storedFile);
      await prisma.$executeRawUnsafe('DELETE FROM "ActionLog";');
      await syncDatabaseSnapshots(prisma);
      res.json({ ok: true });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  router.get('/api/logs/:id/download', async (req, res) => {
    try {
      const id = Number(req.params.id);
      const rows = await prisma.$queryRawUnsafe(
        'SELECT storedFile, outputName, fileName, mimeType, fileData FROM "ActionLog" WHERE id = ?;',
        id
      );
      if (!rows[0]) return res.status(404).send('Запись не найдена');
      const entry = rows[0];
      const dlName = entry.outputName || entry.fileName || 'cosmoconvert-file';

      if (entry.fileData && entry.fileData.length > 0) {
        const buf = Buffer.from(entry.fileData, 'base64');
        setSafeDownloadHeaders(res, dlName, entry.mimeType || 'application/octet-stream');
        return res.send(buf);
      }

      const info = getStoredFileInfo(entry.storedFile);
      if (info.exists) {
        return res.download(info.fullPath, dlName);
      }
      res.status(404).send('Файл отсутствует в базе данных');
    } catch (err) {
      res.status(500).send(err.message);
    }
  });

  router.post('/api/sql', async (req, res) => {
    try {
      const query = (req.body.query || '').trim();
      if (!query) return res.status(400).json({ error: 'Пустой SQL-запрос' });

      const isSelect = /^(SELECT|PRAGMA|EXPLAIN)/i.test(query);
      if (isSelect) {
        const rawRows = await prisma.$queryRawUnsafe(query);
        const rows = JSON.parse(
          JSON.stringify(rawRows, (k, v) => {
            if (typeof v === 'bigint') return Number(v);
            if (k === 'fileData' && typeof v === 'string' && v.length > 60) {
              return `[BASE64 FILE: ${Math.round(v.length * 0.75 / 1024)} KB]`;
            }
            return v;
          })
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

export async function startLocalDbServer(prisma, port = 4000) {
  await initSqlitePragmas(prisma);

  const dbApp = express();
  dbApp.use(express.json());
  dbApp.use(express.urlencoded({ extended: true }));
  dbApp.use('/', createDbRouter(prisma, ''));

  const server = dbApp.listen(port, () => {
    console.log(`[CosmoConvert DB]  Локальный сервер БД запущен: http://localhost:${port}`);
    console.log(`[CosmoConvert DB]  Файлы БД: prisma/dev.db (включая BLOB-файлы истории) | prisma/database.json | prisma/dump.sql`);
    console.log(`[CosmoConvert DB]  Учетка админа: admin@cosmoconvert.local / admin123`);
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
  const backHref = basePath ? '/home' : 'http://localhost:3000/home';
  const backLabel = basePath ? '← Вернуться на сайт' : '← Вернуться на сайт (:3000)';
  return `<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>CosmoConvert DB Server — Локальный сервер СУБД</title>
  <style>
    @import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600;700&family=JetBrains+Mono:wght@400;600;700;800&display=swap');
    :root {
      --bg-base: #070812;
      --bg-surface: rgba(15, 13, 24, 0.94);
      --bg-panel: #13101f;
      --bg-input: #1a162b;
      --accent-primary: #4f46e5;
      --accent-bright: #818cf8;
      --accent-cyan: #38bdf8;
      --border: #252b4a;
      --border-light: #3b4470;
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
        linear-gradient(to right, rgba(99, 102, 241, 0.09) 1px, transparent 1px),
        linear-gradient(to bottom, rgba(99, 102, 241, 0.09) 1px, transparent 1px),
        radial-gradient(ellipse at 50% 0%, rgba(79, 70, 229, 0.16) 0%, transparent 60%);
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
      font-family: var(--font-mono);
      font-weight: 800;
      font-size: 17px;
      letter-spacing: 0.8px;
      color: var(--text-main);
      text-decoration: none;
    }
    .brand-badge {
      background: linear-gradient(135deg, var(--accent-cyan), #3730a3);
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
      font-family: var(--font-mono);
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
      max-width: 1220px;
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
    .stat-label { font-family: var(--font-mono); font-size: 11px; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.6px; margin-bottom: 6px; }
    .stat-value { font-family: var(--font-mono); font-size: 22px; font-weight: 800; color: var(--text-main); }
    .stat-sub { font-size: 12px; color: var(--accent-cyan); margin-top: 4px; }
    .card {
      background: var(--bg-surface);
      border: 1px solid var(--border-light);
      border-radius: 4px;
      padding: 22px;
      overflow-x: auto;
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
    .card-header h2 { font-family: var(--font-mono); font-size: 16px; text-transform: uppercase; display: flex; align-items: center; gap: 8px; }
    .btn {
      font-family: var(--font-mono);
      background: var(--bg-input);
      border: 1px solid var(--border-light);
      color: var(--text-main);
      padding: 7px 13px;
      border-radius: 3px;
      font-size: 11px;
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
      background: linear-gradient(135deg, #6366f1, #4338ca);
      border: 1px solid var(--accent-bright);
      color: #fff;
    }
    .btn-primary:hover { filter: brightness(1.1); }
    .btn-danger {
      background: rgba(244, 63, 94, 0.14);
      border-color: rgba(244, 63, 94, 0.4);
      color: #fda4af;
    }
    .btn-danger:hover { background: var(--danger); color: #fff; }
    .file-link {
      font-family: var(--font-mono);
      color: var(--accent-cyan);
      text-decoration: none;
      font-weight: 600;
    }
    .file-link:hover { text-decoration: underline; color: #fff; }
    .role-tag {
      font-family: var(--font-mono);
      font-size: 11px;
      font-weight: 700;
      padding: 3px 8px;
      border-radius: 2px;
      display: inline-block;
    }
    .role-tag.admin {
      background: rgba(56, 189, 248, 0.16);
      border: 1px solid var(--accent-cyan);
      color: var(--accent-cyan);
    }
    .role-tag.user {
      background: rgba(129, 140, 248, 0.14);
      border: 1px solid var(--border-light);
      color: #c7d2fe;
    }
    table { width: 100%; border-collapse: collapse; font-size: 13px; }
    th, td { text-align: left; padding: 11px 10px; border-bottom: 1px solid var(--border); }
    th { font-family: var(--font-mono); color: var(--text-muted); font-weight: 600; font-size: 11px; text-transform: uppercase; }
    .mono { font-family: var(--font-mono); font-size: 12px; color: #cbd5e1; }
    .input-sm {
      background: var(--bg-input);
      border: 1px solid var(--border-light);
      color: #fff;
      padding: 6px 10px;
      border-radius: 3px;
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
      font-family: var(--font-mono);
      font-size: 13px;
      padding: 12px;
      border-radius: 3px;
      resize: vertical;
      margin-bottom: 12px;
    }
    .preset-queries { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 12px; }
    .sql-result {
      margin-top: 14px;
      background: #06050a;
      border: 1px solid var(--border-light);
      border-radius: 3px;
      padding: 12px;
      overflow-x: auto;
    }

    @media (max-width: 820px) {
      header { padding: 14px 16px; height: auto; flex-wrap: wrap; gap: 10px; }
      .container { padding: 16px; }
      .stats-grid { grid-template-columns: 1fr; }
      .panel { padding: 16px; overflow-x: auto; }
      table { min-width: 560px; }
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
      <span class="status-dot">SQLite3 • ONLINE</span>
      <a href="${backHref}" class="btn">${backLabel}</a>
    </div>
  </header>

  <div class="container">
    <div class="stats-grid">
      <div class="stat-card">
        <div class="stat-label">Движок и файл БД</div>
        <div class="stat-value">prisma/dev.db</div>
        <div class="stat-sub">Размер: ${dbSizeKb} КБ (SQLite 3)</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Хранение файлов</div>
        <div class="stat-value">Внутри БД</div>
        <div class="stat-sub">ActionLog.fileData (30 дней)</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Таблица User</div>
        <div class="stat-value">${users.length}</div>
        <div class="stat-sub">Аккаунтов (включая ADMIN)</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Таблица ActionLog</div>
        <div class="stat-value">${logs.length}</div>
        <div class="stat-sub">Записей истории за 30 дней</div>
      </div>
    </div>

    <div class="card">
      <div class="card-header" style="margin-bottom:0; padding-bottom:0; border-bottom:none;">
        <div>
          <h2>Экспорт и дампы базы данных</h2>
          <p style="font-size:13px; color:var(--text-muted); margin-top:4px;">Обработанные файлы хранятся прямо в prisma/dev.db; мета-снимки обновляются в prisma/database.json и prisma/dump.sql</p>
        </div>
        <div style="display:flex; gap:10px; flex-wrap:wrap;">
          <a href="${apiPrefix}/download/sql" class="btn btn-primary">Скачать SQL-дамп (.sql)</a>
          <a href="${apiPrefix}/download/json" class="btn">Скачать JSON-дамп (.json)</a>
          <a href="${apiPrefix}/download/sqlite" class="btn">Скачать SQLite (dev.db)</a>
        </div>
      </div>
    </div>

    <div class="card">
      <div class="card-header">
        <h2>Таблица «User» (Аккаунты и роли)</h2>
        <button class="btn" onclick="location.reload()">Обновить таблицу</button>
      </div>

      <table>
        <thead>
          <tr>
            <th>ID</th>
            <th>Email</th>
            <th>Роль</th>
            <th>Хэш пароля</th>
            <th>Баланс кредитов</th>
            <th>Операций</th>
            <th>Действия</th>
          </tr>
        </thead>
        <tbody>
          ${users.length === 0 ? '<tr><td colspan="7" style="color:var(--text-muted);">Таблица User пуста</td></tr>' : users.map(u => `
            <tr>
              <td class="mono">#${u.id}</td>
              <td><b>${u.email}</b></td>
              <td>
                <span class="role-tag ${u.role === 'ADMIN' ? 'admin' : 'user'}">${u.role}</span>
              </td>
              <td class="mono" title="${u.passwordHash}">${u.passwordHash.slice(0, 14)}...</td>
              <td>
                ${u.role === 'ADMIN'
                  ? '<span class="mono" style="color:var(--accent-cyan); font-weight:700;">∞ (Безлимит)</span>'
                  : `<div style="display:flex; align-items:center; gap:6px;">
                      <input type="number" id="cred-${u.id}" class="input-sm" style="width:68px;" value="${u.credits}" min="0" max="999">
                      <button class="btn" onclick="updateCredits(${u.id})">Ок</button>
                      <button class="btn" onclick="setCredits(${u.id}, 15)">15</button>
                    </div>`
                }
              </td>
              <td class="mono">${u.logsCount}</td>
              <td>
                <div style="display:flex; gap:6px;">
                  <button class="btn" onclick="toggleRole(${u.id}, '${u.role === 'ADMIN' ? 'USER' : 'ADMIN'}')">${u.role === 'ADMIN' ? 'Сделать USER' : 'Сделать ADMIN'}</button>
                  <button class="btn btn-danger" onclick="deleteUser(${u.id})">Удалить</button>
                </div>
              </td>
            </tr>
          `).join('')}
        </tbody>
      </table>

      <form class="create-row" onsubmit="createUser(event)">
        <input type="email" id="newEmail" class="input-sm" placeholder="Новый email" required style="flex:1; min-width:190px;">
        <input type="text" id="newPass" class="input-sm" placeholder="Пароль" required style="width:150px;">
        <select id="newRole" class="input-sm" style="width:120px;">
          <option value="USER">USER</option>
          <option value="ADMIN">ADMIN (∞)</option>
        </select>
        <input type="number" id="newCredits" class="input-sm" value="15" min="0" max="999" style="width:90px;">
        <button type="submit" class="btn btn-primary">+ Добавить аккаунт</button>
      </form>
    </div>

    <div class="card">
      <div class="card-header">
        <h2>Таблица «ActionLog» (История операций и файлы в БД)</h2>
        <button class="btn btn-danger" onclick="clearAllLogs()">Очистить всю историю</button>
      </div>

      <table>
        <thead>
          <tr>
            <th>ID</th>
            <th>Аккаунт</th>
            <th>Файл (нажмите для скачивания)</th>
            <th>Операция</th>
            <th>Кредиты</th>
            <th>Дата</th>
            <th>Действие</th>
          </tr>
        </thead>
        <tbody>
          ${logs.length === 0 ? '<tr><td colspan="7" style="color:var(--text-muted);">Таблица ActionLog пуста</td></tr>' : logs.map(l => `
            <tr>
              <td class="mono">#${l.id}</td>
              <td><span class="mono">#${l.userId}</span> ${l.userEmail}</td>
              <td>
                ${l.canDownload
                  ? `<a href="${apiPrefix}/api/logs/${l.id}/download" class="file-link">${l.outputName}</a> <span class="mono" style="color:var(--text-muted);">(${l.sizeText})</span>`
                  : `<span class="mono">${l.fileName}</span> <span class="mono" style="color:var(--text-muted);">(без файла)</span>`
                }
              </td>
              <td>${l.targetFormat}</td>
              <td class="mono" style="color:var(--accent-cyan); font-weight:700;">${l.userRole === 'ADMIN' || l.cost === 0 ? '—' : '-' + l.cost + ' кр.'}</td>
              <td class="mono">${new Date(l.createdAt).toLocaleString('ru-RU')}</td>
              <td><button class="btn btn-danger" onclick="deleteLog(${l.id})">Удалить</button></td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>

    <div class="card">
      <div class="card-header">
        <h2>Интерактивная SQL-консоль</h2>
      </div>
      <div class="preset-queries">
        <button type="button" class="btn" data-sql='SELECT id, email, role, credits FROM "User";' onclick="setSql(this.dataset.sql)">SELECT * FROM "User"</button>
        <button type="button" class="btn" data-sql='SELECT id, userId, outputName, targetFormat, cost, fileSize FROM "ActionLog" ORDER BY "createdAt" DESC;' onclick="setSql(this.dataset.sql)">SELECT * FROM "ActionLog"</button>
        <button type="button" class="btn" data-sql='SELECT u.id, u.email, u.role, COUNT(a.id) AS operationsCount FROM "User" u LEFT JOIN "ActionLog" a ON u.id = a.userId GROUP BY u.id;' onclick="setSql(this.dataset.sql)">JOIN: Аккаунты + Операции</button>
        <button type="button" class="btn" data-sql="UPDATE &quot;User&quot; SET credits = 15 WHERE role = 'USER';" onclick="setSql(this.dataset.sql)">UPDATE: Восстановить 15 кредитов юзерам</button>
      </div>
      <textarea id="sqlInput" class="sql-box">SELECT u.id, u.email, u.role, COUNT(a.id) AS operationsCount FROM "User" u LEFT JOIN "ActionLog" a ON u.id = a.userId GROUP BY u.id;</textarea>
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

    async function toggleRole(id, role) {
      await fetch(API + '/api/users/' + id + '/role', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ role })
      });
      location.reload();
    }

    async function createUser(e) {
      e.preventDefault();
      const email = document.getElementById('newEmail').value;
      const password = document.getElementById('newPass').value;
      const role = document.getElementById('newRole').value;
      const credits = document.getElementById('newCredits').value;
      const res = await fetch(API + '/api/users/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password, role, credits })
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
        out.innerHTML = '<div style="color:#4ade80;">Запрос выполнен успешно. Затронуто строк: ' + data.affected + '. Обновите страницу.</div>';
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

const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isDirectRun) {
  sanitizeStaleWalFiles();
  const prisma = new PrismaClient();
  startLocalDbServer(prisma, 4000);
}
