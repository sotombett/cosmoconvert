import express from 'express';
import multer from 'multer';
import sharp from 'sharp';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { PrismaClient } from '@prisma/client';
import {
  startLocalDbServer,
  createDbRouter,
  syncDatabaseSnapshots,
  ensureDbSchemaAndAdmin,
  sanitizeStaleWalFiles,
  deleteStoredHistoryFile,
  getStoredFileInfo,
  formatBytes,
  setSafeDownloadHeaders
} from './db-server.js';
import {
  convertDocumentNatively,
  extractDocumentText,
  buildDocxBuffer,
  buildPdfBuffer,
  stripDocxMetadata,
  readZipEntries
} from './document-utils.js';

const execFileAsync = promisify(execFile);

// Защита от конфликта устаревших WAL-файлов ДО открытия соединения Prisma
sanitizeStaleWalFiles();

const app = express();
const prisma = new PrismaClient();

const MAX_IMAGE_MB = 40;
const MAX_MEDIA_MB = 100;

const uploadImage = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_IMAGE_MB * 1024 * 1024 }
});

const uploadMedia = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_MEDIA_MB * 1024 * 1024 }
});

const DAILY_LIMIT = 15;
const GUEST_LIMIT = 4;
const SECRET_KEY = 'practice-project-secret-key';

app.set('view engine', 'ejs');
app.set('views', path.join(process.cwd(), 'src/views'));

app.use(express.static('public'));
app.use(express.json({ limit: '40mb' }));
app.use(express.urlencoded({ extended: true, limit: '40mb' }));

let dbReadyPromise = null;
function ensureDbReady() {
  if (!dbReadyPromise) {
    dbReadyPromise = ensureDbSchemaAndAdmin(prisma).catch(err => {
      dbReadyPromise = null;
      throw err;
    });
  }
  return dbReadyPromise;
}

// Поиск бинарника FFmpeg: сначала встроенный пакет ffmpeg-static, затем системный ffmpeg
let cachedFfmpegPath = undefined;
async function resolveFfmpegPath() {
  if (cachedFfmpegPath !== undefined) return cachedFfmpegPath;

  try {
    const mod = await import('ffmpeg-static');
    const binPath = mod.default || mod;
    if (typeof binPath === 'string' && fs.existsSync(binPath)) {
      cachedFfmpegPath = binPath;
      return cachedFfmpegPath;
    }
  } catch {
    // Пакет ffmpeg-static еще не установлен
  }

  try {
    await execFileAsync('ffmpeg', ['-version'], { timeout: 3000 });
    cachedFfmpegPath = 'ffmpeg';
    return cachedFfmpegPath;
  } catch {
    cachedFfmpegPath = null;
    return null;
  }
}

function hashPassword(password) {
  return crypto.createHmac('sha256', SECRET_KEY).update(password).digest('hex');
}

function createSignedValue(val) {
  const payload = String(val);
  const sign = crypto.createHmac('sha256', SECRET_KEY).update(payload).digest('hex');
  return `${payload}.${sign}`;
}

function verifySignedValue(token) {
  if (!token) return null;
  const [payload, sign] = token.split('.');
  if (!payload || !sign) return null;
  const expected = crypto.createHmac('sha256', SECRET_KEY).update(payload).digest('hex');
  return sign === expected ? Number(payload) : null;
}

function parseCookies(cookieHeader = '') {
  return Object.fromEntries(
    cookieHeader.split(';').map(c => c.trim().split('=')).filter(p => p.length === 2)
  );
}

function normalizeTimestampMs(val) {
  if (typeof val === 'bigint') return Number(val);
  if (typeof val === 'number') return val;
  const num = Number(val);
  if (!Number.isNaN(num) && String(val || '').trim() !== '') return num;
  const d = new Date(val);
  return Number.isNaN(d.getTime()) ? Date.now() : d.getTime();
}

// Исправляет кодировку кириллических имён файлов из multer (latin1 -> utf8)
function fixUploadedFilename(rawName) {
  const str = String(rawName || 'file');
  if (/[^\x00-\xFF]/.test(str)) return str;
  if (/[\x80-\xFF]/.test(str)) {
    try {
      const decoded = Buffer.from(str, 'latin1').toString('utf8');
      if (!decoded.includes('\uFFFD')) return decoded;
    } catch {}
  }
  return str;
}

function buildOutputFilename(originalName, ext) {
  const base = String(originalName || 'cosmoconvert-result')
    .replace(/\.[^.]+$/, '')
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, '_')
    .trim() || 'cosmoconvert-result';
  const cleanExt = String(ext || 'bin').replace(/[^a-z0-9]/gi, '').toLowerCase() || 'bin';
  return `${base}.${cleanExt}`;
}

// Сборка полноценного многоразмерного Windows ICO (256x256, 64x64, 32x32, 16x16 PNG-in-ICO)
async function buildIcoBuffer(inputBuffer) {
  const sizes = [256, 64, 32, 16];
  const entries = [];

  for (const sz of sizes) {
    const pngBuf = await sharp(inputBuffer)
      .resize(sz, sz, {
        fit: 'contain',
        background: { r: 0, g: 0, b: 0, alpha: 0 }
      })
      .png({ compressionLevel: 9 })
      .toBuffer();
    entries.push({ sz, data: pngBuf });
  }

  const count = entries.length;
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);     // Reserved
  header.writeUInt16LE(1, 2);     // Type: 1 = ICO
  header.writeUInt16LE(count, 4); // Image count

  const dirEntries = [];
  let offset = 6 + 16 * count;
  for (const { sz, data } of entries) {
    const entry = Buffer.alloc(16);
    entry.writeUInt8(sz >= 256 ? 0 : sz, 0); // Width (0 = 256px)
    entry.writeUInt8(sz >= 256 ? 0 : sz, 1); // Height (0 = 256px)
    entry.writeUInt8(0, 2);                  // Color palette
    entry.writeUInt8(0, 3);                  // Reserved
    entry.writeUInt16LE(1, 4);               // Color planes
    entry.writeUInt16LE(32, 6);              // Bits per pixel
    entry.writeUInt32LE(data.length, 8);     // Image data size
    entry.writeUInt32LE(offset, 12);         // Offset from start of file
    dirEntries.push(entry);
    offset += data.length;
  }

  return Buffer.concat([header, ...dirEntries, ...entries.map(e => e.data)]);
}

async function syncUserAccount(userId) {
  await ensureDbReady();
  const rows = await prisma.$queryRawUnsafe(
    'SELECT id, email, passwordHash, role, credits, lastReset FROM "User" WHERE id = ?;',
    userId
  );
  if (!rows || rows.length === 0) return null;

  let user = {
    id: Number(rows[0].id),
    email: rows[0].email,
    passwordHash: rows[0].passwordHash,
    role: rows[0].role || 'USER',
    credits: Number(rows[0].credits),
    lastReset: new Date(normalizeTimestampMs(rows[0].lastReset))
  };

  const now = new Date();
  if (user.role !== 'ADMIN' && now.toDateString() !== user.lastReset.toDateString()) {
    await prisma.$executeRawUnsafe(
      'UPDATE "User" SET credits = ?, lastReset = ? WHERE id = ?;',
      DAILY_LIMIT,
      now.getTime(),
      user.id
    );
    user.credits = DAILY_LIMIT;
    user.lastReset = now;
    await syncDatabaseSnapshots(prisma);
  }

  // Удаление записей старше 30 дней
  const thirtyDaysAgoMs = now.getTime() - 30 * 24 * 60 * 60 * 1000;
  const expired = await prisma.$queryRawUnsafe(
    'SELECT id, storedFile FROM "ActionLog" WHERE userId = ? AND createdAt < ?;',
    user.id,
    thirtyDaysAgoMs
  );
  if (expired && expired.length > 0) {
    for (const row of expired) {
      deleteStoredHistoryFile(row.storedFile);
    }
    await prisma.$executeRawUnsafe(
      'DELETE FROM "ActionLog" WHERE userId = ? AND createdAt < ?;',
      user.id,
      thirtyDaysAgoMs
    );
    await syncDatabaseSnapshots(prisma);
  }

  return user;
}

