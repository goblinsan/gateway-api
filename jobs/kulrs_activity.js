const fs = require('fs').promises;
const path = require('path');
const https = require('https');
const http = require('http');
const Jimp = require('jimp');

const UNSPLASH_ACCESS_KEY = process.env.UNSPLASH_ACCESS_KEY;
const TIMEZONE = process.env.KULRS_TIMEZONE || 'America/New_York';
const KULRS_CREATE_MODE = (process.env.KULRS_CREATE_MODE || 'llm').trim().toLowerCase();
const KULRS_LLM_BASE_URL = (
    process.env.KULRS_LLM_BASE_URL ||
    process.env.OPENAI_BASE_URL ||
    'http://127.0.0.1:5301'
).trim().replace(/\/$/, '');
const KULRS_LLM_MODEL = (
    process.env.KULRS_LLM_MODEL ||
    process.env.OPENAI_DEFAULT_MODEL ||
    'Mistral-7B-Instruct-v0.3-Q4_K_M.gguf'
).trim();
const KULRS_LLM_API_KEY = (
    process.env.KULRS_LLM_API_KEY ||
    process.env.OPENAI_API_KEY ||
    ''
).trim();
const KULRS_LLM_TIMEOUT_MS = Number.parseInt(process.env.KULRS_LLM_TIMEOUT_MS || '25000', 10);
const KULRS_LLM_TEMPERATURE = Number.parseFloat(process.env.KULRS_LLM_TEMPERATURE || '0.7');
const CRON_LOG_RETENTION_DAYS = Number.parseFloat(process.env.KULRS_CRON_LOG_RETENTION_DAYS || '2');

const CALENDAR_THEME_WINDOWS = [
    { label: "New Year's", start: '12-26', end: '01-05', notes: ['midnight', 'spark', 'clean slate'] },
    { label: "Valentine's season", start: '02-01', end: '02-15', notes: ['romance', 'candy', 'floral'] },
    { label: "St. Patrick's season", start: '03-10', end: '03-18', notes: ['emerald', 'parade', 'pub'] },
    { label: 'Spring holidays', start: '03-20', end: '04-20', notes: ['garden', 'blossom', 'fresh air'] },
    { label: 'Memorial Day season', start: '05-20', end: '05-31', notes: ['picnic', 'early summer', 'patriotic'] },
    { label: 'Independence Day season', start: '06-24', end: '07-05', notes: ['fireworks', 'cookout', 'summer night'] },
    { label: 'Back-to-school season', start: '08-01', end: '09-10', notes: ['notebooks', 'fresh markers', 'late summer'] },
    { label: 'Halloween season', start: '10-01', end: '10-31', notes: ['costume', 'candlelight', 'pumpkin'] },
    { label: 'Thanksgiving season', start: '11-10', end: '11-28', notes: ['harvest', 'table', 'warmth'] },
    { label: 'Winter holidays', start: '12-01', end: '12-31', notes: ['evergreen', 'ornament', 'festive lights'] },
];

// Each bot's personality drives palette generation:
// seed word -> datamuse association -> calendar context -> llm palette
const BOT_PERSONALITIES = {
    mireille:   { seeds: ['jazz', 'patisserie', 'lavender', 'champagne', 'ballet', 'autumn', 'lace'] },
    hex_junkie: { seeds: ['circuit', 'neon', 'ramen', 'keyboard', 'plasma', 'glitch', 'laser'] },
    sol_studio: { seeds: ['surfing', 'lemon', 'california', 'sunrise', 'sand', 'tide', 'hammock'] },
    nyx:        { seeds: ['midnight', 'cathedral', 'obsidian', 'galaxy', 'smoke', 'eclipse', 'onyx'] },
    sundrop:    { seeds: ['mango', 'sunflower', 'tropics', 'citrus', 'coral', 'marigold', 'saffron'] },
    fieldnotes: { seeds: ['hiking', 'forest', 'mushroom', 'fog', 'moss', 'fern', 'pine'] },
    retrograde: { seeds: ['vinyl', 'cassette', 'diner', 'polaroid', 'chrome', 'arcade', 'television'] },
    civic_grey: { seeds: ['concrete', 'overcast', 'urban', 'steel', 'subway', 'rain', 'asphalt'] },
    pastelwave: { seeds: ['blossom', 'mochi', 'cotton', 'daydream', 'rose', 'petal', 'cloud'] },
    inkwell:    { seeds: ['coffee', 'library', 'ink', 'parchment', 'candle', 'leather', 'sepia'] },
    saltflat:   { seeds: ['desert', 'salt', 'mirage', 'horizon', 'bleached', 'dust', 'bone'] },
    velvetroom: { seeds: ['velvet', 'bourbon', 'candlelight', 'silk', 'noir', 'burgundy', 'mahogany'] },
    chromalab:  { seeds: ['pigment', 'paint', 'watercolor', 'spectrum', 'dye', 'prism', 'gradient'] },
    zestpop:    { seeds: ['citrus', 'bubblegum', 'candy', 'neon', 'soda', 'confetti', 'sherbet'] },
    driftwood:  { seeds: ['driftwood', 'fog', 'tide', 'barnacle', 'kelp', 'coastal', 'pebble'] },
};

