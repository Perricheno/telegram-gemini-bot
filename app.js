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
bot.use(session({ property: 'session' }));

// Middleware to initialize session defaults if not present
bot.use((ctx, next) => {
    if (!ctx.session) {
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
// Models based on user's screenshot and provided code
const AVAILABLE_MODELS = {
    'flash-04-17': 'gemini-2.5-flash-preview-04-17',
    'flash-05-20': 'gemini-2.5-flash-preview-05-20',
    'pro-05-06': 'gemini-2.5-pro-preview-05-06',
    'flash-2.0': 'gemini-2.0-flash',
    'flash-lite-2.0': 'gemini-2.0-flash-lite',
    'image-gen-2.0': 'gemini-2.0-flash-preview-image-generation', // Note: This model is for image generation, not text/multimodal chat. We'll list it but advise against using it for chat.
    'flash-latest': 'gemini-1.5-flash-latest', // Added a current stable Flash model
    'pro-latest': 'gemini-1.5-pro-latest' // Added a current stable Pro model (better for multimodal)
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
    'default': 'flash-latest' // Alias for the default
};


// --- Helper Functions ---

// Function to download a file from Telegram and get Base64 data
async function downloadFileAsBase64(fileId) {
    try {
        const fileUrl = await bot.telegram.getFileLink(fileId);
        const response = await axios({
            url: fileUrl.href,
            method: 'GET',
            responseType: 'arraybuffer'
        });
        // Detect mime type (basic detection for common image types)
        let mimeType = 'application/octet-stream'; // Default
        const signature = Buffer.from(response.data).toString('hex').toUpperCase();
        if (signature.startsWith('89504E47')) mimeType = 'image/png';
        else if (signature.startsWith('47494638')) mimeType = 'image/gif';
        else if (signature.startsWith('FFD8FF')) mimeType = 'image/jpeg';
         else if (signature.startsWith('52494646') && signature.substring(8, 12) === '57454250') mimeType = 'image/webp';


        const base64 = Buffer.from(response.data).toString('base64');
        return { data: base64, mimeType: mimeType };
    } catch (error) {
        console.error('Error downloading or converting file:', error);
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
              '/toggleurlcontext - включить/выключить URL контекст\n' +
              '/togglegrounding - включить/выключить заземление (Google Search)\n' +
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
              '/toggleurlcontext - включить/выключить URL контекст\n' +
              '/togglegrounding - включить/выключить заземление (Google Search)\n' +
              '/setmodel <имя модели> - выбрать модель Gemini\n' +
              '/showtokens - показать использованные токены');
});


// New Chat command - clear conversation history
bot.command('newchat', (ctx) => {
    ctx.session.history = [];
    ctx.reply('Начат новый чат. Предыдущая история удалена.');
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
        const modelsList = Object.keys(MODEL_ALIASES).map(alias => `${alias} (${AVAILABLE_MODELS[MODEL_ALIASES[alias]]})`).join('\n');
        ctx.reply(`Доступные модели (и их псевдонимы):\n${modelsList}\nТекущая модель: ${ctx.session.model}\nИспользуйте /setmodel <имя модели> для выбора.`);
        return;
    }

    const alias = MODEL_ALIASES[modelName];
    if (alias && AVAILABLE_MODELS[alias]) {
        ctx.session.model = AVAILABLE_MODELS[alias];
         if (alias === 'image-gen-2.0') {
             ctx.reply(`Модель установлена на ${ctx.session.model}. Внимание: Эта модель предназначена ТОЛЬКО для генерации изображений и может не работать для диалога или обработки входящих медиа.`);
         } else if (alias.includes('preview')) {
              ctx.reply(`Модель установлена на ${ctx.session.model}. Внимание: Это превью-модель, ее поведение может меняться.`);
         }
        else {
            ctx.reply(`Модель установлена на ${ctx.session.model}.`);
        }
    } else {
        ctx.reply(`Неизвестное имя модели или псевдоним: "${modelName}". Используйте /setmodel без аргументов, чтобы увидеть список доступных моделей.`);
    }
});

// Show Tokens command
bot.command('showtokens', (ctx) => {
    ctx.reply(`Общее количество использованных токенов (приблизительно): ${ctx.session.totalTokens}.`);
});


// --- Message Handler (Main Logic) ---

bot.on('message', async (ctx) => {
    let userMessage = null; // Content part for the current user message
    let messageText = null; // Text from message or caption

    // 1. Extract text and potentially file ID
    if (ctx.message.text) {
        messageText = ctx.message.text;
        userMessage = { text: messageText };
        console.log(`Received text message from ${ctx.from.id}: ${messageText}`);
    } else if (ctx.message.caption) {
        // This is a media message with a caption
        messageText = ctx.message.caption;
        console.log(`Received media with caption from ${ctx.from.id}: ${messageText}`);
    }

    // Handle media (photos, videos, documents, etc.)
    let fileId = null;
    let mimeType = null;

    if (ctx.message.photo) {
        // Photo: get the largest size
        fileId = ctx.message.photo[ctx.message.photo.length - 1].file_id;
        // Telegram doesn't provide mime type here, will detect during download
        mimeType = 'image/*'; // Hint for Gemini
        console.log(`Received photo (file_id: ${fileId})`);
    } else if (ctx.message.video) {
         fileId = ctx.message.video.file_id;
         mimeType = ctx.message.video.mime_type || 'video/*';
         console.log(`Received video (file_id: ${fileId})`);
    } else if (ctx.message.document) {
         fileId = ctx.message.document.file_id;
         mimeType = ctx.message.document.mime_type || 'application/*';
         console.log(`Received document (file_id: ${fileId})`);
    } else if (ctx.message.voice) {
         fileId = ctx.message.voice.file_id;
         mimeType = ctx.message.voice.mime_type || 'audio/ogg';
         console.log(`Received voice message (file_id: ${fileId})`);
    } else if (ctx.message.video_note) {
         fileId = ctx.message.video_note.file_id;
         mimeType = ctx.message.video_note.mime_type || 'video/mp4';
         console.log(`Received video note (file_id: ${fileId})`);
    }
    // Note: Other types like stickers, animations, location, contacts are not handled here.


    // 2. Prepare content for Gemini API
    const contents = [{
        role: 'user',
        parts: []
    }];

    if (ctx.session.systemInstruction) {
         // Add system instruction if set
         // Note: System instructions are typically set ONCE when starting a chat
         // or when the model supports them as a separate parameter.
         // For models where it's not a separate param, it can be the first message
         // in the history, but the API handles this best internally.
         // Let's include it as the first part of the *initial* history for models that
         // might not have native system instruction support as a separate param.
         // Or, better, use the systemInstruction parameter if available in the library/model.
         // The `@google/generative-ai` library uses a separate `system` parameter in `startChat` or `generateContent`.
         // Let's use that if the model supports it. For now, we'll just set the parameter.
         // The Java code implies it might be part of the content, let's stick to the Node.js library's `system` parameter for clarity.
    }


    // Add historical messages to content (excluding system instruction if handled separately)
    ctx.session.history.forEach(msg => {
        contents.unshift(msg); // Add to the beginning for history
    });


    if (fileId) {
        // Handle media messages
        try {
             // Download the file and get Base64 data
            const fileData = await downloadFileAsBase64(fileId);

            if (fileData && fileData.data) {
                 if (fileData.mimeType.startsWith('image/')) {
                     // Add image part
                    contents[0].parts.push({
                        inline_data: {
                            mime_type: fileData.mimeType,
                            data: fileData.data
                        }
                    });
                    console.log(`Added image part (MIME: ${fileData.mimeType}) to prompt.`);
                 } else {
                     // Handle other file types - Gemini 1.5 Pro can handle PDFs, etc.
                     // This requires sending the file bytes. For simplicity and given
                     // the *listed* models (mostly 2.0 Flash previews), full file handling
                     // for non-images might not be universally supported or require
                     // specific model versions (like 1.5 Pro).
                     // Let's add a note and potentially send as text if it's a known type
                     // that can be represented as text (like a document name).
                     console.warn(`File type "${fileData.mimeType}" might not be fully supported by the selected Gemini model for direct processing.`);
                     // You might extend this to handle specific file types with specific models
                     // For now, we'll rely on the caption text if available, and add a message
                     // indicating the file type was received.
                     contents[0].parts.push({
                         text: `[Пользователь отправил файл типа: ${fileData.mimeType}, file_id: ${fileId}]`
                     });
                 }

            } else {
                 console.error('Failed to get file data for fileId:', fileId);
                 // Add a text part indicating file download failed
                 contents[0].parts.push({ text: `[Не удалось обработать отправленный файл.]` });
            }

        } catch (error) {
            console.error('Error processing file for Gemini:', error);
             contents[0].parts.push({ text: `[Произошла ошибка при обработке отправленного файла.]` });
        }
    }

    // Add text part (caption for media, or the message text for pure text)
    if (messageText) {
        contents[0].parts.push({ text: messageText });
    } else if (!fileId) {
        // If no text and no file, it might be an unhandled message type (e.g., sticker)
        // Inform the user that this type is not supported for AI processing.
        console.log(`Received unhandled message type. ctx.message:`, ctx.message);
        ctx.reply('Извините, я пока умею обрабатывать только текст и фото с текстом для ответа через Gemini.');
        return; // Stop processing if it's an unhandled type
    }


    // Check if the message parts are empty after processing text and file
     if (contents[0].parts.length === 0) {
         console.warn("Message parts are empty, skipping Gemini call.");
         ctx.reply("Не удалось извлечь текст или медиа из вашего сообщения для обработки.");
         return;
     }

    // 3. Prepare tools based on user settings
    const tools = [];
    if (ctx.session.tools.urlContext) {
        tools.push({ urlContext: {} });
        console.log('URL Context tool enabled.');
    }
    if (ctx.session.tools.googleSearch) {
        tools.push({ googleSearch: {} });
         console.log('Google Search tool enabled.');
    }

    // 4. Call Gemini API
    if (ctx.session.talkMode) {
        await ctx.reply('Думаю...'); // "Thinking mode" message
    }

    let geminiResponseText = 'Не удалось получить ответ от Gemini.';
    let outputTokens = 0;
    let inputTokens = 0;

    try {
        // Get the generative model
        // Use the model parameter directly from the session
        const model = genAI.getGenerativeModel({
            model: ctx.session.model,
            tools: tools.length > 0 ? tools : undefined, // Pass tools if any are enabled
            // Safety settings (example: block harmful content)
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
            ],
             system: ctx.session.systemInstruction || undefined, // Pass system instruction if set
             generationConfig: {
                 // You could add other generation parameters here, e.g., temperature, top_p, etc.
                 // based on further "Thinking mode" interpretations or advanced settings commands.
             }
        });

        // For chat-based models, use startChat and sendMessage
        // For generateContent (potentially single-turn or specific models), use generateContent
        // Given we have history, startChat/sendMessage is more appropriate if the model supports it.
        // Multimodal input with history is best handled by sending the full conversation context
        // in each `generateContent` call, or using `startChat` if the model supports multimodal
        // turns within a session. The `generateContent` approach is more universally
        // applicable across model types and is similar to your Java example.

        const result = await model.generateContent({
             contents: contents, // Pass the full conversation history + current message
             tools: tools.length > 0 ? tools : undefined,
             system: ctx.session.systemInstruction || undefined, // Pass system instruction again if needed, depends on model/library handling
        });

        const response = result.response;
        geminiResponseText = response.text();

        // Get token usage (may vary by library version and model)
        // The Node.js library provides promptFeedback and candidates in the result
        // Token counts might be in `usageMetadata` or similar. Let's check the response structure.
        // If not directly available, we might need a separate call or rely on estimates.
         try {
            const tokenEstimation = await model.countTokens({
                contents: contents,
                 tools: tools.length > 0 ? tools : undefined,
                 system: ctx.session.systemInstruction || undefined,
            });
            inputTokens = tokenEstimation.totalTokens;
            // Estimating output tokens is harder without the response structure explicitly providing it.
            // We could estimate based on response text length or make another API call.
            // For simplicity, let's just count input tokens accurately and add an estimated amount for output.
            // A safer way is to use a model that provides usage metadata directly in the response.
            // Let's assume for now that the library might provide `usageMetadata` somewhere in `result` or `response`.
            // If not, we'll just track input tokens or skip accurate tracking for this example.

             // Let's check result.response.usageMetadata or similar
             if (result.response && result.response.usageMetadata && result.response.usageMetadata.totalTokenCount) {
                 // If the library provides total token count in the response metadata:
                 // Note: This field might not be present in all models/versions.
                 const totalTokensForCall = result.response.usageMetadata.totalTokenCount;
                 // This total includes prompt + response. We need to subtract input to get output.
                 // If inputTokens is also available in metadata:
                 // const inputTokensFromMetadata = result.response.usageMetadata.promptTokenCount;
                 // outputTokens = totalTokensForCall - inputTokensFromMetadata;
                 // inputTokens = inputTokensFromMetadata;

                 // If only total is available, we can't accurately separate input/output from this response object alone.
                 // We'll stick to the countTokens estimation for input and maybe estimate output.
                 // Let's refine: countTokens gives input. We need to count output separately or find it in the response.
                 // For a robust solution, one might call countTokens for the response text, or check the full API response structure.
                 // For this example, let's just add the input tokens to the total. A more accurate counter needs more work.
                 ctx.session.totalTokens += inputTokens; // Add input tokens to total
                 console.log(`Token usage: Input=${inputTokens}. Total cumulative=${ctx.session.totalTokens}`);

             } else {
                  // Fallback or simpler tracking: just add input tokens
                  ctx.session.totalTokens += inputTokens;
                  console.log(`Estimated Input tokens for this call: ${inputTokens}. Total cumulative (Input only estimate): ${ctx.session.totalTokens}`);
                  // Accurate output token counting requires more advanced handling or a model that provides it.
             }


         } catch (tokenError) {
             console.error('Error counting tokens:', tokenError);
             // Proceed without updating token count if counting fails
         }


        // Update conversation history if the call was successful
        // Add the user's message and the bot's reply to history
        ctx.session.history.push({ role: 'user', parts: contents[0].parts }); // Add user's message parts
        ctx.session.history.push({ role: 'model', parts: [{ text: geminiResponseText }] }); // Add bot's text reply

        // Keep history length manageable
        const maxHistoryLength = 20; // Example: keep last 10 back-and-forth turns
        if (ctx.session.history.length > maxHistoryLength) {
            ctx.session.history = ctx.session.history.slice(-maxHistoryLength);
        }
         console.log(`History size: ${ctx.session.history.length}`);


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

         // Do NOT add error message to history to avoid repeating errors
         // Keep only the user's message in history if the call failed
         if (contents[0].parts.length > 0) {
            ctx.session.history.push({ role: 'user', parts: contents[0].parts });
             // Optionally prune history to keep only the last user message before error
             // if (ctx.session.history.length > 1) ctx.session.history = [ctx.session.history.pop()];
         }
         console.log(`History size after error: ${ctx.session.history.length}`);

    }

    // 5. Send response to Telegram
    try {
         // Remove the "Думаю..." message if it was sent
         if (ctx.session.talkMode) {
             // This requires storing the message ID of "Думаю..." and deleting it
             // For simplicity in this example, we'll just send the final reply.
             // In a real bot, you'd capture the result of `await ctx.reply('Думаю...')`
             // and use `ctx.deleteMessage(messageId)` later.
         }

        await ctx.reply(geminiResponseText);
    } catch (replyError) {
        console.error('Error sending reply to Telegram:', replyError);
    }
});


// --- Webhook Setup ---
const app = express();
const port = process.env.PORT || 3000;

app.use(express.json()); // Middleware to parse JSON body

// Telegraf webhook middleware
// Use the bot.webhookCallback('/webhook') as before
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
// The Express server handles incoming requests which are then processed by bot.webhookCallback.

// Optional: Enable graceful stop
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));