app.use(async (req, res, next) => {
  try {
    await ensureDbReady();
    const cookies = parseCookies(req.headers.cookie);
    const userId = verifySignedValue(cookies.token);
    req.user = userId ? await syncUserAccount(userId) : null;
    req.isAdmin = Boolean(req.user && req.user.role === 'ADMIN');

    let guestUsed = verifySignedValue(cookies.guest_used);
    if (guestUsed === null || guestUsed < 0) guestUsed = 0;
    req.guestUsed = guestUsed;
    req.guestRemaining = Math.max(0, GUEST_LIMIT - guestUsed);

    res.locals.user = req.user;
    res.locals.isAdmin = req.isAdmin;
    res.locals.dailyLimit = DAILY_LIMIT;
    res.locals.guestLimit = GUEST_LIMIT;
    res.locals.guestRemaining = req.guestRemaining;
    next();
  } catch (err) {
    next(err);
  }
});

const toolsConfig = {
  image_process: {
    key: 'image_process',
    title: 'Обработка изображений',
    desc: 'Единая студия: интерактивное кадрирование, 15 пресетов пропорций, отражение по осям и <b>алгоритмический апскейл 2x / 4x</b>.',
    cost: 1
  }
};

const infoPages = {
  about: {
    title: 'О сайте CosmoConvert',
    subtitle: 'Онлайн-платформа для мультимедийной обработки графики, документов, аудио и видео',
    sections: [
      {
        heading: 'Назначение программного продукта',
        text: 'CosmoConvert разработан в рамках учебной практики по модулю «Проектирование и разработка информационных систем». Платформа объединяет универсальный конвертер (изображения включая ICO, документы, видео и аудио), студию ресайза и алгоритмического апскейла, универсальную очистку метаданных, аудио-студию с 3-полосной волновой формой и модуль извлечения звука из видео.'
      },
      {
        heading: 'Технологический стек',
        text: 'Серверная часть построена на Node.js и Express с графическим ядром Sharp (libvips) и поддержкой FFmpeg / Web Audio DSP. Хранение учетных записей (USER / ADMIN), лимитов кредитов и 30-дневной истории операций вместе с обработанными файлами реализовано непосредственно в базе данных SQLite под управлением Prisma ORM и локального сервера БД.'
      }
    ]
  },
  privacy: {
    title: 'Политика безопасности и конфиденциальности',
    subtitle: 'Как обрабатываются ваши загружаемые файлы и персональные данные',
    sections: [
      {
        heading: 'Хранение истории операций в базе данных (30 дней)',
        text: 'Для авторизованных пользователей готовые обработанные файлы сохраняются в базе данных сроком на 30 дней, чтобы вы могли повторно скачать их по клику на название файла в личном кабинете. По истечении 30 дней записи и файлы автоматически удаляются.'
      },
      {
        heading: 'Защита учетных записей',
        text: 'Доступ к скачиванию файлов из истории строго ограничен владельцем аккаунта. Пароли пользователей хэшируются алгоритмом HMAC-SHA256 и никогда не хранятся в открытом виде.'
      }
    ]
  },
  terms: {
    title: 'Условия использования сервиса',
    subtitle: 'Правила работы с системой ежедневных кредитов, гостевым доступом и ролями',
    sections: [
      {
        heading: 'Гостевой режим, пользователи и администраторы',
        text: 'Неавторизованным посетителям предоставляется 4 ознакомительных действия. После регистрации пользователю начисляется 15 кредитов, которые автоматически восстанавливаются каждые сутки. Учетные записи с ролью администратора имеют безлимитный доступ ко всем инструментам без списания кредитов.'
      },
      {
        heading: 'Тарификация операций в кредитах',
        text: 'Конвертация файлов, ресайз и отдельная очистка метаданных стоят 1 кредит. Аудио-студия и извлечение аудио из видео стоят 2 кредита. Алгоритмический апскейл (2x/4x) стоит 3 кредита. Дополнительная опция «Стереть метаданные EXIF» внутри других вкладок добавляет +1 кредит.'
      }
    ]
  },
  faq: {
    title: 'Часто задаваемые вопросы (FAQ)',
    subtitle: 'Ответы на популярные вопросы по работе с инструментами CosmoConvert',
    sections: [
      {
        heading: 'Как работает конвертация изображений в формат ICO?',
        text: 'При выборе формата ICO сервис автоматически собирает стандартный многоразмерный значок Windows (.ico), включающий в себя слои 256×256, 64×64, 32×32 и 16×16 пикселей с сохранением прозрачности и пропорций.'
      },
      {
        heading: 'Как повторно скачать обработанный файл из истории?',
        text: 'Зайдите в личный кабинет (нажмите на ваш email в правом верхнем углу). Все обработанные файлы сохраняются прямо в базе данных — достаточно кликнуть по названию файла в таблице истории.'
      }
    ]
  },
  contacts: {
    title: 'Контактная информация',
    subtitle: 'Связь с разработчиком проекта и техническая поддержка',
    sections: [
      {
        heading: 'Учебная практика',
        text: 'Проект выполнен в рамках учебной практики «Проектирование и разработка информационных систем» (2026 г.).'
      },
      {
        heading: 'Обратная связь',
        text: 'По вопросам работы веб-приложения, базы данных и алгоритмов обработки файлов обращайтесь через учебный портал или по электронной почте: support@cosmoconvert.local.'
      }
    ]
  }
};

// Встроенный маршрут локального сервера БД
app.use('/db-admin', createDbRouter(prisma, '/db-admin'));

// Главная страница
app.get(['/', '/home'], (req, res) => {
  res.render('home', { activePage: 'home' });
});

// Информационные страницы футера
app.get(['/about', '/privacy', '/terms', '/faq', '/contacts'], (req, res) => {
  const pageKey = req.path.slice(1);
  res.render('info', { info: infoPages[pageKey], activePage: pageKey });
});

// 1. Универсальная конвертация
app.get('/convert', (req, res) => {
  res.render('convert', { activePage: 'convert' });
});

// 2. Изображения (ресайз + апскейл)
app.get(['/images', '/images/process'], (req, res) => {
  res.render('editor', { tool: toolsConfig.image_process, activePage: 'image_process' });
});

// 3. Аудио-студия
app.get('/audio', (req, res) => {
  res.render('audio', { activePage: 'audio' });
});

// 4. Видео -> Извлечь аудио
app.get('/video/extract-audio', (req, res) => {
  res.render('video-extract', { activePage: 'video_extract' });
});

// 5. Метаданные
app.get('/metadata', (req, res) => {
  res.render('metadata', { activePage: 'metadata' });
});

// Совместимость со старыми маршрутами
app.get(['/resize', '/upscale'], (req, res) => res.redirect('/images/process'));
app.get(['/exif', '/images/metadata'], (req, res) => res.redirect('/metadata'));

// Авторизация и профиль
app.get('/login', (req, res) => {
  if (req.user) return res.redirect('/profile');
  res.render('login', { error: null, activePage: 'login' });
});

app.get('/register', (req, res) => {
  if (req.user) return res.redirect('/profile');
  let notice = null;
  if (req.query.reason === 'limit') {
    notice = 'Гостевой лимит (4 действия) исчерпан. Зарегистрируйтесь для получения 15 кредитов в день!';
  } else if (req.query.reason === 'locked') {
    notice = 'Эта функция доступна только для аккаунтов. Зарегистрируйтесь и получите 15 кредитов в день!';
  }
  res.render('register', { error: null, notice, activePage: 'register' });
});

app.get('/profile', async (req, res) => {
  if (!req.user) return res.redirect('/login');
  const rawLogs = await prisma.$queryRawUnsafe(
    'SELECT id, userId, fileName, targetFormat, cost, storedFile, outputName, mimeType, fileSize, (fileData IS NOT NULL AND length(fileData) > 0) AS hasFileData, createdAt FROM "ActionLog" WHERE userId = ? ORDER BY createdAt DESC;',
    req.user.id
  );
  const logs = rawLogs.map(l => {
    const inDb = Boolean(Number(l.hasFileData));
    const diskInfo = getStoredFileInfo(l.storedFile);
    const canDownload = inDb || diskInfo.exists;
    const sizeText = inDb ? formatBytes(l.fileSize) : diskInfo.sizeText;
    return {
      id: Number(l.id),
      fileName: l.fileName,
      targetFormat: l.targetFormat,
      cost: Number(l.cost),
      outputName: l.outputName || l.fileName,
      canDownload,
      sizeText,
      createdAt: new Date(normalizeTimestampMs(l.createdAt))
    };
  });
  res.render('profile', { logs, activePage: 'profile' });
});