const WORKSPACE_DIR = process.env.KULRS_WORKSPACE_DIR || '/home/momito/.openclaw/workspace';
const ACTIVITY_LOG_PATH = process.env.KULRS_ACTIVITY_LOG_PATH || path.join(WORKSPACE_DIR, 'memory', 'kulrs-activity-log.json');
const AUTH_HEALTH_LOG_PATH = process.env.KULRS_AUTH_HEALTH_LOG_PATH || path.join(WORKSPACE_DIR, 'memory', 'kulrs-auth-health.json');
const CREDS_PATH = process.env.KULRS_CREDS_PATH || '/home/momito/.openclaw/kulrs.json';
const CRON_LOG_PATH = process.env.KULRS_CRON_LOG_PATH || path.join(WORKSPACE_DIR, 'memory', 'kulrs-cron.log');
const CRON_LOG_MAX_LINES = Number.parseInt(process.env.KULRS_CRON_LOG_MAX_LINES || '500', 10);

async function rotateCronLog() {
    try {
        const data = await fs.readFile(CRON_LOG_PATH, 'utf-8');
        const cutoff = Date.now() - (Math.max(1, CRON_LOG_RETENTION_DAYS) * 24 * 60 * 60 * 1000);
        const lines = data
            .split('\n')
            .filter(line => line.trim().length > 0)
            .filter((line) => {
                const match = line.match(/^\[([^\]]+)\]/);
                if (!match) return true;
                const timestamp = Date.parse(match[1]);
                return Number.isNaN(timestamp) || timestamp >= cutoff;
            });
        if (lines.length > CRON_LOG_MAX_LINES) {
            await fs.writeFile(CRON_LOG_PATH, `${lines.slice(-CRON_LOG_MAX_LINES).join('\n')}\n`, 'utf-8');
        } else if (lines.length === 0) {
            await fs.writeFile(CRON_LOG_PATH, '', 'utf-8');
        }
    } catch (e) {
        if (e.code !== 'ENOENT') console.warn('Log rotate failed:', e.message);
    }
}

async function appendCronLog(level, message) {
    const line = `[${new Date().toISOString()}] ${level} ${message}\n`;
    await fs.mkdir(path.dirname(CRON_LOG_PATH), { recursive: true });
    await fs.appendFile(CRON_LOG_PATH, line, 'utf-8');
    await rotateCronLog();
}

async function logInfo(message) {
    console.log(message);
    await appendCronLog('INFO', message);
}

async function logWarn(message) {
    console.warn(message);
    await appendCronLog('WARN', message);
}

async function logError(message) {
    console.error(message);
    await appendCronLog('ERROR', message);
}

// --- Helpers ---

async function readJson(filePath, defaultValue = null) {
    try {
        const data = await fs.readFile(filePath, 'utf-8');
        if (data.trim() === '') return defaultValue;
        return JSON.parse(data);
    } catch (error) {
        if (error.code === 'ENOENT') return defaultValue;
        if (error instanceof SyntaxError) return defaultValue;
        throw error;
    }
}

async function writeJson(filePath, data) {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, JSON.stringify(data, null, 2), 'utf-8');
}

function clampNumber(value, fallback) {
    return Number.isFinite(value) ? value : fallback;
}

