const express = require('express');
const cors = require('cors');
const multer = require('multer');
const TelegramBot = require('node-telegram-bot-api');
const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');
const { Api } = require('telegram/tl');
const input = require('telegram/Utils');
const fs = require('fs-extra');
const path = require('path');
const axios = require('axios');
const { pipeline } = require('stream');
const util = require('util');
const streamPipeline = util.promisify(pipeline);
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');

const app = express();

// ------------------------
// Security & Performance Middleware
// ------------------------
app.use(helmet({
  crossOriginResourcePolicy: { policy: "cross-origin" },
  crossOriginEmbedderPolicy: false
}));
app.use(cors({
  origin: true,
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
  credentials: true
}));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // limit each IP to 100 requests per windowMs
  message: { error: 'Too many requests, please try again later.' }
});
app.use('/upload', limiter);

// ------------------------
// CONFIG - Enhanced with Telegram Client
// ------------------------
const BOT_TOKEN = '8462261408:AAH75k38CJV4ZmrG8ZAnAI6HR7MHtT-SxB8';
const CHANNEL_ID = -1002897456594;
const TELEGRAM_MAX_FILE_BYTES = 4 * 1024 * 1024 * 1024; // 4 GB (increased)
const UPLOAD_DIR = '/tmp/uploads';
const CHUNK_SIZE = 2000 * 1024 * 1024; // 2GB chunks for large files

// Telegram Client Configuration
const API_ID = 20288994;
const API_HASH = "d702614912f1ad370a0d18786002adbf";
const BOT_TOKEN_CLIENT = "8146552831:AAEoNRMEt7TUOOprnngUstZaaOZ-wNoKmJs";
const stringSession = new StringSession(""); // Fill this if you have a saved session

// Video file extensions for streaming
const VIDEO_EXTENSIONS = ['.mp4', '.mkv', '.avi', '.mov', '.wmv', '.flv', '.webm', '.m4v', '.3gp', '.ts', '.m2ts'];
const AUDIO_EXTENSIONS = ['.mp3', '.wav', '.flac', '.aac', '.ogg', '.m4a', '.wma'];

// ------------------------
// Telegram clients initialization
// ------------------------
const bot = new TelegramBot(BOT_TOKEN, { polling: false });

// Initialize Telegram Client
const client = new TelegramClient(stringSession, API_ID, API_HASH, {
  connectionRetries: 5,
});

// Connect the client (this will be called in the startup)
async function connectTelegramClient() {
  await client.start({
    botAuthToken: BOT_TOKEN_CLIENT,
    onError: (err) => console.error('Telegram client error:', err),
  });
  console.log('Telegram client connected successfully');
}

// ------------------------
// Ensure directories
// ------------------------
fs.ensureDirSync(UPLOAD_DIR);

// ------------------------
// Enhanced Multer config with better error handling
// ------------------------
const upload = multer({
  dest: UPLOAD_DIR,
  limits: { 
    fileSize: TELEGRAM_MAX_FILE_BYTES,
    files: 1
  },
  fileFilter: (req, file, cb) => {
    // Accept all file types
    cb(null, true);
  }
});

