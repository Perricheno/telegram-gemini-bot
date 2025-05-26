// app.js

/**
 * Telegram Bot with focused Gemini AI Integration.
 *
 * This bot handles various message types (text, photos, videos, documents, voice notes, video notes, audio, animations, stickers)
 * and processes them using Google's selected Gemini models via the Generative AI API.
 * It leverages Gemini's File API for larger multimedia content (PDFs, videos, audio).
 *
 * Selected Models: gemini-2.5-flash, gemini-2.0-flash, gemini-2.5-pro.
 * These models are optimized for multimodal understanding.
 *
 * Features:
 * - Text and comprehensive multimodal input processing (images via inline_data,
 *   PDFs, videos, voice notes, video notes, audio, animations via Gemini File API).
 * - Enhanced file type detection and processing.
 * - Support for audio files, animations, and stickers.
 * - Improved MIME type detection using `detectMimeType` function.
 * - Better error handling for unsupported formats.
 * - Conversation history management.
 * - Restricted and customizable Gemini model selection.
 * - System instructions for guiding AI behavior.
 * - Google Search (Grounding) tool integration.
 * - Token usage tracking (approximate).
 * - "Thinking..." message during AI processing.
 * - Robust error handling and detailed logging.
 *
 * Deployment: Designed for webhook-based deployment on platforms like Render.
 * Session Management: Uses in-memory session for simplicity. For production, consider persistent storage.
 */

// Load environment variables from .env file (for local development).
// This must be the very first line to ensure variables are available.
require('dotenv').config();

// --- Module Imports ---
const { Telegraf, session } = require('telegraf'); // Telegraf for Telegram Bot API interaction, session for state management
const express = require('express');               // Express.js for handling webhooks
const axios = require('axios');                   // Axios for making HTTP requests (e.g., downloading Telegram files)
const { GoogleGenerativeAI, HarmCategory, HarmBlockThreshold } = require('@google/generative-ai'); // Google Gemini AI SDK

// --- Configuration & Initialization ---
// Retrieve API tokens from environment variables for security.
const telegramToken = process.env.TELEGRAM_BOT_TOKEN;
const geminiApiKey = process.env.GEMINI_API_KEY;

// Validate essential environment variables.
if (!telegramToken) {
    console.error('ERROR: TELEGRAM_BOT_TOKEN environment variable is not set. Exiting.');
    process.exit(1); // Exit if Telegram token is missing
}
if (!geminiApiKey) {
    console.error('ERROR: GEMINI_API_KEY environment variable is not set. Exiting.');
    console.error('Please ensure GEMINI_API_KEY is configured in Render environment variables or a local .env file.');
    process.exit(1); // Exit if Gemini API key is missing
}

// Initialize Telegraf bot instance.
const bot = new Telegraf(telegramToken);

// Initialize Google Generative AI client.
const genAI = new GoogleGenerativeAI(geminiApiKey);

// Correct way to get the FileService client for uploading files to Gemini.
// This service does not require a specific model instance.
const fileService = genAI.fileService;

// --- Telegraf Session Management ---
// Using Telegraf's built-in session middleware.
// NOTE: This uses in-memory storage, which means session data (chat history, settings)
// will be LOST if the bot restarts or the server is redeployed.
// FOR PRODUCTION, consider a persistent session store (e.g., Redis, MongoDB, Firestore)
// to maintain conversational context and user settings across restarts.
// Example: https://telegraf.js.org/#/middlewares?id=session
bot.use(session({ property: 'session' }));

// Middleware to initialize default session settings if not present.
bot.use((ctx, next) => {
    // Initialize session if it's new or corrupted.
    if (!ctx.session || typeof ctx.session !== 'object') {
        ctx.session = {
            history: [],                    // Stores conversation turns (user/model) for context.
            systemInstruction: null,        // Custom system instructions for the Gemini model.
            // Set default model to a 2.5 Pro preview for best multimodal support among selected ones.
            model: 'gemini-2.5-pro-preview-05-06',
            tools: {
                urlContext: false,          // Flag for URL context tool (may require specific implementation/model support).
                googleSearch: true,         // Flag for Google Search (Grounding) tool, enabled by default.
            },
            talkMode: true,                 // Controls showing/hiding the "Thinking..." message.
            totalTokens: 0,                 // Cumulative counter for approximate token usage.
            lastMessageTime: Date.now(),    // Timestamp of the last user interaction.
        };
        console.log(`SESSION: Initialized for user ${ctx.from.id}`);
    }
    // Update last interaction time for activity tracking.
    ctx.session.lastMessageTime = Date.now();
    next(); // Proceed to the next middleware/handler.
});

// --- Gemini Model Configuration ---
// Defines ONLY the requested Gemini models with aliases for user convenience and notes on capabilities.
const AVAILABLE_MODELS = {
    'flash-04-17': 'gemini-2.5-flash-preview-04-17', // Good for general multimodal (text, images, potentially limited video/audio).
    'flash-05-20': 'gemini-2.5-flash-preview-05-20', // Latest Flash preview, similar multimodal capabilities.
    'pro-05-06': 'gemini-2.5-pro-preview-05-06',     // Strongest multimodal capabilities (PDF, video, audio via File API).
    'flash-2.0': 'gemini-2.0-flash',                 // Older model, multimodal support might be less robust for complex files.
    'flash-lite-2.0': 'gemini-2.0-flash-lite',       // Older model, likely limited multimodal.
};

// Aliases for user-friendly model selection.
const MODEL_ALIASES = {
    '04-17': 'flash-04-17',
    '05-20': 'flash-05-20',
    'pro-05-06': 'pro-05-06',
    'flash': 'flash-2.0',
    'flash-lite': 'flash-lite-2.0',
    'default': 'pro-05-06', // Set default to the strong 2.5 Pro model.
    'flash2.5': 'flash-05-20', // Alias for the latest 2.5 Flash preview.
    'pro2.5': 'pro-05-06'      // Alias for the latest 2.5 Pro preview.
};

