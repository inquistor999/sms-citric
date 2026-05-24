require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const express = require('express');
const fs = require('fs');
const path = require('path');

const token = process.env.BOT_TOKEN;
const targetChatId = process.env.TARGET_CHAT_ID;

// SMS Queue fayli — server restart bo'lsa ham yo'qolmaydi
const QUEUE_FILE = path.join(__dirname, 'sms_queue.json');

// Yozish vaqtida concurrency muammolarining oldini olish uchun in-memory array ishlatamiz
let activeQueue = [];

// Boshlang'ich yuklash
function initQueue() {
    try {
        if (fs.existsSync(QUEUE_FILE)) {
            const data = fs.readFileSync(QUEUE_FILE, 'utf8');
            activeQueue = JSON.parse(data);
            console.log(`[QUEUE] Kutish fayli muvaffaqiyatli yuklandi. Navbatda ${activeQueue.length} ta xabar bor.`);
        }
    } catch (e) {
        console.error('Queue faylini o\'qishda xato:', e.message);
        activeQueue = [];
    }
}

// Queue'ni faylga yozish
function persistQueue() {
    try {
        fs.writeFileSync(QUEUE_FILE, JSON.stringify(activeQueue, null, 2), 'utf8');
    } catch (e) {
        console.error('Queue faylini saqlashda xato:', e.message);
    }
}

// SMS ni queue'ga qo'shish
function addToQueue(text, source) {
    const smsEntry = {
        id: Date.now() + '_' + Math.random().toString(36).substr(2, 5),
        text: text,
        source: source,
        receivedAt: new Date().toISOString(),
        attempts: 0
    };
    activeQueue.push(smsEntry);
    persistQueue();
    console.log(`[QUEUE] SMS qo'shildi. Queue hajmi: ${activeQueue.length}. ID: ${smsEntry.id}`);
    return smsEntry;
}

// Queue'dan SMS ni o'chirish
function removeFromQueue(id) {
    activeQueue = activeQueue.filter(item => item.id !== id);
    persistQueue();
}

// Create a bot that uses 'polling' to fetch new updates
const bot = new TelegramBot(token, { polling: true });
const app = express();

// Helper: check if Telegram API is reachable (i.e., internet from server side)
async function isTelegramReachable() {
  try {
    await bot.getMe(); // simple API call, throws if no connectivity
    return true;
  } catch (e) {
    console.warn('Telegram API unreachable – will retry later');
    return false;
  }
}

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Queue initialization
initQueue();

console.log('Bot ishga tushdi. SMS Queue tizimi yoqildi...');

// Xabarni qayta ishlash va Telegram guruhga yuborish
function processText(text) {
    if (!text) return null;

    // QATIY SHART: Xabar albatta "Postupil" bilan boshlanishi kerak
    if (!text.trim().startsWith('Postupil')) {
        console.log(`Ignored: "Postupil" bilan boshlanmagan.`);
        return null;
    }

    let processedText = text;
    // "Ost:" dan keyingi qismni o'chirish
    if (processedText.includes('Ost:')) {
        processedText = processedText.split('Ost:')[0].trim();
    }

    return processedText;
}

// Telegram guruhga yuborish (Promise qaytaradi)
function sendToTelegram(text) {
    return bot.sendMessage(targetChatId, text);
}

// ============================
// QUEUE PROCESSOR — har 20 soniyada ishga tushadi
// ============================
let isProcessing = false;

