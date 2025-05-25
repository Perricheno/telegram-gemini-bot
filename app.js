// app.js

// Загружаем переменные окружения из .env файла.
// Эта строка должна быть самой первой в файле, чтобы переменные были доступны сразу.
require('dotenv').config();

// --- Импорт необходимых библиотек ---
const { Telegraf, session } = require('telegraf');
const express = require('express');
const axios = require('axios'); // Используется для скачивания файлов из Telegram
const { GoogleGenerativeAI, HarmCategory, HarmBlockThreshold } = require('@google/generative-ai');

// --- Инициализация API ключей и клиентов ---
// Получаем токен Telegram бота из переменной окружения
const telegramToken = process.env.TELEGRAM_BOT_TOKEN;
// Получаем API ключ Gemini из переменной окружения
const geminiApiKey = process.env.GEMINI_API_KEY;

// Проверка, установлены ли необходимые токены/ключи
if (!telegramToken) {
    console.error('Ошибка: Переменная окружения TELEGRAM_BOT_TOKEN не установлена.');
    process.exit(1); // Завершаем процесс, если токен Telegram отсутствует
}
if (!geminiApiKey) {
    console.error('Ошибка: Переменная окружения GEMINI_API_KEY не установлена.');
    console.error('Пожалуйста, установите GEMINI_API_KEY в переменных окружения Render или в локальном файле .env');
    process.exit(1); // Завершаем процесс, если ключ Gemini отсутствует
}

// Инициализируем экземпляр бота Telegraf
const bot = new Telegraf(telegramToken);

// Инициализируем клиент Google Generative AI
const genAI = new GoogleGenerativeAI(geminiApiKey);
// Получаем клиент FileService для работы с Gemini File API (загрузка файлов)
// *** ИСПРАВЛЕНИЕ: ПРАВИЛЬНЫЙ СПОСОБ ПОЛУЧЕНИЯ FILESERVICE ***
const fileService = genAI.get.fileService;

// --- Управление сессиями Telegraf ---
// Используем встроенное в Telegraf управление сессиями.
// В данном примере используется in-memory хранилище, что удобно для быстрой разработки.
// Для продакшена РЕКОМЕНДУЕТСЯ использовать ПЕРСИСТЕНТНОЕ хранилище (например, Redis, MongoDB),
// чтобы данные сессий (история чата, настройки) сохранялись между перезапусками бота.
bot.use(session({ property: 'session' }));

// Middleware для инициализации значений сессии по умолчанию, если они отсутствуют
bot.use((ctx, next) => {
    // Проверяем, что сессия существует и является объектом (или инициализируем ее)
    if (!ctx.session || typeof ctx.session !== 'object') {
        ctx.session = {
            history: [], // История диалога с Gemini
            systemInstruction: null, // Системные инструкции для Gemini
            model: 'gemini-1.5-pro-latest', // Модель Gemini по умолчанию (Pro-версии лучше для мультимодальности)
            tools: {
                urlContext: false, // Флаг для инструмента URL Context (может быть устаревшим/специфичным)
                googleSearch: true, // Флаг для инструмента Заземления (Google Search), включен по умолчанию
            },
            talkMode: true, // Флаг для режима "Думаю..."
            totalTokens: 0, // Счетчик использованных токенов
            lastMessageTime: Date.now(), // Время последнего сообщения для отслеживания активности
        };
        console.log(`Session initialized for user ${ctx.from.id}`);
    }
    // Обновляем время последнего сообщения при каждом взаимодействии
    ctx.session.lastMessageTime = Date.now();
    next(); // Передаем управление следующему middleware
});

// --- Конфигурация моделей Gemini ---
// Список доступных моделей Gemini с примечаниями об их возможностях
const AVAILABLE_MODELS = {
    'flash-04-17': 'gemini-2.5-flash-preview-04-17', // Preview, хорошо для базовой мультимодальности
    'flash-05-20': 'gemini-2.5-flash-preview-05-20', // Preview, хорошо для базовой мультимодальности
    'pro-05-06': 'gemini-2.5-pro-preview-05-06',   // Preview, вероятно, сильная мультимодальность (поддержка File API)
    'flash-2.0': 'gemini-2.0-flash',              // Старее, поддержка мультимодальности менее надежна для сложных файлов
    'flash-lite-2.0': 'gemini-2.0-flash-lite',    // Старее, вероятно, ограниченная мультимодальность
    'image-gen-2.0': 'gemini-2.0-flash-preview-image-generation', // ВНИМАНИЕ: ТОЛЬКО для генерации изображений, не для чата
    'flash-latest': 'gemini-1.5-flash-latest',    // Стабильная, хороша для изображений + текста
    'pro-latest': 'gemini-1.5-pro-latest'         // Стабильная, ЛУЧШЕ всего для PDF, длинного видео/аудио через File API
};