// Повторное скачивание изменённого файла напрямую из базы данных
app.get('/api/history/:id/download', async (req, res) => {
  try {
    if (!req.user) return res.status(401).redirect('/login');
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).send('Некорректный ID записи');

    const rows = await prisma.$queryRawUnsafe(
      'SELECT id, userId, fileName, storedFile, outputName, mimeType, fileData FROM "ActionLog" WHERE id = ?;',
      id
    );
    if (!rows || rows.length === 0) return res.status(404).send('Запись в истории не найдена');

    const entry = rows[0];
    if (Number(entry.userId) !== req.user.id && !req.isAdmin) {
      return res.status(403).send('Нет доступа к этому файлу');
    }

    const downloadName = entry.outputName || entry.fileName || 'cosmoconvert-result';

    // Приоритет: файл, сохранённый непосредственно в БД (ActionLog.fileData)
    if (entry.fileData && entry.fileData.length > 0) {
      const buffer = Buffer.from(entry.fileData, 'base64');
      setSafeDownloadHeaders(res, downloadName, entry.mimeType || 'application/octet-stream');
      return res.send(buffer);
    }

    // Резерв: если файл ранее был сохранён на диске
    const fileInfo = getStoredFileInfo(entry.storedFile);
    if (fileInfo.exists) {
      return res.download(fileInfo.fullPath, downloadName);
    }

    return res.status(404).send('Файл отсутствует в базе данных');
  } catch (err) {
    console.error(err);
    res.status(500).send('Ошибка скачивания файла из базы данных');
  }
});

// Удаление записи из истории
app.post('/api/history/:id/delete', async (req, res) => {
  try {
    if (!req.user) return res.status(401).json({ error: 'Требуется авторизация' });
    const id = Number(req.params.id);
    const rows = await prisma.$queryRawUnsafe('SELECT id, userId, storedFile FROM "ActionLog" WHERE id = ?;', id);
    if (!rows || rows.length === 0) return res.status(404).json({ error: 'Запись не найдена' });
    if (Number(rows[0].userId) !== req.user.id && !req.isAdmin) {
      return res.status(403).json({ error: 'Нет доступа' });
    }
    deleteStoredHistoryFile(rows[0].storedFile);
    await prisma.$executeRawUnsafe('DELETE FROM "ActionLog" WHERE id = ?;', id);
    await syncDatabaseSnapshots(prisma);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Ошибка удаления записи' });
  }
});

app.post('/login', async (req, res) => {
  try {
    await ensureDbReady();
    const email = (req.body.email || '').trim().toLowerCase();
    const password = req.body.password || '';
    const rows = await prisma.$queryRawUnsafe(
      'SELECT id, email, passwordHash, role FROM "User" WHERE email = ?;',
      email
    );
    const user = rows && rows[0];

    if (!user || user.passwordHash !== hashPassword(password)) {
      return res.render('login', { error: 'Неверная почта или пароль', activePage: 'login' });
    }

    res.cookie('token', createSignedValue(Number(user.id)), { httpOnly: true, path: '/' });
    res.redirect('/convert');
  } catch (err) {
    console.error('[CosmoConvert Login]', err);
    res.render('login', { error: 'Ошибка обращения к базе данных. Попробуйте ещё раз.', activePage: 'login' });
  }
});

app.post('/register', async (req, res) => {
  try {
    await ensureDbReady();
    const email = (req.body.email || '').trim().toLowerCase();
    const password = req.body.password || '';
    const confirmPassword = req.body.confirmPassword || '';

    if (!email || !password || !confirmPassword) {
      return res.render('register', { error: 'Заполните все поля', notice: null, activePage: 'register' });
    }
    if (password !== confirmPassword) {
      return res.render('register', { error: 'Введенные пароли не совпадают', notice: null, activePage: 'register' });
    }
    if (password.length < 4) {
      return res.render('register', { error: 'Пароль должен содержать минимум 4 символа', notice: null, activePage: 'register' });
    }

    const exists = await prisma.$queryRawUnsafe('SELECT id FROM "User" WHERE email = ?;', email);
    if (exists && exists.length > 0) {
      return res.render('register', { error: 'Эта электронная почта уже зарегистрирована', notice: null, activePage: 'register' });
    }

    await prisma.$executeRawUnsafe(
      'INSERT INTO "User" ("email", "passwordHash", "role", "credits", "lastReset") VALUES (?, ?, ?, ?, ?);',
      email,
      hashPassword(password),
      'USER',
      DAILY_LIMIT,
      Date.now()
    );

    const created = await prisma.$queryRawUnsafe('SELECT id FROM "User" WHERE email = ?;', email);
    await syncDatabaseSnapshots(prisma);
    res.cookie('token', createSignedValue(Number(created[0].id)), { httpOnly: true, path: '/' });
    res.redirect('/convert');
  } catch (err) {
    console.error('[CosmoConvert Register]', err);
    res.render('register', { error: 'Ошибка регистрации. Попробуйте ещё раз.', notice: null, activePage: 'register' });
  }
});

app.post('/logout', (req, res) => {
  res.clearCookie('token', { path: '/' });
  res.redirect('/home');
});

// Изменение гостевого лимита (сброс 4/4 или обнуление 0/4)
app.post('/api/guest-limit', (req, res) => {
  const { action } = req.body;
  const newUsed = action === 'zero' ? GUEST_LIMIT : 0;
  const remaining = Math.max(0, GUEST_LIMIT - newUsed);
  res.cookie('guest_used', createSignedValue(newUsed), { httpOnly: true, path: '/' });
  res.json({
    remaining,
    limit: GUEST_LIMIT,
    display: `${remaining}/${GUEST_LIMIT}`
  });
});

// Общая функция списания кредитов (для ADMIN — безлимит, cost = 0) + сохранение готового файла в БД SQLite
async function consumeCreditsAndLog(req, res, fileName, actionLabel, cost, filePayload = null) {
  if (req.user) {
    const hasBuf = Boolean(filePayload && filePayload.buffer && Buffer.isBuffer(filePayload.buffer) && filePayload.buffer.length > 0);
    const fileDataBase64 = hasBuf ? filePayload.buffer.toString('base64') : null;
    const fileSize = hasBuf ? filePayload.buffer.length : null;
    const mimeType = (filePayload && filePayload.mimeType) || 'application/octet-stream';
    const outputName = (filePayload && filePayload.outputName) || fileName;

    if (req.isAdmin) {
      await prisma.$executeRawUnsafe(
        'INSERT INTO "ActionLog" ("userId", "fileName", "targetFormat", "cost", "outputName", "mimeType", "fileSize", "fileData", "createdAt") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?);',
        req.user.id,
        fileName,
        actionLabel,
        0,
        outputName,
        mimeType,
        fileSize,
        fileDataBase64,
        Date.now()
      );
      await syncDatabaseSnapshots(prisma);
      return 'unlimited';
    }

    const nextCredits = Math.max(0, req.user.credits - cost);
    await prisma.$executeRawUnsafe(
      'UPDATE "User" SET credits = ? WHERE id = ?;',
      nextCredits,
      req.user.id
    );
    await prisma.$executeRawUnsafe(
      'INSERT INTO "ActionLog" ("userId", "fileName", "targetFormat", "cost", "outputName", "mimeType", "fileSize", "fileData", "createdAt") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?);',
      req.user.id,
      fileName,
      actionLabel,
      cost,
      outputName,
      mimeType,
      fileSize,
      fileDataBase64,
      Date.now()
    );
    await syncDatabaseSnapshots(prisma);
    return `${nextCredits}/${DAILY_LIMIT}`;
  } else {
    const newUsed = req.guestUsed + 1;
    const rem = Math.max(0, GUEST_LIMIT - newUsed);
    res.cookie('guest_used', createSignedValue(newUsed), { httpOnly: true, path: '/' });
    return `${rem}/${GUEST_LIMIT}`;
  }
}