function getLocalDateParts(date) {
    const formatter = new Intl.DateTimeFormat('en-US', {
        timeZone: TIMEZONE,
        weekday: 'long',
        month: 'long',
        day: 'numeric',
        year: 'numeric',
    });
    const parts = formatter.formatToParts(date);
    const get = (type) => parts.find(part => part.type === type)?.value || '';
    return {
        weekday: get('weekday'),
        month: get('month'),
        day: get('day'),
        year: get('year'),
    };
}

function getDateKey(date) {
    const formatter = new Intl.DateTimeFormat('en-US', {
        timeZone: TIMEZONE,
        month: '2-digit',
        day: '2-digit',
    });
    const parts = formatter.formatToParts(date);
    const get = (type) => parts.find(part => part.type === type)?.value || '00';
    return `${get('month')}-${get('day')}`;
}

function getSeasonForMonth(monthName) {
    const month = monthName.toLowerCase();
    if (['december', 'january', 'february'].includes(month)) return 'winter';
    if (['march', 'april', 'may'].includes(month)) return 'spring';
    if (['june', 'july', 'august'].includes(month)) return 'summer';
    return 'autumn';
}

function isDateKeyWithinRange(dateKey, start, end) {
    if (start <= end) return dateKey >= start && dateKey <= end;
    return dateKey >= start || dateKey <= end;
}

function getCalendarThemeContext(now) {
    const parts = getLocalDateParts(now);
    const dateKey = getDateKey(now);
    const season = getSeasonForMonth(parts.month);
    const holidayThemes = CALENDAR_THEME_WINDOWS
        .filter(window => isDateKeyWithinRange(dateKey, window.start, window.end))
        .map(window => window.label);
    const holidayNotes = CALENDAR_THEME_WINDOWS
        .filter(window => isDateKeyWithinRange(dateKey, window.start, window.end))
        .flatMap(window => window.notes);
    const weekend = ['Saturday', 'Sunday'].includes(parts.weekday);

    return {
        season,
        holidayThemes,
        holidayNotes,
        weekend,
        summary: [
            `${parts.weekday}, ${parts.month} ${parts.day}, ${parts.year}`,
            `${season} in ${TIMEZONE}`,
            holidayThemes.length > 0 ? `holiday windows: ${holidayThemes.join(', ')}` : 'no active holiday window',
            weekend ? 'weekend mood' : 'weekday mood',
        ].join(' | '),
    };
}

function httpsGet(url) {
    return new Promise((resolve, reject) => {
        const options = {
            headers: { 'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36' },
        };
        https.get(url, options, (res) => {
            let body = '';
            res.on('data', chunk => body += chunk);
            res.on('end', () => {
                if (res.statusCode < 200 || res.statusCode >= 300) {
                    reject(new Error(`httpsGet ${url} returned ${res.statusCode}`));
                    return;
                }
                try { resolve({ status: res.statusCode, body: JSON.parse(body) }); }
                catch (e) { reject(new Error(`JSON parse failed for ${url}: ${e.message}`)); }
            });
        }).on('error', reject);
    });
}

function apiRequest(options, postData = null) {
    return new Promise((resolve, reject) => {
        const req = https.request(options, (res) => {
            let body = '';
            res.on('data', chunk => body += chunk);
            res.on('end', () => {
                try {
                    if (res.statusCode >= 200 && res.statusCode < 300) {
                        resolve(JSON.parse(body || '{}'));
                    } else {
                        reject(new Error(`API ${options.path} failed ${res.statusCode}: ${body}`));
                    }
                } catch (e) {
                    reject(new Error(`Failed to parse response from ${options.path}: ${e.message}`));
                }
            });
        });
        req.on('error', reject);
        if (postData) req.write(postData);
        req.end();
    });
}

async function signInBot(email, password, apiKey) {
    const body = JSON.stringify({ email, password, returnSecureToken: true });
    const options = {
        hostname: 'identitytoolkit.googleapis.com',
        path: `/v1/accounts:signInWithPassword?key=${apiKey}`,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    };
    const res = await apiRequest(options, body);
    return res.idToken;
}

