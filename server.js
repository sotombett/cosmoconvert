import express from 'express';
import multer from 'multer';
import sharp from 'sharp';
import crypto from 'node:crypto';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';
import { startLocalDbServer, createDbRouter, syncDatabaseSnapshots } from './db-server.js';

const app = express();
const prisma = new PrismaClient();

// Лимит загрузки 40 МБ
const MAX_FILE_SIZE_MB = 40;
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_SIZE_MB * 1024 * 1024 }
});

const DAILY_LIMIT = 15;
const GUEST_LIMIT = 4;
const SECRET_KEY = 'practice-project-secret-key';

app.set('view engine', 'ejs');
app.set('views', path.join(process.cwd(), 'src/views'));

app.use(express.static('public'));
app.use(express.json({ limit: '40mb' }));
app.use(express.urlencoded({ extended: true, limit: '40mb' }));

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

async function syncUserAccount(userId) {
  let user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) return null;

  const now = new Date();
  if (now.toDateString() !== new Date(user.lastReset).toDateString()) {
    user = await prisma.user.update({
      where: { id: userId },
      data: { credits: DAILY_LIMIT, lastReset: now }
    });
    await syncDatabaseSnapshots(prisma);
  }

  const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  await prisma.actionLog.deleteMany({
    where: { userId, createdAt: { lt: thirtyDaysAgo } }
  });

  return user;
}

app.use(async (req, res, next) => {
  const cookies = parseCookies(req.headers.cookie);
  const userId = verifySignedValue(cookies.token);
  req.user = userId ? await syncUserAccount(userId) : null;

  let guestUsed = verifySignedValue(cookies.guest_used);
  if (guestUsed === null || guestUsed < 0) guestUsed = 0;
  req.guestUsed = guestUsed;
  req.guestRemaining = Math.max(0, GUEST_LIMIT - guestUsed);

  res.locals.user = req.user;
  res.locals.dailyLimit = DAILY_LIMIT;
  res.locals.guestLimit = GUEST_LIMIT;
  res.locals.guestRemaining = req.guestRemaining;
  next();
});

const toolsConfig = {
  convert: {
    key: 'convert',
    title: 'Конвертация форматов',
    desc: 'Перевод изображений между форматами <b>WebP</b>, <b>PNG</b>, <b>JPEG</b> и <b>AVIF</b> с выбором качества сжатия.',
    cost: 1
  },
  resize: {
    key: 'resize',
    title: 'Ресайз и геометрия кадра',
    desc: 'Интерактивное кадрирование рамкой, расширенный набор пресетов пропорций и одновременное отражение по двум осям.',
    cost: 1
  },
  upscale: {
    key: 'upscale',
    title: 'Алгоритмический апскейл',
    desc: 'Многоступенчатое увеличение разрешения в <b>2x</b> и <b>4x</b> раза с реконструкцией микроконтраста и контурной резкости.',
    cost: 3
  },
  exif: {
    key: 'exif',
    title: 'Очистка метаданных EXIF',
    desc: 'Полное удаление скрытых тегов камеры, серийных номеров, даты съемки и <b>GPS-координат</b> из файла.',
    cost: 1
  }
};