// Многоступенчатый алгоритмический апскейл
async function runAlgorithmicUpscale(inputBuffer, baseW, baseH, mult, upscaleMode, sharpness, keepMetadata) {
  const MAX_DIM = 16000;
  if (upscaleMode === 'nearest') {
    const scale = Math.min(mult, MAX_DIM / Math.max(baseW, baseH));
    const targetW = Math.max(16, Math.round(baseW * scale));
    const targetH = Math.max(16, Math.round(baseH * scale));
    let pipe = sharp(inputBuffer).resize(targetW, targetH, { kernel: sharp.kernel.nearest, fit: 'fill' });
    if (sharpness === 'high') pipe = pipe.linear(1.06, -6);
    if (keepMetadata) pipe = pipe.withMetadata();
    return { pipe, targetW, targetH };
  }

  const kernel = upscaleMode === 'mitchell' ? sharp.kernel.mitchell : sharp.kernel.lanczos3;
  const isHigh = sharpness === 'high';

  const scaleStep1 = Math.min(2, MAX_DIM / Math.max(baseW, baseH));
  const step1W = Math.max(16, Math.round(baseW * scaleStep1));
  const step1H = Math.max(16, Math.round(baseH * scaleStep1));

  let step1Pipe = sharp(inputBuffer);
  if (upscaleMode === 'mitchell' || isHigh) step1Pipe = step1Pipe.median(3);

  step1Pipe = step1Pipe
    .resize(step1W, step1H, { kernel, fit: 'fill' })
    .sharpen({
      sigma: isHigh ? 1.65 : 1.3,
      m1: isHigh ? 3.2 : 2.0,
      m2: isHigh ? 6.5 : 4.2,
      x1: 2,
      y2: 22,
      y3: 35
    });

  if (mult !== 4) {
    if (isHigh) step1Pipe = step1Pipe.linear(1.05, -6).modulate({ saturation: 1.05 });
    if (keepMetadata) step1Pipe = step1Pipe.withMetadata();
    return { pipe: step1Pipe, targetW: step1W, targetH: step1H };
  }

  const step1Buffer = await step1Pipe.png({ compressionLevel: 1 }).toBuffer();
  const scaleStep2 = Math.min(4, MAX_DIM / Math.max(baseW, baseH));
  const step2W = Math.max(16, Math.round(baseW * scaleStep2));
  const step2H = Math.max(16, Math.round(baseH * scaleStep2));

  let step2Pipe = sharp(step1Buffer)
    .resize(step2W, step2H, { kernel, fit: 'fill' })
    .sharpen({
      sigma: isHigh ? 2.1 : 1.55,
      m1: isHigh ? 4.0 : 2.4,
      m2: isHigh ? 8.0 : 5.0,
      x1: 2,
      y2: 25,
      y3: 40
    });

  if (isHigh) step2Pipe = step2Pipe.linear(1.06, -7).modulate({ saturation: 1.06 });
  if (keepMetadata) step2Pipe = step2Pipe.withMetadata();

  return { pipe: step2Pipe, targetW: step2W, targetH: step2H };
}

// API: Обработка изображений (конвертация включая ICO, объединенные ресайз+апскейл)
app.post('/api/process', (req, res, next) => {
  uploadImage.single('image')(req, res, (err) => {
    if (err && err.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({ error: `Размер файла превышает допустимый лимит (${MAX_IMAGE_MB} МБ)` });
    }
    if (err) return res.status(400).json({ error: 'Ошибка загрузки файла' });
    next();
  });
}, async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Вы не выбрали файл для обработки' });
    req.file.originalname = fixUploadedFilename(req.file.originalname);

    const {
      category = 'convert',
      format = 'webp',
      quality = '90',
      flipH = 'false',
      flipV = 'false',
      upscaleMode = 'lanczos',
      scaleFactor = '1',
      sharpness = 'normal',
      exifMode = 'all',
      stripExif = 'false',
      width,
      height,
      cropX,
      cropY,
      cropW,
      cropH
    } = req.body;

    const mult = Number(scaleFactor) === 4 ? 4 : (Number(scaleFactor) === 2 ? 2 : 1);
    const isUpscaling = (category === 'image_process' && mult > 1) || category === 'upscale';
    const isMetadataTab = category === 'metadata' || category === 'exif';

    if (!req.user) {
      if (isUpscaling || isMetadataTab) {
        return res.status(403).json({
          error: 'Апскейл и управление метаданными доступны только после регистрации',
          redirect: '/register?reason=locked'
        });
      }
      if (req.guestRemaining <= 0) {
        return res.status(403).json({
          error: 'Гостевой лимит (4 действия) исчерпан. Зарегистрируйтесь для получения 15 кредитов в день!',
          redirect: '/register?reason=limit'
        });
      }
    }

    const baseCost = isUpscaling ? 3 : 1;
    const canStrip = !isMetadataTab && Boolean(req.user) && stripExif === 'true';
    const cost = req.isAdmin ? 0 : (baseCost + (canStrip ? 1 : 0));

    if (req.user && !req.isAdmin && req.user.credits < cost) {
      return res.status(403).json({ error: `Недостаточно кредитов (требуется ${cost} кр., доступно ${req.user.credits} кр.)` });
    }

    let pipeline = sharp(req.file.buffer);
    const meta = await pipeline.metadata();
    const origFormat = ['jpeg', 'png', 'webp', 'avif'].includes(meta.format) ? meta.format : 'png';
    let outFormat = origFormat;
    let outQuality = 92;
    let actionLabel = '';
    let outputBuffer = null;
    let outMimeType = `image/${outFormat}`;

    if (category === 'convert') {
      const reqFmt = String(format || 'webp').toLowerCase();
      if (reqFmt === 'ico') {
        outFormat = 'ico';
        outMimeType = 'image/x-icon';
        outputBuffer = await buildIcoBuffer(req.file.buffer);
        actionLabel = 'Конвертация → ICO (256/64/32/16 px)';
      } else {
        outFormat = ['webp', 'png', 'jpeg', 'avif'].includes(reqFmt) ? reqFmt : 'webp';
        outMimeType = `image/${outFormat}`;
        outQuality = Math.max(40, Math.min(100, Number(quality) || 90));
        actionLabel = `Конвертация → ${outFormat.toUpperCase()} (${outQuality}%)`;
        if (!canStrip) pipeline = pipeline.withMetadata();
      }
    } else if (category === 'image_process' || category === 'resize' || category === 'upscale') {
      const rawCW = Math.round(Number(cropW) || 0);
      const rawCH = Math.round(Number(cropH) || 0);
      if (rawCW > 0 && rawCH > 0 && meta.width && meta.height) {
        const cx = Math.max(0, Math.min(meta.width - 1, Math.round(Number(cropX) || 0)));
        const cy = Math.max(0, Math.min(meta.height - 1, Math.round(Number(cropY) || 0)));
        const cw = Math.max(1, Math.min(meta.width - cx, rawCW));
        const ch = Math.max(1, Math.min(meta.height - cy, rawCH));
        if (cx > 0 || cy > 0 || cw < meta.width || ch < meta.height) {
          pipeline = pipeline.extract({ left: cx, top: cy, width: cw, height: ch });
        }
      }

      const doFlipH = flipH === 'true';
      const doFlipV = flipV === 'true';
      if (doFlipH) pipeline = pipeline.flop();
      if (doFlipV) pipeline = pipeline.flip();

      const w = Math.max(16, Math.min(12000, Number(width) || meta.width || 1000));
      const h = Math.max(16, Math.min(12000, Number(height) || meta.height || 1000));
      pipeline = pipeline.resize(w, h, { fit: 'fill' });

      let symNote = '';
      if (doFlipH && doFlipV) symNote = ', отр. Г+В';
      else if (doFlipH) symNote = ', отр. Г';
      else if (doFlipV) symNote = ', отр. В';

      if (isUpscaling) {
        const prepBuf = await pipeline.png({ compressionLevel: 1 }).toBuffer();
        const { pipe, targetW, targetH } = await runAlgorithmicUpscale(
          prepBuf,
          w,
          h,
          mult === 1 ? 2 : mult,
          upscaleMode,
          sharpness,
          !canStrip
        );
        pipeline = pipe;
        outQuality = 95;
        const modeNames = { lanczos: 'Lanczos3', mitchell: 'Mitchell', nearest: 'Pixel Art' };
        actionLabel = `Обработка + Апскейл ${mult === 1 ? 2 : mult}x → ${targetW}×${targetH}${symNote} (${modeNames[upscaleMode] || 'Lanczos3'})`;
      } else {
        if (!canStrip) pipeline = pipeline.withMetadata();
        actionLabel = `Ресайз ${w}×${h}${symNote} (${origFormat.toUpperCase()})`;
      }
      outMimeType = `image/${outFormat}`;
    } else if (isMetadataTab) {
      if (exifMode === 'keep_icm') {
        pipeline = pipeline.keepIccProfile();
        actionLabel = 'Удаление EXIF (сохранен профиль цвета)';
      } else {
        actionLabel = 'Полная очистка EXIF и GPS';
      }
      outMimeType = `image/${outFormat}`;
    }

    if (!isMetadataTab && canStrip) actionLabel += ' + Удаление EXIF';

    if (!outputBuffer) {
      outputBuffer = await pipeline.toFormat(outFormat, { quality: outQuality }).toBuffer();
    }

    const outName = buildOutputFilename(req.file.originalname, outFormat);
    const creditsDisplay = await consumeCreditsAndLog(req, res, req.file.originalname, actionLabel, cost, {
      buffer: outputBuffer,
      ext: outFormat,
      mimeType: outMimeType,
      outputName: outName
    });

    res.set('X-Credits-Remaining', creditsDisplay);
    res.set('X-Out-Ext', outFormat);
    setSafeDownloadHeaders(res, outName, outMimeType);
    res.send(outputBuffer);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Ошибка обработки изображения' });
  }
});

