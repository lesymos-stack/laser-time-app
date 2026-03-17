# BACKEND-PLAN.md — Архитектура мультитенантной системы

## Итоговые решения

| Вопрос | Решение |
|--------|---------|
| База данных | Supabase (PostgreSQL) |
| Хранилище фото | Supabase Storage |
| Архитектура ботов | Свой бот у каждого мастера |
| Панель мастера | Прямо в Mini App (вкладка «Мастер») |
| Онбординг мастера | Инструкция: создай бота → вставь токен → система настраивает всё |
| Оплата | Нет (v1 — только запись) |
| Бот для клиентов | Запись + напоминания + FAQ-ответы на основе данных мастера |

---

## 1. Схема работы системы

```
┌─────────────────────────────────────────────────────────────────────┐
│                         SUPABASE                                   │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────────────┐   │
│  │ masters  │  │ services │  │ bookings │  │ Supabase Storage │   │
│  │ (tenant) │←─│          │←─│          │  │  (фото услуг)    │   │
│  └────┬─────┘  └──────────┘  └──────────┘  └──────────────────┘   │
│       │                                                            │
│  ┌────┴─────┐  ┌──────────┐  ┌──────────┐                         │
│  │ schedule │  │   faq    │  │ clients  │                         │
│  └──────────┘  └──────────┘  └──────────┘                         │
└──────────────────────────┬──────────────────────────────────────────┘
                           │ REST API
            ┌──────────────┼──────────────┐
            ▼              ▼              ▼
   ┌────────────┐  ┌──────────────┐  ┌──────────────┐
   │ Mini App   │  │  Bot Server  │  │  Cron Worker │
   │ (frontend) │  │  (webhook)   │  │ (напоминания)│
   │  Vercel    │  │  Railway /   │  │  Railway /   │
   │            │  │  Render      │  │  Supabase    │
   └────────────┘  └──────────────┘  └──────────────┘
         ▲                ▲
         │                │
   ┌─────┴─────┐  ┌──────┴──────┐
   │  Клиент   │  │   Мастер    │
   │ (Mini App)│  │ (Mini App + │
   │           │  │  бот-нотиф) │
   └───────────┘  └─────────────┘
```

### Как это работает

1. **Мастер** создаёт бота через @BotFather, вставляет токен в систему
2. **Bot Server** принимает webhook от всех ботов мастеров, роутит по `bot_token`
3. **Mini App** открывается из бота мастера, получает `tenant_id` через deep link
4. **Клиент** видит только услуги, расписание и бренд конкретного мастера
5. **Cron Worker** каждый час проверяет записи и шлёт напоминания за 24ч

---

## 2. База данных (Supabase PostgreSQL)

### Таблица `masters` (мастер = тенант)

```sql
CREATE TABLE masters (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tg_user_id    BIGINT UNIQUE NOT NULL,       -- Telegram ID мастера
  bot_token     TEXT UNIQUE NOT NULL,          -- токен бота мастера
  bot_username  TEXT,                          -- @username бота (заполняется автоматически)
  name          TEXT NOT NULL,                 -- название (бренд / имя мастера)
  description   TEXT DEFAULT '',               -- описание (подзаголовок)
  phone         TEXT DEFAULT '',               -- телефон
  whatsapp_url  TEXT DEFAULT '',               -- ссылка на WhatsApp
  avatar_url    TEXT,                          -- URL аватара (Supabase Storage)
  welcome_text  TEXT DEFAULT '',               -- приветственный текст для клиентов
  master_code   TEXT DEFAULT '0000',           -- код доступа к панели мастера
  is_active     BOOLEAN DEFAULT true,
  created_at    TIMESTAMPTZ DEFAULT now()
);
```

### Таблица `categories`

```sql
CREATE TABLE categories (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  master_id   UUID NOT NULL REFERENCES masters(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,                   -- "Лазерная эпиляция"
  icon        TEXT DEFAULT '✨',               -- эмодзи
  sort_order  INT DEFAULT 0,
  is_active   BOOLEAN DEFAULT true,
  created_at  TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX idx_categories_master ON categories(master_id);
```

### Таблица `services`

