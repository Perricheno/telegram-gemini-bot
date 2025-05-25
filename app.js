// app.js

// Load environment variables from .env file (for local development).
require('dotenv').config();

// Import necessary libraries
const { Telegraf, session } = require('telegraf');
const express = require('express');
const axios = require('axios'); // For downloading files from Telegram
const { GoogleGenerativeAI, HarmCategory, HarmBlockThreshold } = require('@google/generative-ai');

// Get tokens from environment variables
const telegramToken = process.env.TELEGRAM_BOT_TOKEN;
const geminiApiKey = process.env.GEMINI_API_KEY;

// Check if tokens are set
if (!telegramToken) {
    console.error('Error: TELEGRAM_BOT_TOKEN environment variable is not set.');
    process.exit(1);
}
if (!geminiApiKey) {
    console.error('Error: GEMINI_API_KEY environment variable is not set.');
    console.error('Please set GEMINI_API_KEY in your Render environment variables or in the local .env file.');
    process.exit(1);
}

// Initialize Telegraf bot
const bot = new Telegraf(telegramToken);

// Initialize Google Generative AI client
const genAI = new GoogleGenerativeAI(geminiApiKey);
// Get the FileService client for uploading files
const fileService = genAI.getGenerativeModel('').getFileService(); // File Service doesn't require a specific model instance

// --- Session Management ---
// Use in-memory session for simplicity. For production, use persistent storage!
// https://telegraf.js.org/#/middlewares?id=session
bot.use(session({ property: 'session' }));

// Middleware to initialize session defaults if not present
bot.use((ctx, next) => {
    if (!ctx.session || typeof ctx.session !== 'object') {
        ctx.session = {
            history: [],
            systemInstruction: null,
            model: 'gemini-1.5-pro-latest', // Default to Pro for better multimodal support
            tools: {
                urlContext: false,
                googleSearch: true, // Grounding (Google Search) is enabled by default
            },
            talkMode: true, // Interpretation of Thinking Mode (toggles "Thinking..." message)
            totalTokens: 0, // Token counter
            lastMessageTime: Date.now(), // To track session activity if needed
        };
        console.log(`Session initialized for user ${ctx.from.id}`);
    }
     // Update last message time for potential inactivity tracking
     ctx.session.lastMessageTime = Date.now();
    next();
});

// --- Gemini Model Configuration ---
// Added notes on capabilities
const AVAILABLE_MODELS = {
    'flash-04-17': 'gemini-2.5-flash-preview-04-17', // Preview, good for basic multimodal
    'flash-05-20': 'gemini-2.5-flash-preview-05-20', // Preview, good for basic multimodal
    'pro-05-06': 'gemini-2.5-pro-preview-05-06',   // Preview, likely strong multimodal (File API support probable)
    'flash-2.0': 'gemini-2.0-flash',              // Older, multimodal support less certain/robust for complex files
    'flash-lite-2.0': 'gemini-2.0-flash-lite',    // Older, likely limited multimodal
    'image-gen-2.0': 'gemini-2.0-flash-preview-image-generation', // Warning: Image generation ONLY, not chat
    'flash-latest': 'gemini-1.5-flash-latest',    // Stable, good for images+text
    'pro-latest': 'gemini-1.5-pro-latest'         // Stable, BEST for PDF, long video/audio via File API
};

// Map user-friendly names to API names
const MODEL_ALIASES = {
    '04-17': 'flash-04-17',
    '05-20': 'flash-05-20',
    'pro-05-06': 'pro-05-06',
    'flash': 'flash-2.0',
    'flash-lite': 'flash-lite-2.0',
    'image-gen': 'image-gen-2.0',
    'latest-flash': 'flash-latest',
    'latest-pro': 'pro-latest',
    'default': 'pro-latest', // Default to Pro for better file support
     'flash1.5': 'flash-latest',
     'pro1.5': 'pro-latest',
     'flash2.5': 'flash-05-20', // Alias for latest 2.5 Flash preview
     'pro2.5': 'pro-05-06' // Alias for latest 2.5 Pro preview
};