// =========================================================================
// УНИВЕРСАЛЬНАЯ ОЧИСТКА МЕТАДАННЫХ (ИЗОБРАЖЕНИЯ + АУДИО/ВИДЕО + ДОКУМЕНТЫ)
// =========================================================================

function stripMp3Id3Tags(buf) {
  let start = 0;
  let end = buf.length;
  let removedTags = [];

  if (buf.length >= 10 && buf[0] === 0x49 && buf[1] === 0x44 && buf[2] === 0x33) {
    const flags = buf[5];
    const size =
      ((buf[6] & 0x7f) << 21) |
      ((buf[7] & 0x7f) << 14) |
      ((buf[8] & 0x7f) << 7) |
      (buf[9] & 0x7f);
    const hasFooter = (flags & 0x10) !== 0;
    const totalHeader = 10 + size + (hasFooter ? 10 : 0);
    if (totalHeader < end) {
      start = totalHeader;
      removedTags.push('ID3v2');
    }
  }

  if (end - start >= 128) {
    const tailOffset = end - 128;
    if (buf[tailOffset] === 0x54 && buf[tailOffset + 1] === 0x41 && buf[tailOffset + 2] === 0x47) {
      end = tailOffset;
      removedTags.push('ID3v1');
    }
  }

  return { buffer: buf.subarray(start, end), removedTags };
}

function stripWavMetadataChunks(buf) {
  if (buf.length < 12 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    return { buffer: buf, removedChunks: [] };
  }

  const keptChunks = [];
  const removedChunks = [];
  let offset = 12;

  while (offset + 8 <= buf.length) {
    const id = buf.toString('ascii', offset, offset + 4);
    const chunkSize = buf.readUInt32LE(offset + 4);
    const paddedSize = chunkSize + (chunkSize % 2);
    const chunkEnd = Math.min(buf.length, offset + 8 + paddedSize);

    if (id === 'fmt ' || id === 'data' || id === 'fact') {
      keptChunks.push(buf.subarray(offset, chunkEnd));
    } else {
      removedChunks.push(id.trim());
    }
    offset = chunkEnd;
  }

  const bodyLen = keptChunks.reduce((sum, c) => sum + c.length, 0);
  const header = Buffer.alloc(12);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(4 + bodyLen, 4);
  header.write('WAVE', 8, 'ascii');

  return { buffer: Buffer.concat([header, ...keptChunks]), removedChunks };
}

function detectMetadataCategory(file) {
  const ext = (file.originalname.split('.').pop() || '').toLowerCase();
  if (file.mimetype.startsWith('image/') || ['png', 'jpg', 'jpeg', 'webp', 'avif', 'gif', 'tiff', 'bmp'].includes(ext)) {
    return { kind: 'image', ext };
  }
  if (file.mimetype.startsWith('audio/') || ['mp3', 'wav', 'ogg', 'm4a', 'flac'].includes(ext)) {
    return { kind: 'audio', ext };
  }
  if (file.mimetype.startsWith('video/') || ['mp4', 'webm', 'mov', 'mkv', 'avi'].includes(ext)) {
    return { kind: 'video', ext };
  }
  return { kind: 'document', ext };
}

