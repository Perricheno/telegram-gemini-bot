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

// --- Session Management ---
// Use in-memory session for simplicity in this example.
// For production, use a persistent store like Redis, MongoDB, or Firestore.
// https://telegraf.js.org/#/middlewares?id=session
bot.use(session({ property: 'session' }));

// Middleware to initialize session defaults if not present
bot.use((ctx, next) => {
    if (!ctx.session || typeof ctx.session !== 'object') {
        ctx.session = {
            history: [],
            systemInstruction: null,
            model: 'gemini-1.5-flash-latest', // Default model
            tools: {
                urlContext: false,
                googleSearch: false,
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
// Models based on user's screenshot and provided code + common stable models
const AVAILABLE_MODELS = {
    'flash-04-17': 'gemini-2.5-flash-preview-04-17',
    'flash-05-20': 'gemini-2.5-flash-preview-05-20',
    'pro-05-06': 'gemini-2.5-pro-preview-05-06',
    'flash-2.0': 'gemini-2.0-flash', // Note: gemini-2.0 models might have different capabilities/availability
    'flash-lite-2.0': 'gemini-2.0-flash-lite',
    'image-gen-2.0': 'gemini-2.0-flash-preview-image-generation', // Warning: Image generation only
    'flash-latest': 'gemini-1.5-flash-latest', // Current stable Flash model (good starting point)
    'pro-latest': 'gemini-1.5-pro-latest' // Current stable Pro model (better for multimodal and longer context)
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
    'default': 'flash-latest', // Alias for the default
     'flash1.5': 'flash-latest', // Common alias
     'pro1.5': 'pro-latest' // Common alias
};


// --- Helper Functions ---

// Function to download a file from Telegram and get Base64 data
async function downloadFileAsBase64(fileId) {
    try {
        const fileUrl = await bot.telegram.getFileLink(fileId);
        const response = await axios({
            url: fileUrl.href,
            method: 'GET',
            responseType: 'arraybuffer' // Get data as array buffer
        });

        // Basic mime type detection based on file signature (magic numbers)
        // This is not foolproof but works for common types.
        // More robust solutions might inspect file content or rely on Telegram's provided mime_type where available.
        let mimeType = 'application/octet-stream'; // Default unknown
        const buffer = Buffer.from(response.data);
        const signature = buffer.toString('hex').toUpperCase();

        if (signature.startsWith('89504E47')) mimeType = 'image/png'; // PNG
        else if (signature.startsWith('47494638')) mimeType = 'image/gif'; // GIF
        else if (signature.startsWith('FFD8FF')) mimeType = 'image/jpeg'; // JPEG
        else if (signature.startsWith('52494646') && signature.substring(8, 12) === '57454250') mimeType = 'image/webp'; // WebP
        // Add more signatures for other media types if needed (e.g., audio, video)
        // Telegram's API often provides mime_type in the message object for certain media types.
        // For a robust solution, combine this with ctx.message.media_type.mime_type if available.

        const base64 = buffer.toString('base64');
        return { data: base64, mimeType: mimeType };
    } catch (error) {
        console.error(`Error downloading or converting file (ID: ${fileId}):`, error);
        return null;
    }
}

// --- Command Handlers ---

// Start command - Welcome message
bot.start((ctx) => {
    ctx.reply('Привет! Я Telegram бот с интеграцией Gemini. Отправь мне текст или фото с текстом, и я отвечу. Используй команды для настройки:\n' +
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
     ctx.reply('Доступные команды:\n' +
              '/start - приветственное сообщение\n' +
              '/newchat - начать новый чат\n' +
              '/setsysteminstruction <текст> - задать системные инструкции\n' +
              '/toggletalkmode - включить/выключить "режим мышления"\n' +
              '/toggleurlcontext - включить/выключить URL контекст (Инструмент)\n' +
              '/togglegrounding - включить/выключить Заземление (Поиск Google, Инструмент)\n' +
              '/setmodel <имя модели> - выбрать модель Gemini\n' +
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
    ctx.reply(`Инструмент URL Context ${ctx.session.tools.urlContext ? 'включен' : 'выключен'}.`);
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
            .map(alias => `${alias} (${AVAILABLE_MODELS[MODEL_ALIASES[alias]]})`)
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
         if (!['flash-latest', 'pro-latest'].includes(alias)) {
              replyText += `\nДля лучшей поддержки диалога и медиа рекомендуется использовать 'latest-flash' или 'latest-pro'.`;
         }
        ctx.reply(replyText);
    } else {
        ctx.reply(`Неизвестное имя модели или псевдоним: "${modelName}". Используйте /setmodel без аргументов, чтобы увидеть список доступных моделей.`);
    }
});

// Show Tokens command
bot.command('showtokens', (ctx) => {
    // Note: This is a cumulative estimate based on INPUT tokens counted.
    // Accurate token counting for input + output requires checking the API response
    // metadata, which might vary by model and library version.
    ctx.reply(`Общее количество использованных токенов (приблизительно, в основном учитываются входящие токены): ${ctx.session.totalTokens}.`);
});


// --- Message Handler (Main Logic for Gemini Interaction) ---

// Use bot.on('message') to capture all message types
bot.on('message', async (ctx) => {
    // Ignore commands handled above
    if (ctx.message.text && ctx.message.text.startsWith('/')) {
        // If it's a command, and not one of the explicit command handlers,
        // it might be an unknown command. We can add a reply for that,
        // but for this logic, we just return as command handlers run first.
        console.log(`Ignoring message as it appears to be a command: ${ctx.message.text}`);
        return;
    }

    let messageText = null; // Text from message or caption
    const currentUserMessageParts = []; // Parts array for the current user message

    // 1. Extract text and potentially file ID/data
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

    // Handle media (photos, videos, documents, etc.)
    let fileId = null;
    let telegramProvidedMimeType = null; // Mime type provided by Telegram if available

    if (ctx.message.photo) {
        // Photo: get the largest size file_id
        fileId = ctx.message.photo[ctx.message.photo.length - 1].file_id;
        // Telegram does not provide mime_type directly in photo object, detect during download
        telegramProvidedMimeType = 'image/*'; // Hint/placeholder
        console.log(`Received photo (file_id: ${fileId})`);
    } else if (ctx.message.video) {
         fileId = ctx.message.video.file_id;
         telegramProvidedMimeType = ctx.message.video.mime_type || 'video/*';
         console.log(`Received video (file_id: ${fileId}, mime_type: ${telegramProvidedMimeType})`);
    } else if (ctx.message.document) {
         fileId = ctx.message.document.file_id;
         telegramProvidedMimeType = ctx.message.document.mime_type || 'application/*';
         console.log(`Received document (file_id: ${fileId}, mime_type: ${telegramProvidedMimeType})`);
    } else if (ctx.message.voice) {
         fileId = ctx.message.voice.file_id;
         telegramProvidedMimeType = ctx.message.voice.mime_type || 'audio/ogg';
         console.log(`Received voice message (file_id: ${fileId}, mime_type: ${telegramProvidedMimeType})`);
    } else if (ctx.message.video_note) {
         fileId = ctx.message.video_note.file_id;
         telegramProvidedMimeType = ctx.message.video_note.mime_type || 'video/mp4'; // Video Notes are typically mp4
         console.log(`Received video note (file_id: ${fileId}, mime_type: ${telegramProvidedMimeType})`);
    }
    // Add more media types as needed (audio, sticker, animation, etc.)
    // Note: Handling complex types like Location, Contact, Poll, Venue requires specific logic.

    // If a file ID was found, download the file and add it as an inline_data part
    if (fileId) {
        try {
            const fileData = await downloadFileAsBase64(fileId);

            if (fileData && fileData.data) {
                 // Check if Gemini model supports inline data for this MIME type
                 // Gemini 1.5 models support a range of image types, and Pro supports PDFs etc.
                 // Simple check: assume image types are generally supported.
                 if (fileData.mimeType.startsWith('image/')) {
                     currentUserMessageParts.push({
                         inline_data: {
                             mime_type: fileData.mimeType, // Use detected mime type
                             data: fileData.data
                         }
                     });
                     console.log(`Added image part (MIME: ${fileData.mimeType}) to prompt parts.`);
                 } else {
                     // For non-image files, add a text representation or note.
                     // Direct file upload as inline_data for non-image types might not be universally supported
                     // or requires specific model capabilities (like Gemini 1.5 Pro with file API).
                     console.warn(`File type "${fileData.mimeType}" (Telegram Mime: ${telegramProvidedMimeType}) might not be fully supported by the selected Gemini model for direct inline processing.`);
                     // Add a text part indicating the file was received
                     currentUserMessageParts.push({
                          text: `[Пользователь отправил файл типа: ${fileData.mimeType} (Telegram Mime: ${telegramProvidedMimeType || 'N/A'}), file_id: ${fileId}. Содержимое файла может быть не обработано.]`
                     });
                     // You might extend this to handle specific document types or use the File API with Gemini 1.5 Pro.
                 }

            } else {
                 console.error('Failed to get file data for fileId:', fileId);
                 // Add a text part indicating file download failed
                 currentUserMessageParts.push({ text: `[Не удалось обработать отправленный файл.]` });
            }

        } catch (error) {
            console.error('Error processing file for Gemini:', error);
             currentUserMessageParts.push({ text: `[Произошла ошибка при обработке отправленного файла.]` });
        }
    }

    // 2. Check if we have any parts to send to Gemini
     if (currentUserMessageParts.length === 0) {
         console.warn("Current message parts are empty after processing. Skipping Gemini call.");
         // Reply to the user if the message type wasn't handled at all
         if (!ctx.message.text && !ctx.message.caption && !fileId) {
              console.log(`Received completely unhandled message type. ctx.message:`, ctx.message);
              ctx.reply('Извините, я пока умею обрабатывать для ответа через Gemini только текст, фото, видео, документы, голосовые сообщения и видео-сообщения (с текстом или без).');
         } else if (fileId && currentUserMessageParts.length === 0) {
              // If there was a file but processing failed and no text/caption
               ctx.reply('Извините, возникла проблема с обработкой отправленного файла.');
         }
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
    if (ctx.session.tools.urlContext) {
        // Note: URL Context tool may have specific model requirements
        tools.push({ urlContext: {} });
        console.log('URL Context tool enabled for this call.');
    }
    if (ctx.session.tools.googleSearch) {
        // Note: Google Search tool may have specific model requirements
        tools.push({ googleSearch: {} });
         console.log('Google Search tool enabled for this call.');
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
    let inputTokens = 0; // Tokens for the current prompt (history + current turn)
    let outputTokens = 0; // Tokens for the model's reply

    try {
        // Get the generative model instance
        // Use the model name, tools, safety settings, and system instruction from session
        const model = genAI.getGenerativeModel({
            model: ctx.session.model,
            tools: tools.length > 0 ? tools : undefined, // Pass tools if any are enabled
            // Safety settings (example: block harmful content) - configure as needed
             safetySettings: [
                {
                    category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT,
                    threshold: HarmBlockThreshold.BLOCK_NONE, // Adjust as needed
                },
                 {
                    category: HarmCategory.HARM_CATEGORY_HARASSMENT,
                    threshold: HarmBlockThreshold.BLOCK_NONE, // Adjust as needed
                },
                 {
                    category: HarmCategory.HARM_CATEGORY_HATE_SPEECH,
                    threshold: HarmBlockThreshold.BLOCK_NONE, // Adjust as needed
                },
                 {
                    category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT,
                    threshold: HarmBlockThreshold.BLOCK_NONE, // Adjust as needed
                },
                 // Add other safety settings categories as needed
            ],
             system: ctx.session.systemInstruction || undefined, // Pass system instruction if set and supported by model/library
             generationConfig: {
                 // Add other generation parameters here based on potential future settings commands
                 // e.g., temperature: ctx.session.temperature, topP: ctx.session.topP
             }
        });

        // Call generateContent with the prepared contents, tools, and system instruction
        console.log('Calling generateContent with contents:', JSON.stringify(contents)); // Log contents being sent
        const result = await model.generateContent({
             contents: contents, // Pass the full conversation history + current message
             tools: tools.length > 0 ? tools : undefined, // Re-pass tools here as well
             system: ctx.session.systemInstruction || undefined, // Re-pass system instruction
        });

        const response = result.response;
        geminiResponseText = response.text(); // Get the text from the response

        // 6. Update Token Usage
        // The Node.js client library provides token counts in usageMetadata if available from the API
         if (response.usageMetadata) {
             inputTokens = response.usageMetadata.promptTokenCount || 0;
             outputTokens = response.usageMetadata.candidatesTokenCount || 0;
             const totalTokensForCall = response.usageMetadata.totalTokenCount || 0;
             // Note: totalTokenCount should be inputTokens + outputTokens
             console.log(`Gemini API Usage Metadata: Input=${inputTokens}, Output=${outputTokens}, Total=${totalTokensForCall}`);
             ctx.session.totalTokens += totalTokensForCall; // Add total tokens for this turn to cumulative total
         } else {
             // If usageMetadata is not available in the response, try to estimate input tokens
             try {
                 const tokenEstimation = await model.countTokens({
                     contents: contents,
                     tools: tools.length > 0 ? tools : undefined,
                     system: ctx.session.systemInstruction || undefined,
                 });
                 inputTokens = tokenEstimation.totalTokens || 0;
                 ctx.session.totalTokens += inputTokens; // Add estimated input tokens to total
                 console.log(`Estimated Input tokens for this call (from countTokens): ${inputTokens}. Total cumulative (estimated): ${ctx.session.totalTokens}`);
                 // Accurate output token counting is not available without response metadata or further calls.
             } catch (tokenError) {
                 console.error('Error counting tokens after successful response:', tokenError);
                 // Proceed without updating token count if counting fails
             }
         }


        // 7. Update conversation history IF the Gemini call was successful and yielded a text response
        if (geminiResponseText) {
            // Add the user's message and the bot's text reply to history
            // Store the parts that were actually sent to Gemini for the user turn
            ctx.session.history.push({ role: 'user', parts: currentUserMessageParts });
            ctx.session.history.push({ role: 'model', parts: [{ text: geminiResponseText }] });

            // Keep history length manageable (e.g., last 10 back-and-forth turns = 20 messages)
            const maxHistoryMessages = 20;
            if (ctx.session.history.length > maxHistoryMessages) {
                ctx.session.history = ctx.session.history.slice(-maxHistoryMessages);
            }
             console.log(`History size after successful turn: ${ctx.session.history.length}`);
        } else {
             console.warn("Gemini response text was empty. Not adding to history.");
             // Optionally add the user's message even if Gemini gave no text response,
             // but be cautious if this leads to empty model turns in history later.
             // ctx.session.history.push({ role: 'user', parts: currentUserMessageParts });
             // console.log(`User message added to history despite empty Gemini response. History size: ${ctx.session.history.length}`);
        }


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

         // Decide how to handle history on error.
         // Adding the user's message is generally good, but adding a failed model turn is not.
         // Let's add the user's message to history so the context of the attempt is preserved.
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
             } catch (deleteError) {
                 console.error('Error deleting "Thinking..." message:', deleteError);
                 // Ignore deletion errors, as the message might have failed to send or already been deleted
             }
         }
    }


    // 8. Send final response to Telegram
    try {
        // If the Gemini response text is empty or only whitespace, send a default message
        if (!geminiResponseText || geminiResponseText.trim().length === 0) {
             console.warn("Gemini response text was empty, sending a default message.");
             await ctx.reply("Не удалось сгенерировать ответ. Попробуйте еще раз или измените запрос/настройки.");
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
// This middleware handles processing the incoming webhook request and passing it to the bot instance.
app.use(bot.webhookCallback('/webhook'));

// Root endpoint for status check
app.get('/', (req, res) => {
    res.send('Telegram Bot server is running and waiting for webhooks at /webhook. Gemini integration enabled.');
});

// --- Start Server ---
// The Express server listens for incoming HTTP requests on the specified port.
app.listen(port, () => {
    console.log(`Server running on port ${port}`);
    console.log(`Webhook endpoint configured at /webhook`);
    console.log(`Telegram Bot Token loaded.`); // Check for token loaded happens earlier
    console.log(`Gemini API Key loaded.`); // Check for key loaded happens earlier
    console.log('Awaiting incoming webhooks from Telegram...');
});

// Important: Do NOT call bot.launch() when using webhooks.
// The Express server handles incoming requests which are then processed by bot.webhookCallback.

// Optional: Enable graceful stop (for local development or specific environments)
// process.once('SIGINT', () => bot.stop('SIGINT'));
// process.once('SIGTERM', () => bot.stop('SIGTERM'));