// ------------------------
// Enhanced Helpers
// ------------------------
function safeFileName(name) {
  if (!name) return 'file';
  const ext = path.extname(name) || '';
  const base = path.basename(name, ext)
    .replace(/[\r\n"'`]/g, '_')
    .replace(/[<>:"/\\|?*]/g, '_')
    .replace(/[^\w\s\-\.]/g, '_')
    .trim()
    .slice(0, 100);
  return (base || 'file') + ext;
}

function isVideoFile(filename) {
  const ext = path.extname(filename).toLowerCase();
  return VIDEO_EXTENSIONS.includes(ext);
}

function isAudioFile(filename) {
  const ext = path.extname(filename).toLowerCase();
  return AUDIO_EXTENSIONS.includes(ext);
}

function makeDownloadUrl(req, fileId, originalName) {
  const protocol = req.headers['x-forwarded-proto'] || req.protocol || 'https';
  const host = req.headers.host || req.get('host');
  const safeName = encodeURIComponent(safeFileName(originalName || 'file'));
  return `${protocol}://${host}/download/${fileId}?filename=${safeName}`;
}

function makeStreamUrl(req, fileId, originalName) {
  const protocol = req.headers['x-forwarded-proto'] || req.protocol || 'https';
  const host = req.headers.host || req.get('host');
  const safeName = encodeURIComponent(safeFileName(originalName || 'file'));
  return `${protocol}://${host}/stream/${fileId}?filename=${safeName}`;
}

function makePlayerUrl(req, fileId, originalName) {
  const protocol = req.headers['x-forwarded-proto'] || req.protocol || 'https';
  const host = req.headers.host || req.get('host');
  const safeName = encodeURIComponent(safeFileName(originalName || 'file'));
  return `${protocol}://${host}/player/${fileId}?filename=${safeName}`;
}

// ------------------------
// File upload with chunking for large files using Telegram Client
// ------------------------
async function uploadLargeFile(filePath, originalName, chatId) {
  const stats = await fs.stat(filePath);
  
  if (stats.size <= 2000 * 1024 * 1024) { // 2GB or less, single upload
    // Using Telegram Client for larger files
    try {
      const result = await client.sendFile(chatId, {
        file: filePath,
        caption: `📁 ${originalName}\n💾 Size: ${formatFileSize(stats.size)}`
      });
      
      // Extract file_id from the result
      if (result && result.media && result.media.document) {
        return { 
          document: { 
            file_id: result.media.document.id.toString(),
            file_name: originalName
          },
          message_id: result.id
        };
      }
    } catch (error) {
      console.error('Error uploading with Telegram client:', error);
      // Fallback to bot API for smaller files
      return await bot.sendDocument(chatId, fs.createReadStream(filePath), {
        caption: `📁 ${originalName}\n💾 Size: ${formatFileSize(stats.size)}`
      });
    }
  }

  // For files larger than 2GB, we need to split them
  const chunks = Math.ceil(stats.size / CHUNK_SIZE);
  const messages = [];

  for (let i = 0; i < chunks; i++) {
    const start = i * CHUNK_SIZE;
    const end = Math.min(start + CHUNK_SIZE, stats.size);
    const chunkPath = `${filePath}.chunk${i}`;
    
    // Create chunk file
    const readStream = fs.createReadStream(filePath, { start, end: end - 1 });
    const writeStream = fs.createWriteStream(chunkPath);
    await streamPipeline(readStream, writeStream);
    
    try {
      // Use Telegram Client for large chunks
      const result = await client.sendFile(chatId, {
        file: chunkPath,
        caption: `📁 ${originalName} (Part ${i + 1}/${chunks})\n💾 Chunk Size: ${formatFileSize(end - start)}`
      });
      
      if (result && result.media && result.media.document) {
        messages.push({
          document: { 
            file_id: result.media.document.id.toString(),
            file_name: `${originalName} (Part ${i + 1}/${chunks})`
          },
          message_id: result.id
        });
      }
    } catch (error) {
      console.error(`Error uploading chunk ${i}:`, error);
      // Fallback to bot API
      const message = await bot.sendDocument(chatId, fs.createReadStream(chunkPath), {
        caption: `📁 ${originalName} (Part ${i + 1}/${chunks})\n💾 Chunk Size: ${formatFileSize(end - start)}`
      });
      messages.push(message);
    } finally {
      await fs.unlink(chunkPath).catch(() => {});
    }
  }

  return messages[0]; // Return first chunk message
}

function formatFileSize(bytes) {
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
  if (bytes === 0) return '0 Bytes';
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return Math.round(bytes / Math.pow(1024, i) * 100) / 100 + ' ' + sizes[i];
}

// ------------------------
// Webhook setup for Telegram bot
// ------------------------
app.post(`/webhook/${BOT_TOKEN}`, express.json(), async (req, res) => {
  try {
    const { message } = req.body;
    
    if (!message || !message.text) {
      return res.sendStatus(200);
    }
    
    const chatId = message.chat.id;
    const text = message.text.trim();
    
    // Handle /start command
    if (text === '/start') {
      await bot.sendMessage(chatId, 
        `🤖 Welcome to File Upload Bot!\n\n` +
        `Send me a file and I'll upload it to our channel and provide you with download links.\n\n` +
        `Max file size: 4GB\n` +
        `Supported formats: All file types`
      );
    }
    // Handle file messages
    else if (message.document || message.video || message.audio) {
      const fileId = message.document?.file_id || message.video?.file_id || message.audio?.file_id;
      const fileName = message.document?.file_name || 
                      (message.video ? `video_${message.video.file_id}.mp4` : 
                      (message.audio ? `audio_${message.audio.file_id}.mp3` : 'file'));
      
      try {
        // Download the file from Telegram
        const fileStream = bot.getFileStream(fileId);
        const filePath = path.join(UPLOAD_DIR, `${Date.now()}_${safeFileName(fileName)}`);
        const writeStream = fs.createWriteStream(filePath);
        
        await streamPipeline(fileStream, writeStream);
        
        // Upload to channel
        const uploadedMessage = await uploadLargeFile(filePath, fileName, CHANNEL_ID);
        
        if (uploadedMessage && uploadedMessage.document && uploadedMessage.document.file_id) {
          const downloadLink = makeDownloadUrl(req, uploadedMessage.document.file_id, fileName);
          
          await bot.sendMessage(chatId, 
            `✅ File uploaded successfully!\n\n` +
            `📁 Name: ${fileName}\n` +
            `🔗 Download: ${downloadLink}\n\n` +
            `You can share this link with others to download the file.`,
            { disable_web_page_preview: true }
          );
        } else {
          throw new Error('Upload failed - no file_id returned');
        }
        
        // Clean up
        await fs.unlink(filePath).catch(() => {});
        
      } catch (error) {
        console.error('Error processing file from bot:', error);
        await bot.sendMessage(chatId, 
          `❌ Failed to process your file. Please try again or contact support.\n\nError: ${error.message}`
        );
      }
    }
    // Unknown command
    else {
      await bot.sendMessage(chatId, 
        `I don't understand that command. Please send me a file to upload, or use /start to see help.`
      );
    }
    
    res.sendStatus(200);
  } catch (error) {
    console.error('Webhook error:', error);
    res.sendStatus(200); // Always respond to webhook to avoid retries
  }
});

// ------------------------
// Enhanced Upload endpoint
// ------------------------
app.post('/upload', upload.single('file'), async (req, res) => {
  let filePath = null;
  
  try {
    let originalName;
    let fileSize;

    // Handle file upload
    if (req.file) {
      filePath = req.file.path;
      originalName = req.file.originalname || req.file.filename;
      fileSize = req.file.size;
    }
    // Handle URL upload
    else if (req.body?.file_url) {
      const fileUrl = req.body.file_url;
      originalName = path.basename((fileUrl.split('?')[0] || '').trim()) || 'file';
      filePath = path.join(UPLOAD_DIR, `${Date.now()}_${safeFileName(originalName)}`);

      console.log(`📥 Downloading from URL: ${fileUrl}`);
      
      const response = await axios({
        method: 'GET',
        url: fileUrl,
        responseType: 'stream',
        timeout: 30000,
        maxContentLength: TELEGRAM_MAX_FILE_BYTES,
        maxBodyLength: TELEGRAM_MAX_FILE_BYTES
      });

      const writer = fs.createWriteStream(filePath);
      await streamPipeline(response.data, writer);
      
      const stats = await fs.stat(filePath);
      fileSize = stats.size;
    } 
    // Handle Telegram bot integration
    else if (req.body?.telegram_file_id) {
      return res.json({ 
        error: 'Direct Telegram file processing not implemented yet',
        message: 'Please use file upload or URL method' 
      });
    }
    else {
      return res.status(400).json({ 
        error: 'No file provided',
        message: 'Please provide a file via form upload or file_url parameter',
        supported_methods: ['multipart/form-data with file field', 'JSON with file_url field']
      });
    }

    // Validate file size
    if (fileSize > TELEGRAM_MAX_FILE_BYTES) {
      throw new Error(`File too large. Maximum size: ${formatFileSize(TELEGRAM_MAX_FILE_BYTES)}`);
    }

    console.log(`📤 Uploading to Telegram: ${originalName} (${formatFileSize(fileSize)})`);

    // Upload to Telegram
    const message = await uploadLargeFile(filePath, originalName, CHANNEL_ID);
    
    if (!message?.document?.file_id) {
      throw new Error('Telegram upload failed - no file_id returned');
    }

    // Generate URLs
    const fileId = message.document.file_id;
    const downloadLink = makeDownloadUrl(req, fileId, originalName);
    const streamLink = makeStreamUrl(req, fileId, originalName);
    const playerLink = makePlayerUrl(req, fileId, originalName);

    // Determine file type
    const isVideo = isVideoFile(originalName);
    const isAudio = isAudioFile(originalName);

    const response = {
      success: true,
      file_name: originalName,
      file_size: fileSize,
      file_size_formatted: formatFileSize(fileSize),
      file_id: fileId,
      download_url: downloadLink,
      hotlink: downloadLink, // Legacy compatibility
      telegram_message_id: message.message_id,
      file_type: isVideo ? 'video' : isAudio ? 'audio' : 'document',
      upload_time: new Date().toISOString()
    };

    // Add streaming URLs for media files
    if (isVideo || isAudio) {
      response.stream_url = streamLink;
      response.player_url = playerLink;
      response.supports_streaming = true;
    }

    console.log(`✅ Upload successful: ${originalName}`);
    return res.json(response);

  } catch (err) {
    console.error('❌ Upload error:', err);
    
    // Enhanced error messages
    let errorMessage = err.message || 'Upload failed';
    let statusCode = 500;

    if (err.message?.includes('chat not found')) {
      errorMessage = 'Telegram channel not accessible. Please check bot permissions.';
      statusCode = 400;
    } else if (err.message?.includes('too large') || err.code === 'LIMIT_FILE_SIZE') {
      errorMessage = `File too large. Maximum size: ${formatFileSize(TELEGRAM_MAX_FILE_BYTES)}`;
      statusCode = 413;
    } else if (err.code === 'ENOTFOUND' || err.code === 'ECONNREFUSED') {
      errorMessage = 'Network error. Please check the file URL or try again later.';
      statusCode = 502;
    }

    return res.status(statusCode).json({
      success: false,
      error: errorMessage,
      details: process.env.NODE_ENV === 'development' ? err.stack : undefined
    });
  } finally {
    // Cleanup
    if (filePath) {
      await fs.unlink(filePath).catch(() => {});
    }
  }
});

// ------------------------
// Enhanced Download endpoint with range support
// ------------------------
app.get('/download/:file_id', async (req, res) => {
  try {
    const fileId = req.params.file_id;
    const requestedName = req.query.filename || 'file';
    const fileName = safeFileName(decodeURIComponent(requestedName));

    console.log(`📥 Download request: ${fileName}`);

    // Get file info from Telegram
    const file = await bot.getFile(fileId);
    if (!file?.file_path) {
      throw new Error('File not found on Telegram servers');
    }

    const fileUrl = `https://api.telegram.org/file/bot${BOT_TOKEN}/${file.file_path}`;

    // Set headers
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Accept-Ranges', 'bytes');

    // Handle range requests for better download experience
    const range = req.headers.range;
    if (range) {
      try {
        const response = await axios.get(fileUrl, {
          responseType: 'stream',
          headers: { Range: range },
          timeout: 0,
          maxContentLength: Infinity,
          maxBodyLength: Infinity
        });
        
        res.status(206);
        res.setHeader('Content-Range', response.headers['content-range']);
        res.setHeader('Content-Length', response.headers['content-length']);
        
        await streamPipeline(response.data, res);
        return;
      } catch (rangeErr) {
        console.log('Range request failed, falling back to full download');
      }
    }

    // Full file download
    const response = await axios.get(fileUrl, {
      responseType: 'stream',
      timeout: 0,
      maxContentLength: Infinity,
      maxBodyLength: Infinity
    });

    if (response.headers['content-length']) {
      res.setHeader('Content-Length', response.headers['content-length']);
    }

    await streamPipeline(response.data, res);
    console.log(`✅ Download completed: ${fileName}`);

  } catch (err) {
    console.error('❌ Download error:', err);
    const message = err.message?.includes('not found') ? 'File not found' : 'Download failed';
    return res.status(404).json({ error: message });
  }
});

// ------------------------
// Stream endpoint for direct media streaming
// ------------------------
app.get('/stream/:file_id', async (req, res) => {
  try {
    const fileId = req.params.file_id;
    const requestedName = req.query.filename || 'file';
    const fileName = safeFileName(decodeURIComponent(requestedName));

    console.log(`🎬 Stream request: ${fileName}`);

    const file = await bot.getFile(fileId);
    if (!file?.file_path) {
      throw new Error('File not found');
    }

    const fileUrl = `https://api.telegram.org/file/bot${BOT_TOKEN}/${file.file_path}`;

    // Determine content type based on extension
    const ext = path.extname(fileName).toLowerCase();
    let contentType = 'application/octet-stream';
    
    if (VIDEO_EXTENSIONS.includes(ext)) {
      contentType = `video/${ext.substring(1)}`;
    } else if (AUDIO_EXTENSIONS.includes(ext)) {
      contentType = `audio/${ext.substring(1)}`;
    }

    // Set streaming headers
    res.setHeader('Content-Type', contentType);
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Cache-Control', 'public, max-age=31536000');

    // Handle range requests (essential for video streaming)
    const range = req.headers.range;
    
    if (range) {
      const response = await axios.get(fileUrl, {
        responseType: 'stream',
        headers: { Range: range },
        timeout: 0,
        maxContentLength: Infinity,
        maxBodyLength: Infinity
      });

      res.status(206);
      res.setHeader('Content-Range', response.headers['content-range']);
      res.setHeader('Content-Length', response.headers['content-length']);
      
      await streamPipeline(response.data, res);
    } else {
      const response = await axios.get(fileUrl, {
        responseType: 'stream',
        timeout: 0,
        maxContentLength: Infinity,
        maxBodyLength: Infinity
      });

      if (response.headers['content-length']) {
        res.setHeader('Content-Length', response.headers['content-length']);
      }

      await streamPipeline(response.data, res);
    }

    console.log(`✅ Stream completed: ${fileName}`);

  } catch (err) {
    console.error('❌ Stream error:', err);
    return res.status(404).json({ error: 'Stream not available' });
  }
});

// ------------------------
// Player page with Plyr
// ------------------------
app.get('/player/:file_id', async (req, res) => {
  try {
    const fileId = req.params.file_id;
    const requestedName = req.query.filename || 'file';
    const fileName = safeFileName(decodeURIComponent(requestedName));
    
    // Check if file exists
    const file = await bot.getFile(fileId);
    if (!file?.file_path) {
      return res.status(404).send('File not found');
    }

    const streamUrl = makeStreamUrl(req, fileId, fileName);
    const isVideo = isVideoFile(fileName);
    const isAudio = isAudioFile(fileName);

    if (!isVideo && !isAudio) {
      return res.status(400).send('File type not supported for streaming');
    }

    const playerHTML = `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${fileName} - Media Player</title>
    <link rel="stylesheet" href="https://cdn.plyr.io/3.7.8/plyr.css" />
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            min-height: 100vh;
            display: flex;
            align-items: center;
            justify-content: center;
            padding: 20px;
        }
        .container {
            max-width: 90vw;
            max-height: 90vh;
            background: rgba(255, 255, 255, 0.1);
            backdrop-filter: blur(10px);
            border-radius: 20px;
            padding: 30px;
            box-shadow: 0 8px 32px 0 rgba(31, 38, 135, 0.37);
            border: 1px solid rgba(255, 255, 255, 0.18);
        }
        .player-wrapper {
            width: 100%;
            max-width: ${isVideo ? '1200px' : '600px'};
            margin: 0 auto;
        }
        .file-info {
            text-align: center;
            color: white;
            margin-bottom: 20px;
        }
        .file-info h1 {
            font-size: 1.5rem;
            margin-bottom: 10px;
            word-break: break-word;
        }
        .download-btn {
            display: inline-block;
            margin-top: 15px;
            padding: 12px 24px;
            background: rgba(255, 255, 255, 0.2);
            color: white;
            text-decoration: none;
            border-radius: 25px;
            transition: all 0.3s ease;
            border: 1px solid rgba(255, 255, 255, 0.3);
        }
        .download-btn:hover {
            background: rgba(255, 255, 255, 0.3);
            transform: translateY(-2px);
        }
        .plyr {
            border-radius: 15px;
            overflow: hidden;
        }
        ${isAudio ? `
        .plyr--audio {
            background: rgba(255, 255, 255, 0.1);
            border-radius: 15px;
        }
        ` : ''}
        @media (max-width: 768px) {
            .container { padding: 15px; }
            .file-info h1 { font-size: 1.2rem; }
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="file-info">
            <h1>🎬 ${fileName}</h1>
            <p>High-quality streaming powered by Telegram</p>
            <a href="${makeDownloadUrl(req, fileId, fileName)}" class="download-btn">
                📥 Download File
            </a>
        </div>
        <div class="player-wrapper">
            ${isVideo ? 
                `<video id="player" playsinline controls data-poster="" crossorigin="anonymous">
                    <source src="${streamUrl}" type="video/mp4" />
                    Your browser doesn't support video playback.
                </video>` :
                `<audio id="player" controls crossorigin="anonymous">
                    <source src="${streamUrl}" type="audio/mpeg" />
                    Your browser doesn't support audio playback.
                </audio>`
            }
        </div>
    </div>

    <script src="https://cdn.plyr.io/3.7.8/plyr.polyfilled.js"></script>
    <script>
        document.addEventListener('DOMContentLoaded', () => {
            const player = new Plyr('#player', {
                controls: [
                    'play-large', 'restart', 'rewind', 'play', 'fast-forward', 
                    'progress', 'current-time', 'duration', 'mute', 'volume', 
                    ${isVideo ? "'captions', 'settings', 'pip', 'airplay', 'fullscreen'" : "'settings'"}
                ],
                settings: ['captions', 'quality', 'speed'],
                quality: { default: 720, options: [4320, 2880, 2160, 1440, 1080, 720, 576, 480, 360, 240] },
                speed: { selected: 1, options: [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2] },
                ratio: ${isVideo ? "'16:9'" : 'null'},
                loadSprite: false,
                iconUrl: 'https://cdn.plyr.io/3.7.8/plyr.svg'
            });

            player.on('ready', () => {
                console.log('Player ready');
            });

            player.on('error', (event) => {
                console.error('Player error:', event);
                alert('Error loading media. Please try downloading the file instead.');
            });
        });
    </script>
</body>
</html>`;

    res.setHeader('Content-Type', 'text/html');
    res.send(playerHTML);

  } catch (err) {
    console.error('❌ Player error:', err);
    res.status(404).send('<h1>File not found</h1><p>The requested media file could not be found.</p>');
  }
});

// ------------------------
// API Info endpoint
// ------------------------
app.get('/api/info', (req, res) => {
  res.json({
    name: 'Enhanced File Upload & Streaming API',
    version: '2.0.0',
    features: [
      'File uploads up to 4GB',
      'Support for all file types',
      'Video/Audio streaming with Plyr player',
      'Range request support',
      'Rate limiting & security',
      'Multiple upload methods (form, URL)',
      'Telegram bot integration'
    ],
    endpoints: {
      'POST /upload': 'Upload files via form data or URL',
      'GET /download/:file_id': 'Download files',
      'GET /stream/:file_id': 'Stream media files',
      'GET /player/:file_id': 'Media player page',
      'GET /api/info': 'API information',
      `POST /webhook/${BOT_TOKEN}`: 'Telegram bot webhook'
    },
    limits: {
      max_file_size: TELEGRAM_MAX_FILE_BYTES,
      max_file_size_formatted: formatFileSize(TELEGRAM_MAX_FILE_BYTES),
      supported_video_formats: VIDEO_EXTENSIONS,
      supported_audio_formats: AUDIO_EXTENSIONS
    }
  });
});

// ------------------------
// Health check
// ------------------------
app.get('/health', (req, res) => {
  res.json({ 
    status: 'healthy', 
    uptime: process.uptime(),
    timestamp: new Date().toISOString()
  });
});

// ------------------------
// 404 handler
// ------------------------
app.use('*', (req, res) => {
  res.status(404).json({ 
    error: 'Endpoint not found',
    available_endpoints: ['/upload', '/download/:file_id', '/stream/:file_id', '/player/:file_id', '/api/info']
  });
});

// ------------------------
// Global error handler
// ------------------------
app.use((err, req, res, next) => {
  console.error('❌ Global error:', err);
  res.status(500).json({ 
    error: 'Internal server error',
    message: process.env.NODE_ENV === 'development' ? err.message : 'Something went wrong'
  });
});

// ------------------------
// Startup function
// ------------------------
async function startServer() {
  try {
    // Connect Telegram client
    await connectTelegramClient();
    
    // Set webhook for Telegram bot (if running on Vercel)
    if (process.env.VERCEL_URL) {
      const webhookUrl = `https://${process.env.VERCEL_URL}/webhook/${BOT_TOKEN}`;
      await bot.setWebHook(webhookUrl);
      console.log(`Webhook set to: ${webhookUrl}`);
    }
    
    console.log('🚀 Enhanced File Upload & Streaming API ready!');
    console.log('🤖 Telegram bot integrated with 4GB file support');
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}

// ------------------------
// Graceful shutdown
// ------------------------
process.on('SIGTERM', async () => {
  console.log('🛑 Received SIGTERM, shutting down gracefully');
  await client.destroy();
  process.exit(0);
});

process.on('SIGINT', async () => {
  console.log('🛑 Received SIGINT, shutting down gracefully');
  await client.destroy();
  process.exit(0);
});

// Start the server
startServer();

module.exports = app;