// Псевдонимы для моделей, чтобы пользователям было удобнее их выбирать
const MODEL_ALIASES = {
    '04-17': 'flash-04-17',
    '05-20': 'flash-05-20',
    'pro-05-06': 'pro-05-06',
    'flash': 'flash-2.0',
    'flash-lite': 'flash-lite-2.0',
    'image-gen': 'image-gen-2.0',
    'latest-flash': 'flash-latest',
    'latest-pro': 'pro-latest',
    'default': 'pro-latest', // Модель по умолчанию для удобства
    'flash1.5': 'flash-latest',
    'pro1.5': 'pro-latest',
    'flash2.5': 'flash-05-20', // Псевдоним для последней 2.5 Flash preview
    'pro2.5': 'pro-05-06' // Псевдоним для последней 2.5 Pro preview
};

// --- Вспомогательные функции для работы с файлами ---

/**
 * Скачивает файл из Telegram по fileId и возвращает его как Buffer.
 * @param {string} fileId - ID файла в Telegram.
 * @returns {Promise<Buffer|null>} Буфер с данными файла или null в случае ошибки.
 */
async function downloadFileBuffer(fileId) {
    try {
        const fileUrl = await bot.telegram.getFileLink(fileId); // Получаем прямую ссылку на файл
        const response = await axios({
            url: fileUrl.href,
            method: 'GET',
            responseType: 'arraybuffer' // Получаем данные как ArrayBuffer
        });
        return Buffer.from(response.data); // Конвертируем ArrayBuffer в Node.js Buffer
    } catch (error) {
        console.error(`Error downloading file (ID: ${fileId}):`, error);
        return null;
    }
}

/**
 * Скачивает файл из Telegram по fileId и возвращает его Base64 представление с определением mime-типа.
 * Используется в основном для inline_data (изображений).
 * @param {string} fileId - ID файла в Telegram.
 * @returns {Promise<{data: string, mimeType: string}|null>} Объект с Base64 данными и mime-типом, или null.
 */
async function downloadFileAsBase64(fileId) {
    try {
        const fileUrl = await bot.telegram.getFileLink(fileId);
        const response = await axios({
            url: fileUrl.href,
            method: 'GET',
            responseType: 'arraybuffer'
        });

        const buffer = Buffer.from(response.data);
        let mimeType = 'application/octet-stream'; // Тип по умолчанию

        // Базовое определение mime-типа по "магическим числам" (сигнатуре файла)
        if (buffer.length >= 4) {
             const signature = buffer.subarray(0, 4).toString('hex').toUpperCase();
             if (signature === '89504E47') mimeType = 'image/png'; // PNG
             else if (signature === '47494638') mimeType = 'image/gif'; // GIF
             else if (signature.startsWith('FFD8FF')) mimeType = 'image/jpeg'; // JPEG
             else if (signature.startsWith('52494646') && buffer.subarray(8, 12).toString('hex').toUpperCase() === '57454250') mimeType = 'image/webp'; // WebP
        }

        const base64 = buffer.toString('base64');
        return { data: base64, mimeType: mimeType };
    } catch (error) {
        console.error(`Error downloading or converting file (ID: ${fileId}) to Base64:`, error);
        return null;
    }
}

/**
 * Загружает буфер файла в Gemini File API.
 * @param {Buffer} buffer - Буфер с данными файла.
 * @param {string} mimeType - MIME-тип файла (например, 'application/pdf', 'video/mp4').
 * @param {string} fileName - Имя файла для отображения.
 * @returns {Promise<Object|null>} Объект файла от Gemini API (содержит 'name' - FID и 'uri'), или null.
 */
async function uploadFileToGemini(buffer, mimeType, fileName) {
    if (!buffer || !mimeType || !fileName) {
        console.error('Missing buffer, mimeType, or fileName for Gemini upload.');
        return null;
    }
     console.log(`Attempting to upload file "${fileName}" (${mimeType}) to Gemini File API...`);
    try {
        const uploadResult = await fileService.uploadFile(buffer, {
             mimeType: mimeType,
             displayName: fileName, // Отображаемое имя в Gemini API
        });

        const file = uploadResult.file; // Объект файла, возвращаемый File API
        console.log(`File uploaded to Gemini File API: Name=${file.name}, URI=${file.uri}`); // file.name это FID
        return file; // Возвращаем объект файла
    } catch (error) {
        console.error(`Error uploading file "${fileName}" (${mimeType}) to Gemini File API:`, error);
         if (error.response && error.response.data) {
             console.error('Gemini File API Error Response Data:', error.response.data);
         }
        return null;
    }
}

