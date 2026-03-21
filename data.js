/**
 * data.js — Данные каталога услуг
 *
 * Здесь хранятся все услуги, расписание и информация о мастере.
 * В будущем данные будут загружаться из Google Sheets через API.
 * Сейчас — локальные данные для работы без бэкенда.
 *
 * КАК РЕДАКТИРОВАТЬ:
 * - Услуги: массив SERVICES — добавляй/удаляй объекты
 * - Расписание: объект SCHEDULE — ключ = дата, значение = массив слотов
 * - Мастер: объект MASTER — имя, описание, фото
 */

// === ИНФОРМАЦИЯ О МАСТЕРЕ ===
// let — чтобы можно было перезаписать данными из Supabase
let MASTER = {
  name: 'Лазер Тайм',
  description: 'Центр лазерной эпиляции и аппаратной косметологии',
  // Аватар — эмодзи-заглушка, заменить на URL фото мастера
  avatar: null,
  // Контакты — подставь свои данные
  phone: '+79886739548',       // номер для звонка
  telegram: 'anna_beauty',     // username в Telegram (без @)
};

// === КАТЕГОРИИ УСЛУГ ===
let CATEGORIES = [
  { id: 'manicure', name: 'Лазерная эпиляция', icon: '✨', sort: 1 },
  { id: 'pedicure', name: 'Коррекция фигуры', icon: '💎', sort: 2 },
  { id: 'brows',    name: 'Комплексы', icon: '🎁', sort: 3 },
  { id: 'care',     name: 'Лицо',    icon: '💆', sort: 4 },
];

