require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const express = require('express');

const token = process.env.BOT_TOKEN;
const targetChatId = process.env.TARGET_CHAT_ID;

// Create a bot that uses 'polling' to fetch new updates
const bot = new TelegramBot(token, { polling: true });
const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

console.log('Bot started. Waiting for messages...');

// Barcha xabarlarni qayta ishlash funksiyasi
function processAndSendText(text, source) {
    if (!text) return;
    
    // QATIY SHART: Xabar albatta "Postupil" bilan boshlanishi kerak, bo'lmasa ignor qilinadi
    if (!text.trim().startsWith('Postupil')) {
        console.log(`Ignored message from ${source}: Doesn't start with 'Postupil'.`);
        return;
    }
    
    let processedText = text;
    // If the text contains "Ost:", split it and take the first part
    if (processedText.includes('Ost:')) {
        processedText = processedText.split('Ost:')[0].trim();
        console.log(`Text processed (Ost: removed). Source: ${source}`);
    }

    // Send the processed text to the target group
    if (targetChatId) {
        bot.sendMessage(targetChatId, processedText)
            .then(() => {
                console.log(`Message successfully sent to target chat: ${targetChatId}`);
            })
            .catch((error) => {
                console.error('Error sending message to target chat:', error.message);
            });
    } else {
        console.log('TARGET_CHAT_ID is not configured.');
    }
}

// 1. Telegram orqali kelgan xabarlarni ushlash (Manual xabarlar ignor qilinadi)
bot.on('message', (msg) => {
    const chatId = msg.chat.id;

    // Agar xabar guruhning o'zida yozilgan bo'lsa, uni ignor qilish
    if (chatId.toString() === targetChatId.toString()) {
        return;
    }

    // Botning o'ziga kimdir yozsa ham guruhga yubormaymiz, faqat logda ko'rinadi
    console.log(`Ignored manual message from chat ID: ${chatId}`);
});

// 2. Macrodroid HTTP Webhook orqali yuborgan xabarlarni ushlash
app.all('/macrodroid', (req, res) => {
    // Macrodroid POST yoki GET orqali 'text' parametrida xabarni jo'natadi
    const text = req.body.text || req.query.text;
    
    if (text) {
        processAndSendText(text, 'Macrodroid Webhook');
        res.status(200).send('Xabar qabul qilindi va guruhga yuborildi');
    } else {
        res.status(400).send('Xabar matni topilmadi (text parametri kerak)');
    }
});

// Handle polling errors
bot.on('polling_error', (error) => {
    console.log(`Polling error: ${error.code} - ${error.message}`);
});

// Express serverni ishga tushirish (24/7 ishlashi uchun kerak bo'ladi)
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Express server running on port ${PORT}`);
});