function resolveConfiguredBots(creds) {
    const requestedBots = (process.env.KULRS_BOTS || '')
        .split(',')
        .map(bot => bot.trim())
        .filter(Boolean);

    const candidateBots = requestedBots.length > 0
        ? requestedBots
        : Object.keys(creds).filter(key => key !== 'firebaseApiKey');

    return candidateBots.filter(bot =>
        BOT_PERSONALITIES[bot] &&
        creds[bot] &&
        typeof creds[bot].email === 'string' &&
        creds[bot].email &&
        typeof creds[bot].password === 'string' &&
        creds[bot].password
    );
}

// --- Inspiration Chain ---

function pickSeed(bot) {
    const seeds = BOT_PERSONALITIES[bot].seeds;
    return seeds[Math.floor(Math.random() * seeds.length)];
}

async function getAssociatedWord(seed) {
    const { status, body } = await httpsGet(
        `https://api.datamuse.com/words?rel_trg=${encodeURIComponent(seed)}&max=30`
    );
    if (status !== 200 || !Array.isArray(body) || body.length === 0) {
        throw new Error(`Datamuse returned no associations for "${seed}"`);
    }
    const pool = body.slice(0, 15);
    return pool[Math.floor(Math.random() * pool.length)].word;
}

async function searchUnsplash(query) {
    if (!UNSPLASH_ACCESS_KEY) throw new Error('UNSPLASH_ACCESS_KEY env var not set');
    const options = {
        hostname: 'api.unsplash.com',
        path: `/search/photos?page=1&per_page=20&query=${encodeURIComponent(query)}`,
        method: 'GET',
        headers: {
            'Authorization': `Client-ID ${UNSPLASH_ACCESS_KEY}`,
            'Accept-Version': 'v1',
        },
    };
    const res = await apiRequest(options);
    if (!res.results || res.results.length === 0) {
        throw new Error(`Unsplash returned no photos for "${query}"`);
    }
    const photo = res.results[Math.floor(Math.random() * res.results.length)];
    return { url: photo.urls.small, id: photo.id, description: photo.alt_description || query };
}

async function extractPixelsFromUrl(imageUrl) {
    const buffer = await new Promise((resolve, reject) => {
        const client = imageUrl.startsWith('https') ? https : http;
        const get = (url) => client.get(url, (res) => {
            if (res.statusCode === 301 || res.statusCode === 302) {
                return get(res.headers.location);
            }
            const chunks = [];
            res.on('data', chunk => chunks.push(chunk));
            res.on('end', () => resolve(Buffer.concat(chunks)));
            res.on('error', reject);
        }).on('error', reject);
        get(imageUrl);
    });

    const image = await Jimp.read(buffer);
    const { width, height } = image.bitmap;
    const total = width * height;
    const step = Math.max(1, Math.floor(total / 5000));
    const pixels = [];
    for (let i = 0; i < total; i += step) {
        const x = i % width;
        const y = Math.floor(i / width);
        const rgba = Jimp.intToRGBA(image.getPixelColor(x, y));
        pixels.push({ r: rgba.r, g: rgba.g, b: rgba.b });
    }
    return pixels;
}

async function generatePaletteFromPixels(pixels, token) {
    const body = JSON.stringify({ pixels, colorCount: 5 });
    const options = {
        hostname: 'api.kulrs.com',
        path: '/generate/image',
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json',
            'Origin': 'https://kulrs.com',
            'User-Agent': 'Mozilla/5.0',
            'Content-Length': Buffer.byteLength(body),
        },
    };
    const res = await apiRequest(options, body);
    return res.data;
}

function extractAssistantContent(payload) {
    if (!payload || typeof payload !== 'object') {
        throw new Error('LLM response was not an object');
    }
    if (typeof payload.output_text === 'string' && payload.output_text.trim()) {
        return payload.output_text;
    }
    if (Array.isArray(payload.choices) && payload.choices.length > 0) {
        const content = payload.choices[0]?.message?.content;
        if (typeof content === 'string' && content.trim()) {
            return content;
        }
        if (Array.isArray(content)) {
            const text = content
                .map(item => item && typeof item.text === 'string' ? item.text : '')
                .filter(Boolean)
                .join('\n');
            if (text) return text;
        }
    }
    throw new Error('Could not extract text from LLM response');
}

function stripJsonFences(text) {
    const trimmed = text.trim();
    if (!trimmed.startsWith('```')) return trimmed;
    return trimmed
        .replace(/^```(?:json)?\s*/i, '')
        .replace(/\s*```$/, '')
        .trim();
}