// Defined explicitly capable models for File API.
const CAPABLE_FILE_MODELS = [
    'gemini-2.5-pro-preview-05-06',
    'gemini-2.5-flash-preview-05-20',
    'gemini-2.5-flash-preview-04-17',
    'gemini-2.0-flash', // Explicitly included for File API attempt.
    'gemini-2.0-flash-lite' // Explicitly included for File API attempt.
];

// --- Enhanced MIME Type Detection ---
/**
 * Enhanced MIME type detection based on file signatures and extensions.
 * This function is crucial for determining the correct MIME type for Gemini's File API.
 * @param {Buffer} buffer - File buffer to analyze.
 * @param {string} fileName - Original filename (optional), used for extension fallback.
 * @returns {string} Detected MIME type. Defaults to 'application/octet-stream'.
 */
function detectMimeType(buffer, fileName = '') {
    if (!buffer || buffer.length < 4) {
        return 'application/octet-stream';
    }

    const signature = buffer.subarray(0, 16).toString('hex').toUpperCase(); // Read first 16 bytes for signature.
    const ext = fileName.toLowerCase().split('.').pop() || ''; // Get file extension.

    // Image formats (common signatures)
    if (signature.startsWith('89504E47')) return 'image/png';
    if (signature.startsWith('FFD8FF')) return 'image/jpeg';
    if (signature.startsWith('47494638')) return 'image/gif';
    if (signature.startsWith('52494646') && buffer.subarray(8, 12).toString('hex').toUpperCase() === '57454250') return 'image/webp';
    if (signature.startsWith('424D')) return 'image/bmp';
    if (signature.startsWith('49492A00') || signature.startsWith('4D4D002A')) return 'image/tiff';

    // Video formats (common signatures/extensions)
    if (signature.includes('66747970') || ext === 'mp4') return 'video/mp4'; // ftyp is often part of MP4/MOV headers
    if (signature.startsWith('1A45DFA3') || ext === 'webm') return 'video/webm'; // EBML signature for WebM
    if (signature.startsWith('464C5601') || ext === 'flv') return 'video/x-flv';
    if (ext === 'avi') return 'video/x-msvideo';
    if (ext === 'mov' || ext === 'qt') return 'video/quicktime';
    if (ext === 'mkv') return 'video/x-matroska';

    // Audio formats (common signatures/extensions)
    if (signature.startsWith('494433') || signature.startsWith('FFFB') || signature.startsWith('FFF3') || ext === 'mp3') return 'audio/mpeg'; // ID3 tag for MP3, FFFB/FFF3 for MP3 frames
    if (signature.startsWith('4F676753') || ext === 'ogg') return 'audio/ogg'; // OggS for OGG
    if (signature.startsWith('52494646') && buffer.subarray(8, 12).toString('ascii') === 'WAVE') return 'audio/wav'; // RIFF WAV
    if (ext === 'flac') return 'audio/flac';
    if (ext === 'aac') return 'audio/aac';
    if (ext === 'm4a') return 'audio/mp4'; // M4A is often audio/mp4

    // Document formats (common signatures/extensions)
    if (signature.startsWith('25504446') || ext === 'pdf') return 'application/pdf'; // %PDF
    if (signature.startsWith('504B0304') || signature.startsWith('504B0506') || signature.startsWith('504B0708')) { // PK Zip (common for Office XML formats)
        if (ext === 'docx') return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
        if (ext === 'xlsx') return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
        if (ext === 'pptx') return 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
        return 'application/zip'; // Generic zip
    }
    if (signature.startsWith('D0CF11E0A1B11AE1')) { // OLE Compound Document (common for old Office formats)
        if (ext === 'doc') return 'application/msword';
        if (ext === 'xls') return 'application/vnd.ms-excel';
        if (ext === 'ppt') return 'application/vnd.ms-powerpoint';
        return 'application/x-ole-storage'; // Generic OLE
    }

    // Text formats (common extensions)
    if (ext === 'txt') return 'text/plain';
    if (ext === 'html' || ext === 'htm') return 'text/html';
    if (ext === 'css') return 'text/css';
    if (ext === 'js') return 'application/javascript';
    if (ext === 'json') return 'application/json';
    if (ext === 'xml') return 'application/xml';
    if (ext === 'md') return 'text/markdown';
    if (ext === 'csv') return 'text/csv';
    if (ext === 'rtf') return 'text/rtf';
    if (ext === 'py') return 'text/x-python';

    // Archive formats (common signatures/extensions)
    if (signature.startsWith('1F8B08') || ext === 'gz') return 'application/gzip'; // Gzip magic number
    if (signature.startsWith('377ABCAF271C') || ext === '7z') return 'application/x-7z-compressed'; // 7z magic number
    if (signature.startsWith('526172211A0700') || ext === 'rar') return 'application/x-rar-compressed'; // Rar magic number

    // Fallback to generic binary stream.
    return 'application/octet-stream';
}


// --- Helper Functions for File Handling (continued) ---

/**
 * Downloads a file from Telegram by its file ID and returns it as a Node.js Buffer.
 * @param {string} fileId - The file_id from the Telegram message.
 * @returns {Promise<Buffer|null>} A Promise that resolves with the file's Buffer data, or null on error.
 */
async function downloadFileBuffer(fileId) {
    try {
        const fileUrl = await bot.telegram.getFileLink(fileId); // Get the direct URL to the Telegram file.
        const response = await axios({
            url: fileUrl.href,
            method: 'GET',
            responseType: 'arraybuffer' // Fetch data as a raw ArrayBuffer.
        });
        return Buffer.from(response.data); // Convert ArrayBuffer to Node.js Buffer.
    } catch (error) {
        console.error(`FILE_DOWNLOAD_ERROR: Failed to download file (ID: ${fileId}):`, error);
        return null;
    }
}

