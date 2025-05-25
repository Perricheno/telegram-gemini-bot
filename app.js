// app.js

// Load environment variables from .env file
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
// File Service does not require a specific model, it's a global service
const fileService = genAI.getGenerativeModel('gemini-1.5-pro-latest').getFileService(); // Use a model instance to get fileService

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
                urlContext: false, // Note: URL Context tool is often deprecated or specific
                googleSearch: true, // Google Search (Grounding) is more common
            },
            talkMode: true, // Interpretation of Thinking Mode (toggles "Thinking..." message)
            totalTokens: 0, // Token counter for cumulative tokens (input + output where available)
            lastMessageTime: Date.now(), // To track session activity if needed
        };
        console.log(`Session initialized for user ${ctx.from.id}`);
    }
     // Update last message time for potential inactivity tracking
     ctx.session.lastMessageTime = Date.now();
    next();
});

// --- Gemini Model Configuration ---
// Added notes on capabilities and recommended models for file API
const AVAILABLE_MODELS = {
    'flash-04-17': 'gemini-2.5-flash-preview-04-17', // Preview, good for text+images, limited non-image file support.
    'flash-05-20': 'gemini-2.5-flash-preview-05-20', // Preview, good for text+images, limited non-image file support.
    'pro-05-06': 'gemini-2.5-pro-preview-05-06',   // Preview, likely strong multimodal including File API support.
    'flash-2.0': 'gemini-2.0-flash',              // Older, multimodal support generally for text+images, very limited file API.
    'flash-lite-2.0': 'gemini-2.0-flash-lite',    // Older, likely limited multimodal.
    'image-gen-2.0': 'gemini-2.0-flash-preview-image-generation', // Warning: Image generation ONLY. Not for chat/understanding.
    'flash-latest': 'gemini-1.5-flash-latest',    // Stable, good for images+text. Some File API for specific types.
    'pro-latest': 'gemini-1.5-pro-latest'         // Stable, BEST for PDF, long video/audio via File API.
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

// Helper to check if a model supports File API for non-image types
function modelSupportsFileAPI(modelName) {
    // These models are generally known to support File API for various types
    return modelName.includes('1.5-pro') || modelName.includes('2.5-pro-preview');
    // Note: 1.5-flash might support *some* file types (e.g., specific image formats),
    // but Pro models are best for documents/video/audio.
    // 2.0/2.5 Flash previews might have limited/experimental file support.
}

// --- Helper Functions ---

// Function to download a file from Telegram and get its buffer
async function downloadFileBuffer(fileId) {
    try {
        const fileUrl = await bot.telegram.getFileLink(fileId);
        const response = await axios({
            url: fileUrl.href,
            method: 'GET',
            responseType: 'arraybuffer' // Get data as array buffer
        });
        return Buffer.from(response.data);
    } catch (error) {
        console.error(`Error downloading file (ID: ${fileId}):`, error);
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
        // Use the library's uploadFile method which handles the File API protocol
        const uploadResult = await fileService.uploadFile(buffer, {
             mimeType: mimeType,
             displayName: fileName, // Optional display name for Gemini
        });

        const file = uploadResult.file; // Get the file object with FID and URI (e.g., files/FID123)
        console.log(`File uploaded to Gemini File API: Name=${file.name}, URI=${file.uri}`); // file.name is the FID
        return file; // Return the file object
    } catch (error) {
        console.error(`Error uploading file "${fileName}" (${mimeType}) to Gemini File API:`, error);
         if (error.response && error.response.data) {
             console.error('Gemini File API Error Response Data:', JSON.stringify(error.response.data, null, 2));
         }
        return null;
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
     // Note: URL Context is less common/supported now. Grounding (Google Search) is more standard.
    ctx.reply(`Инструмент URL Context ${ctx.session.tools.urlContext ? 'включен' : 'выключен'}. (Этот инструмент может быть устаревшим или требовать определенной модели)`);
});

// Toggle Grounding (Google Search) tool
bot.command('togglegrounding', (ctx) => {
    ctx.session.tools.googleSearch = !ctx.session.tools.googleSearch;
    ctx.reply(`Инструмент Заземление (Google Search) ${ctx.session.tools.googleSearch ? 'включен' : 'выключен'}.`);
});

// Set Model command
bot.command('setmodel', (ctx) => {
    const modelAlias = ctx.message.text.substring('/setmodel'.length).trim().toLowerCase();
    if (!modelAlias) {
        const modelsList = Object.keys(MODEL_ALIASES)
            .map(alias => `${alias}: ${AVAILABLE_MODELS[MODEL_ALIASES[alias]]}`)
            .join('\n');
        ctx.reply(`Доступные модели (псевдоним: имя API):\n${modelsList}\n\nТекущая модель: ${ctx.session.model}\nИспользуйте /setmodel <псевдоним> для выбора.`);
        return;
    }

    const apiModelName = AVAILABLE_MODELS[MODEL_ALIASES[modelAlias]];
    if (apiModelName) {
        ctx.session.model = apiModelName;
        let replyText = `Модель установлена на ${ctx.session.model}.`;

        if (MODEL_ALIASES[modelAlias] === 'image-gen-2.0') {
             replyText += `\nВнимание: Эта модель предназначена ТОЛЬКО для генерации изображений и может не работать для диалога или обработки входящих медиа.`;
        } else if (apiModelName.includes('preview')) {
             replyText += `\nВнимание: Это превью-модель, ее поведение может меняться.`;
        }
        if (!modelSupportsFileAPI(apiModelName)) {
             replyText += `\nЭта модель может иметь ограниченную поддержку мультимодальных данных (PDF, видео, аудио). Для лучшей поддержки рекомендуется использовать 'latest-pro' или 'pro2.5'.`;
        }

        ctx.reply(replyText);
    } else {
        ctx.reply(`Неизвестное имя модели или псевдоним: "${modelAlias}". Используйте /setmodel без аргументов, чтобы увидеть список доступных моделей.`);
    }
});

// Show Tokens command
bot.command('showtokens', (ctx) => {
    // Note: This is a cumulative estimate based on total tokens reported by the API (input + output).
    // If usageMetadata is not available, it might fall back to input-only estimate depending on code.
    ctx.reply(`Общее количество использованных токенов (приблизительно): ${ctx.session.totalTokens}.`);
});


// --- Message Handler (Main Logic for Gemini Interaction) ---

// Use bot.on('message') to capture all message types
bot.on('message', async (ctx) => {
    // Ignore commands handled above
    if (ctx.message.text && ctx.message.text.startsWith('/')) {
        console.log(`Ignoring message as it appears to be a command: ${ctx.message.text}`);
        return;
    }

    let messageText = null; // Text from message or caption
    const currentUserMessageParts = []; // Parts array for the current user message

    // 1. Extract text (caption or message text)
    if (ctx.message.text) {
        messageText = ctx.message.text;
        currentUserMessageParts.push({ text: messageText });
        console.log(`Received text message from ${ctx.from.id}: ${messageText}`);
    } else if (ctx.message.caption) {
        messageText = ctx.message.caption;
        currentUserMessageParts.push({ text: messageText });
        console.log(`Received media with caption from ${ctx.from.id}: ${messageText}`);
    }

    // 2. Handle media (photos, videos, documents, voice, video_note)
    let fileId = null;
    let telegramProvidedMimeType = null;
    let fileName = null;

    if (ctx.message.photo) {
        fileId = ctx.message.photo[ctx.message.photo.length - 1].file_id;
        telegramProvidedMimeType = 'image/jpeg'; // Common format for photos on Telegram
        fileName = `${fileId}.jpg`;
        console.log(`Handling photo (file_id: ${fileId})`);

    } else if (ctx.message.video) {
         fileId = ctx.message.video.file_id;
         telegramProvidedMimeType = ctx.message.video.mime_type || 'video/mp4';
         fileName = ctx.message.video.file_name || `${fileId}.mp4`;
         console.log(`Handling video (file_id: ${fileId}, mime_type: ${telegramProvidedMimeType})`);

    } else if (ctx.message.document) {
         fileId = ctx.message.document.file_id;
         telegramProvidedMimeType = ctx.message.document.mime_type || 'application/octet-stream';
         fileName = ctx.message.document.file_name || `${fileId}.dat`;
         console.log(`Handling document (file_id: ${fileId}, mime_type: ${telegramProvidedMimeType}, file_name: ${fileName})`);

    } else if (ctx.message.voice) {
         fileId = ctx.message.voice.file_id;
         telegramProvidedMimeType = ctx.message.voice.mime_type || 'audio/ogg'; // Voice notes are often Ogg Opus
         fileName = `${fileId}.ogg`;
         console.log(`Handling voice message (file_id: ${fileId}, mime_type: ${telegramProvidedMimeType})`);

    } else if (ctx.message.video_note) {
         fileId = ctx.message.video_note.file_id;
         telegramProvidedMimeType = ctx.message.video_note.mime_type || 'video/mp4'; // Video Notes are typically mp4
         fileName = `${fileId}.mp4`;
         console.log(`Handling video note (file_id: ${fileId}, mime_type: ${telegramProvidedMimeType})`);
    }
    // Add handlers for other media types (e.g., audio, sticker, animation) as needed
    // For sticker, animation, you can echo them back without Gemini if preferred.

    // If a file ID was found, process it for Gemini
    if (fileId) {
        const currentModel = ctx.session.model;
        const supportsFileAPI = modelSupportsFileAPI(currentModel);
        const isImage = telegramProvidedMimeType && telegramProvidedMimeType.startsWith('image/');
        const isPdf = telegramProvidedMimeType === 'application/pdf';

        // Decide whether to use inline_data (Base64) or File API
        // Inline data is simpler for images, File API for larger/other types
        const useInlineData = isImage && telegramProvidedMimeType !== 'image/gif'; // GIFs can be large, might exceed inline limits, but also less frequently used for analysis
        const useFileAPI = (supportsFileAPI && (isPdf || !isImage)) || (!useInlineData && isImage); // Use File API for PDF, Video, Audio, or if inline fails/is not preferred for images

        if (useFileAPI) {
             console.log(`Processing file ${fileId} (${telegramProvidedMimeType}) using File API for model ${currentModel}...`);
             const fileBuffer = await downloadFileBuffer(fileId);

             if (fileBuffer) {
                 const uploadedFile = await uploadFileToGemini(fileBuffer, telegramProvidedMimeType, fileName);

                 if (uploadedFile && uploadedFile.uri) {
                     currentUserMessageParts.push({
                         fileData: {
                             mime_type: telegramProvidedMimeType,
                             uri: uploadedFile.uri
                         }
                     });
                     console.log(`Added fileData part (URI: ${uploadedFile.uri}) to prompt parts for model ${currentModel}.`);
                     // TODO: In a production app, track file URIs for deletion after use or expiry.
                 } else {
                     console.warn(`Failed to upload file ${fileId} (${telegramProvidedMimeType}) to Gemini File API.`);
                     currentUserMessageParts.push({ text: `[Ошибка: не удалось загрузить файл (${telegramProvidedMimeType}) в Gemini File API.]` });
                 }
             } else {
                 console.warn(`Failed to download file buffer for ${fileId} (${telegramProvidedMimeType}).`);
                 currentUserMessageParts.push({ text: `[Ошибка: не удалось скачать файл (${telegramProvidedMimeType}) из Telegram.]` });
             }

        } else if (useInlineData) {
             console.log(`Processing file ${fileId} (${telegramProvidedMimeType}) as inline data for model ${currentModel}...`);
             try {
                 const fileData = await downloadFileAsBase64(fileId);

                 if (fileData && fileData.data && fileData.mimeType.startsWith('image/')) {
                      currentUserMessageParts.push({
                          inline_data: {
                              mime_type: fileData.mimeType,
                              data: fileData.data
                          }
                      });
                      console.log(`Added image part (MIME: ${fileData.mimeType}) as inline data.`);
                 } else {
                     console.warn(`Could not process file ${fileId} as inline image. Detected MIME: ${fileData ? fileData.mimeType : 'N/A'}.`);
                     currentUserMessageParts.push({ text: `[Ошибка: не удалось обработать файл (${telegramProvidedMimeType}) как встроенное изображение.]` });
                 }
             } catch (error) {
                 console.error('Error processing file for inline data:', error);
                  currentUserMessageParts.push({ text: `[Ошибка: произошла ошибка при обработке файла (${telegramProvidedMimeType}).]` });
             }
        } else {
            // File type is not supported by current methods/model
            console.warn(`File type "${telegramProvidedMimeType}" is not fully supported for processing with the selected model (${currentModel}) or via current methods (inline/File API).`);
            currentUserMessageParts.push({ text: `[Файл типа ${telegramProvidedMimeType} не поддерживается выбранной моделью (${currentModel}) или методом обработки.]` });
        }
    } // End if (fileId)

    // If no parts were generated from text or file, it's an unhandled message type (sticker, location, etc.)
    if (currentUserMessageParts.length === 0) {
        console.warn("Current message parts are empty after processing. Skipping Gemini call.");
        console.log(`Received completely unhandled message type. ctx.message:`, ctx.message);
        ctx.reply('Извините, я пока умею обрабатывать для ответа через Gemini только текст, фото, видео, документы (включая PDF), голосовые сообщения и видео-сообщения (с текстом или без), при условии поддержки выбранной моделью.');
        return; // Stop processing if no valid parts to send
    }

    // 3. Build the full contents array for the Gemini API call
    // The contents array should be the conversation history + the current user turn,
    // in chronological order (oldest first).
    const contents = [
        ...ctx.session.history, // Add historical turns first
        { role: 'user', parts: currentUserMessageParts } // Add the current user turn last
    ];

    // 4. Prepare tools based on user settings
    const tools = [];
    if (ctx.session.tools.googleSearch) {
        tools.push({ googleSearch: {} });
         console.log('Google Search tool enabled for this call.');
    }
    // URL Context is less commonly used/supported as a generic tool via standard APIs now.
    // If it's enabled, we log a warning but don't add it to tools array for the API call.
    if (ctx.session.tools.urlContext) {
         console.warn('URL Context tool is enabled but might not be supported by the model or via standard tools configuration.');
    }

    // 5. Call Gemini API
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

    try {
        // Get the generative model instance
        // Pass system instruction as a top-level parameter to getGenerativeModel
        // This is the correct way for the Node.js client library, aligning with Java example's config.systemInstruction
        const model = genAI.getGenerativeModel({
            model: ctx.session.model,
            tools: tools.length > 0 ? tools : undefined,
            safetySettings: [
                { category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: HarmBlockThreshold.BLOCK_NONE, },
                { category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.BLOCK_NONE, },
                { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH, threshold: HarmBlockThreshold.BLOCK_NONE, },
                { category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, threshold: HarmBlockThreshold.BLOCK_NONE, },
                // Add other safety settings categories as needed
            ],
            system: ctx.session.systemInstruction ? { parts: [{ text: ctx.session.systemInstruction }] } : undefined, // System instruction part
            generationConfig: {
                 // You could add other generation parameters here, e.g., temperature, top_p, etc.
            }
        });

        // Call generateContent with the prepared contents
        console.log('Calling generateContent for model', ctx.session.model, 'with contents:', JSON.stringify(contents));
        const result = await model.generateContent({
             contents: contents, // Pass the full conversation history + current message
             tools: tools.length > 0 ? tools : undefined, // Re-pass tools here if model requires it for multimodal context
        });

        const response = result.response;

        // Extract text from response candidates. A response might have multiple candidates.
        if (response && response.candidates && response.candidates.length > 0 && response.candidates[0].content && response.candidates[0].content.parts && response.candidates[0].content.parts.length > 0) {
             geminiResponseText = response.candidates[0].content.parts
                 .map(part => part.text) // Get text from each part
                 .filter(text => text !== undefined) // Filter out non-text parts if any
                 .join(''); // Join multiple text parts into a single string
        } else {
             console.warn("Gemini response did not contain text parts.", response);
             geminiResponseText = 'Не удалось получить текстовый ответ от Gemini.';
        }

        // 6. Update Token Usage
        // The Node.js client library provides token counts in usageMetadata if available from the API response
         if (response.usageMetadata) {
             const totalTokensForCall = response.usageMetadata.totalTokenCount || 0;
             console.log(`Gemini API Usage Metadata for this call: Total=${totalTokensForCall}`);
             ctx.session.totalTokens += totalTokensForCall; // Add total tokens for this turn to cumulative total
         } else {
             // If usageMetadata is not available, try to estimate input tokens
             // This happens with some models or response types.
             try {
                 const tokenEstimation = await model.countTokens({
                     contents: contents,
                     tools: tools.length > 0 ? tools : undefined,
                     system: ctx.session.systemInstruction ? { parts: [{ text: ctx.session.systemInstruction }] } : undefined,
                 });
                 const inputTokens = tokenEstimation.totalTokens || 0;
                 ctx.session.totalTokens += inputTokens; // Add estimated input tokens to total
                 console.log(`Estimated Input tokens for this call (from countTokens): ${inputTokens}. Total cumulative (estimated): ${ctx.session.totalTokens}`);
                 // Accurate output token counting is not available without response metadata or further calls.
             } catch (tokenError) {
                 console.error('Error counting tokens after successful response:', tokenError);
             }
         }

        // 7. Update conversation history IF the Gemini call was successful and yielded a text response
        // Add the user's message parts and the bot's text reply to history
        ctx.session.history.push({ role: 'user', parts: currentUserMessageParts });
        if (geminiResponseText && geminiResponseText.trim().length > 0) {
            ctx.session.history.push({ role: 'model', parts: [{ text: geminiResponseText }] });
        } else {
             // If Gemini returned non-text or empty response, add an empty model turn
             // to keep history aligned, so roles alternate correctly.
             console.warn("Gemini response text was empty or only whitespace. Adding empty model turn to history to maintain turn structure.");
             ctx.session.history.push({ role: 'model', parts: [{ text: '' }] });
        }

        // Keep history length manageable (e.g., last 10 back-and-forth turns = 20 messages)
        const maxHistoryMessages = 20; // 10 user turns + 10 model turns
        if (ctx.session.history.length > maxHistoryMessages) {
            ctx.session.history = ctx.session.history.slice(-maxHistoryMessages);
        }
         console.log(`History size after turn: ${ctx.session.history.length}`);

    } catch (error) {
        console.error('Error calling Gemini API:', error);
        geminiResponseText = 'Произошла ошибка при обращении к Gemini API.';

        if (error.response && error.response.data) {
             console.error('Gemini API Error Response Data:', JSON.stringify(error.response.data, null, 2));
             if (error.response.data.error && error.response.data.error.message) {
                 geminiResponseText += ` Ошибка API: ${error.response.data.error.message}`;
                 // If the error indicates an issue with contents (e.g., empty parts), clear history for next attempt
                 if (error.response.data.error.message.includes('contents.parts must not be empty')) {
                     geminiResponseText += '\nВозможно, проблема с форматом сообщения или историей. Начните новый чат командой /newchat.';
                     ctx.session.history = []; // Clear history to prevent repeating the error
                     console.warn('History cleared due to contents.parts error.');
                 }
             }
        } else if (error.message) {
            geminiResponseText += ` Ошибка: ${error.message}`;
        }

         // Add the user's message to history even if the API call failed,
         // so the context of the attempt is preserved for the next message,
         // unless history was already cleared due to a specific error.
         if (currentUserMessageParts.length > 0 && ctx.session.history.length === 0 || ctx.session.history[ctx.session.history.length - 1].parts !== currentUserMessageParts) {
             ctx.session.history.push({ role: 'user', parts: currentUserMessageParts });
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

    // 8. Send final response to Telegram
    try {
        if (!geminiResponseText || geminiResponseText.trim().length === 0) {
             console.warn("Final Gemini response text was empty, sending a default message.");
             if (!geminiResponseText.startsWith('Произошла ошибка')) { // Avoid sending default if already an error message
                 await ctx.reply("Не удалось сгенерировать ответ. Попробуйте еще раз или измените запрос/настройки.");
             } else {
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

// Optional: Enable graceful stop
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));

// --- Additional Helper for Base64 Download (needed for inline images, moved outside) ---
// Note: This function is primarily for inline_data. For File API, downloadFileBuffer is used.
async function downloadFileAsBase64(fileId) {
    try {
        const fileUrl = await bot.telegram.getFileLink(fileId);
        const response = await axios({
            url: fileUrl.href,
            method: 'GET',
            responseType: 'arraybuffer' // Get data as array buffer
        });

        let mimeType = 'application/octet-stream'; // Default unknown
        const buffer = Buffer.from(response.data);

        // Basic mime type detection for images from buffer signature
        if (buffer.length >= 4) {
             const signature = buffer.subarray(0, 4).toString('hex').toUpperCase();
             if (signature === '89504E47') mimeType = 'image/png';
             else if (signature === '47494638') mimeType = 'image/gif';
             else if (signature.startsWith('FFD8')) mimeType = 'image/jpeg'; // Common JPEG start
             // For WebP (RIFF, WEBP), it's more complex, could check bytes 0-3 (RIFF) and 8-11 (WEBP)
             // else if (buffer.length >= 12 && buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP') mimeType = 'image/webp';
        }
        // More robust detection would involve a library like 'file-type' if needed.

        const base64 = buffer.toString('base64');
        return { data: base64, mimeType: mimeType };
    } catch (error) {
        console.error(`Error downloading or converting file (ID: ${fileId}) to Base64:`, error);
        return null;
    }
}