// === УСЛУГИ ===
let SERVICES = [
  // --- Лазерная эпиляция ---
  {
    id: 1,
    category: 'manicure',
    name: 'Ноги полностью',
    description: 'Лазерная эпиляция ног полностью — от бедра до стопы.',
    duration: 60,
    price: 4390,
    salePrice: null,
    photos: [],
    active: true,
    sort: 1,
  },
  {
    id: 2,
    category: 'manicure',
    name: 'Голени',
    description: 'Лазерная эпиляция голеней.',
    duration: 30,
    price: 2390,
    salePrice: null,
    photos: [],
    active: true,
    sort: 2,
  },
  {
    id: 3,
    category: 'manicure',
    name: 'Ягодицы',
    description: 'Лазерная эпиляция зоны ягодиц.',
    duration: 30,
    price: 2290,
    salePrice: null,
    photos: [],
    active: true,
    sort: 3,
  },
  {
    id: 4,
    category: 'manicure',
    name: 'Бёдра',
    description: 'Лазерная эпиляция бёдер.',
    duration: 30,
    price: 2690,
    salePrice: null,
    photos: [],
    active: true,
    sort: 4,
  },
  {
    id: 5,
    category: 'manicure',
    name: 'Внутренняя/внешняя часть бедра',
    description: 'Лазерная эпиляция внутренней или внешней части бедра.',
    duration: 20,
    price: 1490,
    salePrice: null,
    photos: [],
    active: true,
    sort: 5,
  },
  {
    id: 14,
    category: 'manicure',
    name: 'Колени',
    description: 'Лазерная эпиляция зоны коленей.',
    duration: 15,
    price: 890,
    salePrice: null,
    photos: [],
    active: true,
    sort: 6,
  },
  {
    id: 15,
    category: 'manicure',
    name: 'Руки полностью',
    description: 'Лазерная эпиляция рук полностью — от плеча до кисти.',
    duration: 40,
    price: 2590,
    salePrice: null,
    photos: [],
    active: true,
    sort: 7,
  },
  {
    id: 16,
    category: 'manicure',
    name: 'Руки до локтя',
    description: 'Лазерная эпиляция рук до локтя.',
    duration: 25,
    price: 1800,
    salePrice: null,
    photos: [],
    active: true,
    sort: 8,
  },
  {
    id: 17,
    category: 'manicure',
    name: 'Руки выше локтя',
    description: 'Лазерная эпиляция рук выше локтя.',
    duration: 25,
    price: 2090,
    salePrice: null,
    photos: [],
    active: true,
    sort: 9,
  },
  {
    id: 18,
    category: 'manicure',
    name: 'Пальцы рук/ног',
    description: 'Лазерная эпиляция пальцев рук или ног.',
    duration: 10,
    price: 590,
    salePrice: null,
    photos: [],
    active: true,
    sort: 10,
  },
  {
    id: 19,
    category: 'manicure',
    name: 'Лицо полностью',
    description: 'Лазерная эпиляция лица полностью.',
    duration: 30,
    price: 2000,
    salePrice: null,
    photos: [],
    active: true,
    sort: 11,
  },
  {
    id: 20,
    category: 'manicure',
    name: 'Лоб',
    description: 'Лазерная эпиляция зоны лба.',
    duration: 10,
    price: 790,
    salePrice: null,
    photos: [],
    active: true,
    sort: 12,
  },
  {
    id: 21,
    category: 'manicure',
    name: 'Щёки/бакенбарды',
    description: 'Лазерная эпиляция щёк и бакенбардов.',
    duration: 15,
    price: 1090,
    salePrice: null,
    photos: [],
    active: true,
    sort: 13,
  },
  {
    id: 22,
    category: 'manicure',
    name: 'Верхняя губа',
    description: 'Лазерная эпиляция зоны верхней губы.',
    duration: 10,
    price: 590,
    salePrice: null,
    photos: [],
    active: true,
    sort: 14,
  },
  {
    id: 23,
    category: 'manicure',
    name: 'Подбородок',
    description: 'Лазерная эпиляция подбородка.',
    duration: 10,
    price: 590,
    salePrice: null,
    photos: [],
    active: true,
    sort: 15,
  },
  {
    id: 24,
    category: 'manicure',
    name: 'Шея',
    description: 'Лазерная эпиляция шеи.',
    duration: 15,
    price: 1090,
    salePrice: null,
    photos: [],
    active: true,
    sort: 16,
  },
  {
    id: 25,
    category: 'manicure',
    name: 'Подмышки',
    description: 'Лазерная эпиляция подмышечных впадин.',
    duration: 15,
    price: 1090,
    salePrice: null,
    photos: [],
    active: true,
    sort: 17,
  },
  {
    id: 26,
    category: 'manicure',
    name: 'Декольте',
    description: 'Лазерная эпиляция зоны декольте.',
    duration: 20,
    price: 1790,
    salePrice: null,
    photos: [],
    active: true,
    sort: 18,
  },
  {
    id: 27,
    category: 'manicure',
    name: 'Живот полностью',
    description: 'Лазерная эпиляция живота полностью.',
    duration: 25,
    price: 2090,
    salePrice: null,
    photos: [],
    active: true,
    sort: 19,
  },
  {
    id: 28,
    category: 'manicure',
    name: 'Живот белая линия',
    description: 'Лазерная эпиляция белой линии живота.',
    duration: 10,
    price: 1090,
    salePrice: null,
    photos: [],
    active: true,
    sort: 20,
  },
  {
    id: 29,
    category: 'manicure',
    name: 'Ареолы',
    description: 'Лазерная эпиляция зоны ареол.',
    duration: 10,
    price: 1000,
    salePrice: null,
    photos: [],
    active: true,
    sort: 21,
  },
  {
    id: 30,
    category: 'manicure',
    name: 'Спина',
    description: 'Лазерная эпиляция спины.',
    duration: 30,
    price: 2990,
    salePrice: null,
    photos: [],
    active: true,
    sort: 22,
  },
  {
    id: 31,
    category: 'manicure',
    name: 'Спина полностью',
    description: 'Лазерная эпиляция спины полностью.',
    duration: 45,
    price: 3890,
    salePrice: null,
    photos: [],
    active: true,
    sort: 23,
  },
  {
    id: 32,
    category: 'manicure',
    name: 'Бикини классическое',
    description: 'Лазерная эпиляция зоны классического бикини.',
    duration: 20,
    price: 1190,
    salePrice: null,
    photos: [],
    active: true,
    sort: 24,
  },
  {
    id: 33,
    category: 'manicure',
    name: 'Бикини глубокое',
    description: 'Лазерная эпиляция зоны глубокого бикини.',
    duration: 30,
    price: 1990,
    salePrice: null,
    photos: [],
    active: true,
    sort: 25,
  },
  {
    id: 34,
    category: 'manicure',
    name: 'Бикини тотальное',
    description: 'Лазерная эпиляция зоны тотального бикини.',
    duration: 40,
    price: 2390,
    salePrice: null,
    photos: [],
    active: true,
    sort: 26,
  },

  // --- Коррекция фигуры ---
  {
    id: 6,
    category: 'pedicure',
    name: 'Классический педикюр',
    description: 'Аппаратный педикюр: обработка стоп, пальцев, кутикулы. Без покрытия.',
    duration: 60,
    price: 2000,
    salePrice: null,
    photos: [],
    active: true,
    sort: 1,
  },
  {
    id: 7,
    category: 'pedicure',
    name: 'Педикюр с покрытием',
    description: 'Полный аппаратный педикюр с покрытием гель-лаком. Включает обработку стоп и пальцев.',
    duration: 90,
    price: 2800,
    salePrice: 2400,
    photos: [],
    active: true,
    sort: 2,
  },
  {
    id: 8,
    category: 'pedicure',
    name: 'Комбо маникюр + педикюр',
    description: 'Полный маникюр и педикюр с покрытием гель-лаком. Выгоднее, чем по отдельности.',
    duration: 180,
    price: 4500,
    salePrice: 3800,
    photos: [],
    active: true,
    sort: 3,
  },

  // --- Комплексы ---
  {
    id: 9,
    category: 'brows',
    name: 'XS: Глубокое бикини + подмышки',
    description: 'В комплекс входят: межъягодичная зона, белая линия на животе, верхняя губа. Выгода 1910 ₽!',
    duration: 60,
    price: 3250,
    salePrice: null,
    photos: [],
    active: true,
    sort: 1,
  },
  {
    id: 10,
    category: 'brows',
    name: 'S: Глубокое бикини + подмышки + голени',
    description: 'В комплекс входят: межъягодичная зона, белая линия на животе, пальчики на ногах, верхняя губа. Выгода 2560 ₽!',
    duration: 90,
    price: 4990,
    salePrice: null,
    photos: [],
    active: true,
    sort: 2,
  },
  {
    id: 35,
    category: 'brows',
    name: 'M: Гл. бикини + подмышки + ноги полностью',
    description: 'В комплекс входят: межъягодичная зона, белая линия на животе, верхняя губа, пальчики на ногах. Выгода 3650 ₽!',
    duration: 120,
    price: 5990,
    salePrice: null,
    photos: [],
    active: true,
    sort: 3,
  },
  {
    id: 36,
    category: 'brows',
    name: 'L: Гл. бикини + подмышки + руки/ноги полностью',
    description: 'В комплекс входят: межъягодичная зона, белая линия на животе, пальчики на ногах, верхняя губа, пальчики на руках. Выгода 4150 ₽!',
    duration: 150,
    price: 7290,
    salePrice: null,
    photos: [],
    active: true,
    sort: 4,
  },

  // --- Уход ---
  {
    id: 12,
    category: 'care',
    name: 'SPA-уход для рук',
    description: 'Пилинг, маска, массаж рук, парафинотерапия. Глубокое увлажнение и питание кожи.',
    duration: 30,
    price: 800,
    salePrice: null,
    photos: [],
    active: true,
    sort: 1,
  },
  {
    id: 13,
    category: 'care',
    name: 'Парафинотерапия рук',
    description: 'Горячий парафин для рук. Увлажняет, смягчает кожу, улучшает кровообращение.',
    duration: 20,
    price: 500,
    salePrice: null,
    photos: [],
    active: true,
    sort: 2,
  },
];