/**
 * Удаляет файл из Gemini File API.
 * Важно для управления хранилищем, т.к. файлы хранятся до 48 часов.
 * @param {string} fileUri - URI файла для удаления (например, 'files/some-fid').
 * @returns {Promise<boolean>} True, если удаление успешно, false в противном случае.
 */
async function deleteGeminiFile(fileUri) {
    try {
        console.log(`Attempting to delete Gemini file: ${fileUri}`);
        await fileService.deleteFile(fileUri);
        console.log(`Gemini file deleted: ${fileUri}`);
        return true;
    } catch (error) {
        console.error(`Error deleting Gemini file ${fileUri}:`, error);
        if (error.response && error.response.data) {
             console.error('Gemini File API Error Response Data (Delete):', error.response.data);
         }
        return false;
    }
}

// --- Обработчики команд Telegram ---

// Команда /start - приветственное сообщение и список команд
bot.start((ctx) => {
    ctx.reply('Привет! Я Telegram бот с интеграцией Gemini. Отправь мне текст или поддерживаемый файл (фото, PDF, видео, аудио) с текстом или без, и я отвечу. Используй команды для настройки:\n' +
              '/newchat - начать новый чат\n' +
              '/setsysteminstruction <текст> - задать системные инструкции\n' +
              '/toggletalkmode - включить/выключить "режим мышления"\n' +
              '/toggleurlcontext - включить/выключить URL контекст (Инструмент)\n' +
              '/togglegrounding - включить/выключить Заземление (Поиск Google, Инструмент)\n' +
              '/setmodel <имя модели> - выбрать модель Gemini\n' +
              '/showtokens - показать использованные токены\n' +
              '/help - показать это сообщение еще раз');
});

// Команда /help - список всех доступных команд
bot.help((ctx) => {
     const modelsList = Object.keys(MODEL_ALIASES)
            .map(alias => `${alias}: ${AVAILABLE_MODELS[MODEL_ALIASES[alias]]}`)
            .join('\n');

     ctx.reply('Доступные команды:\n' +
              '/start - приветственное сообщение\n' +
              '/newchat - начать новый чат\n' +
              '/setsysteminstruction <текст> - задать системные инструкции\n' +
              '/toggletalkmode - включить/выключить "режим мышления"\n' +
              '/toggleurlcontext - включить/выключить URL контекст (Инструмент)\n' +
              '/togglegrounding - включить/выключить Заземление (Поиск Google, Инструмент)\n' +
              '/setmodel <псевдоним> - выбрать модель Gemini. Доступные модели (псевдоним: имя API):\n' + modelsList + '\n' +
              '/showtokens - показать использованные токены');
});


// Команда /newchat - очистка истории диалога и сброс системных инструкций
bot.command('newchat', (ctx) => {
    ctx.session.history = [];
    ctx.session.systemInstruction = null; // Сбрасываем системные инструкции
    ctx.reply('Начат новый чат. Предыдущая история и системные инструкции удалены.');
});

// Команда /setsysteminstruction - установка системных инструкций для модели Gemini
bot.command('setsysteminstruction', (ctx) => {
    const instruction = ctx.message.text.substring('/setsysteminstruction'.length).trim();
    if (instruction) {
        ctx.session.systemInstruction = instruction;
        ctx.reply('Системные инструкции установлены.');
    } else {
        ctx.session.systemInstruction = null; // Сброс инструкций, если текст пуст
        ctx.reply('Системные инструкции сброшены. Используйте /setsysteminstruction <текст> для установки.');
    }
});

// Команда /toggletalkmode - переключение режима "Думаю..."
bot.command('toggletalkmode', (ctx) => {
    ctx.session.talkMode = !ctx.session.talkMode;
    ctx.reply(`"Режим мышления" (показ сообщения "Думаю...") ${ctx.session.talkMode ? 'включен' : 'выключен'}.`);
});

// Команда /toggleurlcontext - переключение инструмента URL Context
bot.command('toggleurlcontext', (ctx) => {
    ctx.session.tools.urlContext = !ctx.session.tools.urlContext;
    ctx.reply(`Инструмент URL Context ${ctx.session.tools.urlContext ? 'включен' : 'выключен'}. (Этот инструмент может быть устаревшим или требовать определенной модели/другой реализации)`);
});