async function processQueue() {
    if (isProcessing) return; // Parallel ishlamasligi uchun
    
    // Telegram reachable ekanini tekshiramiz
    const reachable = await isTelegramReachable();
    if (!reachable) return;

    if (activeQueue.length === 0) return;

    isProcessing = true;
    console.log(`[QUEUE] ${activeQueue.length} ta SMS navbatda. Yuborilmoqda...`);

    // Array nusxasini olamiz, chunki sikl davomida elementlar o'chadi
    const queueCopy = [...activeQueue];

    for (const smsEntry of queueCopy) {
        const processedText = processText(smsEntry.text);
        
        if (!processedText) {
            // Yaroqsiz SMS — queue'dan o'chirib tashlash
            removeFromQueue(smsEntry.id);
            console.log(`[QUEUE] Yaroqsiz SMS o'chirildi: ${smsEntry.id}`);
            continue;
        }

        try {
            await sendToTelegram(processedText);
            removeFromQueue(smsEntry.id);
            console.log(`[QUEUE] ✅ SMS muvaffaqiyatli yuborildi va queue'dan o'chirildi: ${smsEntry.id}`);
            console.log(`[QUEUE] SMS qabul qilingan vaqt: ${smsEntry.receivedAt}`);
            
            // Ketma-ketlikda yuborish uchun 1 soniya kutish
            await new Promise(resolve => setTimeout(resolve, 1000));
            
        } catch (error) {
            console.error(`[QUEUE] ❌ SMS yuborishda xato (${smsEntry.id}): ${error.message}`);
            // attempts sonini oshirish
            const idx = activeQueue.findIndex(q => q.id === smsEntry.id);
            if (idx !== -1) {
                activeQueue[idx].attempts += 1;
                activeQueue[idx].lastAttempt = new Date().toISOString();
                persistQueue();
            }
            break; // Xato bo'lsa keyingilarni kutishni to'xtatamiz
        }
    }

    isProcessing = false;
}

// Har 20 soniyada queue'ni tekshirish
setInterval(processQueue, 20000);

// Server ishga tushganda ham bir marta tekshirish (restart bo'lsa avvalgi SMS lar yuboriladi)
setTimeout(processQueue, 3000);

// ============================
// 1. Telegram xabarlarni ushlash (guruh va bot ga yozilganlar ignor)
// ============================
bot.on('message', (msg) => {
    const chatId = msg.chat.id;

    if (chatId.toString() === targetChatId.toString()) {
        return; // Guruhda yozilgan — ignor
    }

    console.log(`Ignored manual message from chat ID: ${chatId}`);
});

// ============================
// 2. MacroDroid Webhook — SMS qabul qilish
// ============================
app.all('/macrodroid', (req, res) => {
    const text = req.body.text || req.query.text;

    if (!text) {
        return res.status(400).send('Xabar matni topilmadi (text parametri kerak)');
    }

    // Har doim queue'ga qo'shamiz, hatto internet bo'lsa ham (concurrency-safe arrayga)
    const smsEntry = addToQueue(text, 'MacroDroid');

    // Darhol yuborishga urinish – faqat Telegram reachable bo'lsa
    const processedText = processText(text);
    if (processedText) {
        isTelegramReachable().then((ok) => {
            if (!ok) {
                // Internet yo'q, qoldiq queue'da qoladi
                return res.status(200).send('SMS qabul qilindi, lekin internet yoq, keyin yuboriladi');
            }
            sendToTelegram(processedText)
                .then(() => {
                    removeFromQueue(smsEntry.id);
                    console.log(`[DIRECT] ✅ SMS bevosita yuborildi: ${smsEntry.id}`);
                    res.status(200).send('SMS qabul qilindi va guruhga yuborildi');
                })
                .catch((error) => {
                    console.error(`[DIRECT] ❌ Bevosita yuborishda xato, queue'da qoladi: ${error.message}`);
                    res.status(200).send('SMS qabul qilindi, lekin yuborishda xato – keyin qayta uriniladi');
                });
        });
    } else {
        // "Postupil" bilan boshlanmagan — queue'dan o'chirib tashlash
        removeFromQueue(smsEntry.id);
        res.status(200).send('SMS qabul qilindi lekin filtrdan o\'tmadi (Postupil bilan boshlanmagan)');
    }
});

// ============================
// 3. Queue holati ko'rish (monitoring uchun)
// ============================
app.get('/queue', (req, res) => {
    res.json({
        queueCount: activeQueue.length,
        queue: activeQueue
    });
});

// Polling xatolarini ushlash
bot.on('polling_error', (error) => {
    console.log(`Polling error: ${error.code} - ${error.message}`);
});

// Express server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Express server ishga tushdi: port ${PORT}`);
    console.log(`Queue holati: GET /queue`);
});