const infoPages = {
  about: {
    title: 'О сайте CosmoConvert',
    subtitle: 'Онлайн-платформа для быстрой серверной обработки и оптимизации графики',
    sections: [
      {
        heading: 'Назначение программного продукта',
        text: 'CosmoConvert разработан в рамках учебной практики по модулю «Проектирование и разработка информационных систем». Сервис объединяет инструменты конвертации современных форматов, интерактивного изменения геометрии кадра, алгоритмического апскейла и защиты приватности метаданных.'
      },
      {
        heading: 'Технологический стек',
        text: 'Серверная часть построена на платформе Node.js и фреймворке Express с использованием высокопроизводительного графического ядра Sharp (libvips). Хранение учетных записей, баланса кредитов и 30-дневной истории операций реализовано в реляционной базе данных под управлением Prisma ORM.'
      }
    ]
  },
  privacy: {
    title: 'Политика безопасности и конфиденциальности',
    subtitle: 'Как обрабатываются ваши загружаемые изображения и персональные данные',
    sections: [
      {
        heading: 'Потоковая обработка в оперативной памяти',
        text: 'Все загружаемые изображения (до 40 МБ) обрабатываются исключительно в оперативной памяти сервера через буферы обмена и удаляются сразу после отправки готового файла пользователю. Мы не сохраняем исходные или сконвертированные фотографии на жестком диске сервера.'
      },
      {
        heading: 'Хранение истории и защита паролей',
        text: 'В базе данных сохраняются только технические мета-записи об операциях (название исходного файла, тип примененного алгоритма, количество списанных кредитов и время), которые автоматически очищаются спустя 30 дней. Пароли пользователей хэшируются алгоритмом HMAC-SHA256.'
      }
    ]
  },
  terms: {
    title: 'Условия использования сервиса',
    subtitle: 'Правила работы с системой ежедневных кредитов и гостевым доступом',
    sections: [
      {
        heading: 'Гостевой режим и аккаунты',
        text: 'Неавторизованным посетителям предоставляется 4 ознакомительных действия для проверки базовой конвертации и ресайза. После регистрации пользователю начисляется 15 кредитов, которые автоматически восстанавливаются каждые сутки.'
      },
      {
        heading: 'Тарификация операций в кредитах',
        text: 'Базовая конвертация, изменение размеров и отдельная очистка метаданных стоят 1 кредит. Алгоритмический апскейл (2x/4x) стоит 3 кредита. При включении дополнительной опции «Стереть метаданные EXIF» внутри других вкладок к стоимости операции прибавляется 1 кредит.'
      }
    ]
  },
  faq: {
    title: 'Часто задаваемые вопросы (FAQ)',
    subtitle: 'Ответы на популярные вопросы по работе с инструментами CosmoConvert',
    sections: [
      {
        heading: 'Какой максимальный размер файла можно загрузить?',
        text: 'Сервис поддерживает загрузку изображений в форматах PNG, JPEG, WebP и AVIF размером до 40 МБ и разрешением вывода до 16000×16000 пикселей.'
      },
      {
        heading: 'Как работает многоступенчатый алгоритмический апскейл?',
        text: 'При увеличении в 2x и 4x сервис выполняет пошаговую пирамидальную интерполяцию (Lanczos3 или Mitchell-Netravali) с промежуточным подавлением артефактов сжатия, усилением локального микроконтраста и адаптивным фильтром контурной резкости (Unsharp Masking).'
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
        text: 'По вопросам работы веб-приложения, базы данных и алгоритмов обработки изображений обращайтесь через форму обратной связи учебного портала или по электронной почте: support@cosmoconvert.local.'
      }
    ]
  }
};

// Встроенный маршрут локального сервера БД
app.use('/db-admin', createDbRouter(prisma, '/db-admin'));

// Главная страница по умолчанию
app.get(['/', '/home'], (req, res) => {
  res.render('home', { activePage: 'home' });
});

// Информационные страницы футера
app.get(['/about', '/privacy', '/terms', '/faq', '/contacts'], (req, res) => {
  const pageKey = req.path.slice(1);
  res.render('info', { info: infoPages[pageKey], activePage: pageKey });
});

// Страницы инструментов (рендерят шаблон editor.ejs)
app.get(['/convert', '/resize', '/upscale', '/exif'], (req, res) => {
  const toolKey = req.path.slice(1);
  res.render('editor', { tool: toolsConfig[toolKey], activePage: toolKey });
});

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
  const logs = await prisma.actionLog.findMany({
    where: { userId: req.user.id },
    orderBy: { createdAt: 'desc' }
  });
  res.render('profile', { logs, activePage: 'profile' });
});

app.post('/login', async (req, res) => {
  const email = (req.body.email || '').trim().toLowerCase();
  const password = req.body.password || '';
  const user = await prisma.user.findUnique({ where: { email } });

  if (!user || user.passwordHash !== hashPassword(password)) {
    return res.render('login', { error: 'Неверная почта или пароль', activePage: 'login' });
  }

  res.cookie('token', createSignedValue(user.id), { httpOnly: true, path: '/' });
  res.redirect('/convert');
});

app.post('/register', async (req, res) => {
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

  const exists = await prisma.user.findUnique({ where: { email } });
  if (exists) {
    return res.render('register', { error: 'Эта электронная почта уже зарегистрирована', notice: null, activePage: 'register' });
  }

  const user = await prisma.user.create({
    data: {
      email,
      passwordHash: hashPassword(password),
      credits: DAILY_LIMIT
    }
  });

  await syncDatabaseSnapshots(prisma);
  res.cookie('token', createSignedValue(user.id), { httpOnly: true, path: '/' });
  res.redirect('/convert');
});