// Команда /togglegrounding - переключение инструмента Заземление (Google Search)
bot.command('togglegrounding', (ctx) => {
    ctx.session.tools.googleSearch = !ctx.session.tools.googleSearch;
    ctx.reply(`Инструмент Заземление (Google Search) ${ctx.session.tools.googleSearch ? 'включен' : 'выключен'}.`);
});

// Команда /setmodel - выбор модели Gemini для использования
bot.command('setmodel', (ctx) => {
    const modelName = ctx.message.text.substring('/setmodel'.length).trim().toLowerCase();
    if (!modelName) {
        const modelsList = Object.keys(MODEL_ALIASES)
            .map(alias => `${alias}: ${AVAILABLE_MODELS[MODEL_ALIASES[alias]]}`)
            .join('\n');
        ctx.reply(`Доступные модели (псевдоним: имя API):\n${modelsList}\n\nТекущая модель: ${ctx.session.model}\nИспользуйте /setmodel <псевдоним> для выбора.`);
        return;
    }

    const alias = MODEL_ALIASES[modelName];
    if (alias && AVAILABLE_MODELS[alias]) {
        ctx.session.model = AVAILABLE_MODELS[alias];
        let replyText = `Модель установлена на ${ctx.session.model}.`;
         if (alias === 'image-gen-2.0') {
             replyText += `\nВнимание: Эта модель предназначена ТОЛЬКО для генерации изображений и может не работать для диалога или обработки входящих медиа.`;
         } else if (alias.includes('preview')) {
              replyText += `\nВнимание: Это превью-модель, ее поведение может меняться.`;
         }
         if (!AVAILABLE_MODELS[alias].includes('pro') && !AVAILABLE_MODELS[alias].includes('1.5-flash') && !AVAILABLE_MODELS[alias].includes('2.5-flash')) {
             replyText += `\nЭта модель (${AVAILABLE_MODELS[alias]}) может иметь ограниченную поддержку мультимодальных данных (PDF, видео, аудио). Для лучшей поддержки рекомендуется использовать 'latest-pro', 'pro2.5' или 'latest-flash'.`;
         } else if (AVAILABLE_MODELS[alias].includes('flash') && !AVAILABLE_MODELS[alias].includes('1.5') && !AVAILABLE_MODELS[alias].includes('2.5')) {
              replyText += `\nМодели серии 2.0 Flash могут иметь ограниченную поддержку мультимодальных данных по сравнению с 1.5 Flash/Pro и 2.5 Flash/Pro.`;
         }

        ctx.reply(replyText);
    } else {
        ctx.reply(`Неизвестное имя модели или псевдоним: "${modelName}". Используйте /setmodel без аргументов, чтобы увидеть список доступных моделей.`);
    }
});

// Команда /showtokens - показывает общее количество использованных токенов
bot.command('showtokens', (ctx) => {
    ctx.reply(`Общее количество использованных токенов (приблизительно): ${ctx.session.totalTokens}.`);
});


// --- Основной обработчик сообщений (логика взаимодействия с Gemini) ---

