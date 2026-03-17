-- Дополнительные RLS-политики для INSERT/UPDATE
-- Запускать в Supabase SQL Editor ПОСЛЕ 001_schema.sql и 002_seed_data.sql
--
-- Зачем: без этих политик приложение может только ЧИТАТЬ данные,
-- но не создавать записи (booking) и не регистрировать клиентов.
-- Это как повесить табличку "Запись открыта" на дверь кабинета.

-- Клиенты Mini App могут СОЗДАВАТЬ записи (бронировать время)
CREATE POLICY "anon_insert_bookings"
  ON bookings FOR INSERT
  TO anon
  WITH CHECK (true);

-- Клиенты Mini App могут регистрироваться (создавать свой профиль)
CREATE POLICY "anon_insert_clients"
  ON clients FOR INSERT
  TO anon
  WITH CHECK (true);

-- Клиенты могут обновлять свои данные (имя, username)
CREATE POLICY "anon_update_clients"
  ON clients FOR UPDATE
  TO anon
  USING (true)
  WITH CHECK (true);