function normalizeHexColor(value) {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim().toUpperCase();
    if (/^#[0-9A-F]{6}$/.test(trimmed)) return trimmed;
    return null;
}

function validatePaletteResponse(rawPayload, fallbackName, fallbackDescription) {
    const payload = rawPayload && typeof rawPayload === 'object' ? rawPayload : {};
    const colors = Array.isArray(payload.colors)
        ? payload.colors.map(normalizeHexColor).filter(Boolean)
        : [];
    const uniqueColors = Array.from(new Set(colors));
    if (uniqueColors.length < 3 || uniqueColors.length > 5) {
        throw new Error(`LLM returned invalid color count (${uniqueColors.length})`);
    }

    const name = typeof payload.name === 'string' && payload.name.trim()
        ? payload.name.trim().slice(0, 80)
        : fallbackName;
    const description = typeof payload.description === 'string' && payload.description.trim()
        ? payload.description.trim().slice(0, 180)
        : fallbackDescription;

    return { name, description, colors: uniqueColors };
}

async function callKulrsLlm(messages, temperature) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), clampNumber(KULRS_LLM_TIMEOUT_MS, 25000));
    const headers = { 'Content-Type': 'application/json' };
    if (KULRS_LLM_API_KEY) {
        headers.Authorization = `Bearer ${KULRS_LLM_API_KEY}`;
    }

    try {
        const response = await fetch(`${KULRS_LLM_BASE_URL}/v1/chat/completions`, {
            method: 'POST',
            headers,
            signal: controller.signal,
            body: JSON.stringify({
                model: KULRS_LLM_MODEL,
                temperature,
                messages,
            }),
        });
        const bodyText = await response.text().catch(() => '');
        if (!response.ok) {
            throw new Error(`LLM request failed (${response.status}): ${bodyText.slice(0, 500)}`);
        }
        const payload = bodyText ? JSON.parse(bodyText) : {};
        return extractAssistantContent(payload);
    } finally {
        clearTimeout(timeout);
    }
}

function buildPaletteMessages({ bot, seed, topic, calendar }) {
    const fallbackName = `${topic} by ${bot}`;
    const fallbackDescription = `Palette for ${bot} built from ${seed}, ${topic}, and ${calendar.season} timing.`;
    return {
        fallbackName,
        fallbackDescription,
        messages: [
            {
                role: 'system',
                content: [
                    'You design polished color palettes for the Kulrs site.',
                    'Return JSON only with exactly this shape:',
                    '{"name":"short palette name","description":"one sentence","colors":["#112233","#445566","#778899"]}',
                    'Rules:',
                    '- colors must contain 3 to 5 distinct uppercase hex values',
                    '- no markdown, no explanations, no extra keys',
                    '- make the palette feel publishable and visually coherent',
                ].join('\n'),
            },
            {
                role: 'user',
                content: [
                    `Bot: ${bot}`,
                    `Personality seeds: ${BOT_PERSONALITIES[bot].seeds.join(', ')}`,
                    `Chosen seed: ${seed}`,
                    `Associated topic: ${topic}`,
                    `Calendar context: ${calendar.summary}`,
                    calendar.holidayNotes.length > 0
                        ? `Holiday cues: ${calendar.holidayNotes.join(', ')}`
                        : 'Holiday cues: none',
                    'Generate a fresh palette for this five-minute slot.',
                ].join('\n'),
            },
        ],
    };
}

async function generatePaletteViaLlm({ bot, seed, topic, calendar }) {
    const { fallbackName, fallbackDescription, messages } = buildPaletteMessages({ bot, seed, topic, calendar });
    const temperatures = [clampNumber(KULRS_LLM_TEMPERATURE, 0.7), 0.35];
    let lastError = null;

    for (const temperature of temperatures) {
        try {
            const content = await callKulrsLlm(messages, temperature);
            const parsed = JSON.parse(stripJsonFences(content));
            return validatePaletteResponse(parsed, fallbackName, fallbackDescription);
        } catch (error) {
            lastError = error;
        }
    }

    throw new Error(`Palette LLM failed: ${lastError?.message || 'unknown error'}`);
}

// --- Core Actions ---

