require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const express = require('express');

// ============================================================
// НАСТРОЙКИ — берём из Render Environment
// ============================================================
const BOT_TOKEN        = process.env.BOT_TOKEN;
const TARGET_CHAT_ID   = process.env.TARGET_CHAT_ID;
const GOOGLE_SHEETS_URL = process.env.GOOGLE_SHEETS_URL;
const RENDER_URL        = process.env.RENDER_URL;
const PORT             = process.env.PORT || 3000;

// Проверка обязательных переменных
if (!BOT_TOKEN)        { console.error('❌ BOT_TOKEN не найден!'); process.exit(1); }
if (!TARGET_CHAT_ID)   { console.error('❌ TARGET_CHAT_ID не найден!'); process.exit(1); }
if (!GOOGLE_SHEETS_URL){ console.error('❌ GOOGLE_SHEETS_URL не найден!'); process.exit(1); }

// ============================================================
// ЗАПУСК БОТА И СЕРВЕРА
// ============================================================
const bot = new TelegramBot(BOT_TOKEN, { polling: true });
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

console.log('🚀 SMS Bot запускается...');

// ============================================================
// ЗАЩИТА ОТ ДУБЛЕЙ
// Храним ID последних 100 отправленных SMS
// Если такое уже отправляли — пропускаем
// ============================================================
const sentMessages = new Set();

function isDuplicate(text, timestamp) {
    // Ключ = первые 50 символов текста + время (до минуты)
    const minute = timestamp ? timestamp.substring(0, 16) : new Date().toISOString().substring(0, 16);
    const key = text.substring(0, 50) + '|' + minute;

    if (sentMessages.has(key)) {
        console.log('⚠️ Дубль — пропускаем:', key);
        return true;
    }

    sentMessages.add(key);

    // Чистим если накопилось больше 100 записей
    if (sentMessages.size > 100) {
        const first = sentMessages.values().next().value;
        sentMessages.delete(first);
    }

    return false;
}

// ============================================================
// ФИЛЬТР SMS
// Только "Postupil" — обрезаем "Ost:" и всё после
// ============================================================
function processText(text) {
    if (!text) return null;

    // Убираем лишние пробелы
    text = text.trim();

    // Должен начинаться с "Postupil" (не важно большими или маленькими буквами)
    if (!text.toLowerCase().startsWith('postupil')) {
        console.log('⏭️ Пропускаем — не начинается с Postupil');
        return null;
    }

    // Обрезаем "Ost:" и всё что после
    if (text.includes('Ost:')) {
        text = text.split('Ost:')[0].trim();
    }

    return text;
}

// ============================================================
// ОТПРАВКА В TELEGRAM
// 3 попытки — если не получилось, сдаёмся
// ============================================================
async function sendToTelegram(text) {
    for (let attempt = 1; attempt <= 3; attempt++) {
        try {
            await bot.sendMessage(TARGET_CHAT_ID, text);
            console.log(`✅ Отправлено в Telegram: "${text.substring(0, 50)}"`);
            return true;

        } catch (err) {
            // Telegram говорит "подожди" (rate limit)
            if (err.message?.includes('429')) {
                const match   = err.message.match(/retry after (\d+)/);
                const waitSec = parseInt(match?.[1] || '30') + 1;
                console.warn(`⏳ Telegram rate limit. Жду ${waitSec} сек...`);
                await sleep(waitSec * 1000);

            } else {
                console.error(`❌ Попытка ${attempt}/3: ${err.message}`);
                if (attempt < 3) await sleep(3000);
            }
        }
    }

    console.error('❌ Не удалось отправить после 3 попыток');
    return false;
}

// ============================================================
// ЧИТАЕМ SMS ИЗ GOOGLE SHEETS И УДАЛЯЕМ ИХ
// ============================================================
async function fetchFromSheets() {
    try {
        const url      = `${GOOGLE_SHEETS_URL}?action=readAndClear`;
        const response = await fetchWithTimeout(url, { method: 'GET', redirect: 'follow' }, 15000);

        if (!response.ok) {
            console.error(`❌ Sheets вернул HTTP ${response.status}`);
            return [];
        }

        const result = await response.json();

        if (result.status === 'success' && result.count > 0) {
            console.log(`📥 Из Sheets получено: ${result.count} SMS`);
            return result.data;
        }

        return [];

    } catch (err) {
        console.error('❌ Ошибка чтения Sheets:', err.message);
        return [];
    }
}

// ============================================================
// ГЛАВНЫЙ ЦИКЛ — читаем Sheets и шлём в Telegram
// ============================================================
let isProcessing = false;

async function processSheets() {
    // Не запускаем если предыдущий ещё работает
    if (isProcessing) return;
    isProcessing = true;

    try {
        const smsList = await fetchFromSheets();
        if (smsList.length === 0) {
            isProcessing = false;
            return;
        }

        // Сортируем по времени — старые сначала
        smsList.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

        console.log(`📤 Обрабатываем ${smsList.length} SMS...`);

        for (const sms of smsList) {
            // Фильтруем текст
            const processed = processText(sms.text);
            if (!processed) continue;

            // Проверяем на дубль
            if (isDuplicate(processed, sms.timestamp)) continue;

            // Отправляем в Telegram
            await sendToTelegram(processed);

            // Пауза 2 сек между сообщениями — Telegram не любит спам
            await sleep(2000);
        }

    } catch (err) {
        console.error('❌ Ошибка в processSheets:', err.message);
    }

    isProcessing = false;
}

// ============================================================
// ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ
// ============================================================

// Ждать N миллисекунд
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// fetch с таймаутом — если сервер не отвечает N секунд, прерываем
async function fetchWithTimeout(url, options, timeoutMs) {
    const controller = new AbortController();
    const timer      = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const res = await fetch(url, { ...options, signal: controller.signal });
        clearTimeout(timer);
        return res;
    } catch (err) {
        clearTimeout(timer);
        throw err;
    }
}

// ============================================================
// ENDPOINTS (адреса для запросов)
// ============================================================

// Главная страница — просто проверка что бот жив
app.get('/', (req, res) => {
    res.send('✅ SMS Bot работает');
});

// Статус — можно открыть в браузере и проверить
app.get('/status', (req, res) => {
    res.json({
        status:      'running',
        sentCount:   sentMessages.size,
        isProcessing,
        time:        new Date().toISOString(),
    });
});

// Ручной запуск — можно дёрнуть если хочешь проверить прямо сейчас
app.get('/run', async (req, res) => {
    res.json({ status: 'started' });
    await processSheets();
});

// Игнорируем входящие сообщения в Telegram
bot.on('message', (msg) => {
    if (msg.chat.id.toString() !== TARGET_CHAT_ID.toString()) {
        console.log(`Ignored message from: ${msg.chat.id}`);
    }
});

// Ошибки polling — просто логируем, не падаем
bot.on('polling_error', (err) => {
    console.error(`Polling error: ${err.code} - ${err.message}`);
});

// ============================================================
// ЗАПУСК СЕРВЕРА
// ============================================================
app.listen(PORT, async () => {
    console.log(`🌐 Сервер запущен на порту ${PORT}`);
    console.log(`📊 Статус: https://sms-citric.onrender.com/status`);
    console.log(`▶️  Ручной запуск: https://sms-citric.onrender.com/run`);

    // Первая проверка Sheets через 5 сек после старта
    await sleep(5000);
    await processSheets();

    // Проверяем Sheets каждые 10 секунд
    setInterval(processSheets, 10 * 1000);
    console.log('⏰ Проверка Sheets каждые 10 сек');
});
