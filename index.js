require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const express = require('express');
const fs = require('fs');
const path = require('path');

// ============================================================
// КОНФИГ — всё берём из .env
// ============================================================
const BOT_TOKEN        = process.env.BOT_TOKEN;
const TARGET_CHAT_ID   = process.env.TARGET_CHAT_ID;
const GOOGLE_SHEETS_URL = process.env.GOOGLE_SHEETS_URL; // Опционально — только для лога
const PORT             = process.env.PORT || 3000;

const QUEUE_FILE    = path.join(__dirname, 'sms_queue.json');
const SYNC_INTERVAL = 30 * 1000; // Каждые 30 секунд проверяем очередь

if (!BOT_TOKEN || !TARGET_CHAT_ID) {
    console.error('❌ BOT_TOKEN или TARGET_CHAT_ID не найден в .env!');
    process.exit(1);
}

// ============================================================
// TELEGRAM + EXPRESS
// ============================================================
const bot = new TelegramBot(BOT_TOKEN, { polling: true });
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

console.log('🚀 SMS Bot запускается...');

// ============================================================
// ОЧЕРЕДЬ — sms_queue.json (локальное хранилище)
// ============================================================

/** Загружает очередь из файла */
function loadQueue() {
    try {
        if (!fs.existsSync(QUEUE_FILE)) return [];
        const raw = fs.readFileSync(QUEUE_FILE, 'utf8');
        return JSON.parse(raw) || [];
    } catch (e) {
        console.error('❌ Очередь повреждена, сбрасываем:', e.message);
        return [];
    }
}

/** Сохраняет очередь в файл */
function saveQueue(queue) {
    try {
        fs.writeFileSync(QUEUE_FILE, JSON.stringify(queue, null, 2), 'utf8');
    } catch (e) {
        console.error('❌ Не удалось сохранить очередь:', e.message);
    }
}

/** Добавляет SMS в очередь */
function addToQueue(text, sender) {
    const queue = loadQueue();
    const entry = {
        id:        Date.now().toString(),
        timestamp: new Date().toISOString(),
        sender:    sender || 'unknown',
        text:      text,
        status:    'pending',  // pending | sent | ignored
    };
    queue.push(entry);
    saveQueue(queue);
    console.log(`📥 SMS в очереди [всего: ${queue.length}]: "${text.substring(0, 40)}..."`);
    return entry;
}

/** Обновляет статус SMS в очереди */
function updateStatus(id, status) {
    const queue = loadQueue();
    const idx = queue.findIndex(s => s.id === id);
    if (idx !== -1) {
        queue[idx].status = status;
        saveQueue(queue);
    }
}

/** Удаляет отправленные и ignored SMS (оставляет только pending) */
function cleanQueue() {
    const queue = loadQueue();
    const pending = queue.filter(s => s.status === 'pending');
    saveQueue(pending);
    if (queue.length !== pending.length) {
        console.log(`🧹 Очередь очищена: удалено ${queue.length - pending.length} отправленных`);
    }
}

// ============================================================
// ФИЛЬТР SMS
// ============================================================

/**
 * Проверяет текст SMS:
 * - Должен начинаться с "Postupil" (без учёта регистра)
 * - Обрезает всё после "Ost:"
 * @returns {string|null} — обработанный текст или null если не подходит
 */
function processText(text) {
    if (!text) return null;

    if (!text.trim().toLowerCase().startsWith('postupil')) {
        console.log('⏭️  Ignored: не начинается с "Postupil"');
        return null;
    }

    // Убираем "Ost:" и всё что после
    if (text.includes('Ost:')) {
        text = text.split('Ost:')[0].trim();
    }

    return text;
}

// ============================================================
// ПРОВЕРКА ИНТЕРНЕТА
// ============================================================

/** Пингует Telegram API — быстрая проверка интернета */
async function isInternetAvailable() {
    try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 5000);
        await fetch('https://api.telegram.org', {
            method: 'HEAD',
            signal: controller.signal,
        });
        clearTimeout(timer);
        return true;
    } catch {
        return false;
    }
}

// ============================================================
// ОТПРАВКА В TELEGRAM
// ============================================================
async function sendToTelegram(text) {
    await bot.sendMessage(TARGET_CHAT_ID, text);
}

// ============================================================
// ЛОГ В GOOGLE SHEETS (опционально, не критично)
// Вызывается ПОСЛЕ успешной отправки в Telegram
// ============================================================
async function logToSheets(sms) {
    if (!GOOGLE_SHEETS_URL) return;
    try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 8000);
        await fetch(GOOGLE_SHEETS_URL, {
            method: 'POST',
            redirect: 'follow',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                text:   sms.processedText,
                sender: sms.sender,
                time:   sms.timestamp,
            }),
            signal: controller.signal,
        });
        clearTimeout(timer);
    } catch (e) {
        // Не критично — SMS уже доставлена в Telegram
        console.warn('⚠️  Google Sheets лог не удался (не критично):', e.message);
    }
}

// ============================================================
// СИНХРОНИЗАТОР — главное сердце бота
// Запускается каждые 30 сек и при получении нового SMS
// ============================================================
let isSyncing = false;