```sql
CREATE TABLE services (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  master_id     UUID NOT NULL REFERENCES masters(id) ON DELETE CASCADE,
  category_id   UUID REFERENCES categories(id) ON DELETE SET NULL,
  name          TEXT NOT NULL,                 -- "Бикини глубокое"
  description   TEXT DEFAULT '',
  duration      INT NOT NULL,                  -- минуты
  price         INT NOT NULL,                  -- рубли (целое число)
  sale_price    INT,                           -- акционная цена (null = нет акции)
  photos        TEXT[] DEFAULT '{}',           -- массив URL фото из Supabase Storage
  is_active     BOOLEAN DEFAULT true,
  sort_order    INT DEFAULT 0,
  created_at    TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX idx_services_master ON services(master_id);
CREATE INDEX idx_services_category ON services(category_id);
```

### Таблица `schedule`

```sql
CREATE TABLE schedule (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  master_id   UUID NOT NULL REFERENCES masters(id) ON DELETE CASCADE,
  day_of_week INT NOT NULL CHECK (day_of_week BETWEEN 0 AND 6),
                                               -- 0=Вс, 1=Пн, ..., 6=Сб
  start_time  TIME NOT NULL,                   -- "10:00"
  end_time    TIME NOT NULL,                   -- "20:00"
  slot_interval INT DEFAULT 30,                -- шаг в минутах
  is_active   BOOLEAN DEFAULT true,

  UNIQUE(master_id, day_of_week)
);
CREATE INDEX idx_schedule_master ON schedule(master_id);
```

### Таблица `day_overrides` (выходные, праздники, особое расписание)

```sql
CREATE TABLE day_overrides (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  master_id   UUID NOT NULL REFERENCES masters(id) ON DELETE CASCADE,
  date        DATE NOT NULL,
  is_day_off  BOOLEAN DEFAULT false,           -- true = выходной
  start_time  TIME,                            -- null = стандартное расписание
  end_time    TIME,

  UNIQUE(master_id, date)
);
CREATE INDEX idx_overrides_master_date ON day_overrides(master_id, date);
```

### Таблица `bookings`

```sql
CREATE TABLE bookings (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  master_id       UUID NOT NULL REFERENCES masters(id) ON DELETE CASCADE,
  service_id      UUID NOT NULL REFERENCES services(id),
  client_tg_id    BIGINT NOT NULL,             -- Telegram ID клиента
  client_name     TEXT DEFAULT '',              -- имя из Telegram
  client_username TEXT DEFAULT '',              -- @username
  date            DATE NOT NULL,
  time            TIME NOT NULL,
  price           INT NOT NULL,                -- цена на момент записи
  duration        INT NOT NULL,                -- длительность на момент записи
  status          TEXT DEFAULT 'pending'
                    CHECK (status IN ('pending', 'confirmed', 'completed', 'cancelled')),
  reminded        BOOLEAN DEFAULT false,        -- напоминание отправлено
  bonus_credited  BOOLEAN DEFAULT false,        -- бонус начислен
  created_at      TIMESTAMPTZ DEFAULT now(),

  UNIQUE(master_id, date, time)                 -- один слот = одна запись
);
CREATE INDEX idx_bookings_master_date ON bookings(master_id, date);
CREATE INDEX idx_bookings_client ON bookings(client_tg_id);
CREATE INDEX idx_bookings_reminder ON bookings(date, reminded) WHERE status = 'confirmed';
```

### Таблица `clients` (бонусы и история)

```sql
CREATE TABLE clients (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  master_id     UUID NOT NULL REFERENCES masters(id) ON DELETE CASCADE,
  tg_user_id    BIGINT NOT NULL,
  first_name    TEXT DEFAULT '',
  username      TEXT DEFAULT '',
  bonus_balance NUMERIC(10,2) DEFAULT 0,
  visits_count  INT DEFAULT 0,
  first_visit   TIMESTAMPTZ,
  last_visit    TIMESTAMPTZ,
  created_at    TIMESTAMPTZ DEFAULT now(),

  UNIQUE(master_id, tg_user_id)
);
CREATE INDEX idx_clients_master ON clients(master_id);
```

### Таблица `faq` (ответы бота)

```sql
CREATE TABLE faq (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  master_id   UUID NOT NULL REFERENCES masters(id) ON DELETE CASCADE,
  question    TEXT NOT NULL,                   -- "Где вы находитесь?"
  answer      TEXT NOT NULL,                   -- "Краснодар, ул. Красная 100"
  keywords    TEXT[] DEFAULT '{}',             -- ["адрес", "где", "как добраться"]
  sort_order  INT DEFAULT 0,
  is_active   BOOLEAN DEFAULT true,
  created_at  TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX idx_faq_master ON faq(master_id);
```

