-- CosmoConvert — Дамп локальной базы данных SQLite
-- Сгенерировано: 19.11.2026, 03:44:34
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS "User" (
  "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
  "email" TEXT NOT NULL UNIQUE,
  "passwordHash" TEXT NOT NULL,
  "credits" INTEGER NOT NULL DEFAULT 15,
  "lastReset" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS "ActionLog" (
  "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
  "userId" INTEGER NOT NULL,
  "fileName" TEXT NOT NULL,
  "targetFormat" TEXT NOT NULL,
  "cost" INTEGER NOT NULL DEFAULT 1,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ActionLog_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- Данные таблицы User
INSERT INTO "User" ("id", "email", "passwordHash", "credits", "lastReset") VALUES (1, 'sotombett@gmail.com', '1dd16740731c9bbef384df792128c2b4483a9817697d0665f7e02379de8adfd6', 12, '2026-11-18T20:14:14.704Z');

-- Данные таблицы ActionLog
INSERT INTO "ActionLog" ("id", "userId", "fileName", "targetFormat", "cost", "createdAt") VALUES (1, 1, 'fisheye (5).png', 'Апскейл 4x (Lanczos3)', 3, '2026-11-18T19:30:42.812Z');
INSERT INTO "ActionLog" ("id", "userId", "fileName", "targetFormat", "cost", "createdAt") VALUES (2, 1, 'pixflow-result(1).png', 'Полная очистка EXIF и GPS', 1, '2026-11-18T19:33:10.797Z');
INSERT INTO "ActionLog" ("id", "userId", "fileName", "targetFormat", "cost", "createdAt") VALUES (3, 1, 'pixflow-result(1).jpeg', 'Апскейл 4x → 5508×9792 (Lanczos3 HQ)', 3, '2026-11-18T21:49:35.646Z');
