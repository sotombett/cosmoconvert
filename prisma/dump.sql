-- CosmoConvert — Дамп локальной базы данных SQLite
-- Сгенерировано: 20.11.2026, 12:11:23
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS "User" (
  "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
  "email" TEXT NOT NULL UNIQUE,
  "passwordHash" TEXT NOT NULL,
  "role" TEXT NOT NULL DEFAULT 'USER',
  "credits" INTEGER NOT NULL DEFAULT 15,
  "lastReset" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

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

-- Данные таблицы User
INSERT INTO "User" ("id", "email", "passwordHash", "role", "credits", "lastReset") VALUES (1, 'sotombett@gmail.com', '1dd16740731c9bbef384df792128c2b4483a9817697d0665f7e02379de8adfd6', 'USER', 9, '2026-11-18T20:14:14.704Z');
INSERT INTO "User" ("id", "email", "passwordHash", "role", "credits", "lastReset") VALUES (2, 'admin@cosmoconvert.local', '783b610b74350ce1b7754d1a65f4e69cf27e0238aea6e9de32cb7983fa9a91d8', 'ADMIN', 999999, '2026-11-19T00:33:37.103Z');

-- Данные таблицы ActionLog (бинарные файлы хранятся в prisma/dev.db)
INSERT INTO "ActionLog" ("id", "userId", "fileName", "targetFormat", "cost", "storedFile", "outputName", "mimeType", "fileSize", "createdAt") VALUES (1, 1, 'fisheye (5).png', 'Апскейл 4x (Lanczos3)', 3, NULL, NULL, NULL, NULL, '2026-11-18T19:30:42.812Z');
INSERT INTO "ActionLog" ("id", "userId", "fileName", "targetFormat", "cost", "storedFile", "outputName", "mimeType", "fileSize", "createdAt") VALUES (2, 1, 'pixflow-result(1).png', 'Полная очистка EXIF и GPS', 1, NULL, NULL, NULL, NULL, '2026-11-18T19:33:10.797Z');
INSERT INTO "ActionLog" ("id", "userId", "fileName", "targetFormat", "cost", "storedFile", "outputName", "mimeType", "fileSize", "createdAt") VALUES (3, 1, 'pixflow-result(1).jpeg', 'Апскейл 4x → 5508×9792 (Lanczos3 HQ)', 3, NULL, NULL, NULL, NULL, '2026-11-18T21:49:35.646Z');
INSERT INTO "ActionLog" ("id", "userId", "fileName", "targetFormat", "cost", "storedFile", "outputName", "mimeType", "fileSize", "createdAt") VALUES (4, 1, 'spaceeeeewebp.png', 'Обработка + Апскейл 4x → 3200×1796 (Mitchell)', 3, NULL, NULL, NULL, NULL, '2026-11-19T00:03:01.575Z');
INSERT INTO "ActionLog" ("id", "userId", "fileName", "targetFormat", "cost", "storedFile", "outputName", "mimeType", "fileSize", "createdAt") VALUES (6, 2, 'cat-cat-dance.gif', 'Конвертация → PNG (90%)', 0, NULL, 'cat-cat-dance.png', 'image/png', 13896, '2026-11-19T07:26:34.339Z');
INSERT INTO "ActionLog" ("id", "userId", "fileName", "targetFormat", "cost", "storedFile", "outputName", "mimeType", "fileSize", "createdAt") VALUES (7, 2, 'rat-kicking-feet.gif', 'Кадр GIF #21 → PNG', 0, NULL, 'rat-kicking-feet-frame-21.png', 'image/png', 77309, '2026-11-19T07:31:31.136Z');