async function performCreateImageAction(bot, token) {
    const seed = pickSeed(bot);
    let word;
    try {
        word = await getAssociatedWord(seed);
    } catch (e) {
        await logWarn(`Datamuse fallback for "${seed}": ${e.message}`);
        word = seed;
    }
    const photo = await searchUnsplash(word);
    const pixels = await extractPixelsFromUrl(photo.url);
    const generated = await generatePaletteFromPixels(pixels, token);

    const postBody = JSON.stringify({
        palette: {
            colors: generated.colors,
            metadata: {
                generator: `kulrs-pulse:${bot}`,
                explanation: `${seed} -> ${word}`,
                timestamp: new Date().toISOString(),
            },
        },
        name: `${word} by ${bot}`,
        description: `Inspired by "${seed}" -> "${word}"`,
        isPublic: true,
    });
    const options = {
        hostname: 'api.kulrs.com',
        path: '/palettes',
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json',
            'Origin': 'https://kulrs.com',
            'User-Agent': 'Mozilla/5.0',
            'Content-Length': Buffer.byteLength(postBody),
        },
    };
    const res = await apiRequest(options, postBody);
    const paletteId = res.data.id;
    await logInfo(`[${bot}] CREATE ok: mode="image" seed="${seed}" word="${word}" image="${photo.description}" photo_id="${photo.id}" palette=${paletteId}`);
    return paletteId;
}

async function performCreateLlmAction(bot, token, now) {
    const seed = pickSeed(bot);
    let topic;
    try {
        topic = await getAssociatedWord(seed);
    } catch (error) {
        await logWarn(`Datamuse fallback for "${seed}": ${error.message}`);
        topic = seed;
    }

    const calendar = getCalendarThemeContext(now);
    const generated = await generatePaletteViaLlm({ bot, seed, topic, calendar });

    const postBody = JSON.stringify({
        palette: {
            colors: generated.colors,
            metadata: {
                generator: `kulrs-pulse:${bot}`,
                strategy: 'llm',
                seed,
                topic,
                calendar: calendar.summary,
                timestamp: new Date().toISOString(),
            },
        },
        name: generated.name,
        description: generated.description,
        isPublic: true,
    });
    const options = {
        hostname: 'api.kulrs.com',
        path: '/palettes',
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json',
            'Origin': 'https://kulrs.com',
            'User-Agent': 'Mozilla/5.0',
            'Content-Length': Buffer.byteLength(postBody),
        },
    };
    const res = await apiRequest(options, postBody);
    const paletteId = res.data.id;
    await logInfo(
        `[${bot}] CREATE ok: mode="llm" seed="${seed}" topic="${topic}" themes="${calendar.holidayThemes.join(', ') || calendar.season}" palette=${paletteId}`
    );
    return paletteId;
}

async function performCreateAction(bot, token, now) {
    if (KULRS_CREATE_MODE === 'image') {
        return performCreateImageAction(bot, token);
    }
    if (KULRS_CREATE_MODE !== 'llm') {
        throw new Error(`Unsupported KULRS_CREATE_MODE "${KULRS_CREATE_MODE}"`);
    }
    return performCreateLlmAction(bot, token, now);
}

async function performLikeAction(bot, token, activityLog) {
    const likedIds = new Set(
        activityLog.filter(e => e.action === 'LIKE' && e.result === 'ok').map(e => e.target)
    );
    const twentyMinutesAgo = Date.now() - 20 * 60 * 1000;
    const options = {
        hostname: 'api.kulrs.com', path: '/palettes?sort=popular&limit=50', method: 'GET',
        headers: { 'Origin': 'https://kulrs.com', 'User-Agent': 'Mozilla/5.0' },
    };
    const res = await apiRequest(options);
    const palettes = res.data;
    if (!palettes || palettes.length === 0) throw new Error('No palettes returned to like');

    const eligible = palettes.filter(
        p => !likedIds.has(p.id) && new Date(p.createdAt).getTime() < twentyMinutesAgo
    );
    if (eligible.length === 0) throw new Error('No eligible palettes to like');

    const target = eligible[Math.floor(Math.random() * eligible.length)];
    const likeBody = JSON.stringify({});
    const postOptions = {
        hostname: 'api.kulrs.com', path: `/palettes/${target.id}/like`, method: 'POST',
        headers: {
            'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json',
            'Origin': 'https://kulrs.com', 'User-Agent': 'Mozilla/5.0',
            'Content-Length': Buffer.byteLength(likeBody),
        },
    };
    await apiRequest(postOptions, likeBody);
    return target.id;
}