/**
 * Downloads an image file from Telegram and returns its Base64 representation along with detected MIME type.
 * Primarily used for `inline_data` parts in Gemini API requests (suitable for smaller images).
 * @param {string} fileId - The file_id from the Telegram message.
 * @returns {Promise<{data: string, mimeType: string}|null>} An object containing base64 data and mimeType, or null on error.
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
        // Use the enhanced detectMimeType function here.
        const mimeType = detectMimeType(buffer); 

        const base64 = buffer.toString('base64');
        return { data: base64, mimeType: mimeType };

    } catch (error) {
        console.error(`FILE_BASE64_CONVERSION_ERROR: Failed to download or convert file (ID: ${fileId}) to Base64:`, error);
        return null;
    }
}

/**
 * Uploads a file Buffer to the Gemini File API. This is crucial for larger files
 * like PDFs, videos, and audio, as they cannot be sent directly via `inline_data`.
 * @param {Buffer} buffer - The file data as a Buffer.
 * @param {string} mimeType - The MIME type of the file (e.g., 'application/pdf', 'video/mp4').
 * @param {string} fileName - An optional display name for the file in Gemini.
 * @returns {Promise<Object|null>} A Promise that resolves with the Gemini File object (containing 'name' - FID, and 'uri'), or null on error.
 */
async function uploadFileToGemini(buffer, mimeType, fileName) {
    if (!buffer || !mimeType || !fileName) {
        console.error('FILE_UPLOAD_ERROR: Missing required parameters (buffer, mimeType, or fileName) for Gemini upload.');
        return { success: false, error: 'missing_parameters', details: 'Buffer, mimeType, or fileName missing.' };
    }
    console.log(`GEMINI_FILE_UPLOAD: Starting upload for "${fileName}" (MIME: ${mimeType})...`);
    try {
        const uploadResult = await fileService.uploadFile(buffer, {
            mimeType: mimeType,
            displayName: fileName, // Display name in Gemini API.
        });

        let file = uploadResult.file; // The file object returned by the File API.
        console.log(`GEMINI_FILE_UPLOAD: Initial upload complete. Name: ${file.name}, State: ${file.state}, URI (download): ${file.uri}`);

        // Polling to wait for the file to be processed (state: ACTIVE)
        // Gemini API requires files to be processed before they can be used in generateContent.
        // The 'name' (e.g., 'files/your-file-id') is used for getFile and in generateContent.
        // The 'uri' on the File object is a download URI, not the one for generateContent.
        if (file.state === 'PROCESSING') {
            console.log(`GEMINI_FILE_PROCESSING: File "${file.name}" is PROCESSING. Starting polling...`);
            let attempts = 0;
            const maxAttempts = 12; // Poll for up to 60 seconds (12 * 5s)
            while (file.state === 'PROCESSING' && attempts < maxAttempts) {
                await new Promise(resolve => setTimeout(resolve, 5000)); // Wait 5 seconds
                file = await fileService.getFile(file.name); // Fetch updated file status
                attempts++;
                console.log(`GEMINI_FILE_PROCESSING: Polling attempt ${attempts}/${maxAttempts}. File "${file.name}" state: ${file.state}`);
            }
        }

        if (file.state === 'ACTIVE') {
            console.log(`GEMINI_FILE_SUCCESS: File "${file.name}" is ACTIVE and ready. MIME: ${file.mimeType}.`);
            return { success: true, file: file }; // Return the processed file object
        } else if (file.state === 'FAILED') {
            console.error(`GEMINI_FILE_ERROR: File processing FAILED for "${file.name}". State: ${file.state}.`);
            return { success: false, error: 'processing_failed', details: `File state: ${file.state}` };
        } else {
            console.warn(`GEMINI_FILE_WARNING: File "${file.name}" processing timed out or ended in unexpected state: ${file.state}.`);
            return { success: false, error: 'processing_timeout_or_unexpected_state', details: `File state: ${file.state}` };
        }

    } catch (error) {
        console.error(`GEMINI_FILE_ERROR: Exception during upload or processing for "${fileName}" (MIME: ${mimeType}):`, error);
        if (error.response && error.response.data) {
            console.error('GEMINI_API_ERROR_DETAILS:', error.response.data);
        }
        return { success: false, error: 'upload_exception', details: error.message };
    }
}

/**
 * Deletes a file from the Gemini File API.
 * This is important for managing storage and adhering to data retention policies,
 * as files are typically stored for up to 48 hours.
 * (Not automatically called in this example, but essential for production usage).
 * @param {string} fileUri - The URI of the file to delete (e.g., 'files/your-file-id').
 *                           This should be the `name` property of the Gemini File object.
 * @returns {Promise<boolean>} True if deletion was successful, false otherwise.
 */
async function deleteGeminiFile(fileUri) {
    try {
        console.log(`GEMINI_FILE_DELETE: Attempting to delete Gemini file: ${fileUri}`);
        await fileService.deleteFile(fileUri);
        console.log(`GEMINI_FILE_DELETE_SUCCESS: Gemini file deleted: ${fileUri}`);
        return true;
    } catch (error) {
        console.error(`GEMINI_FILE_DELETE_ERROR: Failed to delete Gemini file ${fileUri}:`, error);
        if (error.response && error.response.data) {
            console.error('GEMINI_FILE_API_ERROR_RESPONSE (DELETE):', error.response.data);
        }
        return false;
    }
}

/**
 * Determines the file processing strategy based on MIME type and current model capabilities.
 * @param {string} mimeType - The detected MIME type of the file.
 * @param {string} currentModel - The name of the currently selected Gemini model.
 * @returns {Object} An object indicating whether the file can be processed, which method to use (inline/File API),
 *                   and a recommendation.
 */