// bot.on('message') обрабатывает все типы входящих сообщений
bot.on('message', async (ctx) => {
    // Игнорируем сообщения, которые являются командами (они обрабатываются отдельными обработчиками)
    if (ctx.message.text && ctx.message.text.startsWith('/')) {
        console.log(`Ignoring message as it appears to be a command: ${ctx.message.text}`);
        return;
    }

    let messageText = null; // Переменная для текста сообщения или подписи к медиа
    const currentUserMessageParts = []; // Массив "частей" (parts) для текущего сообщения пользователя Gemini API

    // 1. Извлечение текста (из подписи или из текстового сообщения)
    if (ctx.message.text) {
        messageText = ctx.message.text;
        currentUserMessageParts.push({ text: messageText });
        console.log(`Received text message from ${ctx.from.id}: ${messageText}`);
    } else if (ctx.message.caption) {
        // Это медиа-сообщение с подписью
        messageText = ctx.message.caption;
        currentUserMessageParts.push({ text: messageText });
        console.log(`Received media with caption from ${ctx.from.id}: ${messageText}`);
    }

    // 2. Обработка медиафайлов (фото, видео, документы, голосовые, видео-сообщения)
    let fileId = null; // ID файла в Telegram
    let telegramProvidedMimeType = null; // MIME-тип, предоставленный Telegram (если есть)
    let fileName = null; // Имя файла для загрузки в Gemini File API

    // Определяем fileId, mimeType и fileName в зависимости от типа сообщения
    if (ctx.message.photo) {
        // Фото: берем ID файла наибольшего размера
        fileId = ctx.message.photo[ctx.message.photo.length - 1].file_id;
        telegramProvidedMimeType = 'image/jpeg'; // Telegram часто конвертирует фото в JPEG
        fileName = `${fileId}.jpg`;
        console.log(`Received photo (file_id: ${fileId})`);

    } else if (ctx.message.video) {
         fileId = ctx.message.video.file_id;
         telegramProvidedMimeType = ctx.message.video.mime_type || 'video/mp4'; // По умолчанию mp4
         fileName = ctx.message.video.file_name || `${fileId}.mp4`;
         console.log(`Received video (file_id: ${fileId}, mime_type: ${telegramProvidedMimeType})`);

    } else if (ctx.message.document) {
         fileId = ctx.message.document.file_id;
         telegramProvidedMimeType = ctx.message.document.mime_type || 'application/octet-stream';
         fileName = ctx.message.document.file_name || `${fileId}.dat`;
         console.log(`Received document (file_id: ${fileId}, mime_type: ${telegramProvidedMimeType}, file_name: ${fileName})`);

    } else if (ctx.message.voice) {
         fileId = ctx.message.voice.file_id;
         telegramProvidedMimeType = ctx.message.voice.mime_type || 'audio/ogg'; // Голосовые часто в Ogg Opus
         fileName = `${fileId}.ogg`;
         console.log(`Received voice message (file_id: ${fileId}, mime_type: ${telegramProvidedMimeType})`);

    } else if (ctx.message.video_note) {
         fileId = ctx.message.video_note.file_id;
         telegramProvidedMimeType = ctx.message.video_note.mime_type || 'video/mp4'; // Видео-сообщения обычно mp4
         fileName = `${fileId}.mp4`;
         console.log(`Received video note (file_id: ${fileId}, mime_type: ${telegramProvidedMimeType})`);
    }
    // TODO: Расширить для других типов медиа, если необходимо (аудио, анимация, стикеры).

    // Если найден ID файла, скачиваем и обрабатываем его для Gemini
    if (fileId) {
        const currentModel = ctx.session.model;
        const isProModel = currentModel.includes('pro'); // Модели Pro-серии
        const isFlash1_5_or_2_5 = currentModel.includes('1.5-flash') || currentModel.includes('2.5-flash'); // Flash-модели 1.5 и 2.5

        const isPdf = telegramProvidedMimeType === 'application/pdf';
        const isImage = telegramProvidedMimeType && telegramProvidedMimeType.startsWith('image/');
        const isVideo = telegramProvidedMimeType && telegramProvidedMimeType.startsWith('video/');
        const isAudio = telegramProvidedMimeType && telegramProvidedMimeType.startsWith('audio/');

        // Определяем, какой метод использовать: inline_data (Base64) или File API
        // inline_data подходит для изображений (обычно до 4MB)
        const shouldUseInlineData = isImage;
        // File API используется для PDF, видео, аудио и других больших файлов, если модель поддерживает
        const shouldUseFileAPI = (isProModel || isFlash1_5_or_2_5) && (isPdf || isVideo || isAudio || (isImage && !shouldUseInlineData));

        if (shouldUseInlineData) {
             console.log(`Processing file ${fileId} (${telegramProvidedMimeType}) as inline image data...`);
             try {
                 const fileData = await downloadFileAsBase64(fileId);

                 if (fileData && fileData.data && fileData.mimeType.startsWith('image/')) {
                      currentUserMessageParts.push({
                          inline_data: {
                              mime_type: fileData.mimeType, // Используем определенный mime-тип для inline_data
                              data: fileData.data
                          }
                      });
                      console.log(`Added image part (MIME: ${fileData.mimeType}) as inline data.`);
                 } else {
                     console.warn(`Could not process file ${fileId} as inline image. Detected MIME: ${fileData ? fileData.mimeType : 'N/A'}. Falling back or skipping.`);
                      currentUserMessageParts.push({ text: `[Не удалось обработать отправленное изображение (${telegramProvidedMimeType}) как встроенное изображение.]` });
                 }

             } catch (error) {
                 console.error('Error processing file for inline data:', error);
                  currentUserMessageParts.push({ text: `[Произошла ошибка при обработке отправленного файла (${telegramProvidedMimeType}).]` });
             }

        } else if (shouldUseFileAPI) {
             console.log(`Processing file ${fileId} (${telegramProvidedMimeType}) using Gemini File API...`);
             const fileBuffer = await downloadFileBuffer(fileId); // Скачиваем файл как буфер

             if (fileBuffer) {
                 const uploadedFile = await uploadFileToGemini(fileBuffer, telegramProvidedMimeType, fileName); // Загружаем в Gemini File API

                 if (uploadedFile && uploadedFile.uri) {
                     // Добавляем часть fileData, ссылающуюся на URI загруженного файла в Gemini
                     currentUserMessageParts.push({
                         fileData: {
                             mime_type: telegramProvidedMimeType, // Используем MIME-тип, предоставленный Telegram
                             uri: uploadedFile.uri // URI файла в Gemini (формат: 'files/FID')
                         }
                     });
                     console.log(`Added fileData part (URI: ${uploadedFile.uri}) to prompt parts.`);
                     // TODO: Здесь можно добавить логику для удаления файла из File API после использования
                     // (файлы хранятся до 48 часов, но лучше управлять хранилищем).
                 } else {
                     console.warn(`Failed to upload file ${fileId} (${telegramProvidedMimeType}) to Gemini File API.`);
                     currentUserMessageParts.push({ text: `[Не удалось загрузить файл (${telegramProvidedMimeType}) в Gemini File API.]` });
                 }

             } else {
                 console.warn(`Failed to download file buffer for ${fileId} (${telegramProvidedMimeType}).`);
                 currentUserMessageParts.push({ text: `[Не удалось скачать файл (${telegramProvidedMimeType}) из Telegram.]` });
             }

        } else {
            // Тип файла не поддерживается для inline или File API выбранной моделью
            console.warn(`File type "${telegramProvidedMimeType}" is not supported for processing with the selected model (${currentModel}) or via current methods (inline/File API).`);
             currentUserMessageParts.push({ text: `[Файл типа ${telegramProvidedMimeType} не поддерживается выбранной моделью (${currentModel}) или методом обработки.]` });
        }

    } // Конец блока if (fileId)

    // 3. Проверка, есть ли части для отправки в Gemini
    // Если после обработки текста и файла parts пусты, это означает, что тип сообщения
    // не был обработан (например, стикер, локация и т.д.)
     if (currentUserMessageParts.length === 0) {
         console.warn("Current message parts are empty after processing. Skipping Gemini call.");
         // Отвечаем пользователю, если тип сообщения вообще не был обработан
         if (!ctx.message.text && !ctx.message.caption && !fileId) {
              console.log(`Received completely unhandled message type. ctx.message:`, ctx.message);
              ctx.reply('Извините, я пока умею обрабатывать для ответа через Gemini только текст, фото, видео, документы (включая PDF), голосовые сообщения и видео-сообщения (с текстом или без), при условии поддержки выбранной моделью.');
         } else {
              // В случае, если файл был, но его обработка не дала частей (например, ошибка)
              ctx.reply('Извините, возникла проблема с обработкой вашего сообщения.');
         }
         return; // Останавливаем дальнейшую обработку, если нет частей для отправки
     }

    // 4. Формирование полного массива содержимого (contents) для запроса к Gemini API
    // Массив contents должен содержать историю диалога + текущий ход пользователя, в хронологическом порядке.
    const contents = [
        ...ctx.session.history, // Добавляем исторические ходы
        { role: 'user', parts: currentUserMessageParts } // Добавляем текущий ход пользователя
    ];

    // 5. Подготовка инструментов (tools) на основе настроек пользователя
    const tools = [];
    // Инструмент Google Search (Заземление) - это стандартный поддерживаемый инструмент
    if (ctx.session.tools.googleSearch) {
        tools.push({ googleSearch: {} });
         console.log('Google Search tool enabled for this call.');
    }
    // URL Context менее распространен/поддерживается через стандартные инструменты API сейчас.
    // Мы НЕ будем добавлять его в массив tools для вызова API в этом примере,
    // так как он часто не поддерживается как общий объект инструмента.
    if (ctx.session.tools.urlContext) {
         console.warn('URL Context tool is enabled but might not be supported by the model or via standard tools configuration for API call.');
    }

    // 6. Вызов Gemini API
    let thinkingMessageId = null;
    if (ctx.session.talkMode) {
         try {
            // Отправляем сообщение "Думаю..." и сохраняем его ID для последующего удаления
            const thinkingMsg = await ctx.reply('Думаю...');
            thinkingMessageId = thinkingMsg.message_id;
         } catch (error) {
             console.error('Error sending "Thinking..." message:', error);
         }
    }

    let geminiResponseText = 'Не удалось получить ответ от Gemini.';
    let inputTokens = 0; // Токены для текущего запроса (история + текущий ход)
    let outputTokens = 0; // Токены для ответа модели

    try {
        // Получаем экземпляр генеративной модели
        const model = genAI.getGenerativeModel({
            model: ctx.session.model,
        });

        // Подготавливаем системные инструкции, если они заданы.
        // Передаем их в `systemInstruction` параметр в вызове `generateContent`, как в Java-примере.
        const systemInstructionContent = ctx.session.systemInstruction
            ? { parts: [{ text: ctx.session.systemInstruction }] }
            : undefined;

        // Выполняем вызов generateContent с подготовленным содержимым, инструментами и системными инструкциями
        console.log('Calling generateContent with contents:', JSON.stringify(contents));
        console.log('Using system instruction:', systemInstructionContent ? systemInstructionContent.parts[0].text : 'None');
        console.log('Using tools:', tools.length > 0 ? JSON.stringify(tools) : 'None');

        const result = await model.generateContent({
             contents: contents, // Полная история диалога + текущее сообщение пользователя
             tools: tools.length > 0 ? tools : undefined, // Инструменты
             systemInstruction: systemInstructionContent, // **ИСПРАВЛЕНИЕ ДЛЯ СИСТЕМНЫХ ИНСТРУКЦИЙ**
             safetySettings: [ // Настройки безопасности (пример: блокировка вредоносного контента)
                { category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: HarmBlockThreshold.BLOCK_NONE },
                { category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.BLOCK_NONE },
                { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH, threshold: HarmBlockThreshold.BLOCK_NONE },
                { category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, threshold: HarmBlockThreshold.BLOCK_NONE },
                { category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT_AND_NON_SOLICITED, threshold: HarmBlockThreshold.BLOCK_NONE },
            ],
             generationConfig: {
                 // Здесь можно добавить другие параметры генерации (например, temperature, top_p)
             }
        });

        const response = result.response;

        // 7. Извлечение текстового ответа из ответа Gemini
        if (response && response.candidates && response.candidates.length > 0 && response.candidates[0].content && response.candidates[0].content.parts && response.candidates[0].content.parts.length > 0) {
             geminiResponseText = response.candidates[0].content.parts
                 .map(part => part.text) // Получаем текст из каждой части
                 .filter(text => text !== undefined && text !== null) // Отфильтровываем нетекстовые части или null
                 .join(''); // Объединяем текстовые части
        } else {
             console.warn("Gemini response did not contain text parts.", response);
             geminiResponseText = 'Не удалось получить текстовый ответ от Gemini.';
        }


        // 8. Обновление использования токенов
        // Клиентская библиотека Node.js предоставляет информацию об использовании токенов в `usageMetadata`
         if (response.usageMetadata) {
             inputTokens = response.usageMetadata.promptTokenCount || 0;
             outputTokens = response.usageMetadata.candidatesTokenCount || 0;
             const totalTokensForCall = response.usageMetadata.totalTokenCount || 0;
             console.log(`Gemini API Usage Metadata: Input=${inputTokens}, Output=${outputTokens}, Total=${totalTokensForCall}`);
             ctx.session.totalTokens += totalTokensForCall; // Добавляем общее количество токенов за этот вызов к кумулятивному итогу
         } else {
             // Если `usageMetadata` недоступен в ответе, пытаемся оценить входящие токены
             try {
                 const tokenEstimation = await model.countTokens({
                     contents: contents,
                     tools: tools.length > 0 ? tools : undefined,
                     systemInstruction: systemInstructionContent, // Важно передать системные инструкции для точного подсчета
                 });
                 inputTokens = tokenEstimation.totalTokens || 0;
                 ctx.session.totalTokens += inputTokens; // Добавляем только оценочные входящие токены
                 console.log(`Estimated Input tokens for this call (from countTokens): ${inputTokens}. Total cumulative (estimated, input-biased): ${ctx.session.totalTokens}`);
             } catch (tokenError) {
                 console.error('Error counting tokens after successful response:', tokenError);
             }
         }


        // 9. Обновление истории диалога
        // Добавляем текущий ход пользователя и текстовый ответ модели в историю
        ctx.session.history.push({ role: 'user', parts: currentUserMessageParts });
        // Добавляем текстовый ответ модели в историю
        if (geminiResponseText && geminiResponseText.trim().length > 0) {
            ctx.session.history.push({ role: 'model', parts: [{ text: geminiResponseText }] });
        } else {
             // Если Gemini вернул нетекстовый или пустой ответ, добавляем пустой ход модели,
             // чтобы сохранить структуру истории (user, model, user, model).
             console.warn("Gemini response text was empty or only whitespace. Adding empty model turn to history.");
             ctx.session.history.push({ role: 'model', parts: [{ text: '' }] });
        }

        // Ограничиваем длину истории (например, последние 10 пар "вопрос-ответ" = 20 сообщений)
        const maxHistoryMessages = 20;
        if (ctx.session.history.length > maxHistoryMessages) {
            ctx.session.history = ctx.session.history.slice(-maxHistoryMessages); // Удаляем старые сообщения
        }
         console.log(`History size after turn: ${ctx.session.history.length}`);


    } catch (error) {
        console.error('Error calling Gemini API:', error);
        geminiResponseText = 'Произошла ошибка при обращении к Gemini API.';

        // Логируем специфические детали ошибки API, если доступны
        if (error.response && error.response.data) {
             console.error('Gemini API Error Response Data:', error.response.data);
             if (error.response.data.error && error.response.data.error.message) {
                 geminiResponseText += ` Ошибка API: ${error.response.data.error.message}`;
             }
        } else if (error.message) {
            geminiResponseText += ` Ошибка: ${error.message}`;
        }

         // Добавляем сообщение пользователя в историю, даже если вызов API завершился ошибкой,
         // чтобы сохранить контекст попытки.
         if (currentUserMessageParts.length > 0) {
             ctx.session.history.push({ role: 'user', parts: currentUserMessageParts });
              // Ограничиваем длину истории даже при ошибке
              const maxHistoryMessages = 20;
              if (ctx.session.history.length > maxHistoryMessages) {
                  ctx.session.history = ctx.session.history.slice(-maxHistoryMessages);
              }
         }
         console.log(`History size after error: ${ctx.session.history.length}`);

    } finally {
         // Всегда пытаемся удалить сообщение "Думаю...", если оно было отправлено
         if (thinkingMessageId) {
             try {
                 await ctx.deleteMessage(thinkingMessageId);
                 console.log(`Deleted "Thinking..." message ${thinkingMessageId}`);
             } catch (deleteError) {
                 // Игнорируем ошибки удаления, т.к. сообщение могло не отправиться
                 console.error(`Error deleting "Thinking..." message ${thinkingMessageId}:`, deleteError);
             }
         }
    }


    // 10. Отправка итогового ответа в Telegram
    try {
        // Если ответ Gemini пуст или содержит только пробелы, отправляем сообщение по умолчанию
        if (!geminiResponseText || geminiResponseText.trim().length === 0) {
             console.warn("Final Gemini response text was empty, sending a default message.");
             // Отправляем сообщение по умолчанию, только если это еще не сообщение об ошибке
             if (!geminiResponseText.startsWith('Произошла ошибка')) {
                 await ctx.reply("Не удалось сгенерировать ответ. Попробуйте еще раз или измените запрос/настройки.");
             } else {
                 // Если geminiResponseText уже содержит ошибку, отправляем ее
                  await ctx.reply(geminiResponseText);
             }
        } else {
             await ctx.reply(geminiResponseText);
        }

    } catch (replyError) {
        console.error('Error sending final reply to Telegram:', replyError);
    }
});