---

## 3. Supabase Storage (фото)

### Bucket: `service-photos`

```
service-photos/
  {master_id}/
    {service_id}/
      photo1.webp
      photo2.webp
```

**Политики:**
- **Чтение**: публичное (клиенты видят фото без авторизации)
- **Запись**: только авторизованный мастер (RLS по `master_id`)
- **Формат**: WebP (автоконвертация при загрузке через API)
- **Размеры**: thumb 200×200, full 800×600 (resize на backend)

### Bucket: `avatars`

```
avatars/
  {master_id}.webp
```

---

## 4. API (Supabase REST + Edge Functions)

### 4.1 Публичные эндпоинты (Mini App → Supabase)

Фронтенд обращается напрямую к Supabase REST API через `anon` ключ + RLS.

| Метод | Путь | Описание |
|-------|------|----------|
| GET | `/rest/v1/masters?bot_username=eq.{username}` | Получить данные мастера по username бота |
| GET | `/rest/v1/categories?master_id=eq.{id}&is_active=eq.true` | Категории мастера |
| GET | `/rest/v1/services?master_id=eq.{id}&is_active=eq.true` | Услуги мастера |
| GET | `/rest/v1/schedule?master_id=eq.{id}` | Расписание мастера |
| GET | `/rest/v1/day_overrides?master_id=eq.{id}&date=gte.{from}&date=lte.{to}` | Исключения дат |
| GET | `/rest/v1/bookings?master_id=eq.{id}&date=gte.{from}&date=lte.{to}&select=date,time` | Занятые слоты |
| GET | `/rest/v1/faq?master_id=eq.{id}&is_active=eq.true` | FAQ мастера |

### 4.2 Edge Functions (серверная логика)

| Функция | Метод | Описание |
|---------|-------|----------|
| `create-booking` | POST | Создать запись (валидация initData, проверка слота, сохранение, уведомление мастеру) |
| `register-master` | POST | Регистрация мастера (валидация токена бота, настройка webhook, создание записи) |
| `upload-photo` | POST | Загрузка фото (resize → WebP → Storage, возврат URL) |
| `get-slots` | GET | Вычисление свободных слотов (расписание − записи − overrides) |
| `bot-webhook` | POST | Единый webhook для всех ботов мастеров (роутинг по URL path) |

### 4.3 Формат запроса `create-booking`

```
POST /functions/v1/create-booking
Headers:
  X-Telegram-Init-Data: <initData строка из Telegram>

Body:
{
  "master_id": "uuid",
  "service_id": "uuid",
  "date": "2026-03-20",
  "time": "14:30"
}

Response 200:
{
  "booking_id": "uuid",
  "status": "confirmed",
  "message": "Вы записаны!"
}

Response 409:
{
  "error": "slot_taken",
  "message": "Это время уже занято"
}
```

### 4.4 Формат запроса `register-master`

```
POST /functions/v1/register-master
Headers:
  X-Telegram-Init-Data: <initData мастера>

Body:
{
  "bot_token": "123456:ABC..."
}

Response 200:
{
  "master_id": "uuid",
  "bot_username": "my_beauty_bot",
  "app_url": "https://app.example.com/?bot=my_beauty_bot",
  "message": "Бот подключён! Настройте услуги в панели мастера."
}
```

### 4.5 Формат `get-slots`

```
GET /functions/v1/get-slots?master_id={id}&from=2026-03-17&to=2026-03-31

Response 200:
{
  "2026-03-17": ["10:00", "10:30", "11:00", ...],
  "2026-03-18": ["10:00", "11:30", ...],
  "2026-03-19": []  // выходной
}
```

Логика:
1. Берём `schedule` для мастера (шаблон по дням недели)
2. Применяем `day_overrides` (выходные, особый график)
3. Исключаем `bookings` (занятые слоты)
4. Возвращаем оставшиеся свободные слоты

---

## 5. Bot Server (обработка Telegram webhook)

### Технология
- **Runtime**: Node.js (или Deno) на Railway / Render
- **Библиотека**: grammY (легковесный, TypeScript)
- **Webhook URL**: `https://bot.example.com/webhook/{bot_token_hash}`

### Маршрутизация

Все боты мастеров шлют webhook на один сервер, но по разным путям:

```
POST /webhook/abc123 → master_id = lookup by token hash
POST /webhook/def456 → master_id = lookup by token hash
```