function getFileProcessingStrategy(mimeType, currentModel) {
    const isCapableModel = CAPABLE_FILE_MODELS.includes(currentModel);
    
    const isImage = mimeType && mimeType.startsWith('image/');
    const isVideo = mimeType && mimeType.startsWith('video/');
    const isAudio = mimeType && mimeType.startsWith('audio/');
    const isPdf = mimeType === 'application/pdf';
    const isDocument = mimeType && (
        mimeType.includes('document') || 
        mimeType.includes('spreadsheet') || 
        mimeType.includes('presentation') ||
        mimeType === 'application/msword' ||
        mimeType === 'application/vnd.ms-excel' ||
        mimeType === 'application/vnd.ms-powerpoint'
    );
    const isText = mimeType && mimeType.startsWith('text/');
    const isCodeOrStructuredText = mimeType && ( // Other non 'text/*' document types
        mimeType === 'application/javascript' ||
        mimeType === 'application/json' ||
        mimeType === 'application/xml'
    );

    const isStickerOrAnimation = mimeType && (mimeType.includes('image/webp') || mimeType.includes('video/') || mimeType.includes('animation/'));


    // The `canProcess` logic should broadly cover what Gemini *can* do with its multimodal features.
    // This is more about whether we *attempt* to process it.
    const canProcess = isCapableModel && (
        isImage || isVideo || isAudio || isPdf || isDocument || isText || isCodeOrStructuredText || isStickerOrAnimation
    );

    // Strategy for sending to Gemini:
    // Prefer inline for images if they are small enough (not checked here, assumed for simplicity).
    // Use File API for anything else supported by capable models (PDFs, videos, audio, documents, potentially larger images).
    const useInlineData = isImage && isCapableModel; // Only images usually go inline.
    const useFileAPI = isCapableModel && (
        isPdf || isVideo || isAudio || isDocument || isText || isCodeOrStructuredText || isStickerOrAnimation || (isImage && !useInlineData)
    ); // Everything else goes via File API if model is capable.

    const isSupported = isImage || isVideo || isAudio || isPdf || isDocument || isText || isCodeOrStructuredText || isStickerOrAnimation;

    const recommendation = !isCapableModel ? 'upgrade_model' : 'supported';

    return {
        canProcess: canProcess,         // Overall capability to send to Gemini.
        useInlineData: useInlineData,   // Should attempt to send as Base64 inline.
        useFileAPI: useFileAPI,         // Should attempt to upload to File API.
        isSupported: isSupported,       // Does the bot *know* how to process this type?
        recommendation: recommendation  // Feedback for user if model is not capable.
    };
}

// --- Telegram Command Handlers ---

// /start command: Welcomes the user and provides a list of available commands.
bot.start((ctx) => {
    ctx.reply('Привет! Я Telegram бот с интеграцией Gemini. Отправь мне текст или поддерживаемый файл (фото, видео, аудио, PDF, документы, анимации, стикеры) с текстом или без, и я отвечу. Используй команды для настройки:\n' +
        '/newchat - начать новый чат\n' +
        '/setsysteminstruction <текст> - задать системные инструкции\n' +
        '/toggletalkmode - включить/выключить "режим мышления"\n' +
        '/toggleurlcontext - включить/выключить URL контекст (Инструмент)\n' +
        '/togglegrounding - включить/выключить Заземление (Поиск Google, Инструмент)\n' +
        '/setmodel <имя модели> - выбрать модель Gemini\n' +
        '/showtokens - показать использованные токены\n' +
        '/supportedformats - показать поддерживаемые форматы файлов\n' +
        '/help - показать это сообщение еще раз');
});

// /help command: Provides a concise list of all available commands.
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
              '/showtokens - показать использованные токены\n' +
              '/supportedformats - показать поддерживаемые форматы файлов');
});

// /supportedformats command: Shows supported file formats
bot.command('supportedformats', (ctx) => {
    ctx.reply('Поддерживаемые форматы файлов Gemini (при условии поддержки моделью):\n\n' +
        '📷 **Изображения**: PNG, JPEG, GIF, WebP (включая анимированные), BMP, TIFF (обычно inline, большие могут через File API)\n' +
        '🎥 **Видео**: MP4, WebM, AVI, MOV, MKV, FLV (через File API, после обработки Gemini)\n' +
        '🎵 **Аудио**: MP3, OGG, WAV, FLAC, AAC, M4A (через File API, после обработки Gemini)\n' +
        '📄 **Документы (Office)**: PDF, DOC, DOCX, XLS, XLSX, PPT, PPTX (через File API, после обработки Gemini)\n' +
        '📝 **Текстовые и кодовые файлы**: TXT, HTML, CSS, JS, JSON, XML, Markdown (MD), CSV, RTF, Python (PY) (через File API, после обработки Gemini)\n' +
        '📦 **Архивы**: ZIP, 7Z, RAR, GZ (модель может попытаться извлечь текст)\n' +
        '💬 **Голосовые сообщения Telegram**: OGG (через File API)\n' +
        '🎭 **Стикеры Telegram**: WebP (через inline_data или File API, если анимированы)\n\n' +
        'Для наилучшей обработки сложных файлов (видео, аудио, PDF) используйте модели `pro2.5` или `flash2.5`.');
});

// /newchat command: Clears the conversation history and resets system instructions for a fresh start.
bot.command('newchat', (ctx) => {
    ctx.session.history = [];
    ctx.session.systemInstruction = null; // Also reset system instructions
    ctx.reply('Чат очищен. Предыдущая история и системные инструкции удалены.');
});

// /setsysteminstruction command: Allows the user to set custom system instructions for the Gemini model.
bot.command('setsysteminstruction', (ctx) => {
    const instruction = ctx.message.text.substring('/setsysteminstruction'.length).trim();
    if (instruction) {
        ctx.session.systemInstruction = instruction;
        ctx.reply('Системные инструкции установлены.');
    } else {
        ctx.session.systemInstruction = null; // Reset instructions if command is used without text.
        ctx.reply('Системные инструкции сброшены. Используйте /setsysteminstruction <текст> для установки.');
    }
});

// /toggletalkmode command: Toggles the display of a "Думаю..." (Thinking...) message while the AI processes.
bot.command('toggletalkmode', (ctx) => {
    ctx.session.talkMode = !ctx.session.talkMode;
    ctx.reply(`"Режим мышления" (показ сообщения "Думаю...") ${ctx.session.talkMode ? 'включен' : 'выключен'}.`);
});

