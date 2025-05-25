// app.js

// Загружаем переменные окружения из .env файла (для локальной разработки).
require('dotenv').config();

// Импортируем необходимые библиотеки
const { Telegraf } = require('telegraf');
const express = require('express');

// 1. Получаем токен бота из переменной окружения
const token = process.env.TELEGRAM_BOT_TOKEN;

// 2. Проверяем наличие токена
if (!token) {
    console.error('Ошибка: Переменная окружения TELEGRAM_BOT_TOKEN не установлена.');
    console.error('Пожалуйста, установите TELEGRAM_BOT_TOKEN в переменных окружения Render или в локальном файле .env');
    process.exit(1);
}

// 3. Инициализируем экземпляр бота Telegraf
const bot = new Telegraf(token);

// 4. Определяем УНИВЕРСАЛЬНЫЙ обработчик для ВСЕХ входящих сообщений ('message').
// Этот обработчик будет вызван для любого типа сообщения (текст, фото, видео и т.д.).
bot.on('message', async (ctx) => {
  // Логируем получение любого сообщения
  console.log(`Получено сообщение типа: ${ctx.update.message.chat.type} от ${ctx.from.first_name || ctx.from.username}`);

  try {
    // Проверяем, какой тип контента содержится в сообщении, и отправляем его обратно.
    // Проверяем специфичные типы первыми.
    if (ctx.message.photo) {
      // Для фото Telegraf предоставляет массив объектов PhotoSize.
      // Последний элемент обычно имеет самое высокое разрешение.
      const photoId = ctx.message.photo[ctx.message.photo.length - 1].file_id;
      const caption = ctx.message.caption;
      console.log(`Повторяем фото (ID: ${photoId}) с подписью: "${caption || ''}"`);
      await ctx.replyWithPhoto(photoId, { caption: caption });

    } else if (ctx.message.video) {
      const videoId = ctx.message.video.file_id;
      const caption = ctx.message.caption;
      console.log(`Повторяем видео (ID: ${videoId}) с подписью: "${caption || ''}"`);
      await ctx.replyWithVideo(videoId, { caption: caption });

    } else if (ctx.message.audio) {
      const audioId = ctx.message.audio.file_id;
      const caption = ctx.message.caption;
      console.log(`Повторяем аудио (ID: ${audioId}) с подписью: "${caption || ''}"`);
      await ctx.replyWithAudio(audioId, { caption: caption });

    } else if (ctx.message.document) {
      const documentId = ctx.message.document.file_id;
      const caption = ctx.message.caption;
       console.log(`Повторяем документ (ID: ${documentId}) с подписью: "${caption || ''}"`);
      await ctx.replyWithDocument(documentId, { caption: caption });

    } else if (ctx.message.sticker) {
      const stickerId = ctx.message.sticker.file_id;
      console.log(`Повторяем стикер (ID: ${stickerId})`);
      await ctx.replyWithSticker(stickerId);

    } else if (ctx.message.animation) {
        const animationId = ctx.message.animation.file_id;
        const caption = ctx.message.caption;
        console.log(`Повторяем анимацию (ID: ${animationId}) с подписью: "${caption || ''}"`);
        await ctx.replyWithAnimation(animationId, { caption: caption });

    } else if (ctx.message.voice) {
        const voiceId = ctx.message.voice.file_id;
        console.log(`Повторяем голосовое сообщение (ID: ${voiceId})`);
        await ctx.replyWithVoice(voiceId);

    } else if (ctx.message.video_note) {
        const videoNoteId = ctx.message.video_note.file_id;
        console.log(`Повторяем видео-сообщение (ID: ${videoNoteId})`);
        await ctx.replyWithVideoNote(videoNoteId);

    } else if (ctx.message.text) {
      // Если это обычный текст, повторяем его.
      console.log(`Повторяем текст: "${ctx.message.text}"`);
      await ctx.reply(ctx.message.text);

    } else {
      // Обработка других типов сообщений, которые мы пока не обрабатываем явно.
      console.log('Получено сообщение необрабатываемого типа:', ctx.message);
      // Опционально, можно отправить пользователю сообщение о том, что тип не поддерживается:
      // await ctx.reply('Извините, я пока умею повторять только текст и медиафайлы.');
    }

  } catch (error) {
    console.error('Ошибка при обработке и повторении сообщения:', error);
    // Опционально, можно уведомить пользователя об ошибке
    // await ctx.reply('Произошла ошибка при обработке вашего сообщения.');
  }
});

// ------------------------------------------------------------
// 5. Настройка веб-сервера Express для обработки вебхуков
// ------------------------------------------------------------

const app = express();
const port = process.env.PORT || 3000;

app.use(express.json());

app.post('/webhook', (req, res) => {
    bot.handleUpdate(req.body);
    res.sendStatus(200); // Отправляем 200 OK в ответ на запрос Telegram
});

// Корневой эндпоинт для проверки статуса
app.get('/', (req, res) => {
  res.send('Telegram Echo Bot server is running and waiting for webhooks at /webhook.');
});

// ------------------------------------------------------------
// 6. Запуск веб-сервера
// ------------------------------------------------------------

app.listen(port, () => {
  console.log(`Сервер запущен на порту ${port}`);
  console.log(`Эндпоинт для вебхуков настроен по пути: /webhook`);
  console.log(`Токен бота загружен: ${token ? 'Да' : 'Нет'}`);
  console.log('Ожидание входящих вебхуков от Telegram...');
});

// В режиме вебхуков НЕ вызываем bot.launch()