// --- Настройка вебхука Express ---
const app = express();
const port = process.env.PORT || 3000; // Render предоставит порт через переменную окружения PORT

app.use(express.json()); // Middleware для парсинга JSON тела запроса

// Используем middleware `bot.webhookCallback('/webhook')` от Telegraf
// Он обрабатывает входящий запрос вебхука и передает его экземпляру бота.
app.use(bot.webhookCallback('/webhook'));

// Корневая конечная точка '/' для проверки статуса сервера
app.get('/', (req, res) => {
    res.send('Telegram Bot server is running and waiting for webhooks at /webhook. Gemini integration enabled.');
});

// --- Запуск сервера ---
app.listen(port, () => {
    console.log(`Сервер запущен на порту ${port}`);
    console.log(`Эндпоинт для вебхуков настроен по пути: /webhook`);
    console.log(`Telegram Bot Token loaded.`);
    console.log(`Gemini API Key loaded.`);
    console.log('Ожидание входящих вебхуков от Telegram...');
});

// ВАЖНО: При использовании вебхуков НЕ вызывайте `bot.launch()`,
// который используется для режима long polling.

// Опционально: Включение корректного завершения работы (для локальной разработки или специфических сред)
// process.once('SIGINT', () => bot.stop('SIGINT')); // Для прерывания Ctrl+C
// process.once('SIGTERM', () => bot.stop('SIGTERM')); // Для сигналов завершения от ОС/хостинга