// /toggleurlcontext command: Toggles a URL context tool.
// Note: Direct URL context tool might be deprecated or require a specific implementation/model.
bot.command('toggleurlcontext', (ctx) => {
    ctx.session.tools.urlContext = !ctx.session.tools.urlContext;
    ctx.reply(`Инструмент URL Context ${ctx.session.tools.urlContext ? 'включен' : 'выключен'}. (Этот инструмент может быть устаревшим или требовать определенной модели/другой реализации)`);
});

// /togglegrounding command: Toggles the Google Search (Grounding) tool.
bot.command('togglegrounding', (ctx) => {
    ctx.session.tools.googleSearch = !ctx.session.tools.googleSearch;
    ctx.reply(`Инструмент Заземление (Google Search) ${ctx.session.tools.googleSearch ? 'включен' : 'выключен'}.`);
});

// /setmodel command: Allows the user to select a Gemini model from predefined aliases.
bot.command('setmodel', (ctx) => {
    const modelName = ctx.message.text.substring('/setmodel'.length).trim().toLowerCase();
    if (!modelName) {
        // If no model name provided, list available models.
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
        // Provide warnings/info based on selected model's capabilities.
        if (alias === 'image-gen-2.0') { 
            replyText += `\nВнимание: Эта модель предназначена ТОЛЬКО для генерации изображений и может не работать для диалога или обработки входящих медиа.`;
        } else if (alias.includes('preview')) {
            replyText += `\nВнимание: Это превью-модель, ее поведение может меняться.`;
        }
        // General warning if a less capable model is selected
        if (!CAPABLE_FILE_MODELS.includes(AVAILABLE_MODELS[alias])) {
             replyText += `\nЭта модель (${AVAILABLE_MODELS[alias]}) может иметь ограниченную поддержку мультимодальных данных (PDF, видео, аудио). Для наилучшей поддержки рекомендуется использовать 'pro2.5', 'flash2.5' или '04-17'.`;
        }

        ctx.reply(replyText);
    } else {
        ctx.reply(`Неизвестное имя модели или псевдоним: "${modelName}". Используйте /setmodel без аргументов, чтобы увидеть список доступных моделей.`);
    }
});

// /showtokens command: Displays the approximate cumulative token usage.
bot.command('showtokens', (ctx) => {
    // This is an approximate cumulative count, based on total tokens reported by the API
    // (input + output). If usageMetadata is not available, it might default to an input-only estimate.
    ctx.reply(`Общее количество использованных токенов (приблизительно): ${ctx.session.totalTokens}.`);
});