// === РАСПИСАНИЕ ===
// Генерируем расписание на 14 дней вперёд
function generateSchedule() {
  const schedule = {};
  const today = new Date();

  for (let i = 0; i < 14; i++) {
    const date = new Date(today);
    date.setDate(today.getDate() + i);

    // Выходной — воскресенье (0)
    if (date.getDay() === 0) continue;

    const key = formatDateKey(date);

    // Суббота — короткий день
    if (date.getDay() === 6) {
      schedule[key] = ['10:00', '10:30', '11:00', '11:30', '12:00', '12:30', '13:00', '13:30', '14:00', '14:30', '15:00', '15:30', '16:00', '16:30', '17:00'];
    } else {
      schedule[key] = ['10:00', '10:30', '11:00', '11:30', '12:00', '12:30', '13:00', '13:30', '14:00', '14:30', '15:00', '15:30', '16:00', '16:30', '17:00', '17:30', '18:00', '18:30', '19:00', '19:30', '20:00'];
    }
  }

  return schedule;
}

// Формат даты: "2026-03-10"
function formatDateKey(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

let SCHEDULE = generateSchedule();

// Массив забронированных слотов (имитация)
// Формат: "2026-03-10_10:00"
let BOOKED_SLOTS = [];

// Занятые интервалы по дням (для проверки длительности услуги)
// Формат: { "2026-03-20": [{start: 600, end: 660}, ...] }
let BUSY_INTERVALS = {};
