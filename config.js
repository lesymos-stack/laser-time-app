// TODO(security S2): API_KEY is public and doesn't provide security.
// After S4 (IDOR fix on backend), mutating endpoints require JWT —
// at that point API_KEY can be removed entirely. Read endpoints are public.

// API — настройки подключения
// Вместо Supabase используем свой REST API на VPS (Россия, 152-ФЗ)

// API проксируется через Vercel rewrites → VPS (без cross-origin проблем на iOS)
const API_BASE_URL = '';

const API_KEY = 'beauty-api-key-2026';
