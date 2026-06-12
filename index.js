require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const express = require('express');

const token = process.env.BOT_TOKEN;
const targetChatId = process.env.TARGET_CHAT_ID;
const googleSheetsUrl = process.env.GOOGLE_SHEETS_URL;

// Google Sheets URL tekshirish
if (!googleSheetsUrl) {
    console.error('❌ GOOGLE_SHEETS_URL .env faylda topilmadi!');
    console.error('Google Apps Script Web App URL ni .env faylga qo\'shing.');
    process.exit(1);
}

// Create a bot that uses 'polling' to fetch new updates
const bot = new TelegramBot(token, { polling: true });
const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

console.log('🚀 Bot ishga tushdi. Google Sheets polling tizimi yoqildi...');
console.log(`📊 Google Sheets URL: ${googleSheetsUrl.substring(0, 60)}...`);

// ============================
// Helper: Telegram API ga ulanish tekshirish
// ============================
async function isTelegramReachable() {
    try {
        await bot.getMe();
        return true;
    } catch (e) {
        console.warn('⚠️ Telegram API unreachable – keyinroq qayta uriniladi');
        return false;
    }
}

// ============================
// Xabarni qayta ishlash (Postupil filtri + Ost: ni o'chirish)
// ============================
function processText(text) {
    if (!text) return null;

    // QATIY SHART: Xabar albatta "Postupil" bilan boshlanishi kerak
    if (!text.trim().startsWith('Postupil')) {
        console.log(`⏭️ Ignored: "Postupil" bilan boshlanmagan.`);
        return null;
    }

    let processedText = text;
    // "Ost:" dan keyingi qismni o'chirish
    if (processedText.includes('Ost:')) {
        processedText = processedText.split('Ost:')[0].trim();
    }

    return processedText;
}

// ============================
// Google Sheets dan SMS larni olish va tozalash
// ============================
async function fetchAndClearFromGoogleSheets() {
    try {
        const url = `${googleSheetsUrl}?action=readAndClear`;
        const response = await fetch(url, {
            method: 'GET',
            redirect: 'follow' // Google Apps Script redirect qiladi
        });

        if (!response.ok) {
            console.error(`❌ Google Sheets dan o'qishda xato: HTTP ${response.status}`);
            return [];
        }

        const result = await response.json();

        if (result.status === 'success' && result.count > 0) {
            console.log(`📥 Google Sheets dan ${result.count} ta SMS olindi`);
            return result.data;
        }

        return [];
    } catch (error) {
        console.error(`❌ Google Sheets ga ulanishda xato: ${error.message}`);
        return [];
    }
}

// ============================
// Telegram guruhga yuborish
// ============================
function sendToTelegram(text) {
    return bot.sendMessage(targetChatId, text);
}

// ============================
// ASOSIY PROCESSOR — Google Sheets dan o'qib, guruhga yuborish
// ============================
let isProcessing = false;

async function processGoogleSheets() {
    if (isProcessing) return; // Parallel ishlamasligi uchun

    // Telegram reachable ekanini tekshiramiz
    const reachable = await isTelegramReachable();
    if (!reachable) {
        console.log('⏳ Telegram unreachable — Google Sheets dagi SMS lar saqlanib qoladi');
        return;
    }

    isProcessing = true;

    try {
        // Google Sheets dan barcha SMS larni olish (va Sheet ni tozalash)
        const smsList = await fetchAndClearFromGoogleSheets();

        if (smsList.length === 0) {
            isProcessing = false;
            return;
        }

        // SMS larni vaqti bo'yicha saralash (eng eskisidan yangisiga qarab)
        // Shunda internet o'chganda yig'ilib qolgan SMS lar ketma-ketlikda yuboriladi
        smsList.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

        console.log(`📤 ${smsList.length} ta SMS guruhga yuborilmoqda...`);

        let sentCount = 0;
        let failedMessages = [];

        for (const sms of smsList) {
            const processedText = processText(sms.text);

            if (!processedText) {
                console.log(`⏭️ SMS filtrdan o'tmadi (Postupil bilan boshlanmagan)`);
                continue;
            }

            let success = false;
            let retries = 0;
            
            while (!success && retries < 3) {
                try {
                    await sendToTelegram(processedText);
                    success = true;
                    sentCount++;
                    console.log(`✅ SMS yuborildi [${sms.timestamp}]: "${processedText.substring(0, 50)}..."`);

                    // Ketma-ketlikda yuborish uchun 2000ms kutish (Telegram limitlariga tushmaslik uchun)
                    await new Promise(resolve => setTimeout(resolve, 2000));

                } catch (error) {
                    if (error.message && error.message.includes('429')) {
                        const match = error.message.match(/retry after (\d+)/);
                        const retryAfter = match ? parseInt(match[1], 10) : 30;
                        console.warn(`⏳ Telegram API blokladi (429). Bot ${retryAfter} soniya kutmoqda...`);
                        await new Promise(resolve => setTimeout(resolve, (retryAfter * 1000) + 1000));
                        retries++;
                    } else {
                        console.error(`❌ SMS yuborishda xato: ${error.message}`);
                        break;
                    }
                }
            }

            if (!success) {
                failedMessages.push(sms);
            }
        }

        // Agar yuborilmagan SMS lar bo'lsa — qayta Google Sheets ga yozish
        if (failedMessages.length > 0) {
            console.log(`⚠️ ${failedMessages.length} ta SMS yuborilmadi — Google Sheets ga qayta yozilmoqda...`);
            for (const failedSms of failedMessages) {
                await writeToGoogleSheets(failedSms.text, failedSms.sender || 'retry');
            }
        }

        console.log(`📊 Natija: ${sentCount} ta yuborildi, ${failedMessages.length} ta qayta navbatga qo'shildi`);

    } catch (error) {
        console.error(`❌ Processor xato: ${error.message}`);
    }

    isProcessing = false;
}

