-- Горизонт записи: на сколько месяцев вперёд мастер показывает клиентам календарь.
-- Значение по умолчанию 1 = 1 месяц (30 дней).
ALTER TABLE masters ADD COLUMN IF NOT EXISTS booking_months integer DEFAULT 1;
