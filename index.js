require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');

const token = process.env.BOT_TOKEN;
const targetChatId = process.env.TARGET_CHAT_ID;
const sourceChatId = process.env.SOURCE_CHAT_ID;

// Create a bot that uses 'polling' to fetch new updates
const bot = new TelegramBot(token, { polling: true });

console.log('Bot started. Waiting for messages...');

bot.on('message', (msg) => {
    const chatId = msg.chat.id;
    const text = msg.text;

    // Log the incoming message details for debugging
    console.log(`Received message from chat ID: ${chatId}`);

    // If we only want to process messages from a specific source (like Macrodroid)
    // and if there's text in the message
    if ((!sourceChatId || chatId.toString() === sourceChatId.toString()) && text) {
        let processedText = text;

        // If the text contains "Ost:", split it and take the first part
        if (processedText.includes('Ost:')) {
            processedText = processedText.split('Ost:')[0].trim();
            console.log('Text processed (Ost: removed).');
        }

        // Send the processed text to the target group
        if (targetChatId) {
            bot.sendMessage(targetChatId, processedText)
                .then(() => {
                    console.log(`Message successfully sent to target chat: ${targetChatId}`);
                })
                .catch((error) => {
                    console.error('Error sending message to target chat:', error.message);
                    bot.sendMessage(chatId, `Guruhga xabar yuborishda xatolik yuz berdi: ${error.message}\nIltimos, guruh ID sini to'g'riligini va bot guruhda admin ekanligini tekshiring.`);
                });
        } else {
            console.log('TARGET_CHAT_ID is not configured.');
        }
    } else {
        // Option to just debug if it's from another chat
        if (chatId.toString() !== sourceChatId.toString()) {
            console.log(`Ignored message from unauthorized chat ID: ${chatId}`);
            bot.sendMessage(chatId, `Sizning Chat ID raqamingiz: ${chatId}\nBu ID .env faylida SOURCE_CHAT_ID yoki TARGET_CHAT_ID sifatida ishlatilishi mumkin.`);
        }
    }
});

// Handle polling errors
bot.on('polling_error', (error) => {
    console.log(`Polling error: ${error.code} - ${error.message}`);
});