app.post('/logout', (req, res) => {
  res.clearCookie('token', { path: '/' });
  res.redirect('/home');
});

// Изменение гостевого лимита (сброс 4/4 или обнуление 0/4 для тестирования)
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

// Многоступенчатый алгоритмический апскейл с промежуточной реконструкцией контуров
async function runAlgorithmicUpscale(inputBuffer, meta, mult, upscaleMode, sharpness, keepMetadata) {
  const MAX_DIM = 16000;
  const baseW = meta.width || 1000;
  const baseH = meta.height || 1000;

  if (upscaleMode === 'nearest') {
    const scale = Math.min(mult, MAX_DIM / Math.max(baseW, baseH));
    const targetW = Math.max(16, Math.round(baseW * scale));
    const targetH = Math.max(16, Math.round(baseH * scale));
    let pipe = sharp(inputBuffer).resize(targetW, targetH, {
      kernel: sharp.kernel.nearest,
      fit: 'fill'
    });
    if (sharpness === 'high') {
      pipe = pipe.linear(1.06, -6);
    }
    if (keepMetadata) pipe = pipe.withMetadata();
    return { pipe, targetW, targetH };
  }

  // Ядро интерполяции: Lanczos3 для фото/деталей или Mitchell для 2D-арта/иллюстраций
  const kernel = upscaleMode === 'mitchell' ? sharp.kernel.mitchell : sharp.kernel.lanczos3;
  const isHigh = sharpness === 'high';

  // Шаг 1: увеличение в 2 раза + первичное восстановление границ
  const scaleStep1 = Math.min(2, MAX_DIM / Math.max(baseW, baseH));
  const step1W = Math.max(16, Math.round(baseW * scaleStep1));
  const step1H = Math.max(16, Math.round(baseH * scaleStep1));

  let step1Pipe = sharp(inputBuffer);
  if (upscaleMode === 'mitchell' || isHigh) {
    // Сглаживаем мелкий цветовой шум перед подъемом резкости контуров
    step1Pipe = step1Pipe.median(3);
  }

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
    if (isHigh) {
      step1Pipe = step1Pipe.linear(1.05, -6).modulate({ saturation: 1.05 });
    }
    if (keepMetadata) step1Pipe = step1Pipe.withMetadata();
    return { pipe: step1Pipe, targetW: step1W, targetH: step1H };
  }

  // Шаг 2 (для 4x): материализуем буфер 2x и выполняем второй проход до 4x
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

  if (isHigh) {
    step2Pipe = step2Pipe.linear(1.06, -7).modulate({ saturation: 1.06 });
  }
  if (keepMetadata) step2Pipe = step2Pipe.withMetadata();

  return { pipe: step2Pipe, targetW: step2W, targetH: step2H };
}

