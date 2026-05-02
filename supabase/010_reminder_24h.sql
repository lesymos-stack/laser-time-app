-- Флаг отправки 24-часового напоминания клиенту с интерактивными кнопками
-- (подтвердить / отменить / перенести). Атомарно ставится в reminder.js
-- после попытки доставки.
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS reminder_24h_sent_at timestamp with time zone;