// --- Helper Functions ---

// Function to download a file from Telegram as a Buffer
async function downloadFileBuffer(fileId) {
    try {
        const fileUrl = await bot.telegram.getFileLink(fileId);
        const response = await axios({
            url: fileUrl.href,
            method: 'GET',
            responseType: 'arraybuffer' // Get data as ArrayBuffer
        });
        return Buffer.from(response.data);
    } catch (error) {
        console.error(`Error downloading file (ID: ${fileId}):`, error);
        return null;
    }
}

// Function to download an image file from Telegram as Base64 (for inline_data)
async function downloadFileAsBase64(fileId) {
    try {
        const fileUrl = await bot.telegram.getFileLink(fileId);
        const response = await axios({
            url: fileUrl.href,
            method: 'GET',
            responseType: 'arraybuffer'
        });

        const buffer = Buffer.from(response.data);
        // Basic mime type detection based on file signature (magic numbers).
        // This is primarily for images for inline_data.
        let mimeType = 'application/octet-stream';
        if (buffer.length >= 4) {
             const signature = buffer.subarray(0, 4).toString('hex').toUpperCase();
             if (signature === '89504E47') mimeType = 'image/png'; // PNG
             else if (signature === '47494638') mimeType = 'image/gif'; // GIF
             else if (signature.startsWith('FFD8FF')) mimeType = 'image/jpeg'; // JPEG (Common start)
             else if (signature.startsWith('52494646') && buffer.subarray(8, 12).toString('hex').toUpperCase() === '57454250') mimeType = 'image/webp'; // WebP
        }
        // If Telegram provided a mime type for the photo, it's usually reliable too.
        // For inline data, make sure the detected type is correct for Gemini.

        const base64 = buffer.toString('base64');
        return { data: base64, mimeType: mimeType };
    } catch (error) {
        console.error(`Error downloading or converting file (ID: ${fileId}) to Base64:`, error);
        return null;
    }
}


// Function to upload a file buffer to Gemini File API
async function uploadFileToGemini(buffer, mimeType, fileName) {
    if (!buffer || !mimeType || !fileName) {
        console.error('Missing buffer, mimeType, or fileName for Gemini upload.');
        return null;
    }
     console.log(`Attempting to upload file "${fileName}" (${mimeType}) to Gemini File API...`);
    try {
        const uploadResult = await fileService.uploadFile(buffer, {
             mimeType: mimeType,
             displayName: fileName, // Optional display name
        });

        const file = uploadResult.file; // Get the file object with FID and URI
        console.log(`File uploaded to Gemini File API: Name=${file.name}, URI=${file.uri}`); // file.name is the FID
        return file; // Return the file object
    } catch (error) {
        console.error(`Error uploading file "${fileName}" (${mimeType}) to Gemini File API:`, error);
         if (error.response && error.response.data) {
             console.error('Gemini File API Error Response Data:', error.response.data);
         }
        return null;
    }
}

// Function to delete files from Gemini File API (important for managing storage)
// It's good practice to delete files after they are no longer needed (e.g., after conversation ends or after a grace period)
// For simplicity, not called automatically in this example, but keep in mind for production.
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


// --- Command Handlers ---

// Start command - Welcome message
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

// Help command - show commands
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


// New Chat command - clear conversation history and reset instruction
bot.command('newchat', (ctx) => {
    ctx.session.history = [];
    ctx.session.systemInstruction = null; // Also reset system instruction
    ctx.reply('Начат новый чат. Предыдущая история и системные инструкции удалены.');
});

// Set System Instruction command
bot.command('setsysteminstruction', (ctx) => {
    const instruction = ctx.message.text.substring('/setsysteminstruction'.length).trim();
    if (instruction) {
        ctx.session.systemInstruction = instruction;
        ctx.reply('Системные инструкции установлены.');
    } else {
        ctx.session.systemInstruction = null;
        ctx.reply('Системные инструкции сброшены. Используйте /setsysteminstruction <текст> для установки.');
    }
});