// Обработка изображений
app.post('/api/process', (req, res, next) => {
  upload.single('image')(req, res, (err) => {
    if (err && err.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({ error: `Размер файла превышает допустимый лимит (${MAX_FILE_SIZE_MB} МБ)` });
    }
    if (err) {
      return res.status(400).json({ error: 'Ошибка загрузки файла' });
    }
    next();
  });
}, async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'Файл не выбран' });
    }

    const {
      category = 'convert',
      format = 'webp',
      quality = '90',
      symmetry = 'none',
      flipH = 'false',
      flipV = 'false',
      upscaleMode = 'lanczos',
      scaleFactor = '2',
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

    // Проверка прав для гостей
    if (!req.user) {
      if (category === 'upscale' || category === 'exif') {
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

    const baseCost = category === 'upscale' ? 3 : 1;
    const canStrip = category !== 'exif' && Boolean(req.user) && stripExif === 'true';
    const extraExifCost = canStrip ? 1 : 0;
    const cost = baseCost + extraExifCost;

    if (req.user && req.user.credits < cost) {
      return res.status(403).json({ error: `Недостаточно кредитов (требуется ${cost} кр., доступно ${req.user.credits} кр.)` });
    }

    let pipeline = sharp(req.file.buffer);
    const meta = await pipeline.metadata();
    const origFormat = ['jpeg', 'png', 'webp', 'avif'].includes(meta.format) ? meta.format : 'png';
    let outFormat = origFormat;
    let outQuality = 92;
    let actionLabel = '';

    // 1. Логика вкладки КОНВЕРТАЦИЯ
    if (category === 'convert') {
      outFormat = format;
      outQuality = Math.max(40, Math.min(100, Number(quality) || 90));
      actionLabel = `Конвертация → ${outFormat.toUpperCase()} (${outQuality}%)`;
      if (!canStrip) pipeline = pipeline.withMetadata();
    }
    // 2. Логика вкладки РЕСАЙЗ (интерактивная рамка + одновременное отражение по двум осям)
    else if (category === 'resize') {
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

      const doFlipH = flipH === 'true' || symmetry === 'horizontal' || symmetry === 'both';
      const doFlipV = flipV === 'true' || symmetry === 'vertical' || symmetry === 'both';
      if (doFlipH) pipeline = pipeline.flop();
      if (doFlipV) pipeline = pipeline.flip();

      const w = Math.max(16, Math.min(12000, Number(width) || meta.width));
      const h = Math.max(16, Math.min(12000, Number(height) || meta.height));
      pipeline = pipeline.resize(w, h, { fit: 'fill' });

      let symNote = '';
      if (doFlipH && doFlipV) symNote = ', отр. Г+В';
      else if (doFlipH) symNote = ', отр. Г';
      else if (doFlipV) symNote = ', отр. В';

      actionLabel = `Ресайз ${w}×${h}${symNote} (${origFormat.toUpperCase()})`;
      if (!canStrip) pipeline = pipeline.withMetadata();
    }
    // 3. Логика вкладки АПСКЕЙЛ (многоступенчатый пайплайн)
    else if (category === 'upscale') {
      const mult = Number(scaleFactor) === 4 ? 4 : 2;
      const keepMeta = !canStrip;
      const { pipe, targetW, targetH } = await runAlgorithmicUpscale(
        req.file.buffer,
        meta,
        mult,
        upscaleMode,
        sharpness,
        keepMeta
      );
      pipeline = pipe;
      outQuality = 95;

      const modeNames = {
        lanczos: 'Lanczos3 HQ',
        mitchell: 'Mitchell Art',
        nearest: 'Pixel Art'
      };
      actionLabel = `Апскейл ${mult}x → ${targetW}×${targetH} (${modeNames[upscaleMode] || 'Lanczos3'})`;
    }
    // 4. Логика вкладки МЕТАДАННЫЕ
    else if (category === 'exif') {
      if (exifMode === 'keep_icm') {
        pipeline = pipeline.keepIccProfile();
        actionLabel = `Удаление EXIF (сохранен профиль цвета)`;
      } else {
        actionLabel = `Полная очистка EXIF и GPS`;
      }
    }

    if (category !== 'exif' && canStrip) {
      actionLabel += ' + Удаление EXIF';
    }

    const outputBuffer = await pipeline.toFormat(outFormat, { quality: outQuality }).toBuffer();

    if (req.user) {
      const [updatedUser] = await prisma.$transaction([
        prisma.user.update({
          where: { id: req.user.id },
          data: { credits: { decrement: cost } }
        }),
        prisma.actionLog.create({
          data: {
            userId: req.user.id,
            fileName: req.file.originalname,
            targetFormat: actionLabel,
            cost
          }
        })
      ]);
      await syncDatabaseSnapshots(prisma);
      res.set('X-Credits-Remaining', `${updatedUser.credits}/${DAILY_LIMIT}`);
    } else {
      const newUsed = req.guestUsed + 1;
      const rem = Math.max(0, GUEST_LIMIT - newUsed);
      res.cookie('guest_used', createSignedValue(newUsed), { httpOnly: true, path: '/' });
      res.set('X-Credits-Remaining', `${rem}/${GUEST_LIMIT}`);
    }

    res.set('X-Out-Ext', outFormat);
    res.set('Content-Type', `image/${outFormat}`);
    res.set('Content-Disposition', `attachment; filename="cosmoconvert-result.${outFormat}"`);
    res.send(outputBuffer);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Ошибка обработки файла' });
  }
});

app.listen(3000, async () => {
  console.log('[CosmoConvert Web] Основной сайт запущен:       http://localhost:3000');
  await startLocalDbServer(prisma, 4000);
});