// --- Main Message Handler (Gemini Interaction Logic) ---
// This handler listens for all message types and orchestrates the interaction with Gemini.
bot.on('message', async (ctx) => {
    // Ignore messages that are commands (these are handled by specific command handlers).
    if (ctx.message.text && ctx.message.text.startsWith('/')) {
        console.log(`MESSAGE_HANDLER: Ignoring message as it appears to be a command: ${ctx.message.text}`);
        return;
    }

    let messageText = null;             // Stores text content from the message (either text or caption).
    const currentUserMessageParts = []; // Array to build the 'parts' for the current user turn for Gemini API.

    // 1. Extract Text Content (from message.text or message.caption).
    if (ctx.message.text) {
        messageText = ctx.message.text;
        currentUserMessageParts.push({ text: messageText });
        console.log(`MESSAGE_HANDLER: Received text message from ${ctx.from.id}: "${messageText}"`);
    } else if (ctx.message.caption) {
        // This is a media message with a text caption.
        messageText = ctx.message.caption;
        currentUserMessageParts.push({ text: messageText });
        console.log(`MESSAGE_HANDLER: Received media with caption from ${ctx.from.id}: "${messageText}"`);
    }

    // 2. Handle Media Files (photos, videos, documents, voice notes, video notes, audio, animations, stickers).
    let fileId = null;                  // Telegram file_id.
    let telegramProvidedMimeType = null; // MIME type reported by Telegram (can be less accurate).
    let fileName = null;                // Suggested file name for upload.
    let fileBuffer = null;              // Buffer to hold file data for MIME detection and upload.

    // Determine fileId, original mimeType (from Telegram), and fileName based on the specific message type.
    if (ctx.message.photo) {
        fileId = ctx.message.photo[ctx.message.photo.length - 1].file_id;
        telegramProvidedMimeType = 'image/jpeg'; // Telegram often converts photos to JPEG.
        fileName = `${fileId}.jpg`;
        console.log(`MESSAGE_HANDLER: Received photo (file_id: ${fileId})`);
    } else if (ctx.message.video) {
        fileId = ctx.message.video.file_id;
        telegramProvidedMimeType = ctx.message.video.mime_type || 'video/mp4';
        fileName = ctx.message.video.file_name || `${fileId}.mp4`;
        console.log(`MESSAGE_HANDLER: Received video (file_id: ${fileId}, mime_type: ${telegramProvidedMimeType})`);
    } else if (ctx.message.document) {
        fileId = ctx.message.document.file_id;
        telegramProvidedMimeType = ctx.message.document.mime_type || 'application/octet-stream';
        fileName = ctx.message.document.file_name || `${fileId}.dat`;
        console.log(`MESSAGE_HANDLER: Received document (file_id: ${fileId}, mime_type: ${telegramProvidedMimeType}, file_name: ${fileName})`);
    } else if (ctx.message.voice) {
        fileId = ctx.message.voice.file_id;
        telegramProvidedMimeType = ctx.message.voice.mime_type || 'audio/ogg';
        fileName = `${fileId}.ogg`;
        console.log(`MESSAGE_HANDLER: Received voice message (file_id: ${fileId}, mime_type: ${telegramProvidedMimeType})`);
    } else if (ctx.message.video_note) {
        fileId = ctx.message.video_note.file_id;
        telegramProvidedMimeType = ctx.message.video_note.mime_type || 'video/mp4';
        fileName = `${fileId}.mp4`;
        console.log(`MESSAGE_HANDLER: Received video note (file_id: ${fileId}, mime_type: ${telegramProvidedMimeType})`);
    } else if (ctx.message.audio) { // NEW: Audio file handling
        fileId = ctx.message.audio.file_id;
        telegramProvidedMimeType = ctx.message.audio.mime_type || 'audio/mpeg'; // Common audio MIME type
        fileName = ctx.message.audio.file_name || `${fileId}.mp3`;
        console.log(`MESSAGE_HANDLER: Received audio (file_id: ${fileId}, mime_type: ${telegramProvidedMimeType}, file_name: ${fileName})`);
    } else if (ctx.message.animation) { // NEW: Animation file handling
        fileId = ctx.message.animation.file_id;
        telegramProvidedMimeType = ctx.message.animation.mime_type || 'video/mp4'; // Animations can be MP4/GIF
        fileName = ctx.message.animation.file_name || `${fileId}.mp4`;
        console.log(`MESSAGE_HANDLER: Received animation (file_id: ${fileId}, mime_type: ${telegramProvidedMimeType}, file_name: ${fileName})`);
    } else if (ctx.message.sticker) { // NEW: Sticker handling (often WebP)
        // Note: Stickers are typically WebP or animated. For static stickers, can be inline.
        // Animated stickers often require File API.
        fileId = ctx.message.sticker.file_id;
        telegramProvidedMimeType = ctx.message.sticker.mime_type || 'image/webp'; // Stickers are often WebP
        fileName = `${fileId}.webp`; // Assume WebP for sticker
        console.log(`MESSAGE_HANDLER: Received sticker (file_id: ${fileId}, mime_type: ${telegramProvidedMimeType})`);
        if (ctx.message.sticker.is_animated || ctx.message.sticker.is_video) {
            console.log(`MESSAGE_HANDLER: Animated/Video sticker detected.`);
            // These might be better handled by File API for models that support video/animation.
        }
    }

    // If a file ID was found, proceed to download and process it for Gemini.
    if (fileId) {
        // Download the file buffer once for MIME detection and subsequent upload.
        fileBuffer = await downloadFileBuffer(fileId);
        if (!fileBuffer) {
            console.warn(`FILE_PROCESSING_WARNING: Failed to download file buffer for ${fileId}. Skipping processing.`);
            currentUserMessageParts.push({ text: `[Не удалось скачать файл из Telegram.]` });
        } else {
            // Use the enhanced MIME type detection with the downloaded buffer.
            const detectedMimeType = detectMimeType(fileBuffer, fileName || '');
            console.log(`FILE_PROCESSING: Original Telegram MIME: ${telegramProvidedMimeType}, Detected MIME: ${detectedMimeType}`);
            telegramProvidedMimeType = detectedMimeType; // Use the more accurate detected MIME type.

            const currentModel = ctx.session.model;
            const strategy = getFileProcessingStrategy(telegramProvidedMimeType, currentModel);

            // --- DEBUGGING LOGS FOR FILE PROCESSING DECISION ---
            console.log(`DEBUG_FILE_LOGIC: currentModel: "${currentModel}"`);
            console.log(`DEBUG_FILE_LOGIC: telegramProvidedMimeType (final): "${telegramProvidedMimeType}"`);
            console.log(`DEBUG_FILE_LOGIC: Strategy: ${JSON.stringify(strategy)}`);
            // --- END DEBUGGING LOGS ---

            if (strategy.canProcess) {
                if (strategy.useInlineData) {
                    console.log(`FILE_PROCESSING: Processing file ${fileId} (${telegramProvidedMimeType}) as inline image data...`);
                    try {
                        const base64Data = fileBuffer.toString('base64');
                        currentUserMessageParts.push({
                            inline_data: {
                                mime_type: telegramProvidedMimeType, // Use the accurately detected MIME type.
                                data: base64Data
                            }
                        });
                        console.log(`FILE_PROCESSING: Added inline data part (MIME: ${telegramProvidedMimeType}).`);
                    } catch (error) {
                        console.error('FILE_PROCESSING_ERROR: Error converting file to Base64 for inline data:', error);
                        currentUserMessageParts.push({ text: `[Произошла ошибка при обработке отправленного файла (${telegramProvidedMimeType}) как встроенного изображения.]` });
                    }
                } else if (strategy.useFileAPI) {
                    console.log(`FILE_PROCESSING: Processing file ${fileId} (${telegramProvidedMimeType}) using Gemini File API...`);
                    const uploadResult = await uploadFileToGemini(fileBuffer, telegramProvidedMimeType, fileName); // Upload to Gemini File API

                    if (uploadResult.success && uploadResult.file) {
                        const geminiFile = uploadResult.file;
                        currentUserMessageParts.push({
                            fileData: {
                                mime_type: geminiFile.mimeType, // Use MIME type confirmed by Gemini.
                                uri: geminiFile.name            // Use the resource name (e.g., 'files/your-file-id').
                            }
                        });
                        console.log(`FILE_PROCESSING: Added fileData part (Name: ${geminiFile.name}, MIME: ${geminiFile.mimeType}) to prompt parts.`);
                        // TODO: Implement a strategy to delete files from File API (using geminiFile.name) after use.
                    } else {
                        const errorReason = uploadResult.error || 'unknown_error';
                        const errorDetails = uploadResult.details || 'No additional details';
                        console.warn(`FILE_PROCESSING_WARNING: Failed to upload/process file ${fileId} (${telegramProvidedMimeType}) for Gemini File API. Reason: ${errorReason}, Details: ${errorDetails}`);
                        currentUserMessageParts.push({ text: `[Не удалось обработать файл (${telegramProvidedMimeType}) для Gemini File API. Причина: ${errorReason}.]` });
                    }
                }
            } else {
                // File type is not supported by the current model or overall strategy.
                console.warn(`FILE_PROCESSING_WARNING: File type "${telegramProvidedMimeType}" is not supported for processing with the selected model (${currentModel}) or via current methods.`);
                let userMessage = `[Файл типа ${telegramProvidedMimeType} не поддерживается выбранной моделью (${currentModel}) или методом обработки.]`;
                if (strategy.recommendation === 'upgrade_model') {
                    userMessage += ` Для лучшей поддержки попробуйте выбрать более мощную модель, например, 'pro2.5' или 'flash2.5'.`;
                }
                currentUserMessageParts.push({ text: userMessage });
            }
        }
    } // End of file processing block.

    // 3. Final check for parts to send to Gemini.
    // If after processing text and file, `currentUserMessageParts` is empty, it means
    // the message type was unhandled (e.g., location, contact, poll).
    if (currentUserMessageParts.length === 0) {
        console.warn("GEMINI_CALL_SKIPPED: Current message parts are empty after processing.");
        // Reply to the user if the message type wasn't handled at all.
        if (!ctx.message.text && !ctx.message.caption && !fileId) {
            console.log(`MESSAGE_HANDLER: Received completely unhandled message type. ctx.message:`, ctx.message);
            ctx.reply('Извините, я пока умею обрабатывать для ответа через Gemini только текст, фото, видео, документы (включая PDF), голосовые сообщения, видео-сообщения, аудио, анимации и стикеры (при условии поддержки выбранной моделью).');
        } else {
            // This case should ideally not be reached if fileId was processed,
            // but as a fallback for other processing failures.
            ctx.reply('Извините, возникла проблема с обработкой вашего сообщения.');
        }
        return; // Stop processing if no valid parts to send.
    }

    // 4. Construct the full `contents` array for the Gemini API request.
    // The `contents` array represents the conversation history + the current user turn,
    // in chronological order (oldest first).
    const contents = [
        ...ctx.session.history, // Add historical turns first.
        { role: 'user', parts: currentUserMessageParts } // Add the current user turn last.
    ];

    // 5. Prepare tools based on user settings.
    const tools = [];
    // The Google Search Tool (Grounding) is a standard supported tool.
    if (ctx.session.tools.googleSearch) {
        tools.push({ googleSearch: {} });
        console.log('TOOLS: Google Search tool enabled for this call.');
    }
    // The URL Context tool is less commonly used/supported as a generic tool via the API now.
    // It is NOT added to the `tools` array for the API call in this example.
    if (ctx.session.tools.urlContext) {
        console.warn('TOOLS_WARNING: URL Context tool is enabled but might not be supported by the model or via standard tools configuration for API call.');
    }

    // 6. Call the Gemini API.
    let thinkingMessageId = null; // To store the ID of the "Thinking..." message for deletion.
    if (ctx.session.talkMode) {
        try {
            // Send a "Thinking..." message and store its ID.
            const thinkingMsg = await ctx.reply('Думаю...');
            thinkingMessageId = thinkingMsg.message_id;
        } catch (error) {
            console.error('TELEGRAM_ERROR: Failed to send "Thinking..." message:', error);
        }
    }

    let geminiResponseText = 'Не удалось получить ответ от Gemini.';
    let inputTokens = 0;  // Tokens for the current prompt (history + current turn).
    let outputTokens = 0; // Tokens for the model's reply.

    try {
        // Get the generative model instance with the selected model.
        const model = genAI.getGenerativeModel({
            model: ctx.session.model,
        });

        // Prepare system instructions content if set.
        // Passed as `systemInstruction` parameter in the `generateContent` call, mirroring the Java example.
        const systemInstructionContent = ctx.session.systemInstruction
            ? { parts: [{ text: ctx.session.systemInstruction }] }
            : undefined;

        // Log the full request details before calling the API.
        console.log('GEMINI_API_CALL: Calling generateContent with contents:', JSON.stringify(contents));
        console.log('GEMINI_API_CALL: Using system instruction:', systemInstructionContent ? systemInstructionContent.parts[0].text : 'None');
        console.log('GEMINI_API_CALL: Using tools:', tools.length > 0 ? JSON.stringify(tools) : 'None');

        const result = await model.generateContent({
            contents: contents, // Full conversation history + current user message.
            tools: tools.length > 0 ? tools : undefined, // Tools to enable for this generation.
            systemInstruction: systemInstructionContent, // Correct parameter for system instructions.
            // Safety settings are TEMPORARILY REMOVED to resolve 400 Bad Request error.
            // Re-introduce carefully after confirming basic functionality.
            /* safetySettings: [
                { category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: HarmBlockThreshold.BLOCK_NONE },
                { category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.BLOCK_NONE },
                { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH, threshold: HarmBlockThreshold.BLOCK_NONE },
                { category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, threshold: HarmBlockThreshold.BLOCK_NONE },
                { category: HarmCategory.HARM_CATEGORY_CIVIC_INTEGRITY, threshold: HarmBlockThreshold.BLOCK_NONE },
            ], */
            generationConfig: {
                // Future generation parameters (e.g., temperature, top_p) could be added here.
            }
        });

        const response = result.response;

        // 7. Extract the text response from Gemini's output.
        if (response && response.candidates && response.candidates.length > 0 && response.candidates[0].content && response.candidates[0].content.parts && response.candidates[0].content.parts.length > 0) {
            geminiResponseText = response.candidates[0].content.parts
                .map(part => part.text) // Extract text from each part.
                .filter(text => text !== undefined && text !== null) // Filter out non-text parts.
                .join(''); // Concatenate all text parts.
        } else {
            console.warn("GEMINI_RESPONSE_WARNING: Gemini response did not contain text parts.", response);
            geminiResponseText = 'Не удалось получить текстовый ответ от Gemini.';
        }

        // 8. Update Token Usage.
        // The Node.js client library provides token counts in `usageMetadata` if available from the API response.
        if (response.usageMetadata) {
            inputTokens = response.usageMetadata.promptTokenCount || 0;
            outputTokens = response.usageMetadata.candidatesTokenCount || 0;
            const totalTokensForCall = response.usageMetadata.totalTokenCount || 0;
            console.log(`TOKEN_USAGE: Gemini API Usage Metadata: Input=${inputTokens}, Output=${outputTokens}, Total=${totalTokensForCall}`);
            ctx.session.totalTokens += totalTokensForCall; // Add total tokens for this call to cumulative total.
        } else {
            // If `usageMetadata` is not available, try to estimate input tokens using `countTokens`.
            try {
                const tokenEstimation = await model.countTokens({
                    contents: contents,
                    tools: tools.length > 0 ? tools : undefined,
                    systemInstruction: systemInstructionContent, // Pass system instructions for accurate count.
                });
                inputTokens = tokenEstimation.totalTokens || 0;
                ctx.session.totalTokens += inputTokens; // Add estimated input tokens to cumulative total.
                console.log(`TOKEN_USAGE: Estimated Input tokens for this call (from countTokens): ${inputTokens}. Total cumulative (estimated, input-biased): ${ctx.session.totalTokens}`);
            } catch (tokenError) {
                console.error('TOKEN_COUNT_ERROR: Failed to count tokens after successful response:', tokenError);
            }
        }

        // 9. Update Conversation History.
        // Add the current user's message and the bot's text reply to the session history.
        ctx.session.history.push({ role: 'user', parts: currentUserMessageParts });
        if (geminiResponseText && geminiResponseText.trim().length > 0) {
            ctx.session.history.push({ role: 'model', parts: [{ text: geminiResponseText }] });
        } else {
            // If Gemini returned no text, add an empty model turn to maintain history structure (user, model, user, model).
            console.warn("HISTORY_UPDATE_WARNING: Gemini response text was empty. Adding empty model turn to history.");
            ctx.session.history.push({ role: 'model', parts: [{ text: '' }] });
        }

        // Keep history length manageable (e.g., last 10 back-and-forth turns = 20 messages).
        const maxHistoryMessages = 20;
        if (ctx.session.history.length > maxHistoryMessages) {
            ctx.session.history = ctx.session.history.slice(-maxHistoryMessages); // Remove older messages.
        }
        console.log(`HISTORY_STATE: Current history size: ${ctx.session.history.length}`);

    } catch (error) {
        console.error('GEMINI_API_ERROR: Error calling Gemini API:', error);
        geminiResponseText = 'Произошла ошибка при обращении к Gemini API.';

        // Log specific API error details if available.
        if (error.response && error.response.data) {
            console.error('GEMINI_API_ERROR_RESPONSE:', error.response.data);
            if (error.response.data.error && error.response.data.error.message) {
                geminiResponseText += ` Ошибка API: ${error.response.data.error.message}`;
            }
        } else if (error.message) {
            geminiResponseText += ` Ошибка: ${error.message}`;
        }

        // Add the user's message to history even if the API call failed,
        // to preserve the context of the failed attempt for subsequent messages.
        if (currentUserMessageParts.length > 0) {
            ctx.session.history.push({ role: 'user', parts: currentUserMessageParts });
            // Ensure history length is managed even on error.
            const maxHistoryMessages = 20;
            if (ctx.session.history.length > maxHistoryMessages) {
                ctx.session.history = ctx.session.history.slice(-maxHistoryMessages);
            }
        }
        console.log(`HISTORY_STATE: History size after error: ${ctx.session.history.length}`);

    } finally {
        // Always attempt to delete the "Thinking..." message if it was sent.
        if (thinkingMessageId) {
            try {
                await ctx.deleteMessage(thinkingMessageId);
                console.log(`TELEGRAM_ACTION: Deleted "Thinking..." message ${thinkingMessageId}`);
            } catch (deleteError) {
                // Ignore deletion errors, as the message might have failed to send or already been deleted.
                console.error(`TELEGRAM_ERROR: Failed to delete "Thinking..." message ${thinkingMessageId}:`, deleteError);
            }
        }
    }

    // 10. Send the final response back to Telegram.
    try {
        // If the Gemini response text is empty or only whitespace, send a default fallback message.
        if (!geminiResponseText || geminiResponseText.trim().length === 0) {
            console.warn("TELEGRAM_REPLY: Final Gemini response text was empty, sending a default message.");
            // Only send a generic fallback if the `geminiResponseText` doesn't already contain an error message.
            if (!geminiResponseText.startsWith('Произошла ошибка')) {
                await ctx.reply("Не удалось сгенерировать ответ. Попробуйте еще раз или измените запрос/настройки.");
            } else {
                // If it's already an error message from the try-catch block, send that.
                await ctx.reply(geminiResponseText);
            }
        } else {
            await ctx.reply(geminiResponseText);
        }
    } catch (replyError) {
        console.error('TELEGRAM_REPLY_ERROR: Failed to send final reply to Telegram:', replyError);
    }
});