### Команды бота (для клиента)

| Команда | Действие |
|---------|----------|
| `/start` | Приветствие + кнопка «Открыть каталог» (Web App) |
| `/help` | Как записаться, контакты мастера |
| Текстовое сообщение | Поиск ответа в `faq` по ключевым словам. Если не найдено → «Напишите мастеру напрямую» |

### Уведомления

| Событие | Кому | Сообщение |
|---------|------|----------|
| Новая запись | Мастер | «📋 Новая запись! {имя}, {услуга}, {дата} {время}, {цена}» |
| Новая запись | Клиент | «✅ Вы записаны! {услуга}, {дата} {время}. Напомним за день.» |
| Напоминание (24ч) | Клиент | «🔔 Напоминаем: завтра в {время} — {услуга}» |
| Визит подтверждён | Клиент | «🎉 Спасибо за визит! +{бонус}₽ бонусов начислено» |
| Отмена записи | Мастер | «❌ {имя} отменил запись на {дата} {время}» |

### FAQ-ответы бота

Логика поиска:
1. Клиент пишет текст боту
2. Бот берёт `faq` мастера из базы
3. Сравнивает текст с `keywords` каждого FAQ (простой keyword match)
4. Если найден — отвечает `answer`
5. Если не найден — «Не нашёл ответ. Напишите мастеру: @{master_telegram}»

---

## 6. Роли и доступ

### Клиент (обычный пользователь Telegram)

**Видит:**
- Профиль мастера (имя, описание, аватар)
- Категории и услуги (только `is_active = true`)
- Фото услуг
- Свободные слоты
- Свою историю записей
- Свой бонусный баланс
- FAQ-ответы бота

**Может:**
- Записаться на свободный слот
- Просмотреть свои записи
- Отменить запись (за 24+ часов)
- Задать вопрос боту
- Поделиться ссылкой на бота

**Не может:**
- Видеть чужие записи
- Редактировать услуги/расписание
- Видеть данные других мастеров

### Мастер (владелец бота)

**Видит:**
- Все записи к себе (сегодня + все)
- Статистику (записей, выручка, клиентов)
- Свои услуги, категории, расписание
- Бонусы клиентов

**Может (в Mini App, вкладка «Мастер»):**
- Добавлять / редактировать / удалять категории
- Добавлять / редактировать / удалять услуги
- Загружать фото к услугам
- Настраивать расписание (рабочие дни, часы, перерывы)
- Отмечать выходные / особые дни
- Подтверждать визиты (начисляет бонус клиенту)
- Отменять записи
- Добавлять FAQ-вопросы и ответы
- Редактировать профиль (имя, описание, аватар, телефон)

**Не может:**
- Видеть данные других мастеров
- Менять код доступа других

### Суперадмин (ты)

**Видит:** всё — все мастера, все записи, все данные
**Может:** блокировать мастеров, мониторинг, прямой доступ к Supabase Dashboard

---

## 7. Row Level Security (RLS)

Supabase RLS обеспечивает изоляцию данных между тенантами.

### Принцип

Mini App передаёт `master_id` в запросах. Данные фильтруются на уровне базы:

```sql
-- Клиент видит только активные услуги конкретного мастера
CREATE POLICY "Public read services"
  ON services FOR SELECT
  USING (is_active = true);

-- Мастер редактирует только свои услуги
CREATE POLICY "Master manages own services"
  ON services FOR ALL
  USING (master_id = auth.uid())
  WITH CHECK (master_id = auth.uid());
```

Для публичных запросов (клиент без авторизации) данные фильтруются по `master_id` в запросе — `anon` ключ имеет только SELECT на активные записи.

Мутации (create booking, upload photo) проходят через Edge Functions, которые валидируют `initData` от Telegram.

---

## 8. Онбординг мастера (пошагово)

```
1. Мастер получает инструкцию:
   «Откройте @BotFather → /newbot → придумайте имя и username → скопируйте токен»

2. Мастер открывает ссылку: https://app.example.com/setup
   или пишет главному боту: /connect

3. Вставляет токен бота

4. Система автоматически:
   a) Валидирует токен (getMe)
   b) Сохраняет мастера в БД
   c) Настраивает webhook бота → наш Bot Server
   d) Устанавливает описание бота (setMyDescription)
   e) Устанавливает команды (setMyCommands)
   f) Настраивает Menu Button → Mini App URL с параметром ?bot={username}

5. Мастер попадает в панель настроек:
   → Заполняет имя, описание, телефон
   → Добавляет категории
   → Добавляет услуги с фото
   → Настраивает расписание (рабочие дни и часы)
   → Добавляет FAQ

6. Готово — клиенты мастера могут открыть бота и записаться
```

