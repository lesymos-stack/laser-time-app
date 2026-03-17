-- Beauty Catalog — Schema

-- ────────────────────────────────────────────────────────────
-- 1. ТАБЛИЦЫ
-- ────────────────────────────────────────────────────────────

-- Мастера (каждый мастер = отдельный "магазин")
CREATE TABLE masters (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tg_user_id    BIGINT UNIQUE NOT NULL,
  bot_token     TEXT UNIQUE NOT NULL,
  bot_username  TEXT,
  name          TEXT NOT NULL,
  description   TEXT DEFAULT '',
  phone         TEXT DEFAULT '',
  whatsapp_url  TEXT DEFAULT '',
  avatar_url    TEXT,
  welcome_text  TEXT DEFAULT '',
  master_code   TEXT DEFAULT '0000',
  is_active     BOOLEAN DEFAULT true,
  created_at    TIMESTAMPTZ DEFAULT now()
);

-- Категории услуг (например: "Лазерная эпиляция", "Маникюр")
CREATE TABLE categories (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  master_id   UUID NOT NULL REFERENCES masters(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  icon        TEXT DEFAULT '✨',
  sort_order  INT DEFAULT 0,
  is_active   BOOLEAN DEFAULT true,
  created_at  TIMESTAMPTZ DEFAULT now()
);

-- Услуги (конкретные процедуры с ценой и длительностью)
CREATE TABLE services (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  master_id     UUID NOT NULL REFERENCES masters(id) ON DELETE CASCADE,
  category_id   UUID REFERENCES categories(id) ON DELETE SET NULL,
  name          TEXT NOT NULL,
  description   TEXT DEFAULT '',
  duration      INT NOT NULL,
  price         INT NOT NULL,
  sale_price    INT,
  photos        TEXT[] DEFAULT '{}',
  is_active     BOOLEAN DEFAULT true,
  sort_order    INT DEFAULT 0,
  created_at    TIMESTAMPTZ DEFAULT now()
);

-- Расписание (шаблон: какие дни недели рабочие, с какого по какое время)
CREATE TABLE schedule (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  master_id     UUID NOT NULL REFERENCES masters(id) ON DELETE CASCADE,
  day_of_week   INT NOT NULL CHECK (day_of_week BETWEEN 0 AND 6),
  start_time    TIME NOT NULL,
  end_time      TIME NOT NULL,
  slot_interval INT DEFAULT 30,
  is_active     BOOLEAN DEFAULT true,

  UNIQUE(master_id, day_of_week)
);

-- Исключения из расписания (выходные, праздники, особый график)
CREATE TABLE day_overrides (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  master_id   UUID NOT NULL REFERENCES masters(id) ON DELETE CASCADE,
  date        DATE NOT NULL,
  is_day_off  BOOLEAN DEFAULT false,
  start_time  TIME,
  end_time    TIME,

  UNIQUE(master_id, date)
);

-- Записи клиентов
CREATE TABLE bookings (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  master_id       UUID NOT NULL REFERENCES masters(id) ON DELETE CASCADE,
  service_id      UUID NOT NULL REFERENCES services(id),
  client_tg_id    BIGINT NOT NULL,
  client_name     TEXT DEFAULT '',
  client_username TEXT DEFAULT '',
  date            DATE NOT NULL,
  time            TIME NOT NULL,
  price           INT NOT NULL,
  duration        INT NOT NULL,
  status          TEXT DEFAULT 'confirmed'
                    CHECK (status IN ('pending', 'confirmed', 'completed', 'cancelled')),
  reminded        BOOLEAN DEFAULT false,
  bonus_credited  BOOLEAN DEFAULT false,
  created_at      TIMESTAMPTZ DEFAULT now(),

  UNIQUE(master_id, date, time)
);

-- Клиенты (бонусы, история визитов)
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

-- FAQ — ответы бота на вопросы клиентов
CREATE TABLE faq (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  master_id   UUID NOT NULL REFERENCES masters(id) ON DELETE CASCADE,
  question    TEXT NOT NULL,
  answer      TEXT NOT NULL,
  keywords    TEXT[] DEFAULT '{}',
  sort_order  INT DEFAULT 0,
  is_active   BOOLEAN DEFAULT true,
  created_at  TIMESTAMPTZ DEFAULT now()
);


-- ────────────────────────────────────────────────────────────
-- 2. ИНДЕКСЫ (ускоряют поиск данных)
-- ────────────────────────────────────────────────────────────

CREATE INDEX idx_categories_master ON categories(master_id);
CREATE INDEX idx_services_master ON services(master_id);
CREATE INDEX idx_services_category ON services(category_id);
CREATE INDEX idx_schedule_master ON schedule(master_id);
CREATE INDEX idx_overrides_master_date ON day_overrides(master_id, date);
CREATE INDEX idx_bookings_master_date ON bookings(master_id, date);
CREATE INDEX idx_bookings_client ON bookings(client_tg_id);
CREATE INDEX idx_bookings_reminder ON bookings(date, reminded) WHERE status = 'confirmed';
CREATE INDEX idx_clients_master ON clients(master_id);
CREATE INDEX idx_faq_master ON faq(master_id);


-- ────────────────────────────────────────────────────────────
-- 3. RLS — ОХРАННИК (кто что может видеть и менять)
-- ────────────────────────────────────────────────────────────

-- Включаем RLS на всех таблицах
ALTER TABLE masters ENABLE ROW LEVEL SECURITY;
ALTER TABLE categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE services ENABLE ROW LEVEL SECURITY;
ALTER TABLE schedule ENABLE ROW LEVEL SECURITY;
ALTER TABLE day_overrides ENABLE ROW LEVEL SECURITY;
ALTER TABLE bookings ENABLE ROW LEVEL SECURITY;
ALTER TABLE clients ENABLE ROW LEVEL SECURITY;
ALTER TABLE faq ENABLE ROW LEVEL SECURITY;

-- ── Политики для АНОНИМНЫХ пользователей (клиенты Mini App) ──
-- Клиенты могут только ЧИТАТЬ публичные данные

-- Мастера: читать активных
CREATE POLICY "anon_read_masters"
  ON masters FOR SELECT
  TO anon
  USING (is_active = true);

-- Категории: читать активные
CREATE POLICY "anon_read_categories"
  ON categories FOR SELECT
  TO anon
  USING (is_active = true);

-- Услуги: читать активные
CREATE POLICY "anon_read_services"
  ON services FOR SELECT
  TO anon
  USING (is_active = true);

-- Расписание: читать активное
CREATE POLICY "anon_read_schedule"
  ON schedule FOR SELECT
  TO anon
  USING (is_active = true);

-- Исключения дат: читать все (нужно знать выходные)
CREATE POLICY "anon_read_overrides"
  ON day_overrides FOR SELECT
  TO anon
  USING (true);

-- Записи: читать только дату и время (для показа занятых слотов)
-- Полные данные записей клиенты получают через Edge Functions
CREATE POLICY "anon_read_bookings"
  ON bookings FOR SELECT
  TO anon
  USING (status IN ('confirmed', 'pending'));

-- FAQ: читать активные
CREATE POLICY "anon_read_faq"
  ON faq FOR SELECT
  TO anon
  USING (is_active = true);

-- Клиенты: анонимы НЕ читают (данные идут через Edge Functions)
-- Никаких политик для anon на таблицу clients

-- ── Политики для SERVICE_ROLE (Edge Functions, Bot Server) ──
-- service_role обходит RLS автоматически — ничего настраивать не нужно.
-- Edge Functions используют SUPABASE_SERVICE_ROLE_KEY и имеют полный доступ.


-- ────────────────────────────────────────────────────────────
-- 4. STORAGE BUCKETS (склады для фото)
-- ────────────────────────────────────────────────────────────

-- Создаём bucket для фото услуг (публичный для чтения)
INSERT INTO storage.buckets (id, name, public)
VALUES ('service-photos', 'service-photos', true);

-- Создаём bucket для аватаров мастеров (публичный для чтения)
INSERT INTO storage.buckets (id, name, public)
VALUES ('avatars', 'avatars', true);

-- Политика: все могут ЧИТАТЬ фото (они публичные)
CREATE POLICY "public_read_service_photos"
  ON storage.objects FOR SELECT
  TO anon
  USING (bucket_id = 'service-photos');

CREATE POLICY "public_read_avatars"
  ON storage.objects FOR SELECT
  TO anon
  USING (bucket_id = 'avatars');

-- Загрузка фото — только через Edge Functions (service_role),
-- поэтому дополнительных политик на INSERT не нужно.