// ============================
// Yuborilmagan SMS larni qayta Google Sheets ga yozish
// ============================
async function writeToGoogleSheets(text, sender) {
    try {
        const response = await fetch(googleSheetsUrl, {
            method: 'POST',
            redirect: 'follow',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                text: text,
                sender: sender || 'bot-retry'
            })
        });

        if (!response.ok) {
            console.error(`❌ Google Sheets ga yozishda xato: HTTP ${response.status}`);
        }
    } catch (error) {
        console.error(`❌ Google Sheets ga yozishda xato: ${error.message}`);
    }
}

// ============================
// Har 10 soniyada Google Sheets ni tekshirish
// ============================
const POLL_INTERVAL = 10000; // 10 soniya
// setInterval(processGoogleSheets, POLL_INTERVAL); // VAQTINCHA PAUZA QILINDI

// Server ishga tushganda 5 soniyadan keyin birinchi tekshirish
// setTimeout(processGoogleSheets, 5000); // VAQTINCHA PAUZA QILINDI

console.log(`⏰ Google Sheets tekshiruvi vaqtincha PAUZADA`);

// ============================
// Telegram xabarlarni ushlash (guruh va bot ga yozilganlar ignor)
// ============================
bot.on('message', (msg) => {
    const chatId = msg.chat.id;

    if (chatId.toString() === targetChatId.toString()) {
        return; // Guruhda yozilgan — ignor
    }

    console.log(`Ignored manual message from chat ID: ${chatId}`);
});

// ============================
// MacroDroid Webhook — zaxira endpoint (eski usul ham ishlaydi)
// ============================
app.all('/macrodroid', async (req, res) => {
    const text = req.body.text || req.query.text;

    if (!text) {
        return res.status(400).send('Xabar matni topilmadi (text parametri kerak)');
    }

    console.log(`[WEBHOOK] Yangi SMS keldi: "${text.substring(0, 50)}..."`);

    // Filtrdan o'tkazish
    const processedText = processText(text);
    if (!processedText) {
        console.log(`[WEBHOOK] SMS filtrdan o'tmadi (Postupil bilan boshlanmagan)`);
        return res.status(200).send('SMS qabul qilindi lekin filtrdan o\'tmadi');
    }

    // Google Sheets ga yozamiz (zaxira yo'l orqali)
    await writeToGoogleSheets(text, 'MacroDroid-webhook');

    res.status(200).send('SMS qabul qilindi va Google Sheets ga yozildi');

    // Darhol processor ni ishga tushiramiz
    setTimeout(processGoogleSheets, 2000);
});

// ============================
// Status endpoint — monitoring uchun
// ============================
app.get('/status', async (req, res) => {
    try {
        const url = `${googleSheetsUrl}?action=read`;
        const response = await fetch(url, { method: 'GET', redirect: 'follow' });
        const result = await response.json();

        res.json({
            botStatus: 'running',
            googleSheetsConnected: true,
            pendingSMS: result.count || 0,
            pollInterval: `${POLL_INTERVAL / 1000} soniya`,
            smsList: result.data || []
        });
    } catch (error) {
        res.json({
            botStatus: 'running',
            googleSheetsConnected: false,
            error: error.message
        });
    }
});

// ============================
// Health check
// ============================
app.get('/', (req, res) => {
    res.send('✅ SMS Bot ishlayapti — Google Sheets rejimida');
});

// Polling xatolarini ushlash
bot.on('polling_error', (error) => {
    console.log(`Polling error: ${error.code} - ${error.message}`);
});

// Express server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🌐 Express server ishga tushdi: port ${PORT}`);
    console.log(`📊 Status: GET /status`);
    console.log(`💚 Health: GET /`);
});