---

## 9. Фронтенд: что меняется

### Текущее состояние → Что нужно

| Сейчас | Нужно |
|--------|-------|
| Данные захардкожены в `data.js` | Загрузка с Supabase API по `master_id` |
| localStorage для записей | POST в `create-booking` Edge Function |
| localStorage для бонусов | Таблица `clients` в Supabase |
| Код мастера = `const MASTER_CODE` | Код из таблицы `masters.master_code` |
| Панель мастера: только просмотр записей | + CRUD услуг, категорий, расписания, FAQ |
| Фото = пустой массив | Загрузка из Supabase Storage |
| `tenant_id` нет | Из URL параметра `?bot={username}` или `initData` |

### Новый flow загрузки данных

```
1. Mini App открывается с параметром ?bot=my_beauty_bot
2. GET /masters?bot_username=eq.my_beauty_bot → получаем master_id
3. Параллельно:
   - GET /categories?master_id=eq.{id}
   - GET /services?master_id=eq.{id}
   - GET /functions/v1/get-slots?master_id={id}
4. Рендер экранов с реальными данными
5. При записи: POST /functions/v1/create-booking
```

### Новые экраны панели мастера

| Экран | Функция |
|-------|---------|
| Мастер → Профиль | Имя, описание, аватар, телефон, WhatsApp |
| Мастер → Категории | Список + добавить / редактировать / удалить |
| Мастер → Услуги | Список + добавить / редактировать / удалить / загрузить фото |
| Мастер → Расписание | Дни недели: вкл/выкл + часы работы + шаг слота |
| Мастер → Выходные | Календарь: отметить выходные / особые дни |
| Мастер → FAQ | Список вопросов-ответов + ключевые слова |
| Мастер → Записи | Все записи + подтверждение визитов (как сейчас) |

---

## 10. Инфраструктура и деплой

| Компонент | Платформа | Стоимость |
|-----------|----------|----------|
| База данных | Supabase Free (500MB, 50K запросов/мес) | $0 |
| Хранилище фото | Supabase Storage Free (1GB) | $0 |
| Edge Functions | Supabase Free (500K вызовов/мес) | $0 |
| Mini App (фронтенд) | Vercel Free | $0 |
| Bot Server | Railway Free ($5 credit/мес) или Render Free | $0 |
| Cron (напоминания) | Supabase pg_cron или Railway cron | $0 |

**Итого на старте: $0/мес** при <50 мастеров и <10K записей/мес.

---

## 11. Порядок разработки

### Фаза 1: Supabase + API (2-3 дня)
- [ ] Создать проект в Supabase
- [ ] Создать все таблицы + индексы + RLS
- [ ] Создать Storage buckets + политики
- [ ] Edge Function: `get-slots`
- [ ] Edge Function: `create-booking`
- [ ] Edge Function: `register-master`
- [ ] Edge Function: `upload-photo`

### Фаза 2: Фронтенд → API (2-3 дня)
- [ ] Заменить `data.js` на загрузку с Supabase
- [ ] `?bot={username}` → определение мастера
- [ ] Skeleton-загрузки при fetch
- [ ] Запись через `create-booking`
- [ ] Бонусы из таблицы `clients`
- [ ] Фото из Supabase Storage

### Фаза 3: Панель мастера в Mini App (3-4 дня)
- [ ] CRUD категорий
- [ ] CRUD услуг + загрузка фото
- [ ] Настройка расписания
- [ ] Управление выходными
- [ ] Редактирование профиля
- [ ] Управление FAQ

### Фаза 4: Bot Server (2-3 дня)
- [ ] grammY сервер с мульти-бот роутингом
- [ ] Webhook регистрация при подключении мастера
- [ ] /start, /help команды
- [ ] FAQ-ответы по ключевым словам
- [ ] Уведомление мастеру о новой записи
- [ ] Подтверждение клиенту

### Фаза 5: Напоминания + полировка (1-2 дня)
- [ ] Cron: напоминания за 24ч
- [ ] Cron: сообщение после визита (отзыв + бонус)
- [ ] Тестирование полного цикла
- [ ] Онбординг первого внешнего мастера