// --- Main ---

async function main() {
    await rotateCronLog();
    const now = new Date(new Date().toLocaleString('en-US', { timeZone: TIMEZONE }));
    const hour = now.getHours();
    if (hour < 5 || hour > 23) {
        await logInfo(`Skipping run outside active window in ${TIMEZONE} (hour=${hour})`);
        return;
    }

    const slotIndex = Math.floor((hour * 60 + now.getMinutes()) / 5);
    let activityLog = await readJson(ACTIVITY_LOG_PATH, []);
    if (!Array.isArray(activityLog)) activityLog = [];

    const fifteenMinutesAgo = Date.now() - 15 * 60 * 1000;
    if (activityLog.some(e => e.slotIndex === slotIndex && new Date(e.ts).getTime() > fifteenMinutesAgo)) {
        await logInfo(`Skipping duplicate slot ${slotIndex}`);
        return;
    }

    const action = (slotIndex % 2 === 0) ? 'CREATE' : 'LIKE';
    let bot = 'unconfigured';
    let result = 'fail', target = null, reason = '';

    try {
        const creds = await readJson(CREDS_PATH, {});
        if (!creds.firebaseApiKey) throw new Error('Missing firebaseApiKey in KULRS credentials');
        const configuredBots = resolveConfiguredBots(creds);
        if (configuredBots.length === 0) throw new Error('No configured KULRS bots found in credentials');
        bot = configuredBots[slotIndex % configuredBots.length];
        const token = await signInBot(creds[bot].email, creds[bot].password, creds.firebaseApiKey);

        target = action === 'LIKE'
            ? await performLikeAction(bot, token, activityLog)
            : await performCreateAction(bot, token, now);
        result = 'ok';
        await logInfo(`[${bot}] ${action} ok target=${String(target)}`);
    } catch (error) {
        reason = error.message;
        await logError(`[${bot}] ${action} failed: ${reason}`);
    }

    const timestamp = new Date().toISOString();
    const updatedActivityLog = [{ ts: timestamp, bot, action, result, target, slotIndex }, ...activityLog].slice(0, 60);
    await writeJson(ACTIVITY_LOG_PATH, updatedActivityLog);

    let authHealthLog = await readJson(AUTH_HEALTH_LOG_PATH, { entries: [] });
    if (typeof authHealthLog !== 'object' || !authHealthLog.entries) authHealthLog = { entries: [] };

    const newHealthEntry = { ts: timestamp, slotIndex, bot, action, result, reason };
    const updatedHealthEntries = [newHealthEntry, ...(Array.isArray(authHealthLog.entries) ? authHealthLog.entries : [])].slice(0, 720);

    const oneHourAgo = Date.now() - 60 * 60 * 1000;
    const thirtyMinutesAgo = Date.now() - 30 * 60 * 1000;
    const lastHourEntries = updatedHealthEntries.filter(e => new Date(e.ts).getTime() >= oneHourAgo);

    const total = lastHourEntries.length;
    const ok = lastHourEntries.filter(e => e.result === 'ok').length;
    const authFailuresLast30m = updatedHealthEntries
        .filter(e => new Date(e.ts).getTime() >= thirtyMinutesAgo && (e.reason.includes('401') || e.reason.includes('403'))).length;

    const successRate = total > 0 ? parseFloat((ok / total).toFixed(2)) : 1.0;
    let healthState = 'ok';
    if (successRate < 0.60) healthState = 'alert';
    else if (successRate < 0.80 || authFailuresLast30m > 0) healthState = 'warn';

    await writeJson(AUTH_HEALTH_LOG_PATH, {
        updatedAt: timestamp,
        entries: updatedHealthEntries,
        rollups: {
            last1h: { total, ok, fail: total - ok, successRate, authFailures: authFailuresLast30m, healthState },
        },
    });
}

main().catch(async (err) => {
    const message = `Cron fatal: ${err.message}`;
    console.error(message);
    try {
        await appendCronLog('ERROR', message);
    } catch (logError) {
        console.error('Cron fatal logging failed:', logError.message);
    }
});