app.post('/api/metadata/inspect', uploadMedia.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Файл не загружен' });
    req.file.originalname = fixUploadedFilename(req.file.originalname);
    const { kind, ext } = detectMetadataCategory(req.file);
    const items = [];

    if (kind === 'image') {
      const meta = await sharp(req.file.buffer).metadata();
      items.push({ label: 'Тип файла', value: `Изображение (${(meta.format || ext).toUpperCase()})` });
      items.push({ label: 'Разрешение', value: `${meta.width || '?'} × ${meta.height || '?'} px` });
      items.push({ label: 'EXIF-теги (камера / GPS)', value: meta.exif ? `Обнаружено (${meta.exif.length} байт)` : 'Не обнаружено' });
      items.push({ label: 'XMP / IPTC метаданные', value: (meta.xmp || meta.iptc) ? 'Обнаружены скрытые блоки' : 'Отсутствуют' });
      items.push({ label: 'Цветовой профиль (ICC)', value: meta.icc ? `Присутствует (${meta.icc.length} байт)` : 'Стандартный sRGB' });
    } else if (kind === 'audio' || kind === 'video') {
      items.push({ label: 'Тип файла', value: `${kind === 'video' ? 'Видео' : 'Аудио'} (.${ext})` });
      items.push({ label: 'Размер', value: `${(req.file.size / (1024 * 1024)).toFixed(2)} МБ` });
      if (ext === 'mp3') {
        const hasV2 = req.file.buffer.length >= 10 && req.file.buffer.toString('ascii', 0, 3) === 'ID3';
        const hasV1 = req.file.buffer.length >= 128 && req.file.buffer.toString('ascii', req.file.buffer.length - 128, req.file.buffer.length - 125) === 'TAG';
        items.push({ label: 'ID3-теги (автор, обложка)', value: (hasV2 || hasV1) ? `Обнаружены (${[hasV2 && 'ID3v2', hasV1 && 'ID3v1'].filter(Boolean).join(', ')})` : 'Не найдены' });
      } else if (ext === 'wav') {
        const { removedChunks } = stripWavMetadataChunks(req.file.buffer);
        items.push({ label: 'Служебные RIFF-чанки', value: removedChunks.length ? `Найдены (${removedChunks.join(', ')})` : 'Отсутствуют' });
      } else {
        items.push({ label: 'Контейнерные теги', value: 'Будут очищены поля автора, даты, GPS и ПО кодирования' });
      }
    } else if (ext === 'docx') {
      const entries = readZipEntries(req.file.buffer);
      const coreXml = entries.get('docProps/core.xml')?.toString('utf-8') || '';
      const author = (coreXml.match(/<dc:creator>([^<]+)<\/dc:creator>/) || [])[1];
      const modBy = (coreXml.match(/<cp:lastModifiedBy>([^<]+)<\/cp:lastModifiedBy>/) || [])[1];
      items.push({ label: 'Тип файла', value: 'Документ Microsoft Word (.DOCX)' });
      items.push({ label: 'Автор (dc:creator)', value: author || 'Не указан' });
      items.push({ label: 'Последний редактор', value: modBy || 'Не указан' });
      items.push({ label: 'Свойства документа', value: entries.has('docProps/core.xml') ? 'Будут очищены core.xml и app.xml' : 'Не обнаружены' });
    } else if (ext === 'pdf') {
      const latin = req.file.buffer.toString('latin1');
      const hasAuthor = /\/Author\s*\(/.test(latin);
      const hasCreator = /\/Creator\s*\(/.test(latin);
      const hasProducer = /\/Producer\s*\(/.test(latin);
      items.push({ label: 'Тип файла', value: 'Документ PDF (.PDF)' });
      items.push({ label: 'Метаданные /Author', value: hasAuthor ? 'Обнаружены' : 'Не найдены' });
      items.push({ label: 'Метаданные /Creator и /Producer', value: (hasCreator || hasProducer) ? 'Обнаружены' : 'Не найдены' });
    } else {
      const text = req.file.buffer.toString('utf-8');
      const hasBom = text.charCodeAt(0) === 0xFEFF;
      const metaTagsCount = (text.match(/<meta\b[^>]*>/gi) || []).length;
      const commentsCount = (text.match(/<!--[\s\S]*?-->/g) || []).length;
      items.push({ label: 'Тип файла', value: `Документ (.${ext})` });
      items.push({ label: 'HTML/XML meta-теги', value: metaTagsCount > 0 ? `Найдено: ${metaTagsCount}` : 'Не найдено' });
      items.push({ label: 'Скрытые комментарии', value: commentsCount > 0 ? `Найдено: ${commentsCount}` : 'Не найдено' });
      items.push({ label: 'Скрытый маркер BOM', value: hasBom ? 'Присутствует (UTF-8 BOM)' : 'Отсутствует' });
    }

    res.json({ kind, ext, items });
  } catch (err) {
    res.status(500).json({ error: 'Не удалось проанализировать метаданные файла' });
  }
});

app.post('/api/metadata/clean', (req, res, next) => {
  uploadMedia.single('file')(req, res, (err) => {
    if (err && err.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({ error: `Размер файла превышает лимит (${MAX_MEDIA_MB} МБ)` });
    }
    if (err) return res.status(400).json({ error: 'Ошибка загрузки файла' });
    next();
  });
}, async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Вы не выбрали файл для обработки' });
    req.file.originalname = fixUploadedFilename(req.file.originalname);

    if (!req.user) {
      return res.status(403).json({
        error: 'Очистка метаданных доступна только после регистрации',
        redirect: '/register?reason=locked'
      });
    }

    const cost = req.isAdmin ? 0 : 1;
    if (!req.isAdmin && req.user.credits < cost) {
      return res.status(403).json({ error: `Недостаточно кредитов (требуется ${cost} кр., доступно ${req.user.credits} кр.)` });
    }

    const { kind, ext } = detectMetadataCategory(req.file);
    const cleanMode = req.body.cleanMode || 'all';
    let outBuffer = null;
    let outExt = ext || 'bin';
    let contentType = req.file.mimetype || 'application/octet-stream';
    let actionLabel = '';

    if (kind === 'image') {
      let pipeline = sharp(req.file.buffer);
      const meta = await pipeline.metadata();
      outExt = ['jpeg', 'png', 'webp', 'avif'].includes(meta.format) ? meta.format : 'png';
      if (cleanMode === 'keep_icm') {
        pipeline = pipeline.keepIccProfile();
        actionLabel = `Очистка EXIF/GPS (${outExt.toUpperCase()}, сохранён ICC)`;
      } else {
        actionLabel = `Полная очистка EXIF/GPS (${outExt.toUpperCase()})`;
      }
      outBuffer = await pipeline.toFormat(outExt, { quality: 94 }).toBuffer();
      contentType = `image/${outExt}`;
    } else if (kind === 'document' && ext === 'docx') {
      outBuffer = stripDocxMetadata(req.file.buffer);
      contentType = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
      actionLabel = 'Очистка метаданных автора (DOCX)';
    } else if (kind === 'document' && ext === 'pdf') {
      // Пересобираем чистый PDF без /Author, /Creator, /Producer с сохранением текста
      const extracted = extractDocumentText(req.file.buffer, req.file.originalname);
      outBuffer = await buildPdfBuffer(extracted, 'Clean PDF Document', sharp);
      contentType = 'application/pdf';
      actionLabel = 'Очистка метаданных документа (PDF)';
    } else if (kind === 'document') {
      let text = req.file.buffer.toString('utf-8');
      text = text.replace(/^\uFEFF/, '').replace(/[\u200B-\u200D\uFEFF]/g, '');

      if (ext === 'html' || ext === 'htm' || ext === 'xml') {
        text = text.replace(/<!--[\s\S]*?-->/g, '');
        text = text.replace(/<meta\b(?![^>]*(charset|viewport))[^>]*>/gi, '');
        actionLabel = `Очистка мета-тегов и комментариев (${ext.toUpperCase()})`;
      } else if (ext === 'json') {
        try {
          const parsed = JSON.parse(text);
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            for (const key of ['_meta', 'metadata', 'author', 'creator', 'createdBy', 'generator']) {
              delete parsed[key];
            }
            text = JSON.stringify(parsed, null, 2);
          }
        } catch {}
        actionLabel = 'Очистка мета-полей документа (JSON)';
      } else {
        actionLabel = `Очистка служебных символов документа (${ext.toUpperCase()})`;
      }

      outBuffer = Buffer.from(text, 'utf-8');
      contentType = 'text/plain; charset=utf-8';
    } else {
      const ffmpegBin = await resolveFfmpegPath();
      if (ffmpegBin) {
        const tmpId = crypto.randomBytes(8).toString('hex');
        const safeExt = ext.replace(/[^a-z0-9]/gi, '') || 'mp4';
        const inPath = path.join(os.tmpdir(), `cc_meta_in_${tmpId}.${safeExt}`);
        const outPath = path.join(os.tmpdir(), `cc_meta_out_${tmpId}.${safeExt}`);
        try {
          fs.writeFileSync(inPath, req.file.buffer);
          await execFileAsync(ffmpegBin, [
            '-y', '-i', inPath,
            '-map_metadata', '-1',
            '-map_chapters', '-1',
            '-c', 'copy',
            outPath
          ], { timeout: 60000 });
          outBuffer = fs.readFileSync(outPath);
          actionLabel = `Очистка метаданных ${kind === 'video' ? 'видео' : 'аудио'} (${safeExt.toUpperCase()})`;
        } finally {
          if (fs.existsSync(inPath)) fs.unlinkSync(inPath);
          if (fs.existsSync(outPath)) fs.unlinkSync(outPath);
        }
      } else if (ext === 'mp3') {
        const { buffer } = stripMp3Id3Tags(req.file.buffer);
        outBuffer = Buffer.from(buffer);
        contentType = 'audio/mpeg';
        actionLabel = 'Очистка ID3v1/ID3v2 тегов (MP3)';
      } else if (ext === 'wav') {
        const { buffer } = stripWavMetadataChunks(req.file.buffer);
        outBuffer = buffer;
        contentType = 'audio/wav';
        actionLabel = 'Очистка RIFF-метаданных (WAV)';
      } else {
        return res.status(400).json({
          error: `Для очистки метаданных формата .${ext.toUpperCase()} установите встроенный FFmpeg командой "npm install" (MP3, WAV, изображения и документы работают сразу без FFmpeg).`
        });
      }
    }

    const cleanName = buildOutputFilename(req.file.originalname.replace(/\.[^.]+$/, '') + '-clean', outExt);
    const creditsDisplay = await consumeCreditsAndLog(req, res, req.file.originalname, actionLabel, cost, {
      buffer: outBuffer,
      ext: outExt,
      mimeType: contentType,
      outputName: cleanName
    });

    res.set('X-Credits-Remaining', creditsDisplay);
    res.set('X-Out-Ext', outExt);
    res.set('X-Out-Name', encodeURIComponent(cleanName));
    setSafeDownloadHeaders(res, cleanName, contentType);
    res.send(outBuffer);
  } catch (err) {
    console.error('[CosmoConvert Metadata]', err);
    res.status(500).json({ error: 'Ошибка очистки метаданных файла' });
  }
});