async function syncQueue() {
    if (isSyncing) return; // Не запускаем параллельно

    const queue   = loadQueue();
    const pending = queue.filter(s => s.status === 'pending');

    if (pending.length === 0) return; // Нечего отправлять

    // Проверяем интернет
    const online = await isInternetAvailable();
    if (!online) {
        console.log(`⏳ Нет интернета. В очереди ждут: ${pending.length} SMS`);
        return;
    }

    isSyncing = true;
    console.log(`📤 Начинаем синхронизацию: ${pending.length} SMS...`);

    // Сортируем по времени — сначала старые
    pending.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

    let sentCount    = 0;
    let ignoredCount = 0;

    for (const sms of pending) {
        const processedText = processText(sms.text);

        // SMS не прошёл фильтр
        if (!processedText) {
            updateStatus(sms.id, 'ignored');
            ignoredCount++;
            continue;
        }

        // Пробуем отправить (до 3 попыток)
        let sent = false;
        for (let attempt = 1; attempt <= 3; attempt++) {
            try {
                await sendToTelegram(processedText);
                updateStatus(sms.id, 'sent');
                sentCount++;

                // Логируем в Sheets (не ждём результата)
                logToSheets({ ...sms, processedText });

                console.log(`✅ Отправлено [${sms.timestamp}]: "${processedText.substring(0, 50)}"`);
                sent = true;

                // Пауза 2 сек — защита от Telegram rate limit (30 msg/сек)
                await new Promise(r => setTimeout(r, 2000));
                break;

            } catch (err) {
                // Telegram rate limit (429) — ждём сколько скажут
                if (err.message?.includes('429')) {
                    const match    = err.message.match(/retry after (\d+)/);
                    const waitSec  = parseInt(match?.[1] || '30') + 1;
                    console.warn(`⏳ Telegram rate limit. Жду ${waitSec} сек...`);
                    await new Promise(r => setTimeout(r, waitSec * 1000));
                } else {
                    console.error(`❌ Попытка ${attempt}/3 провалилась: ${err.message}`);
                    await new Promise(r => setTimeout(r, 3000));
                }
            }
        }

        // Если не отправили — остаётся pending, попробуем в следующий раз
        if (!sent) {
            console.warn(`⚠️  SMS остался в очереди: ${sms.id}`);
        }
    }

    // Удаляем отправленные и ignored
    cleanQueue();

    const stillPending = loadQueue().filter(s => s.status === 'pending').length;
    console.log(`📊 Итог: ✅ ${sentCount} отправлено | ⏭️ ${ignoredCount} проигнорировано | ⏳ ${stillPending} в очереди`);

    isSyncing = false;
}

// ============================================================
// ENDPOINT: MacroDroid → POST /sms
// MacroDroid делает локальный запрос — интернет НЕ НУЖЕН
// ============================================================
app.post('/sms', (req, res) => {
    const text   = req.body.text   || req.query.text;
    const sender = req.body.sender || req.query.sender || 'unknown';

    if (!text) {
        return res.status(400).json({ error: 'text required' });
    }

    console.log(`📨 Новый SMS от MacroDroid (${sender}): "${text.substring(0, 50)}"`);

    // Сохраняем локально (работает без интернета!)
    addToQueue(text, sender);

    // Пробуем отправить сразу (если есть интернет)
    setTimeout(syncQueue, 1000);

    res.status(200).json({ status: 'queued', message: 'SMS сохранён в очередь' });
});

// ============================================================
// STATUS ENDPOINT — для мониторинга
// ============================================================
app.get('/status', (req, res) => {
    const queue   = loadQueue();
    const pending = queue.filter(s => s.status === 'pending');
    res.json({
        status:   'running',
        pending:  pending.length,
        total:    queue.length,
        syncEvery: `${SYNC_INTERVAL / 1000} сек`,
        sheetsLog: GOOGLE_SHEETS_URL ? 'включён' : 'выключен',
    });
});

// Health check
app.get('/', (req, res) => res.send('✅ SMS Bot работает'));

// ============================================================
// TELEGRAM: игнорируем входящие сообщения
// ============================================================
bot.on('message', (msg) => {
    if (msg.chat.id.toString() !== TARGET_CHAT_ID.toString()) {
        console.log(`Ignored incoming from chat: ${msg.chat.id}`);
    }
});

bot.on('polling_error', (err) => {
    console.error(`Polling error: ${err.code} - ${err.message}`);
});

// ============================================================
// ЗАПУСК СЕРВЕРА
// ============================================================
app.listen(PORT, () => {
    console.log(`🌐 Сервер запущен: http://localhost:${PORT}`);
    console.log(`📊 Status: GET http://localhost:${PORT}/status`);
    console.log(`📨 MacroDroid endpoint: POST http://localhost:${PORT}/sms`);

    // Первая синхронизация через 5 сек после запуска
    setTimeout(syncQueue, 5000);

    // Периодическая синхронизация
    setInterval(syncQueue, SYNC_INTERVAL);
    console.log(`⏰ Синхронизация каждые ${SYNC_INTERVAL / 1000} сек`);
});