// --- Webhook Configuration for Express ---
const app = express();
// Render provides the port via the PORT environment variable; default to 3000 for local development.
const port = process.env.PORT || 3000;

app.use(express.json()); // Middleware to parse incoming JSON request bodies.

// Use Telegraf's `bot.webhookCallback('/webhook')` middleware.
// This handles the incoming webhook POST request from Telegram and processes it through the bot instance.
app.use(bot.webhookCallback('/webhook'));

// Root endpoint ('/') for a simple server status check.
app.get('/', (req, res) => {
    res.send('Telegram Bot server is running and waiting for webhooks at /webhook. Gemini integration enabled.');
});

// --- Server Startup ---
// Start the Express server to listen for incoming HTTP requests.
app.listen(port, () => {
    console.log(`SERVER_START: Server running on port ${port}`);
    console.log(`SERVER_START: Webhook endpoint configured at /webhook`);
    console.log(`SERVER_START: Telegram Bot Token loaded.`);
    console.log(`SERVER_START: Gemini API Key loaded.`);
    console.log('SERVER_START: Awaiting incoming webhooks from Telegram...');
});

// IMPORTANT: Do NOT call `bot.launch()` when using webhooks.
// `bot.launch()` is for long polling mode. For webhooks, the Express server handles
// incoming requests which are then processed by `bot.webhookCallback()`.

// Optional: Enable graceful shutdown for local development/container environments.
// process.once('SIGINT', () => bot.stop('SIGINT')); // Handles Ctrl+C.
// process.once('SIGTERM', () => bot.stop('SIGTERM')); // Handles termination signals from OS/container orchestrators.