// Toggle Talk Mode command (Simple interpretation: show "Thinking..." message)
bot.command('toggletalkmode', (ctx) => {
    ctx.session.talkMode = !ctx.session.talkMode;
    ctx.reply(`"Режим мышления" (показ сообщения "Думаю...") ${ctx.session.talkMode ? 'включен' : 'выключен'}.`);
});

// Toggle URL Context tool
bot.command('toggleurlcontext', (ctx) => {
    ctx.session.tools.urlContext = !ctx.session.tools.urlContext;
     // Note: URL Context tool is often deprecated or specific to certain non-standard tools.
     // Google Search (Grounding) is the more common and supported tool.
    ctx.reply(`Инструмент URL Context ${ctx.session.tools.urlContext ? 'включен' : 'выключен'}. (Этот инструмент может быть устаревшим или требовать определенной модели/другой реализации)`);
});

// Toggle Grounding (Google Search) tool
bot.command('togglegrounding', (ctx) => {
    ctx.session.tools.googleSearch = !ctx.session.tools.googleSearch;
    ctx.reply(`Инструмент Заземление (Google Search) ${ctx.session.tools.googleSearch ? 'включен' : 'выключен'}.`);
});

// Set Model command
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

// Show Tokens command
bot.command('showtokens', (ctx) => {
    // This is a cumulative estimate based on total tokens reported by the API (input + output)
    // for calls where usageMetadata is available. Otherwise, it's an input-only estimate.
    ctx.reply(`Общее количество использованных токенов (приблизительно): ${ctx.session.totalTokens}.`);
});


// --- Message Handler (Main Logic for Gemini Interaction) ---