// Утилиты конвертации документов
function escapeHtml(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function stripHtmlTags(html) {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>|<\/div>|<\/h[1-6]>|<\/li>|<\/tr>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function parseCsvRows(text) {
  const lines = text.replace(/\r\n/g, '\n').split('\n').filter(l => l.trim().length > 0);
  const delimiter = lines[0] && lines[0].includes(';') && !lines[0].includes(',') ? ';' : ',';
  return lines.map(line => line.split(delimiter).map(cell => cell.trim().replace(/^"|"$/g, '')));
}

function markdownToSimpleHtml(md) {
  return md
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map(line => {
      if (line.startsWith('### ')) return `<h3>${escapeHtml(line.slice(4))}</h3>`;
      if (line.startsWith('## ')) return `<h2>${escapeHtml(line.slice(3))}</h2>`;
      if (line.startsWith('# ')) return `<h1>${escapeHtml(line.slice(2))}</h1>`;
      if (line.startsWith('- ') || line.startsWith('* ')) return `<li>${escapeHtml(line.slice(2))}</li>`;
      if (!line.trim()) return '<br>';
      const bolded = escapeHtml(line).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
      return `<p>${bolded}</p>`;
    })
    .join('\n');
}

// API: Предпросмотр текста бинарных документов (DOCX, DOC, RTF, ODT, PDF)
app.post('/api/document/preview', uploadImage.single('document'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Файл не выбран' });
    req.file.originalname = fixUploadedFilename(req.file.originalname);
    const text = extractDocumentText(req.file.buffer, req.file.originalname);
    const preview = text.slice(0, 12000) + (text.length > 12000 ? '\n\n... (показано начало документа)' : '');
    res.json({ text: preview || '(Документ пуст или не содержит текстового слоя)' });
  } catch (err) {
    res.json({ text: 'Предпросмотр недоступен, но документ готов к конвертации.' });
  }
});

// API: Конвертация документов (PDF, DOCX, DOC, RTF, ODT, TXT, MD, HTML, CSV, JSON, XML)
app.post('/api/convert-document', uploadImage.single('document'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Вы не выбрали файл для обработки' });
    req.file.originalname = fixUploadedFilename(req.file.originalname);

    if (!req.user && req.guestRemaining <= 0) {
      return res.status(403).json({
        error: 'Гостевой лимит (4 действия) исчерпан. Зарегистрируйтесь для получения 15 кредитов в день!',
        redirect: '/register?reason=limit'
      });
    }

    const cost = req.isAdmin ? 0 : 1;
    if (req.user && !req.isAdmin && req.user.credits < cost) {
      return res.status(403).json({ error: `Недостаточно кредитов (требуется ${cost} кр.)` });
    }

    const target = (req.body.targetFormat || 'pdf').toLowerCase();
    const srcExt = (req.file.originalname.split('.').pop() || 'txt').toLowerCase();

    let outBuffer = null;
    let contentType = 'text/plain; charset=utf-8';
    let nativeEngine = null;

    const mimeByTarget = {
      pdf: 'application/pdf',
      docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      doc: 'application/msword; charset=utf-8',
      html: 'text/html; charset=utf-8',
      txt: 'text/plain; charset=utf-8',
      json: 'application/json; charset=utf-8',
      csv: 'text/csv; charset=utf-8',
      md: 'text/markdown; charset=utf-8'
    };

    // Шаг 1: Пытаемся сконвертировать нативно через LibreOffice или Microsoft Word (100% сохранение верстки, таблиц и изображений)
    if (['pdf', 'docx', 'doc'].includes(target) && srcExt !== target) {
      const nativeRes = await convertDocumentNatively(req.file.buffer, srcExt, target);
      if (nativeRes && nativeRes.buffer && nativeRes.buffer.length > 0) {
        outBuffer = nativeRes.buffer;
        contentType = mimeByTarget[target] || 'application/octet-stream';
        nativeEngine = nativeRes.engine;
      }
    }

    // Шаг 2: Резервная встроенная конвертация (если LibreOffice / MS Word не установлены или выбран текстовый формат)
    const rawText = outBuffer ? '' : extractDocumentText(req.file.buffer, req.file.originalname);
    const plainText = outBuffer ? '' : ((srcExt === 'html' || srcExt === 'htm') ? stripHtmlTags(rawText) : rawText);
    let outText = rawText;

    if (outBuffer) {
      // Уже сконвертировано нативным движком
    } else if (target === 'pdf') {
      const docTitle = req.file.originalname.replace(/\.[^.]+$/, '');
      outBuffer = await buildPdfBuffer(plainText, docTitle, sharp);
      contentType = 'application/pdf';
    } else if (target === 'docx') {
      outBuffer = buildDocxBuffer(plainText, req.file.originalname);
      contentType = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    } else if (target === 'txt') {
      if (srcExt === 'json') {
        try { outText = JSON.stringify(JSON.parse(rawText), null, 2); } catch { outText = rawText; }
      } else {
        outText = plainText.replace(/^#+\s+/gm, '').replace(/\*\*(.+?)\*\*/g, '$1');
      }
      contentType = 'text/plain; charset=utf-8';
    } else if (target === 'html' || target === 'doc') {
      let bodyHtml = '';
      if (srcExt === 'csv') {
        const rows = parseCsvRows(rawText);
        const trs = rows.map((r, idx) => {
          const tag = idx === 0 ? 'th' : 'td';
          return '<tr>' + r.map(c => `<${tag} style="border:1px solid #ccc; padding:6px 10px;">${escapeHtml(c)}</${tag}>`).join('') + '</tr>';
        }).join('\n');
        bodyHtml = `<table style="border-collapse:collapse; width:100%;">${trs}</table>`;
      } else if (srcExt === 'json') {
        let pretty = rawText;
        try { pretty = JSON.stringify(JSON.parse(rawText), null, 2); } catch {}
        bodyHtml = `<pre style="background:#f4f6fc; padding:16px; border:1px solid #d5dbf0; font-family:monospace;">${escapeHtml(pretty)}</pre>`;
      } else if (srcExt === 'html' || srcExt === 'htm') {
        bodyHtml = rawText;
      } else {
        bodyHtml = markdownToSimpleHtml(plainText);
      }

      if (target === 'doc') {
        outText = `<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word" xmlns="http://www.w3.org/TR/REC-html40"><head><meta charset="utf-8"><title>${escapeHtml(req.file.originalname)}</title></head><body style="font-family:Calibri,Arial,sans-serif; line-height:1.6;">${bodyHtml}</body></html>`;
        contentType = 'application/msword; charset=utf-8';
      } else {
        outText = `<!DOCTYPE html><html lang="ru"><head><meta charset="UTF-8"><title>${escapeHtml(req.file.originalname)}</title><style>body{font-family:system-ui,sans-serif;max-width:860px;margin:36px auto;padding:0 20px;line-height:1.65;color:#11152c;}</style></head><body>${bodyHtml}</body></html>`;
        contentType = 'text/html; charset=utf-8';
      }
    } else if (target === 'json') {
      if (srcExt === 'csv') {
        const rows = parseCsvRows(rawText);
        if (rows.length >= 2) {
          const headers = rows[0];
          const objects = rows.slice(1).map(r => {
            const obj = {};
            headers.forEach((h, i) => { obj[h || `col_${i + 1}`] = r[i] ?? ''; });
            return obj;
          });
          outText = JSON.stringify(objects, null, 2);
        } else {
          outText = JSON.stringify(rows, null, 2);
        }
      } else {
        const lines = plainText.replace(/\r\n/g, '\n').split('\n');
        outText = JSON.stringify({ fileName: req.file.originalname, lineCount: lines.length, lines }, null, 2);
      }
      contentType = 'application/json; charset=utf-8';
    } else if (target === 'csv') {
      let csvOut = '';
      if (srcExt === 'json') {
        try {
          const parsed = JSON.parse(rawText);
          const arr = Array.isArray(parsed) ? parsed : [parsed];
          if (arr.length > 0 && typeof arr[0] === 'object' && arr[0] !== null) {
            const keys = Object.keys(arr[0]);
            csvOut = keys.join(';') + '\n' + arr.map(item => keys.map(k => `"${String(item[k] ?? '').replace(/"/g, '""')}"`).join(';')).join('\n');
          } else {
            csvOut = 'value\n' + arr.map(v => `"${String(v).replace(/"/g, '""')}"`).join('\n');
          }
        } catch {
          csvOut = 'line;content\n' + plainText.split(/\r?\n/).map((l, i) => `${i + 1};"${l.replace(/"/g, '""')}"`).join('\n');
        }
      } else {
        csvOut = 'line;content\n' + plainText.split(/\r?\n/).map((l, i) => `${i + 1};"${l.replace(/"/g, '""')}"`).join('\n');
      }
      outText = '\uFEFF' + csvOut;
      contentType = 'text/csv; charset=utf-8';
    } else if (target === 'md') {
      if (srcExt === 'csv') {
        const rows = parseCsvRows(rawText);
        if (rows.length > 0) {
          const header = '| ' + rows[0].join(' | ') + ' |';
          const sep = '| ' + rows[0].map(() => '---').join(' | ') + ' |';
          const body = rows.slice(1).map(r => '| ' + r.join(' | ') + ' |').join('\n');
          outText = `${header}\n${sep}\n${body}`;
        }
      } else if (srcExt === 'json') {
        outText = '```json\n' + rawText + '\n```';
      } else {
        outText = plainText;
      }
      contentType = 'text/markdown; charset=utf-8';
    }

    if (!outBuffer) {
      outBuffer = Buffer.from(outText, 'utf-8');
    }

    const outName = buildOutputFilename(req.file.originalname, target);
    const label = `Документ (${srcExt.toUpperCase()} → ${target.toUpperCase()}${nativeEngine ? ', ' + nativeEngine : ''})`;
    const creditsDisplay = await consumeCreditsAndLog(req, res, req.file.originalname, label, cost, {
      buffer: outBuffer,
      ext: target,
      mimeType: contentType,
      outputName: outName
    });

    res.set('X-Credits-Remaining', creditsDisplay);
    res.set('X-Out-Ext', target);
    setSafeDownloadHeaders(res, outName, contentType);
    res.send(outBuffer);
  } catch (err) {
    console.error('[CosmoConvert Doc]', err);
    res.status(500).json({ error: 'Ошибка конвертации документа' });
  }
});

// API: Конвертация аудио/видео через FFmpeg (с мягким переключением на Web Audio, если FFmpeg не установлен)
app.post('/api/media/ffmpeg-convert', (req, res, next) => {
  uploadMedia.single('media')(req, res, (err) => {
    if (err && err.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({ error: `Размер файла превышает лимит (${MAX_MEDIA_MB} МБ)` });
    }
    if (err) return res.status(400).json({ error: 'Ошибка загрузки медиафайла' });
    next();
  });
}, async (req, res) => {
  const rawCost = Math.max(1, Math.min(5, Number(req.body.cost) || 1));
  const cost = req.isAdmin ? 0 : rawCost;

  if (!req.file) return res.status(400).json({ error: 'Вы не выбрали файл для обработки' });
    req.file.originalname = fixUploadedFilename(req.file.originalname);

  if (!req.user && req.guestRemaining <= 0) {
    return res.status(403).json({
      error: 'Гостевой лимит (4 действия) исчерпан. Зарегистрируйтесь для получения 15 кредитов в день!',
      redirect: '/register?reason=limit'
    });
  }

  if (req.user && !req.isAdmin && req.user.credits < cost) {
    return res.status(403).json({ error: `Недостаточно кредитов (требуется ${cost} кр., доступно ${req.user.credits} кр.)` });
  }

  const targetFormat = ['mp3', 'wav', 'ogg'].includes(req.body.targetFormat) ? req.body.targetFormat : 'mp3';
  const bitrate = ['128k', '192k', '320k'].includes(req.body.bitrate) ? req.body.bitrate : '320k';
  const bitrateKbps = parseInt(bitrate, 10) || 128;
  const actionTitle = req.body.actionTitle || `Медиа → ${targetFormat.toUpperCase()} (${bitrate})`;

  const ffmpegBin = await resolveFfmpegPath();
  if (!ffmpegBin) {
    return res.json({
      useClientFallback: true,
      requestedFormat: targetFormat,
      bitrateKbps
    });
  }

  const tmpId = crypto.randomBytes(8).toString('hex');
  const inExt = (req.file.originalname.split('.').pop() || 'bin').replace(/[^a-z0-9]/gi, '');
  const inPath = path.join(os.tmpdir(), `cc_in_${tmpId}.${inExt}`);
  const outPath = path.join(os.tmpdir(), `cc_out_${tmpId}.${targetFormat}`);

  try {
    fs.writeFileSync(inPath, req.file.buffer);
    const args = ['-y', '-i', inPath, '-vn'];

    if (req.body.startSec) args.push('-ss', String(Number(req.body.startSec) || 0));
    if (req.body.endSec) args.push('-to', String(Number(req.body.endSec)));

    const filters = [];
    const pitch = Number(req.body.pitchSemitones) || 0;
    const speed = Number(req.body.speed) || 1;
    const vol = Number(req.body.volume) || 100;
    const rate = Math.max(0.25, Math.min(4.0, speed * Math.pow(2, pitch / 12)));
    if (Math.abs(rate - 1) > 0.01) {
      filters.push(`aresample=44100,asetrate=44100*${rate.toFixed(4)},aresample=44100`);
    }
    if (vol !== 100) {
      filters.push(`volume=${(vol / 100).toFixed(2)}`);
    }
    if (filters.length > 0) args.push('-af', filters.join(','));

    if (targetFormat === 'mp3') {
      args.push('-c:a', 'libmp3lame', '-b:a', bitrate, '-ar', '44100');
    } else if (targetFormat === 'ogg') {
      args.push('-c:a', 'libvorbis', '-b:a', bitrate, '-ar', '44100');
    } else if (targetFormat === 'wav') {
      args.push('-c:a', 'pcm_s16le');
    }
    args.push(outPath);

    await execFileAsync(ffmpegBin, args, { timeout: 90000 });
    const outBuffer = fs.readFileSync(outPath);
    const outName = buildOutputFilename(req.file.originalname, targetFormat);
    const mimeMap = { mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg' };
    const outMime = mimeMap[targetFormat] || 'application/octet-stream';

    const creditsDisplay = await consumeCreditsAndLog(req, res, req.file.originalname, actionTitle, cost, {
      buffer: outBuffer,
      ext: targetFormat,
      mimeType: outMime,
      outputName: outName
    });

    res.set('X-Credits-Remaining', creditsDisplay);
    res.set('X-Out-Ext', targetFormat);
    setSafeDownloadHeaders(res, outName, outMime);
    res.send(outBuffer);
  } catch (err) {
    console.error('[CosmoConvert FFmpeg]', err.message);
    res.json({ useClientFallback: true, requestedFormat: targetFormat, bitrateKbps });
  } finally {
    if (fs.existsSync(inPath)) fs.unlinkSync(inPath);
    if (fs.existsSync(outPath)) fs.unlinkSync(outPath);
  }
});

// API: Учет кредитов + сохранение готового файла в БД SQLite для браузерной Web Audio обработки
app.post('/api/media/log-client-action', (req, res, next) => {
  const ct = req.headers['content-type'] || '';
  if (ct.includes('multipart/form-data')) {
    uploadMedia.single('resultFile')(req, res, (err) => {
      if (err) return res.status(400).json({ error: 'Ошибка сохранения файла в историю' });
      next();
    });
  } else {
    next();
  }
}, async (req, res) => {
  try {
    const fileName = String(req.body.fileName || 'audio-file');
    const actionLabel = String(req.body.actionLabel || 'Обработка медиа');
    const rawCost = Math.max(1, Math.min(5, Number(req.body.cost) || 1));
    const cost = req.isAdmin ? 0 : rawCost;

    if (!req.user && req.guestRemaining <= 0) {
      return res.status(403).json({
        error: 'Гостевой лимит (4 действия) исчерпан. Зарегистрируйтесь для получения 15 кредитов в день!',
        redirect: '/register?reason=limit'
      });
    }

    if (req.user && !req.isAdmin && req.user.credits < cost) {
      return res.status(403).json({ error: `Недостаточно кредитов (требуется ${cost} кр., доступно ${req.user.credits} кр.)` });
    }

    let filePayload = null;
    if (req.file && req.file.buffer) {
      req.file.originalname = fixUploadedFilename(req.file.originalname);
      const outExt = String(req.body.outExt || req.file.originalname.split('.').pop() || 'wav').toLowerCase();
      const outputName = String(req.body.outputName || buildOutputFilename(fileName, outExt));
      const mimeMap = { mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg' };
      filePayload = {
        buffer: req.file.buffer,
        ext: outExt,
        mimeType: mimeMap[outExt] || req.file.mimetype || 'application/octet-stream',
        outputName
      };
    }

    const creditsDisplay = await consumeCreditsAndLog(req, res, fileName, actionLabel, cost, filePayload);
    res.json({ ok: true, creditsDisplay });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Ошибка записи операции в БД' });
  }
});

app.listen(3000, async () => {
  console.log('[CosmoConvert Web] Основной сайт запущен:       http://localhost:3000');
  const ffPath = await resolveFfmpegPath();
  if (ffPath) {
    console.log(`[CosmoConvert FFmpeg] Аудио/видео кодек активен: ${ffPath}`);
  } else {
    console.log('[CosmoConvert FFmpeg] Системный FFmpeg не найден — будет использован браузерный MP3/WAV движок (для OGG и видео-метаданных выполните: npm install)');
  }
  await startLocalDbServer(prisma, 4000);
});