// Use bot.on('message') to capture all message types
bot.on('message', async (ctx) => {
    // Ignore commands handled by specific command handlers
    if (ctx.message.text && ctx.message.text.startsWith('/')) {
        console.log(`Ignoring message as it appears to be a command: ${ctx.message.text}`);
        return;
    }

    let messageText = null; // Text from message or caption
    const currentUserMessageParts = []; // Parts array for the current user message to send to Gemini

    // 1. Extract text (caption or message text)
    if (ctx.message.text) {
        messageText = ctx.message.text;
        currentUserMessageParts.push({ text: messageText });
        console.log(`Received text message from ${ctx.from.id}: ${messageText}`);
    } else if (ctx.message.caption) {
        // This is a media message with a caption
        messageText = ctx.message.caption;
        currentUserMessageParts.push({ text: messageText });
        console.log(`Received media with caption from ${ctx.from.id}: ${messageText}`);
    }

    // 2. Handle media (photos, videos, documents, voice, video_note)
    let fileId = null;
    let telegramProvidedMimeType = null; // Mime type provided by Telegram if available
    let fileName = null; // File name for upload

    // Determine fileId, mimeType, and fileName based on message type
    if (ctx.message.photo) {
        // Photo: get the largest size file_id. Mime type is typically image/jpeg.
        fileId = ctx.message.photo[ctx.message.photo.length - 1].file_id;
        telegramProvidedMimeType = 'image/jpeg'; // Common Telegram photo type
        fileName = `${fileId}.jpg`;
        console.log(`Received photo (file_id: ${fileId})`);

    } else if (ctx.message.video) {
         fileId = ctx.message.video.file_id;
         telegramProvidedMimeType = ctx.message.video.mime_type || 'video/mp4'; // Assume mp4 if not provided
         fileName = ctx.message.video.file_name || `${fileId}.mp4`;
         console.log(`Received video (file_id: ${fileId}, mime_type: ${telegramProvidedMimeType})`);

    } else if (ctx.message.document) {
         fileId = ctx.message.document.file_id;
         telegramProvidedMimeType = ctx.message.document.mime_type || 'application/octet-stream';
         fileName = ctx.message.document.file_name || `${fileId}.dat`;
         console.log(`Received document (file_id: ${fileId}, mime_type: ${telegramProvidedMimeType}, file_name: ${fileName})`);

    } else if (ctx.message.voice) {
         fileId = ctx.message.voice.file_id;
         telegramProvidedMimeType = ctx.message.voice.mime_type || 'audio/ogg'; // Voice notes are often Ogg Opus
         fileName = `${fileId}.ogg`;
         console.log(`Received voice message (file_id: ${fileId}, mime_type: ${telegramProvidedMimeType})`);

    } else if (ctx.message.video_note) {
         fileId = ctx.message.video_note.file_id;
         telegramProvidedMimeType = ctx.message.video_note.mime_type || 'video/mp4'; // Video Notes are typically mp4
         fileName = `${fileId}.mp4`;
         console.log(`Received video note (file_id: ${fileId}, mime_type: ${telegramProvidedMimeType})`);
    }
    // TODO: Extend for other media types like audio (not voice), animation, sticker if needed.

    // If a file ID was found, download and process it for Gemini
    if (fileId) {
        // Determine if the current model supports File API for the detected mime type
        const currentModel = ctx.session.model;
        const isProModel = currentModel.includes('pro');
        const isFlash1_5_or_2_5 = currentModel.includes('1.5-flash') || currentModel.includes('2.5-flash');
        const isPdf = telegramProvidedMimeType === 'application/pdf';
        const isImage = telegramProvidedMimeType && telegramProvidedMimeType.startsWith('image/');
        const isVideo = telegramProvidedMimeType && telegramProvidedMimeType.startsWith('video/');
        const isAudio = telegramProvidedMimeType && telegramProvidedMimeType.startsWith('audio/');

        // General rule: inline for images (smaller), File API for PDF, video, audio (larger/complex)
        const shouldUseInlineData = isImage; // For images, Base64 inline is simpler if size permits
        const shouldUseFileAPI = (isProModel || isFlash1_5_or_2_5) && (isPdf || isVideo || isAudio || (isImage && !shouldUseInlineData)); // Use File API for specific types with supported models

        if (shouldUseInlineData) {
             console.log(`Processing file ${fileId} (${telegramProvidedMimeType}) as inline image data...`);
             try {
                 const fileData = await downloadFileAsBase64(fileId);

                 if (fileData && fileData.data && fileData.mimeType.startsWith('image/')) {
                      currentUserMessageParts.push({
                          inline_data: {
                              mime_type: fileData.mimeType, // Use detected mime type for inline
                              data: fileData.data
                          }
                      });
                      console.log(`Added image part (MIME: ${fileData.mimeType}) as inline data.`);
                 } else {
                     console.warn(`Could not process file ${fileId} as inline image. Detected MIME: ${fileData ? fileData.mimeType : 'N/A'}. Falling back or skipping.`);
                      // Fallback to text or error if inline failed/unsupported type
                      currentUserMessageParts.push({ text: `[Не удалось обработать отправленное изображение (${telegramProvidedMimeType}) как встроенное изображение.]` });
                 }

             } catch (error) {
                 console.error('Error processing file for inline data:', error);
                  currentUserMessageParts.push({ text: `[Произошла ошибка при обработке отправленного файла (${telegramProvidedMimeType}).]` });
             }

        } else if (shouldUseFileAPI) {
             console.log(`Processing file ${fileId} (${telegramProvidedMimeType}) using Gemini File API...`);
             const fileBuffer = await downloadFileBuffer(fileId);

             if (fileBuffer) {
                 const uploadedFile = await uploadFileToGemini(fileBuffer, telegramProvidedMimeType, fileName);

                 if (uploadedFile && uploadedFile.uri) {
                     currentUserMessageParts.push({
                         fileData: {
                             mime_type: telegramProvidedMimeType, // Use Telegram's provided mime type for File API
                             uri: uploadedFile.uri // URI format is 'files/FID'
                         }
                     });
                     console.log(`Added fileData part (URI: ${uploadedFile.uri}) to prompt parts.`);
                     // TODO: Consider implementing file deletion logic here (e.g., after successful API call or after session expires)
                 } else {
                     console.warn(`Failed to upload file ${fileId} (${telegramProvidedMimeType}) to Gemini File API.`);
                     currentUserMessageParts.push({ text: `[Не удалось загрузить файл (${telegramProvidedMimeType}) в Gemini File API.]` });
                 }

             } else {
                 console.warn(`Failed to download file buffer for ${fileId} (${telegramProvidedMimeType}).`);
                 currentUserMessageParts.push({ text: `[Не удалось скачать файл (${telegramProvidedMimeType}) из Telegram.]` });
             }

        } else {
            // File type is not supported for inline OR File API with the current model
            console.warn(`File type "${telegramProvidedMimeType}" is not supported for processing with the selected model (${currentModel}) or via current methods (inline/File API).`);
             currentUserMessageParts.push({ text: `[Файл типа ${telegramProvidedMimeType} не поддерживается выбранной моделью (${currentModel}) или методом обработки.]` });
        }

    } // End if (fileId)


    // 3. Check if we have any parts to send to Gemini
     if (currentUserMessageParts.length === 0) {
         console.warn("Current message parts are empty after processing. Skipping Gemini call.");
         // Reply to the user if the message type wasn't handled at all
         if (!ctx.message.text && !ctx.message.caption && !fileId) {
              console.log(`Received completely unhandled message type. ctx.message:`, ctx.message);
              ctx.reply('Извините, я пока умею обрабатывать для ответа через Gemini только текст, фото, видео, документы (включая PDF), голосовые сообщения и видео-сообщения (с текстом или без), при условии поддержки выбранной моделью.');
         } else {
             // This case should ideally not be reached if fileId was processed,
             // but as a fallback:
              ctx.reply('Извините, возникла проблема с обработкой вашего сообщения.');
         }
         return; // Stop processing if no valid parts to send
     }


    // 4. Build the full contents array for the Gemini API call
    // The contents array should be the conversation history + the current user turn,
    // in chronological order (oldest first).
    const contents = [
        ...ctx.session.history, // Add historical turns first
        { role: 'user', parts: currentUserMessageParts } // Add the current user turn last
    ];

    // 5. Prepare tools based on user settings
    const tools = [];
    // Google Search Tool (Grounding) is the standard supported tool
    if (ctx.session.tools.googleSearch) {
        tools.push({ googleSearch: {} });
         console.log('Google Search tool enabled for this call.');
    }
    // URL Context is less commonly used/supported via standard tools API now
    // We will NOT add it to the tools array for the API call in this example
    // as it's often not supported as a generic tool object or requires special setup.
    if (ctx.session.tools.urlContext) {
         console.warn('URL Context tool is enabled but might not be supported by the model or via standard tools configuration for API call.');
         // If specific URL reading is needed, it might involve fetching content
         // manually and adding it as a text part, or using a model's
         // native URL parsing if available.
    }


    // 6. Call Gemini API
    let thinkingMessageId = null;
    if (ctx.session.talkMode) {
         try {
            const thinkingMsg = await ctx.reply('Думаю...');
            thinkingMessageId = thinkingMsg.message_id;
         } catch (error) {
             console.error('Error sending "Thinking..." message:', error);
         }
    }

    let geminiResponseText = 'Не удалось получить ответ от Gemini.';
    let inputTokens = 0; // Tokens for the current prompt (history + current turn)
    let outputTokens = 0; // Tokens for the model's reply

    try {
        // Get the generative model instance
        const model = genAI.getGenerativeModel({
            model: ctx.session.model,
            // system: ctx.session.systemInstruction || undefined, // System instruction is passed in generateContent's config now
        });

        // Prepare system instruction content if set, matching Java example
        const systemInstructionContent = ctx.session.systemInstruction
            ? { parts: [{ text: ctx.session.systemInstruction }] }
            : undefined;

        // Call generateContent with the prepared contents, tools, and system instruction
        console.log('Calling generateContent with contents:', JSON.stringify(contents)); // Log contents being sent
        console.log('Using system instruction:', systemInstructionContent ? systemInstructionContent.parts[0].text : 'None');
        console.log('Using tools:', tools.length > 0 ? JSON.stringify(tools) : 'None');

        const result = await model.generateContent({
             contents: contents, // Pass the full conversation history + current message
             tools: tools.length > 0 ? tools : undefined, // Pass tools if any are enabled
             systemInstruction: systemInstructionContent, // **THIS IS THE FIX FOR SYSTEM INSTRUCTIONS**
             safetySettings: [ // Safety settings as previously defined
                { category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: HarmBlockThreshold.BLOCK_NONE },
                { category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.BLOCK_NONE },
                { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH, threshold: HarmBlockThreshold.BLOCK_NONE },
                { category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, threshold: HarmBlockThreshold.BLOCK_NONE },
                { category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT_AND_NON_SOLICITED, threshold: HarmBlockThreshold.BLOCK_NONE },
            ],
             generationConfig: {
                 // You could add other generation parameters here, e.g., temperature, top_p, etc.
             }
        });

        const response = result.response;

        // Check if the response has text parts and extract
        if (response && response.candidates && response.candidates.length > 0 && response.candidates[0].content && response.candidates[0].content.parts && response.candidates[0].content.parts.length > 0) {
             geminiResponseText = response.candidates[0].content.parts
                 .map(part => part.text) // Get text from each part
                 .filter(text => text !== undefined && text !== null) // Filter out non-text parts or nulls
                 .join(''); // Join text parts
        } else {
             console.warn("Gemini response did not contain text parts.", response);
             geminiResponseText = 'Не удалось получить текстовый ответ от Gemini.';
        }


        // 7. Update Token Usage
        // The Node.js client library provides token counts in usageMetadata if available from the API response
         if (response.usageMetadata) {
             inputTokens = response.usageMetadata.promptTokenCount || 0;
             outputTokens = response.usageMetadata.candidatesTokenCount || 0;
             const totalTokensForCall = response.usageMetadata.totalTokenCount || 0;
             console.log(`Gemini API Usage Metadata: Input=${inputTokens}, Output=${outputTokens}, Total=${totalTokensForCall}`);
             ctx.session.totalTokens += totalTokensForCall; // Add total tokens for this turn to cumulative total
         } else {
             // If usageMetadata is not available, try to estimate input tokens using countTokens
             // This happens with some models or response types.
             try {
                 const tokenEstimation = await model.countTokens({
                     contents: contents,
                     tools: tools.length > 0 ? tools : undefined,
                     systemInstruction: systemInstructionContent, // Pass system instruction here too for accurate count
                 });
                 inputTokens = tokenEstimation.totalTokens || 0;
                 ctx.session.totalTokens += inputTokens; // Add estimated input tokens to total
                 console.log(`Estimated Input tokens for this call (from countTokens): ${inputTokens}. Total cumulative (estimated, input-biased): ${ctx.session.totalTokens}`);
             } catch (tokenError) {
                 console.error('Error counting tokens after successful response:', tokenError);
             }
         }


        // 8. Update conversation history IF the Gemini call was successful and yielded a response
        // Add the user's message and the bot's text reply to history
        // Store the parts that were actually sent to Gemini for the user turn
        ctx.session.history.push({ role: 'user', parts: currentUserMessageParts });
        // Only add the model's text response to history
        if (geminiResponseText && geminiResponseText.trim().length > 0) {
            ctx.session.history.push({ role: 'model', parts: [{ text: geminiResponseText }] });
        } else {
             // If Gemini returned non-text or empty response, add an empty model turn
             // to keep history aligned for proper turn-taking (user, model, user, model).
             console.warn("Gemini response text was empty or only whitespace. Adding empty model turn to history.");
             ctx.session.history.push({ role: 'model', parts: [{ text: '' }] }); // Add an empty text part for the model turn
        }


        // Keep history length manageable (e.g., last 10 back-and-forth turns = 20 messages)
        const maxHistoryMessages = 20; // 10 user turns + 10 model turns
        if (ctx.session.history.length > maxHistoryMessages) {
            // Remove older messages from the beginning of the history array
            ctx.session.history = ctx.session.history.slice(-maxHistoryMessages);
        }
         console.log(`History size after turn: ${ctx.session.history.length}`);


    } catch (error) {
        console.error('Error calling Gemini API:', error);
        geminiResponseText = 'Произошла ошибка при обращении к Gemini API.';

        // Log specific details if available (e.g., API error messages)
        if (error.response && error.response.data) {
             console.error('Gemini API Error Response Data:', error.response.data);
             if (error.response.data.error && error.response.data.error.message) {
                 geminiResponseText += ` Ошибка API: ${error.response.data.error.message}`;
             }
        } else if (error.message) {
            geminiResponseText += ` Ошибка: ${error.message}`;
        }

         // Add the user's message to history even if the API call failed,
         // so the context of the attempt is preserved for the next message.
         if (currentUserMessageParts.length > 0) {
             ctx.session.history.push({ role: 'user', parts: currentUserMessageParts });
              // Keep history length manageable even on error
              const maxHistoryMessages = 20;
              if (ctx.session.history.length > maxHistoryMessages) {
                  ctx.session.history = ctx.session.history.slice(-maxHistoryMessages);
              }
         }
         console.log(`History size after error: ${ctx.session.history.length}`);

    } finally {
         // Always attempt to delete the "Thinking..." message if it was sent
         if (thinkingMessageId) {
             try {
                 await ctx.deleteMessage(thinkingMessageId);
                 console.log(`Deleted "Thinking..." message ${thinkingMessageId}`);
             } catch (deleteError) {
                 console.error(`Error deleting "Thinking..." message ${thinkingMessageId}:`, deleteError);
             }
         }
    }


    // 9. Send final response to Telegram
    try {
        // If the Gemini response text is empty or only whitespace, send a default message
        if (!geminiResponseText || geminiResponseText.trim().length === 0) {
             console.warn("Final Gemini response text was empty, sending a default message.");
             // Only send this if an error message wasn't already generated
             if (!geminiResponseText.startsWith('Произошла ошибка')) { // Check if it's already an error message
                 await ctx.reply("Не удалось сгенерировать ответ. Попробуйте еще раз или измените запрос/настройки.");
             } else {
                 // If geminiResponseText already contains an error, send that
                  await ctx.reply(geminiResponseText);
             }
        } else {
             await ctx.reply(geminiResponseText);
        }

    } catch (replyError) {
        console.error('Error sending final reply to Telegram:', replyError);
    }
});


// --- Webhook Setup ---
const app = express();
const port = process.env.PORT || 3000;

app.use(express.json()); // Middleware to parse JSON body

// Use the bot.webhookCallback('/webhook') middleware provided by Telegraf
app.use(bot.webhookCallback('/webhook'));

// Root endpoint for status check
app.get('/', (req, res) => {
    res.send('Telegram Bot server is running and waiting for webhooks at /webhook. Gemini integration enabled.');
});

// --- Start Server ---
app.listen(port, () => {
    console.log(`Server running on port ${port}`);
    console.log(`Webhook endpoint configured at /webhook`);
    console.log(`Telegram Bot Token loaded.`);
    console.log(`Gemini API Key loaded.`);
    console.log('Awaiting incoming webhooks from Telegram...');
});

// Important: Do NOT call bot.launch() when using webhooks.

// Optional: Enable graceful stop (for local development or specific environments)
// process.once('SIGINT', () => bot.stop('SIGINT'));
// process.once('SIGTERM', () => bot.stop('SIGTERM'));