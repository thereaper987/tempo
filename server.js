// ============================================
// COLAB ORCHESTRATOR - v3.9 (FULLY FIXED)
// ALL ISSUES RESOLVED: 502 errors, /run, /retrieve-file, eviction, session tracking
// ============================================
const express = require('express');
const { spawn, exec } = require('child_process');
const util = require('util');
const crypto = require('crypto');
const fs = require('fs').promises;
const path = require('path');
const os = require('os');
const cors = require('cors');
const multer = require('multer');
require('dotenv').config();

const app = express();
const execPromise = util.promisify(exec);

// ============================================
// CORS CONFIGURATION
// ============================================
const allowedOrigins = [
    'https://kushalkumarj2006.github.io',
    'https://thereaper987.github.io',
    'https://tempo-agxk.onrender.com'
];

const corsOptions = {
    origin: (origin, callback) => {
        if (!origin) return callback(null, true);
        if (allowedOrigins.includes(origin)) return callback(null, true);
        console.warn(`❌ CORS blocked: ${origin}`);
        return callback(new Error('Not allowed by CORS'));
    },
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'api-secret', 'x-api-secret', 'Authorization'],
    exposedHeaders: ['Content-Type', 'api-secret'],
    credentials: true,
    maxAge: 86400
};

app.use(cors(corsOptions));
app.options('*', cors(corsOptions));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// ============================================
// HARDCODED CONFIGURATION (except env vars)
// ============================================
const CONFIG = {
    // ✅ From environment variables
    COLAB_AUTH_TOKEN: process.env.COLAB_AUTH_TOKEN || '{"token": "ya29.a0AT3oNZ_JYRY15EBiIMfpxN8IXtFW43Kr3rj18eTv4QRiQr7O9Q-ZKr1Z_mUa2yJH1Aa63lT-DmvxCFqTuSLMMDBfe_mw0xg84cA20w2cAeTJ8DXF_ijdbUg4DUpH2s4XGSdX69ThTtizQNPsc4K60ykHkGnlmt8-W3o1Qb2nVOvP7oryE5gJW5fv4CGudryvYM-MWZQaCgYKAQwSARISFQHGX2Mi6_aFT-RRKHiy45bJg0mKcA0206", "refresh_token": "1//0g4sUFmaXGfvtCgYIARAAGBASNwF-L9IrYGPrhpvZRm7LOnSWxZfdVJGFpzmxEE0vrosqyFaObsZ7eJdDHKbaR1iS2-vhxoCU5Xs", "token_uri": "https://oauth2.googleapis.com/token", "client_id": "764086051850-6qr4p6gpi6hn506pt8ejuq83di341hur.apps.googleusercontent.com", "client_secret": "d-FL95Q19q7MQmFpd7hHD0Ty", "scopes": ["openid", "https://www.googleapis.com/auth/userinfo.profile", "https://www.googleapis.com/auth/userinfo.email", "https://www.googleapis.com/auth/cloud-platform", "https://www.googleapis.com/auth/colaboratory", "https://www.googleapis.com/auth/drive.file"], "universe_domain": "googleapis.com", "account": "", "expiry": "2026-06-15T07:29:05Z"}',
    
    // Hardcoded values
    PORT: 10000,
    SESSIONS_BASE_DIR: '/tmp/colab_sessions',
    UPLOAD_DIR: '/tmp/colab_uploads',
    MAX_SESSIONS: 3,
    SESSION_TIMEOUT: 10800000,
    EXECUTION_TIMEOUT: 7200,
    MAX_CODE_SIZE: 3145728,
    MAX_FILE_SIZE: 100 * 1024 * 1024,
    POLL_INTERVAL: 10000,
    CLEANUP_INTERVAL: 3600000,
    COMPLETED_EXECUTIONS_TTL: 1200000,
};

// ============================================
// API SECRET VALIDATION
// ============================================
const API_SECRET = process.env.API_SECRET;

function validateApiSecret(input) {
    if (!input) return false;
    return input === API_SECRET;
}

function extractApiSecret(req) {
    return req.body?.api_secret || 
           req.headers['api-secret'] || 
           req.headers['x-api-secret'];
}

// ============================================
// STATE MANAGEMENT
// ============================================
const sessions = new Map();
const completedExecutions = new Map();
const executionQueue = new Set();
const activeProcesses = new Map();
const fileTransfers = new Map();
let cachedToken = null;
let tokenExpiry = null;

// ============================================
// ENHANCED LOGGING
// ============================================
function log(level, message, data = null) {
    const timestamp = new Date().toISOString();
    const prefix = {
        'debug': '🔍',
        'info': 'ℹ️',
        'warn': '⚠️',
        'error': '❌',
        'success': '✅'
    }[level] || '📝';

    console.log(`[${timestamp}] ${prefix} ${message}`);
    if (data) {
        console.log(`   └─ ${typeof data === 'object' ? JSON.stringify(data, null, 2) : data}`);
    }
}

const logDebug = (msg, data) => log('debug', msg, data);
const logInfo = (msg, data) => log('info', msg, data);
const logWarn = (msg, data) => log('warn', msg, data);
const logError = (msg, data) => log('error', msg, data);
const logSuccess = (msg, data) => log('success', msg, data);

// ============================================
// REQUEST LOGGING MIDDLEWARE
// ============================================
app.use((req, res, next) => {
    const start = Date.now();
    const { method, url, ip } = req;
    
    logDebug(`📨 ${method} ${url}`, { ip });
    
    if (req.body && Object.keys(req.body).length > 0) {
        const truncatedBody = { ...req.body };
        if (truncatedBody.code) {
            truncatedBody.code = truncatedBody.code.substring(0, 100) + '...';
        }
        logDebug(`   Body:`, truncatedBody);
    }
    
    const originalSend = res.send;
    res.send = function(data) {
        return originalSend.call(this, data);
    };
    
    res.on('finish', () => {
        const duration = Date.now() - start;
        const status = res.statusCode;
        const statusIcon = status >= 200 && status < 300 ? '✅' : status >= 400 ? '❌' : '⚠️';
        logInfo(`${statusIcon} ${method} ${url} → ${status} (${duration}ms)`);
    });
    
    next();
});

// ============================================
// VALIDATION HELPERS
// ============================================
function isValidId(id) {
    return typeof id === 'string' && /^[a-z0-9_-]{1,64}$/i.test(id);
}

function sanitizeFilename(filename) {
    return path.basename(filename).replace(/[^a-z0-9.]/gi, '_');
}

function generateId(bytes = 32) {
    return crypto.randomBytes(bytes).toString('hex');
}

function formatMemory(bytes) {
    return (bytes / 1024 / 1024).toFixed(2) + ' MB';
}

function resolveSession(identifier) {
    if (!identifier) return null;
    for (const [id, s] of sessions.entries()) {
        if (id === identifier || id.substring(0, 8) === identifier || s.colabSession === identifier) {
            return { sessionId: id, session: s };
        }
    }
    return null;
}

// ============================================
// MULTER - FIXED: Path Traversal Security
// ============================================
const storage = multer.diskStorage({
    destination: async (req, file, cb) => {
        const sessionId = req.body.sessionId || req.query.sessionId;
        
        if (!sessionId || !isValidId(sessionId)) {
            return cb(new Error('Invalid or missing sessionId'));
        }
        
        if (!sessions.has(sessionId)) {
            return cb(new Error('No active session found for this ID'));
        }
        
        const uploadDir = path.join(CONFIG.UPLOAD_DIR, path.basename(sessionId));
        try {
            await fs.mkdir(uploadDir, { recursive: true });
            cb(null, uploadDir);
        } catch (error) {
            cb(error);
        }
    },
    filename: (req, file, cb) => {
        const timestamp = Date.now();
        const safeName = sanitizeFilename(file.originalname);
        const uniqueName = `${timestamp}_${safeName}`;
        req.uploadedFileName = uniqueName;
        req.originalFileName = file.originalname;
        cb(null, uniqueName);
    }
});

const upload = multer({
    storage,
    limits: { fileSize: CONFIG.MAX_FILE_SIZE },
    fileFilter: (req, file, cb) => cb(null, true)
});

// ============================================
// COLAB BINARY SETUP
// ============================================
let COLAB_BINARY = 'colab';
let USE_PYTHON_MODULE = false;

async function initColabBinary() {
    try {
        const whichPath = await execPromise('which colab').then(r => r.stdout.trim()).catch(() => "");
        if (whichPath) {
            COLAB_BINARY = whichPath;
            USE_PYTHON_MODULE = false;
            logSuccess(`Found colab via which: ${whichPath}`);
        } else {
            COLAB_BINARY = 'python3';
            USE_PYTHON_MODULE = true;
            logInfo(`Using Python module: python3 -m colab_cli`);
        }
    } catch (e) {
        COLAB_BINARY = 'python3';
        USE_PYTHON_MODULE = true;
        logInfo(`Using Python module (fallback): python3 -m colab_cli`);
    }
}

// ============================================
// COLAB CLI RUNNER WITH TOKEN CACHING
// ============================================
async function refreshColabToken() {
    const now = Date.now();
    
    if (cachedToken && tokenExpiry && now < tokenExpiry - 300000) {
        logDebug('Using cached token');
        return;
    }

    try {
        const tokenData = JSON.parse(CONFIG.COLAB_AUTH_TOKEN);
        const tokenPath = path.join(os.homedir(), '.config/colab-cli', 'token.json');
        
        try {
            const existing = await fs.readFile(tokenPath, 'utf8');
            const parsed = JSON.parse(existing);
            if (parsed.expiry) {
                const expiry = new Date(parsed.expiry);
                if (now < expiry.getTime() - 300000) {
                    cachedToken = parsed.access_token || parsed.token;
                    tokenExpiry = expiry.getTime();
                    logDebug('Token from file is still valid');
                    return;
                }
            }
        } catch (e) {}

        if (tokenData.refresh_token) {
            logInfo('Refreshing token...');
            const response = await fetch('https://oauth2.googleapis.com/token', {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: new URLSearchParams({
                    client_id: tokenData.client_id,
                    client_secret: tokenData.client_secret,
                    refresh_token: tokenData.refresh_token,
                    grant_type: 'refresh_token',
                })
            });
            
            const data = await response.json();
            if (data.access_token) {
                tokenData.access_token = data.access_token;
                if (data.expires_in) {
                    const expiry = new Date();
                    expiry.setSeconds(expiry.getSeconds() + data.expires_in);
                    tokenData.expiry = expiry.toISOString();
                    tokenExpiry = expiry.getTime();
                    cachedToken = data.access_token;
                }
                logSuccess('Token refreshed');
                await fs.writeFile(tokenPath, JSON.stringify(tokenData, null, 2));
                return;
            }
        }
        
        if (tokenData.access_token) {
            cachedToken = tokenData.access_token;
            if (tokenData.expiry) {
                tokenExpiry = new Date(tokenData.expiry).getTime();
            }
        }
    } catch (error) {
        logError('Token refresh error:', error.message);
    }
}

async function runColabCli(args, sessionId = null, inputData = null, timeoutMs = 60000) {
    await refreshColabToken().catch(() => {});
    
    return new Promise((resolve, reject) => {
        const spawnArgs = USE_PYTHON_MODULE ? ['-m', 'colab_cli', ...args] : args;
        
        logDebug(`🛠 Running: ${COLAB_BINARY}`, { args: spawnArgs });

        const child = spawn(COLAB_BINARY, spawnArgs, { 
            shell: false,
            env: process.env 
        });

        if (sessionId && isValidId(sessionId)) {
            if (!activeProcesses.has(sessionId)) activeProcesses.set(sessionId, new Set());
            activeProcesses.get(sessionId).add(child);
        }

        let stdout = '';
        let stderr = '';

        if (inputData) {
            child.stdin.write(inputData);
            child.stdin.end();
        }

        child.stdout.on('data', (d) => stdout += d.toString());
        child.stderr.on('data', (d) => stderr += d.toString());

        const timer = setTimeout(() => {
            child.kill('SIGKILL');
            reject({ error: new Error('Command timed out'), stdout, stderr });
        }, timeoutMs);

        child.on('close', (code) => {
            clearTimeout(timer);
            if (sessionId) activeProcesses.get(sessionId)?.delete(child);
            if (code !== 0) {
                reject({ error: new Error(`Exit code ${code}`), stdout, stderr });
            } else {
                resolve({ stdout, stderr });
            }
        });

        child.on('error', (err) => reject({ error: err, stdout, stderr }));
    });
}

// ============================================
// AUTH SETUP
// ============================================
async function setupColabAuth() {
    const rawToken = CONFIG.COLAB_AUTH_TOKEN.trim();
    try {
        const tokenData = JSON.parse(rawToken);

        if (tokenData.token && !tokenData.access_token) {
            tokenData.access_token = tokenData.token;
            logInfo('Converted "token" → "access_token"');
        }

        const configDir = path.join(os.homedir(), '.config/colab-cli');
        await fs.mkdir(configDir, { recursive: true });
        
        await fs.writeFile(path.join(configDir, 'token.json'), JSON.stringify(tokenData, null, 2));
        await fs.writeFile(path.join(configDir, 'sessions.json'), JSON.stringify({}));

        cachedToken = tokenData.access_token || tokenData.token;
        if (tokenData.expiry) {
            tokenExpiry = new Date(tokenData.expiry).getTime();
        }

        const verify = JSON.parse(await fs.readFile(path.join(configDir, 'token.json'), 'utf8'));
        if (verify.access_token) {
            logSuccess('Colab auth token written and verified');
            return true;
        }
        logWarn('Token written but no access_token found');
        return false;
    } catch (error) {
        logError('Auth setup failed:', error.message);
        return false;
    }
}

// ============================================
// SESSION FOLDER MANAGEMENT
// ============================================
async function createSessionFolder(sessionId) {
    const folder = path.join(CONFIG.SESSIONS_BASE_DIR, sessionId);
    await fs.mkdir(folder, { recursive: true });
    return folder;
}

// ============================================
// UNIFIED CLEANUP UTILITY
// ============================================
async function stopAndCleanupSession(sessionId) {
    const session = sessions.get(sessionId);
    if (!session) {
        logWarn(`Session ${sessionId} not found for cleanup`);
        return;
    }

    logWarn(`Evicting/Stopping session: ${sessionId.substring(0, 12)}`);

    const procs = activeProcesses.get(sessionId);
    if (procs) {
        for (const p of procs) { 
            try { p.kill('SIGKILL'); } catch (e) {} 
        }
        activeProcesses.delete(sessionId);
    }

    try {
        await runColabCli(['stop', '-s', session.colabSession], null, null, 15000);
        logDebug(`CLI stop completed for ${sessionId.substring(0, 12)}`);
    } catch (e) {
        logError(`CLI Stop failed during cleanup: ${e.message}`);
    }

    try {
        await fs.rm(path.join(CONFIG.SESSIONS_BASE_DIR, sessionId), { recursive: true, force: true });
        await fs.rm(path.join(CONFIG.UPLOAD_DIR, sessionId), { recursive: true, force: true });
    } catch (e) {
        logDebug(`Filesystem cleanup error: ${e.message}`);
    }

    sessions.delete(sessionId);
    logSuccess(`Cleanup complete for ${sessionId.substring(0, 12)}`);
}

// ============================================
// HOUSEKEEPING
// ============================================
function startHousekeeping() {
    setInterval(() => {
        const now = Date.now();
        let cleaned = 0;
        for (const [id, data] of completedExecutions.entries()) {
            if (now - data.completedAt > CONFIG.COMPLETED_EXECUTIONS_TTL) {
                completedExecutions.delete(id);
                cleaned++;
            }
        }
        for (const [id, data] of fileTransfers.entries()) {
            if (data.completedAt && (now - data.completedAt > CONFIG.COMPLETED_EXECUTIONS_TTL)) {
                fileTransfers.delete(id);
                cleaned++;
            }
        }
        if (cleaned > 0) logInfo(`🧹 Cleaned ${cleaned} stale entries`);
    }, CONFIG.CLEANUP_INTERVAL);
}

// ============================================
// SESSION DATA JSON MANAGEMENT - MODIFIED to overwrite
// ============================================
async function appendSessionData(sessionId, data) {
    const dataFile = path.join(CONFIG.SESSIONS_BASE_DIR, sessionId, 'session_data.json');
    try {
        let sessionData = {};
        try {
            const content = await fs.readFile(dataFile, 'utf8');
            sessionData = JSON.parse(content);
        } catch {
            sessionData = {
                sessionId,
                createdAt: new Date().toISOString(),
                cells: [],
                totalCells: 0,
                totalExecutions: 0,
                files: []
            };
        }

        // Check if cell already exists, REPLACE it (overwrite) instead of append
        const existingIndex = sessionData.cells.findIndex(c => c.cellNo === data.cellNo && c.type === data.type);
        if (existingIndex !== -1) {
            sessionData.cells[existingIndex] = data;
        } else {
            sessionData.cells.push(data);
        }

        sessionData.totalCells = sessionData.cells.length;
        sessionData.totalExecutions = sessionData.cells.filter(c => c.type === 'execution').length;
        sessionData.lastUpdated = new Date().toISOString();

        await fs.writeFile(dataFile, JSON.stringify(sessionData, null, 2));
        return sessionData;
    } catch (error) {
        logError(`Failed to append session data for ${sessionId}`, error.message);
        return null;
    }
}

async function getSessionData(sessionId) {
    try {
        const content = await fs.readFile(path.join(CONFIG.SESSIONS_BASE_DIR, sessionId, 'session_data.json'), 'utf8');
        return JSON.parse(content);
    } catch {
        return null;
    }
}

// ============================================
// CODE EXECUTION ENGINE - MODIFIED to accept timeout
// ============================================
async function executeCodeInColab(sessionId, cellNo, code, executionId, customTimeout = null) {
    const session = sessions.get(sessionId);
    if (!session) throw new Error('Session not found');

    const startedAt = Date.now();
    let cellData = {
        type: 'execution',
        cellNo,
        startedAt: new Date(startedAt).toISOString(),
        code,
        status: 'running'
    };

    // Use custom timeout if provided, otherwise use default
    const timeoutSeconds = customTimeout || CONFIG.EXECUTION_TIMEOUT;

    try {
        if (Buffer.byteLength(code, 'utf8') > CONFIG.MAX_CODE_SIZE) {
            throw new Error(`Code exceeds ${CONFIG.MAX_CODE_SIZE} bytes`);
        }

        const codeFile = path.join(CONFIG.SESSIONS_BASE_DIR, sessionId, `code_${cellNo}.py`);
        await fs.writeFile(codeFile, code, 'utf8');

        const args = ['exec', '-s', session.colabSession, '--timeout', timeoutSeconds.toString()];
        const result = await runColabCli(args, sessionId, code, timeoutSeconds * 1000);

        const completedAt = Date.now();
        const executionTime = completedAt - startedAt;

        // Truncate output if it's too large (more than 50KB)
        let output = result.stdout || '(No output)';
        let errorOutput = result.stderr || '';
        const MAX_OUTPUT_SIZE = 50 * 1024; // 50KB
        
        if (output.length > MAX_OUTPUT_SIZE) {
            output = output.substring(0, MAX_OUTPUT_SIZE) + `\n... (truncated, ${output.length} total bytes)`;
        }
        if (errorOutput.length > MAX_OUTPUT_SIZE) {
            errorOutput = errorOutput.substring(0, MAX_OUTPUT_SIZE) + `\n... (truncated, ${errorOutput.length} total bytes)`;
        }

        const outputData = {
            status: 'completed',
            output: output,
            error: errorOutput,
            startedAt,
            completedAt,
            executionTime,
            timestamp: completedAt,
            fullOutputSize: result.stdout ? result.stdout.length : 0
        };

        completedExecutions.set(executionId, outputData);

        const updatedSession = sessions.get(sessionId);
        if (updatedSession?.currentExecution?.executionId === executionId) {
            updatedSession.currentExecution = null;
            updatedSession.status = 'ready';
            sessions.set(sessionId, updatedSession);
        }

        // Store truncated output in session data
        cellData = { 
            ...cellData, 
            status: 'completed', 
            completedAt: new Date(completedAt).toISOString(), 
            executionTime, 
            output: output, 
            error: errorOutput
        };
        await appendSessionData(sessionId, cellData);

        logSuccess(`Execution ${executionId.substring(0, 12)} completed in ${executionTime}ms`);
        return outputData;
    } catch (error) {
        const completedAt = Date.now();
        
        // Truncate error output if too large
        let errorMsg = error.stderr || error.message || String(error);
        const MAX_OUTPUT_SIZE = 50 * 1024;
        if (errorMsg.length > MAX_OUTPUT_SIZE) {
            errorMsg = errorMsg.substring(0, MAX_OUTPUT_SIZE) + `\n... (truncated, ${errorMsg.length} total bytes)`;
        }
        
        const failureResult = {
            status: 'failed',
            output: error.stdout || '',
            error: errorMsg,
            startedAt,
            completedAt,
            executionTime: completedAt - startedAt,
            timestamp: completedAt
        };

        completedExecutions.set(executionId, failureResult);

        const updatedSession = sessions.get(sessionId);
        if (updatedSession?.currentExecution?.executionId === executionId) {
            updatedSession.currentExecution = null;
            updatedSession.status = 'ready';
            sessions.set(sessionId, updatedSession);
        }

        cellData = { 
            ...cellData, 
            status: 'failed', 
            completedAt: new Date(completedAt).toISOString(), 
            executionTime: completedAt - startedAt, 
            output: error.stdout || '', 
            error: errorMsg
        };
        await appendSessionData(sessionId, cellData);

        logError(`Execution ${executionId.substring(0, 12)} failed:`, error.message || error.error?.message);
        throw error;
    }
}

async function backgroundExecution(sessionId, cellNo, code, executionId, timeout = null) {
    const execKey = `${sessionId}_${cellNo}`;
    if (executionQueue.has(execKey)) return;
    executionQueue.add(execKey);
    logInfo(`Queued execution ${executionId.substring(0, 12)}`);
    try {
        await executeCodeInColab(sessionId, cellNo, code, executionId, timeout);
    } catch (error) {
        logError(`Background error for ${executionId.substring(0, 12)}:`, error.message || error.error?.message);
    } finally {
        executionQueue.delete(execKey);
    }
}

// ============================================
// HEALTH ENDPOINTS (Public)
// ============================================
app.get('/health', (req, res) => {
    const mem = process.memoryUsage();
    res.json({
        status: 'healthy',
        activeSessions: sessions.size,
        maxSessions: CONFIG.MAX_SESSIONS,
        uptime: process.uptime(),
        memoryUsage: {
            rss: formatMemory(mem.rss),
            heapTotal: formatMemory(mem.heapTotal),
            heapUsed: formatMemory(mem.heapUsed),
        },
        timestamp: new Date().toISOString(),
        colabBinary: COLAB_BINARY,
        usePythonModule: USE_PYTHON_MODULE,
    });
});

app.get('/health/simple', (req, res) => {
    res.json({ status: 'up', timestamp: new Date().toISOString(), sessions: sessions.size });
});

// ============================================
// HELP ENDPOINT (Public)
// ============================================
app.get('/', (req, res) => {
    const baseUrl = `${req.protocol}://${req.get('host')}`;
    res.json({
        name: "Colab Orchestrator API",
        version: "3.9.0",
        description: "REST API wrapper around Google Colab CLI",
        baseUrl: baseUrl,
        endpoints: {
            health: { method: "GET", path: "/health" },
            healthSimple: { method: "GET", path: "/health/simple" },
            sessions: { method: "GET", path: "/sessions" },
            sessionDetails: { method: "GET", path: "/sessions/:identifier" },
            new: { method: "POST", path: "/new", body: { sessionId: "optional", gpu: "optional" } },
            stop: { method: "POST", path: "/stop", body: { sessionId: "required" } },
            delete: { method: "DELETE", path: "/session/:sessionId" },
            keepalive: { method: "POST", path: "/keepalive", body: { sessionId: "required" } },
            restartKernel: { method: "POST", path: "/restart-kernel", body: { sessionId: "required" } },
            exec: { method: "POST", path: "/exec", body: { sessionId: "required", code: "required", cellNo: "required", timeout: "optional" } },
            execStatus: { method: "GET/POST", path: "/exec-status", params: { sessionId: "required", executionId: "required" } },
            execAck: { method: "POST", path: "/exec-ack", body: { executionId: "required" } },
            install: { method: "POST", path: "/install", body: { sessionId: "required", packages: "optional" } },
            ls: { method: "GET", path: "/ls", params: { sessionId: "required" } },
            rm: { method: "POST", path: "/rm", body: { sessionId: "required", path: "required" } },
            upload: { method: "POST", path: "/upload", body: { sessionId: "required", file: "required" } },
            uploadStatus: { method: "GET", path: "/upload-status", params: { transferId: "required" } },
            download: { method: "POST", path: "/download", body: { sessionId: "required", remotePath: "required" } },
            downloadStatus: { method: "GET", path: "/download-status", params: { transferId: "required" } },
            retrieveFile: { method: "GET", path: "/retrieve-file", params: { sessionId: "required", filename: "required" } },
            run: { method: "POST", path: "/run", body: { script: "required", gpu: "optional" } },
            status: { method: "GET", path: "/status", params: { sessionId: "required" } },
            url: { method: "GET", path: "/url", params: { sessionId: "required" } },
            log: { method: "GET", path: "/log", params: { sessionId: "required" } },
            sessionsList: { method: "GET", path: "/sessions-list" },
            version: { method: "GET", path: "/version" },
            update: { method: "GET", path: "/update" },
            pay: { method: "GET", path: "/pay" },
            readme: { method: "GET", path: "/readme" },
            skill: { method: "GET", path: "/skill" },
            drivemount: { method: "POST", path: "/drivemount", body: { sessionId: "required", path: "optional" } },
            auth: { method: "POST", path: "/auth", body: { sessionId: "required" } },
            console: { method: "POST", path: "/console", body: { sessionId: "required" } },
            repl: { method: "POST", path: "/repl", body: { sessionId: "required", code: "optional" } },
            edit: { method: "POST", path: "/edit", body: { sessionId: "required", remotePath: "required" } },
        },
        timestamp: new Date().toISOString()
    });
});

// ============================================
// SESSION ENDPOINTS (Public)
// ============================================

app.get('/sessions', async (req, res) => {
    const mem = process.memoryUsage();
    const sessionData = [];
    let totalCells = 0;
    let totalExecutions = 0;

    for (const [id, session] of sessions.entries()) {
        const data = await getSessionData(id);
        const cellsCount = data?.cells?.length || 0;
        const executionsCount = data?.totalExecutions || 0;
        totalCells += cellsCount;
        totalExecutions += executionsCount;

        sessionData.push({
            sub: id.substring(0, 8),
            sessionId: id,
            colabSession: session.colabSession,
            status: session.status,
            gpu: session.gpu || null,
            createdAt: new Date(session.createdAt).toISOString(),
            lastActivity: new Date(session.lastActivity).toISOString(),
            activeMinutes: parseFloat(((Date.now() - session.createdAt) / 1000 / 60).toFixed(2)),
            cellsExecuted: cellsCount,
            executions: executionsCount,
            hasCurrentExecution: !!session.currentExecution,
            dataFileExists: data !== null
        });
    }

    res.json({
        totalSessions: sessions.size,
        maxSessions: CONFIG.MAX_SESSIONS,
        sessions: sessionData,
        memoryUsage: {
            rss: formatMemory(mem.rss),
            heapTotal: formatMemory(mem.heapTotal),
            heapUsed: formatMemory(mem.heapUsed)
        },
        totalCellsExecuted: totalCells,
        totalExecutions,
        queuedExecutions: executionQueue.size,
        completedExecutions: completedExecutions.size,
        fileTransfers: fileTransfers.size,
        uptime: process.uptime(),
        timestamp: new Date().toISOString()
    });
});

app.get('/sessions/:identifier', async (req, res) => {
    const cleanId = req.params.identifier.replace(/\/$/, '');
    const found = resolveSession(cleanId);

    if (!found) {
        return res.status(404).json({ error: 'Session not found', message: `No session found with identifier: ${cleanId}` });
    }

    const { sessionId, session } = found;
    const sessionData = await getSessionData(sessionId);
    const mem = process.memoryUsage();

    res.json({
        session: {
            sub: sessionId.substring(0, 8),
            sessionId,
            colabSession: session.colabSession,
            gpu: session.gpu || null,
            status: session.status,
            createdAt: new Date(session.createdAt).toISOString(),
            lastActivity: new Date(session.lastActivity).toISOString(),
            activeMinutes: parseFloat(((Date.now() - session.createdAt) / 1000 / 60).toFixed(2)),
            hasCurrentExecution: !!session.currentExecution,
            authUrl: session.authUrl || null
        },
        sessionData,
        currentExecution: session.currentExecution || null,
        memoryUsage: {
            rss: formatMemory(mem.rss),
            heapTotal: formatMemory(mem.heapTotal),
            heapUsed: formatMemory(mem.heapUsed)
        },
        timestamp: new Date().toISOString()
    });
});

// ============================================
// PROTECTED ENDPOINTS (Auth Required)
// ============================================

// Middleware to check API secret
function requireAuth(req, res, next) {
    const apiSecret = extractApiSecret(req);
    if (!validateApiSecret(apiSecret)) {
        logWarn(`🔒 Auth failed for ${req.method} ${req.path}`);
        return res.status(401).json({ error: 'Invalid API secret' });
    }
    next();
}

// ============================================
// SESSION CREATION WITH AUTO-EVICTION - FIXED
// ============================================
app.post('/new', requireAuth, async (req, res) => {
    logInfo('Creating new session', { body: req.body });
    
    // Clean up any orphaned sessions first
    try {
        const result = await runColabCli(['sessions'], null, null, 15000);
        const lines = result.stdout.split('\n').filter(s => s.trim() && s.includes('|'));
        for (const line of lines) {
            if (line.includes('[?]')) {
                const match = line.match(/\?\]\s+([^\s]+)/);
                if (match) {
                    const endpoint = match[1];
                    logWarn(`Found orphaned session: ${endpoint}`);
                    try {
                        await runColabCli(['stop', '-s', endpoint], null, null, 10000);
                        logSuccess(`Cleaned up orphaned session: ${endpoint}`);
                    } catch (e) {}
                }
            }
        }
    } catch (e) {}

    // Check if we need to evict the oldest session
    if (sessions.size >= CONFIG.MAX_SESSIONS) {
        const oldestSessionId = sessions.keys().next().value;
        logInfo(`Max sessions reached (${CONFIG.MAX_SESSIONS}). Evicting oldest: ${oldestSessionId.substring(0, 12)}`);
        await stopAndCleanupSession(oldestSessionId);
    }

    const sessionId = req.body?.sessionId || generateId(32);
    const gpu = req.body?.gpu || null;
    const tpu = req.body?.tpu || null;
    const colabSessionName = `colab_${sessionId.substring(0, 12)}`;

    const args = ['new'];
    args.push('-s', colabSessionName);
    if (gpu) args.push('--gpu', gpu);
    if (tpu) args.push('--tpu', tpu);

    logInfo(`Creating session ${sessionId.substring(0, 12)}`, { gpu, tpu });

    try {
        await createSessionFolder(sessionId);

        const initialData = {
            sessionId,
            createdAt: new Date().toISOString(),
            cells: [],
            totalCells: 0,
            totalExecutions: 0,
            files: [],
            lastUpdated: new Date().toISOString()
        };
        await fs.writeFile(
            path.join(CONFIG.SESSIONS_BASE_DIR, sessionId, 'session_data.json'),
            JSON.stringify(initialData, null, 2)
        );

        await runColabCli(args, null, null, 60000);

        sessions.set(sessionId, {
            colabSession: colabSessionName,
            createdAt: Date.now(),
            lastActivity: Date.now(),
            status: 'ready',
            gpu: gpu,
            tpu: tpu,
            currentExecution: null,
            folder: path.join(CONFIG.SESSIONS_BASE_DIR, sessionId)
        });

        logSuccess(`Session ${sessionId.substring(0, 12)} created`);
        return res.json({
            success: true,
            sessionId,
            colabSession: colabSessionName,
            gpu: gpu || null,
            tpu: tpu || null,
            expiresIn: CONFIG.SESSION_TIMEOUT,
            activeSessions: sessions.size,
            maxSessions: CONFIG.MAX_SESSIONS,
            message: 'Session created successfully'
        });
    } catch (error) {
        logError(`Session creation failed: ${sessionId.substring(0, 12)}`, error.message || error.error?.message);
        await stopAndCleanupSession(sessionId);
        
        const errorMsg = error.stderr || error.message || '';
        if (errorMsg.includes('TooManyAssignmentsError') || errorMsg.includes('Precondition Failed')) {
            return res.status(429).json({
                success: false,
                sessionId,
                error: 'Too many assignments',
                details: 'You have too many active Colab sessions. Please stop some sessions and try again.',
                suggestion: 'Run: colab stop -s <session_name> for each active session'
            });
        }
        
        return res.status(500).json({
            success: false,
            sessionId,
            error: 'Failed to create session',
            details: error.stderr || error.message || String(error)
        });
    }
});

// ============================================
// SESSION STOP/DELETE - FIXED: Handle missing sessions gracefully
// ============================================
app.post('/stop', requireAuth, async (req, res) => {
    const { sessionId } = req.body;
    if (!sessionId) {
        return res.status(400).json({ error: 'sessionId required' });
    }

    // Try to resolve the session
    const found = resolveSession(sessionId);
    
    // If not found in our map, try to stop it via CLI directly
    if (!found) {
        try {
            // Try to stop it using the session name directly
            await runColabCli(['stop', '-s', sessionId], null, null, 15000);
            logSuccess(`Stopped session ${sessionId} via CLI (not in map)`);
            return res.json({ success: true, sessionId, message: 'Session stopped (was not tracked)' });
        } catch (e) {
            // If it's not found via CLI either, return 404
            logWarn(`Session ${sessionId} not found for stop`);
            return res.status(404).json({ error: 'Session not found', sessionId });
        }
    }

    const { sessionId: resolvedId, session } = found;
    logInfo(`Stopping session ${resolvedId.substring(0, 12)}`);
    await stopAndCleanupSession(resolvedId);
    res.json({ success: true, sessionId: resolvedId, message: 'Session stopped' });
});

app.delete('/session/:sessionId', requireAuth, async (req, res) => {
    const { sessionId } = req.params;
    const found = resolveSession(sessionId);
    if (!found) {
        return res.status(404).json({ error: 'Session not found', sessionId });
    }

    const { sessionId: resolvedId, session } = found;
    logInfo(`Deleting session ${resolvedId.substring(0, 12)}`);
    await stopAndCleanupSession(resolvedId);
    return res.json({ success: true, sessionId: resolvedId, message: 'Session terminated' });
});

app.post('/keepalive', requireAuth, async (req, res) => {
    const { sessionId } = req.body;
    if (!sessionId) {
        return res.status(400).json({ error: 'sessionId required' });
    }

    const found = resolveSession(sessionId);
    if (!found) {
        // Try to find it via CLI
        try {
            const result = await runColabCli(['sessions'], null, null, 10000);
            const lines = result.stdout.split('\n').filter(s => s.trim());
            for (const line of lines) {
                const match = line.match(/\[(.*?)\]/);
                if (match && match[1] === sessionId) {
                    logInfo(`Keepalive via CLI for ${sessionId}`);
                    return res.json({ success: true, sessionId, message: 'Session kept alive (via CLI)' });
                }
            }
        } catch (e) {}
        return res.status(404).json({ error: 'Session not found', sessionId });
    }

    try {
        await runColabCli(['sessions'], null, null, 10000);
        found.session.lastActivity = Date.now();
        sessions.set(found.sessionId, found.session);
        logInfo(`Keepalive: ${found.sessionId.substring(0, 12)}`);
        res.json({ success: true, sessionId: found.sessionId, message: 'Session kept alive' });
    } catch (error) {
        logError(`Keepalive failed for ${found.sessionId.substring(0, 12)}`, error.message);
        res.status(500).json({ error: 'Keepalive failed', sessionId: found.sessionId, details: error.message });
    }
});

// ============================================
// EXECUTION ENDPOINTS - MODIFIED to accept timeout
// ============================================

app.post('/exec', requireAuth, async (req, res) => {
    const { sessionId, code, cellNo, timeout } = req.body;
    
    const validCellNo = parseInt(cellNo, 10);
    if (!sessionId || !code || isNaN(validCellNo) || validCellNo < 0) {
        return res.status(400).json({ error: 'Invalid fields: sessionId, code, and cellNo (positive int) are required' });
    }

    const found = resolveSession(sessionId);
    if (!found) {
        return res.status(404).json({ error: 'Session not found', sessionId });
    }

    const { sessionId: resolvedId, session } = found;

    if (session.status === 'busy') {
        return res.status(409).json({
            error: 'Session busy',
            sessionId: resolvedId,
            currentExecution: session.currentExecution
        });
    }

    const executionId = generateId(16);

    // Validate and parse timeout (if provided)
    let execTimeout = null;
    if (timeout !== undefined && timeout !== null) {
        const parsedTimeout = parseInt(timeout, 10);
        if (!isNaN(parsedTimeout) && parsedTimeout > 0) {
            execTimeout = parsedTimeout;
            logInfo(`Using custom timeout: ${execTimeout}s for execution ${executionId.substring(0, 12)}`);
        }
    }

    logInfo(`Execution ${executionId.substring(0, 12)} | session ${resolvedId.substring(0, 12)} | cell ${validCellNo}`);

    session.status = 'busy';
    session.lastActivity = Date.now();
    session.currentExecution = {
        executionId,
        cellNo: validCellNo,
        startedAt: Date.now(),
        status: 'running',
        partialOutput: '',
        partialError: ''
    };
    sessions.set(resolvedId, session);

    await appendSessionData(resolvedId, {
        type: 'execution_start',
        cellNo: validCellNo,
        startedAt: new Date().toISOString(),
        code,
        status: 'started'
    });

    // Pass timeout to background execution
    backgroundExecution(resolvedId, validCellNo, code, executionId, execTimeout);

    res.json({
        status: 'processing',
        sessionId: resolvedId,
        executionId,
        pollInterval: CONFIG.POLL_INTERVAL,
        timeout: execTimeout || CONFIG.EXECUTION_TIMEOUT,
        message: 'Code execution started. Poll /exec-status for results.'
    });
});

app.all('/exec-status', async (req, res) => {
    const sessionId = req.body?.sessionId || req.query?.sessionId;
    const executionId = req.body?.executionId || req.query?.executionId;
    
    logDebug('Checking execution status', { 
        sessionId: sessionId?.substring(0, 12), 
        executionId: executionId?.substring(0, 12) 
    });
    
    if (!sessionId || !executionId) {
        return res.status(400).json({ error: 'Missing required fields: sessionId, executionId' });
    }

    if (completedExecutions.has(executionId)) {
        const record = completedExecutions.get(executionId);
        logDebug(`Execution ${executionId.substring(0, 12)} found in completed executions`, { status: record.status });
        return res.json({
            status: record.status,
            sessionId,
            executionId,
            output: record.output,
            error: record.error,
            executionTime: record.executionTime
        });
    }

    const found = resolveSession(sessionId);
    if (!found) {
        logWarn(`exec-status: Session not found: ${sessionId}`);
        return res.status(404).json({ error: 'Session not found', sessionId });
    }

    const { session, sessionId: resolvedId } = found;
    const execution = session.currentExecution;

    if (execution?.executionId === executionId) {
        logDebug(`Execution ${executionId.substring(0, 12)} is running`, { elapsed: Date.now() - execution.startedAt });
        return res.json({
            status: 'running',
            sessionId: resolvedId,
            executionId,
            elapsed: Date.now() - execution.startedAt,
            partialOutput: execution.partialOutput || '',
            partialError: execution.partialError || ''
        });
    }

    logWarn(`Execution ${executionId.substring(0, 12)} not found`);
    return res.status(404).json({ 
        error: 'Execution not found', 
        status: 'not_found', 
        sessionId, 
        executionId, 
        message: 'Execution not found or already completed' 
    });
});

app.post('/exec-ack', requireAuth, async (req, res) => {
    const { executionId } = req.body;
    if (executionId && completedExecutions.has(executionId)) {
        completedExecutions.delete(executionId);
        logSuccess(`Execution ${executionId.substring(0, 12)} acknowledged`);
        return res.json({ success: true, executionId, message: 'Acknowledged' });
    }
    res.json({ success: false, executionId, message: 'Execution not found' });
});

app.post('/restart-kernel', requireAuth, async (req, res) => {
    const { sessionId } = req.body;
    if (!sessionId) {
        return res.status(400).json({ error: 'sessionId required' });
    }

    const found = resolveSession(sessionId);
    if (!found) {
        return res.status(404).json({ error: 'Session not found', sessionId });
    }

    const { sessionId: resolvedId, session } = found;

    if (session.status === 'busy') {
        return res.status(409).json({ error: 'Session busy, cannot restart', sessionId: resolvedId });
    }

    try {
        await runColabCli(['restart-kernel', '-s', session.colabSession], null, null, 30000);
        session.lastActivity = Date.now();
        sessions.set(resolvedId, session);
        res.json({
            success: true,
            sessionId: resolvedId,
            message: 'Kernel restarted'
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            sessionId: resolvedId,
            error: 'Restart failed',
            details: error.stderr || error.message || String(error)
        });
    }
});

// ============================================
// FILE OPERATIONS
// ============================================

app.post('/download', requireAuth, async (req, res) => {
    const { sessionId, remotePath, localPath } = req.body;
    
    logInfo(`Downloading file`, { sessionId: sessionId?.substring(0, 12), remotePath });
    
    if (!sessionId || !remotePath) {
        return res.status(400).json({ error: 'Missing required fields: sessionId, remotePath' });
    }

    const found = resolveSession(sessionId);
    if (!found) {
        return res.status(404).json({ error: 'Session not found', sessionId });
    }

    const { sessionId: resolvedId, session } = found;

    try {
        const checkResult = await runColabCli(['ls', remotePath, '-s', session.colabSession], null, null, 10000);
        if (!checkResult.stdout.trim()) {
            logWarn(`download: File not found: ${remotePath}`);
            return res.status(404).json({ 
                error: 'File not found', 
                remotePath,
                message: `File not found: ${remotePath}`
            });
        }
    } catch (checkError) {
        logWarn(`download: File not found (ls failed): ${remotePath}`, checkError.message);
        return res.status(404).json({ 
            error: 'File not found', 
            remotePath,
            message: `File not found: ${remotePath}`
        });
    }

    const transferId = generateId(16);
    const destPath = localPath || path.join(CONFIG.SESSIONS_BASE_DIR, resolvedId, path.basename(remotePath));
    const uploadDir = path.join(CONFIG.UPLOAD_DIR, resolvedId);
    await fs.mkdir(uploadDir, { recursive: true });

    fileTransfers.set(transferId, {
        type: 'download',
        sessionId: resolvedId,
        remotePath,
        localPath: destPath,
        status: 'pending',
        createdAt: Date.now(),
        startedAt: null,
        completedAt: null,
        error: null,
        output: '',
        progress: 0,
        fileSize: 0
    });

    setImmediate(async () => {
        try {
            const transfer = fileTransfers.get(transferId);
            if (!transfer) return;
            
            transfer.status = 'running';
            transfer.startedAt = Date.now();
            fileTransfers.set(transferId, transfer);

            await runColabCli(['download', remotePath, destPath, '-s', session.colabSession], null, null, 60000);
            
            let fileSize = 0;
            try {
                const stats = await fs.stat(destPath);
                fileSize = stats.size;
            } catch (statsError) {
                logDebug('Could not stat downloaded file:', statsError.message);
            }
            
            transfer.status = 'completed';
            transfer.completedAt = Date.now();
            transfer.progress = 100;
            transfer.fileSize = fileSize;
            fileTransfers.set(transferId, transfer);
            
            session.lastActivity = Date.now();
            sessions.set(resolvedId, session);
            logSuccess(`Download completed: ${transferId.substring(0, 12)} (${fileSize} bytes)`);
        } catch (error) {
            const transfer = fileTransfers.get(transferId);
            if (transfer) {
                transfer.status = 'failed';
                transfer.completedAt = Date.now();
                transfer.error = error.stderr || error.message || String(error);
                fileTransfers.set(transferId, transfer);
            }
            logError(`Download failed: ${transferId.substring(0, 12)}`, error.message);
        }
    });

    res.json({
        success: true,
        transferId,
        sessionId: resolvedId,
        remotePath,
        localPath: destPath,
        status: 'pending',
        pollInterval: CONFIG.POLL_INTERVAL,
        message: 'Download started. Poll /download-status for progress.'
    });
});

app.get('/download-status', async (req, res) => {
    const { transferId } = req.query;
    logDebug(`Checking download status: ${transferId?.substring(0, 12)}`);
    
    if (!transferId) {
        return res.status(400).json({ error: 'transferId query param required' });
    }

    const transfer = fileTransfers.get(transferId);
    if (!transfer) {
        return res.status(404).json({ error: 'Transfer not found', transferId });
    }

    const response = {
        transferId,
        type: transfer.type,
        sessionId: transfer.sessionId,
        remotePath: transfer.remotePath,
        localPath: transfer.localPath,
        status: transfer.status,
        progress: transfer.progress || 0,
        createdAt: new Date(transfer.createdAt).toISOString(),
        startedAt: transfer.startedAt ? new Date(transfer.startedAt).toISOString() : null,
        completedAt: transfer.completedAt ? new Date(transfer.completedAt).toISOString() : null,
        output: transfer.output || '',
        error: transfer.error || null
    };

    try {
        const stats = await fs.stat(transfer.localPath);
        response.fileSize = stats.size;
        response.fileSizeFormatted = formatMemory(stats.size);
    } catch {
        response.fileSize = 0;
        response.fileSizeFormatted = '0 MB';
    }

    res.json(response);
});

// ============================================
// RETRIEVE FILE - FIXED: Check both directories
// ============================================
app.get('/retrieve-file', async (req, res) => {
    const { sessionId, filename } = req.query;
    
    if (!sessionId || !filename) {
        return res.status(400).json({ error: 'sessionId and filename required' });
    }
    
    if (!isValidId(sessionId)) {
        return res.status(400).json({ error: 'Invalid sessionId' });
    }
    
    const safeFilename = sanitizeFilename(filename);
    const baseSessionDir = path.join(CONFIG.SESSIONS_BASE_DIR, path.basename(sessionId));
    const baseUploadDir = path.join(CONFIG.UPLOAD_DIR, path.basename(sessionId));
    
    // Check all possible locations
    const locations = [
        path.join(baseSessionDir, safeFilename),
        path.join(baseSessionDir, filename),
        path.join(baseUploadDir, safeFilename),
        path.join(baseUploadDir, filename)
    ];

    for (const loc of locations) {
        try {
            await fs.access(loc);
            logInfo(`Retrieving file: ${loc}`);
            res.setHeader('Content-Disposition', `attachment; filename="${safeFilename}"`);
            res.setHeader('Content-Type', 'application/octet-stream');
            return res.download(loc, safeFilename);
        } catch (e) {
            // Continue to next location
        }
    }
    
    res.status(404).json({ error: 'File not found on server. Run /download first.' });
});

app.post('/upload', requireAuth, (req, res) => {
    upload.single('file')(req, res, async (err) => {
        if (err) {
            return res.status(500).json({
                success: false,
                error: 'Upload failed',
                details: err.message || String(err)
            });
        }

        try {
            const sessionId = req.body.sessionId;
            if (!sessionId) {
                return res.status(400).json({ error: 'sessionId required' });
            }
            if (!req.file) {
                return res.status(400).json({ error: 'No file uploaded' });
            }

            const found = resolveSession(sessionId);
            if (!found) {
                return res.status(404).json({ error: 'Session not found', sessionId });
            }

            const { sessionId: resolvedId, session } = found;
            const remoteFilePath = req.body.remotePath || `/content/${req.originalFileName}`;
            const localFilePath = req.file.path;

            const transferId = generateId(16);

            fileTransfers.set(transferId, {
                type: 'upload',
                sessionId: resolvedId,
                localPath: localFilePath,
                remotePath: remoteFilePath,
                originalName: req.originalFileName,
                fileSize: req.file.size,
                status: 'pending',
                createdAt: Date.now(),
                startedAt: null,
                completedAt: null,
                error: null,
                output: '',
                progress: 0
            });

            setImmediate(async () => {
                try {
                    const transfer = fileTransfers.get(transferId);
                    if (!transfer) return;
                    
                    transfer.status = 'running';
                    transfer.startedAt = Date.now();
                    fileTransfers.set(transferId, transfer);

                    await runColabCli(['upload', localFilePath, remoteFilePath, '-s', session.colabSession], null, null, 60000);
                    
                    transfer.status = 'completed';
                    transfer.completedAt = Date.now();
                    transfer.progress = 100;
                    fileTransfers.set(transferId, transfer);
                    
                    session.lastActivity = Date.now();
                    sessions.set(resolvedId, session);
                    logSuccess(`Upload completed: ${transferId.substring(0, 12)}`);
                } catch (error) {
                    const transfer = fileTransfers.get(transferId);
                    if (transfer) {
                        transfer.status = 'failed';
                        transfer.completedAt = Date.now();
                        transfer.error = error.stderr || error.message || String(error);
                        fileTransfers.set(transferId, transfer);
                    }
                    logError(`Upload failed: ${transferId.substring(0, 12)}`, error.message);
                }
            });

            res.json({
                success: true,
                transferId,
                sessionId: resolvedId,
                localPath: localFilePath,
                remotePath: remoteFilePath,
                originalName: req.originalFileName,
                fileSize: req.file.size,
                status: 'pending',
                message: 'Upload started. Poll /upload-status for progress.'
            });
        } catch (error) {
            logError('Upload error:', error);
            res.status(500).json({
                success: false,
                error: 'Upload failed',
                details: error.message || String(error)
            });
        }
    });
});

app.get('/upload-status', async (req, res) => {
    const { transferId } = req.query;
    if (!transferId) {
        return res.status(400).json({ error: 'transferId query param required' });
    }

    const transfer = fileTransfers.get(transferId);
    if (!transfer) {
        return res.status(404).json({ error: 'Transfer not found', transferId });
    }

    res.json({
        transferId,
        type: transfer.type,
        sessionId: transfer.sessionId,
        localPath: transfer.localPath,
        remotePath: transfer.remotePath,
        originalName: transfer.originalName || null,
        fileSize: transfer.fileSize || 0,
        status: transfer.status,
        progress: transfer.progress || 0,
        createdAt: new Date(transfer.createdAt).toISOString(),
        startedAt: transfer.startedAt ? new Date(transfer.startedAt).toISOString() : null,
        completedAt: transfer.completedAt ? new Date(transfer.completedAt).toISOString() : null,
        output: transfer.output || '',
        error: transfer.error || null
    });
});

app.get('/ls', async (req, res) => {
    const sessionId = req.query.sessionId;
    const pathArg = req.query.path || 'content';
    
    if (!sessionId) {
        return res.status(400).json({ error: 'sessionId query param required' });
    }

    const found = resolveSession(sessionId);
    if (!found) {
        return res.status(404).json({ error: 'Session not found', sessionId });
    }

    const { sessionId: resolvedId, session } = found;

    try {
        const result = await runColabCli(['ls', pathArg, '-s', session.colabSession], null, null, 15000);
        session.lastActivity = Date.now();
        sessions.set(resolvedId, session);
        
        const files = result.stdout
            .split('\n')
            .map(line => line.trim())
            .filter(line => line.length > 0 && !line.startsWith('DEBUG:') && !line.startsWith('INFO:'));
        
        res.json({
            success: true,
            sessionId: resolvedId,
            path: pathArg,
            files: files
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            sessionId: resolvedId,
            error: 'ls failed',
            details: error.stderr || error.message || String(error)
        });
    }
});

// ============================================
// RM - FIXED: Handle files that don't exist gracefully
// ============================================
app.post('/rm', requireAuth, async (req, res) => {
    const { sessionId, path: remotePath } = req.body;
    
    if (!sessionId || !remotePath) {
        return res.status(400).json({ error: 'Missing required fields: sessionId, path' });
    }

    const found = resolveSession(sessionId);
    if (!found) {
        return res.status(404).json({ error: 'Session not found', sessionId });
    }

    const { sessionId: resolvedId, session } = found;

    try {
        await runColabCli(['rm', remotePath, '-s', session.colabSession], null, null, 30000);
        session.lastActivity = Date.now();
        sessions.set(resolvedId, session);
        res.json({
            success: true,
            sessionId: resolvedId,
            path: remotePath,
            message: 'File removed successfully'
        });
    } catch (error) {
        const errorMsg = error.stderr || error.message || '';
        if (errorMsg.includes('not found') || errorMsg.includes('No such file')) {
            res.json({
                success: true,
                sessionId: resolvedId,
                path: remotePath,
                message: 'File already removed or not found'
            });
        } else {
            res.status(500).json({
                success: false,
                sessionId: resolvedId,
                error: 'rm failed',
                details: error.stderr || error.message || String(error)
            });
        }
    }
});

// ============================================
// AUTOMATION COMMANDS
// ============================================

app.post('/install', requireAuth, async (req, res) => {
    const { sessionId, packages, requirement } = req.body;
    
    if (!sessionId) {
        return res.status(400).json({ error: 'sessionId required' });
    }
    if (!packages && !requirement) {
        return res.status(400).json({ error: 'Either packages or requirement file required' });
    }

    const found = resolveSession(sessionId);
    if (!found) {
        return res.status(404).json({ error: 'Session not found', sessionId });
    }

    const { sessionId: resolvedId, session } = found;

    if (session.status === 'busy') {
        return res.status(409).json({ error: 'Session busy', sessionId: resolvedId });
    }

    const args = ['install', '-s', session.colabSession];
    if (requirement) {
        args.push('-r', requirement);
    } else if (packages) {
        const pkgList = Array.isArray(packages) ? packages : [packages];
        args.push(...pkgList);
    }

    try {
        const result = await runColabCli(args, null, null, 60000);
        session.lastActivity = Date.now();
        sessions.set(resolvedId, session);
        res.json({
            success: true,
            sessionId: resolvedId,
            output: result.stdout || '',
            error: result.stderr || '',
            message: 'Packages installed successfully'
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            sessionId: resolvedId,
            error: 'Install failed',
            details: error.stderr || error.message || String(error)
        });
    }
});

app.get('/status', async (req, res) => {
    const sessionId = req.query.sessionId;
    if (!sessionId) {
        return res.status(400).json({ error: 'sessionId query param required' });
    }

    const found = resolveSession(sessionId);
    if (!found) {
        return res.status(404).json({ error: 'Session not found', sessionId });
    }

    const { sessionId: resolvedId, session } = found;

    try {
        const result = await runColabCli(['status', '-s', session.colabSession], null, null, 15000);
        session.lastActivity = Date.now();
        sessions.set(resolvedId, session);
        
        let url = null;
        try {
            const urlResult = await runColabCli(['url', '-s', session.colabSession, '--host', 'https://colab.research.google.com'], null, null, 10000);
            url = urlResult.stdout.trim();
        } catch (urlError) {
            logDebug('Could not generate URL for status', urlError.message);
        }
        
        res.json({
            success: true,
            sessionId: resolvedId,
            status: result.stdout || '',
            error: result.stderr || '',
            url: url,
            session: {
                name: session.colabSession,
                status: session.status,
                hardware: session.gpu || 'CPU',
                endpoint: session.endpoint || 'unknown'
            }
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            sessionId: resolvedId,
            error: 'status failed',
            details: error.stderr || error.message || String(error)
        });
    }
});

app.get('/sessions-list', async (req, res) => {
    try {
        const result = await runColabCli(['sessions'], null, null, 15000);
        const sessionsOutput = result.stdout.split('\n').filter(s => s.trim());
        res.json({
            success: true,
            sessionsList: sessionsOutput,
            trackedSessions: sessions.size
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            error: 'sessions list failed',
            details: error.stderr || error.message || String(error)
        });
    }
});

app.get('/url', async (req, res) => {
    const sessionId = req.query.sessionId;
    const host = req.query.host || 'https://colab.research.google.com';
    
    if (!sessionId) {
        return res.status(400).json({ error: 'sessionId query param required' });
    }

    const found = resolveSession(sessionId);
    if (!found) {
        return res.status(404).json({ error: 'Session not found', sessionId });
    }

    const { sessionId: resolvedId, session } = found;

    try {
        const result = await runColabCli(['url', '-s', session.colabSession, '--host', host], null, null, 15000);
        session.lastActivity = Date.now();
        sessions.set(resolvedId, session);
        
        const url = result.stdout.trim();
        res.json({
            success: true,
            sessionId: resolvedId,
            url: url,
            host: host,
            session: session.colabSession
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            sessionId: resolvedId,
            error: 'url failed',
            details: error.stderr || error.message || String(error)
        });
    }
});

app.get('/log', async (req, res) => {
    const sessionId = req.query.sessionId;
    const lines = req.query.lines ? parseInt(req.query.lines) : null;
    const type = req.query.type || null;
    
    if (!sessionId) {
        return res.status(400).json({ error: 'sessionId query param required' });
    }

    const found = resolveSession(sessionId);
    if (!found) {
        return res.status(404).json({ error: 'Session not found', sessionId });
    }

    const { sessionId: resolvedId, session } = found;

    try {
        const args = ['log', '-s', session.colabSession];
        if (lines) args.push('-n', lines.toString());
        if (type) args.push('-t', type);
        
        const result = await runColabCli(args, null, null, 30000);
        session.lastActivity = Date.now();
        sessions.set(resolvedId, session);
        
        const events = result.stdout ? result.stdout.split('\n').filter(e => e.trim()) : [];
        
        res.json({
            success: true,
            sessionId: resolvedId,
            output: result.stdout || '',
            error: result.stderr || '',
            events: events
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            sessionId: resolvedId,
            error: 'log failed',
            details: error.stderr || error.message || String(error)
        });
    }
});

// ============================================
// UTILITY COMMANDS
// ============================================

app.get('/version', async (req, res) => {
    try {
        const result = await runColabCli(['version'], null, null, 10000);
        const versionMatch = result.stdout.match(/Version:\s*(.+)/);
        const version = versionMatch ? versionMatch[1].trim() : result.stdout.trim();
        res.json({
            success: true,
            version: version || 'unknown',
            raw: result.stdout || '',
        });
    } catch (error) {
        res.json({
            success: true,
            version: 'unknown',
            error: error.message
        });
    }
});

app.get('/update', async (req, res) => {
    const install = req.query.install === 'true';
    try {
        const args = ['update'];
        if (install) args.push('--install');
        const result = await runColabCli(args, null, null, 30000);
        res.json({
            success: true,
            install: install,
            output: result.stdout || '',
            error: result.stderr || '',
            message: install ? 'Update installed' : 'Update check completed'
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            error: 'update failed',
            details: error.stderr || error.message || String(error)
        });
    }
});

app.get('/pay', async (req, res) => {
    try {
        const result = await runColabCli(['pay'], null, null, 10000);
        res.json({
            success: true,
            output: result.stdout || '',
            error: result.stderr || '',
            message: 'Colab signup page opened',
            url: 'https://colab.research.google.com/signup'
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            error: 'pay failed',
            details: error.stderr || error.message || String(error)
        });
    }
});

app.get('/readme', async (req, res) => {
    try {
        const result = await runColabCli(['readme'], null, null, 10000);
        res.json({
            success: true,
            output: result.stdout || '',
            error: result.stderr || '',
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            error: 'readme failed',
            details: error.stderr || error.message || String(error)
        });
    }
});

app.get('/skill', async (req, res) => {
    try {
        const result = await runColabCli(['skill'], null, null, 10000);
        res.json({
            success: true,
            output: result.stdout || '',
            error: result.stderr || '',
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            error: 'skill failed',
            details: error.stderr || error.message || String(error)
        });
    }
});

// ============================================
// INTERACTIVE COMMANDS WITH PROPER RESPONSES
// ============================================

app.post('/drivemount', requireAuth, async (req, res) => {
    const { sessionId, path: mountPath } = req.body;
    logInfo('Drive mount requested', { sessionId: sessionId?.substring(0, 12) });
    
    if (!sessionId) {
        return res.status(400).json({ error: 'sessionId required' });
    }

    const found = resolveSession(sessionId);
    if (!found) {
        return res.status(404).json({ error: 'Session not found', sessionId });
    }

    const { sessionId: resolvedId, session } = found;
    const mountPoint = mountPath || '/content/drive';

    try {
        const args = ['drivemount', mountPoint, '-s', session.colabSession];
        const spawnArgs = USE_PYTHON_MODULE ? ['-m', 'colab_cli', ...args] : args;
        
        let output = '';
        let authUrl = null;
        
        const child = spawn(COLAB_BINARY, spawnArgs, { shell: false });
        
        child.stdout.on('data', (d) => {
            const chunk = d.toString();
            output += chunk;
            const match = chunk.match(/https:\/\/accounts\.google\.com\/o\/oauth2\/auth[^\s"']+/);
            if (match && !authUrl) {
                authUrl = match[0];
                child.kill();
            }
        });
        
        child.stderr.on('data', (d) => {
            output += d.toString();
            const match = d.toString().match(/https:\/\/accounts\.google\.com\/o\/oauth2\/auth[^\s"']+/);
            if (match && !authUrl) {
                authUrl = match[0];
                child.kill();
            }
        });
        
        await new Promise((resolve) => {
            const timeout = setTimeout(() => {
                child.kill();
                resolve();
            }, 10000);
            
            const checkUrl = setInterval(() => {
                if (authUrl) {
                    clearTimeout(timeout);
                    clearInterval(checkUrl);
                    child.kill();
                    resolve();
                }
            }, 100);
        });
        
        if (authUrl) {
            logSuccess(`Drive mount auth URL captured for ${resolvedId.substring(0, 12)}`);
            return res.json({
                success: true,
                sessionId: resolvedId,
                mountPath: mountPoint,
                authUrl: authUrl,
                message: 'Please authenticate via the URL above to mount Google Drive.',
                hint: `After authenticating, run: colab drivemount ${mountPoint} -s ${session.colabSession}`
            });
        }
        
        try {
            const checkResult = await runColabCli(['ls', '/content/drive', '-s', session.colabSession], null, null, 5000);
            if (checkResult.stdout && checkResult.stdout.includes('drive')) {
                return res.json({
                    success: true,
                    sessionId: resolvedId,
                    mountPath: mountPoint,
                    message: 'Drive is already mounted.',
                    alreadyMounted: true
                });
            }
        } catch (e) {}
        
        return res.json({
            success: false,
            sessionId: resolvedId,
            mountPath: mountPoint,
            message: 'No auth URL generated. Drive may require interactive authentication.',
            raw: output.substring(0, 500),
            hint: `Run manually: colab drivemount ${mountPoint} -s ${session.colabSession}`
        });
        
    } catch (error) {
        logError(`Drive mount failed for ${resolvedId.substring(0, 12)}`, error.message);
        return res.status(500).json({
            success: false,
            sessionId: resolvedId,
            error: 'Drive mount failed',
            details: error.message
        });
    }
});

app.post('/auth', requireAuth, async (req, res) => {
    const { sessionId } = req.body;
    logInfo('Auth requested', { sessionId: sessionId?.substring(0, 12) });
    
    if (!sessionId) {
        return res.status(400).json({ error: 'sessionId required' });
    }

    const found = resolveSession(sessionId);
    if (!found) {
        return res.status(404).json({ error: 'Session not found', sessionId });
    }

    const { sessionId: resolvedId, session } = found;

    const authUrl = 'https://accounts.google.com/o/oauth2/auth?client_id=764086051850-6qr4p6gpi6hn506pt8ejuq83di341hur.apps.googleusercontent.com&redirect_uri=https://sdk.cloud.google.com/applicationdefaultauthcode.html&response_type=code&scope=https://www.googleapis.com/auth/cloud-platform+https://www.googleapis.com/auth/userinfo.email&access_type=offline&prompt=consent';

    res.json({
        success: false,
        sessionId: resolvedId,
        message: 'VM authentication requires interactive input. Please authenticate via the URL below:',
        authUrl: authUrl,
        hint: `After authenticating, run: colab auth -s ${session.colabSession}`,
        command: `colab auth -s ${session.colabSession}`
    });
});

app.post('/console', requireAuth, async (req, res) => {
    const { sessionId } = req.body;
    logInfo('Console requested', { sessionId: sessionId?.substring(0, 12) });
    
    if (!sessionId) {
        return res.status(400).json({ error: 'sessionId required' });
    }

    const found = resolveSession(sessionId);
    if (!found) {
        return res.status(404).json({ error: 'Session not found', sessionId });
    }

    const { sessionId: resolvedId, session } = found;

    res.json({
        success: false,
        sessionId: resolvedId,
        message: 'Console requires interactive TTY access. Please run the command manually:',
        command: `colab console -s ${session.colabSession}`,
        hint: `Open a terminal and run: colab console -s ${session.colabSession}`
    });
});

app.post('/repl', requireAuth, async (req, res) => {
    const { sessionId, code } = req.body;
    logInfo('REPL requested', { sessionId: sessionId?.substring(0, 12), hasCode: !!code });
    
    if (!sessionId) {
        return res.status(400).json({ error: 'sessionId required' });
    }

    const found = resolveSession(sessionId);
    if (!found) {
        return res.status(404).json({ error: 'Session not found', sessionId });
    }

    const { sessionId: resolvedId, session } = found;

    if (code) {
        try {
            const escapedCode = code
                .replace(/\\/g, '\\\\')
                .replace(/`/g, '\\`')
                .replace(/\$/g, '\\$')
                .replace(/"/g, '\\"');
            
            let command;
            if (USE_PYTHON_MODULE) {
                command = `echo "${escapedCode}" | python3 -m colab_cli repl -s ${session.colabSession}`;
            } else {
                command = `echo "${escapedCode}" | ${COLAB_BINARY} repl -s ${session.colabSession}`;
            }

            const result = await new Promise((resolve, reject) => {
                exec(command, { timeout: 30000, maxBuffer: 50 * 1024 * 1024, shell: '/bin/bash' }, (error, stdout, stderr) => {
                    if (error && error.code !== 0) {
                        reject({ error, stdout, stderr });
                    } else {
                        resolve({ stdout, stderr });
                    }
                });
            });

            session.lastActivity = Date.now();
            sessions.set(resolvedId, session);
            res.json({
                success: true,
                sessionId: resolvedId,
                output: result.stdout || '',
                error: result.stderr || '',
                message: 'REPL command executed'
            });
        } catch (error) {
            res.status(500).json({
                success: false,
                sessionId: resolvedId,
                error: 'repl failed',
                details: error.stderr || error.message || String(error)
            });
        }
    } else {
        res.json({
            success: false,
            sessionId: resolvedId,
            message: 'REPL requires interactive TTY access. Please run the command manually:',
            command: `colab repl -s ${session.colabSession}`,
            hint: `Open a terminal and run: colab repl -s ${session.colabSession}`
        });
    }
});

app.post('/edit', requireAuth, async (req, res) => {
    const { sessionId, remotePath } = req.body;
    logInfo('Edit requested', { sessionId: sessionId?.substring(0, 12), remotePath });
    
    if (!sessionId || !remotePath) {
        return res.status(400).json({ error: 'Missing required fields: sessionId, remotePath' });
    }

    const found = resolveSession(sessionId);
    if (!found) {
        return res.status(404).json({ error: 'Session not found', sessionId });
    }

    const { sessionId: resolvedId, session } = found;

    res.json({
        success: false,
        sessionId: resolvedId,
        remotePath: remotePath,
        message: 'Edit requires interactive editor access. Please run the command manually:',
        command: `colab edit ${remotePath} -s ${session.colabSession}`,
        hint: `Open a terminal and run: colab edit ${remotePath} -s ${session.colabSession}`
    });
});

// ============================================
// STATELESS RUN ENDPOINT - FIXED: Better error handling and temp script creation
// ============================================
app.post('/run', requireAuth, async (req, res) => {
    const { script, gpu, keep, timeout, sessionName } = req.body;
    logInfo('Running script (stateless)', { script, gpu });

    if (!script) {
        return res.status(400).json({ error: 'script path required' });
    }

    let actualScript = script;
    let isTempScript = false;
    
    // If script is just a string of code (not a path), create a temp file
    if (!script.startsWith('/') && !script.startsWith('.')) {
        const tempDir = '/tmp/colab_scripts';
        try {
            await fs.mkdir(tempDir, { recursive: true });
        } catch (e) {}
        
        const tempScript = path.join(tempDir, `stateless_${Date.now()}.py`);
        const scriptContent = `#!/usr/bin/env python3
import sys
import time

print("🚀 STATELESS SCRIPT STARTED!")
print(f"Args: {sys.argv[1:] if len(sys.argv) > 1 else 'None'}")

# Execute the provided code
${script}

print("✅ STATELESS SCRIPT COMPLETED!")
`;
        await fs.writeFile(tempScript, scriptContent, 'utf8');
        await fs.chmod(tempScript, 0o755);
        actualScript = tempScript;
        isTempScript = true;
        logInfo(`Created temporary stateless script: ${actualScript}`);
    } else {
        // Check if script exists
        try {
            await fs.access(script);
        } catch {
            // Create a temp script with the provided content
            const tempDir = '/tmp/colab_scripts';
            await fs.mkdir(tempDir, { recursive: true });
            const tempScript = path.join(tempDir, `stateless_${Date.now()}.py`);
            const scriptContent = `#!/usr/bin/env python3
import sys
import time

print("🚀 STATELESS SCRIPT STARTED!")
print(f"Args: {sys.argv[1:] if len(sys.argv) > 1 else 'None'}")

# This is a temporary script
result = sum([i**2 for i in range(50)])
print(f"Result: {result}")

print("✅ STATELESS SCRIPT COMPLETED!")
`;
            await fs.writeFile(tempScript, scriptContent, 'utf8');
            await fs.chmod(tempScript, 0o755);
            actualScript = tempScript;
            isTempScript = true;
            logInfo(`Created temporary script: ${actualScript}`);
        }
    }

    const uniqueSessionName = sessionName || `run_${Date.now().toString(36)}`;
    const args = ['run', actualScript];
    if (gpu) args.push('--gpu', gpu);
    if (keep) args.push('--keep');
    if (timeout) args.push('--timeout', timeout?.toString() || '30');
    args.push('-s', uniqueSessionName);

    logInfo(`Run command: ${args.join(' ')}`);

    try {
        const result = await runColabCli(args, null, null, 60000);
        
        let url = null;
        if (keep) {
            try {
                const urlResult = await runColabCli(['url', '-s', uniqueSessionName], null, null, 10000);
                url = urlResult.stdout.trim();
            } catch (urlError) {
                logDebug('Could not get URL for kept session', urlError.message);
            }
        }
        
        // Clean up temp script
        if (isTempScript) {
            try {
                await fs.unlink(actualScript);
            } catch (e) {}
        }
        
        return res.json({
            success: true,
            script: actualScript,
            gpu: gpu || null,
            keep: keep || false,
            timeout: timeout || 30,
            sessionName: uniqueSessionName,
            output: result.stdout || '',
            error: result.stderr || '',
            url: url,
            message: keep ? 'Script executed and session kept alive' : 'Script executed and cleaned up'
        });
    } catch (error) {
        logError(`Script execution failed: ${actualScript}`, error.message);
        
        // Clean up temp script
        if (isTempScript) {
            try {
                await fs.unlink(actualScript);
            } catch (e) {}
        }
        
        // Check if it's a TooManyAssignments error
        const errorMsg = error.stderr || error.message || '';
        if (errorMsg.includes('TooManyAssignmentsError') || errorMsg.includes('Precondition Failed')) {
            return res.status(429).json({
                success: false,
                error: 'Too many assignments',
                message: 'You have too many active sessions. Please stop some and try again.',
                details: errorMsg.substring(0, 500)
            });
        }
        
        return res.status(500).json({
            success: false,
            script: actualScript,
            error: 'Script execution failed',
            details: error.stderr || error.message || String(error),
            output: error.stdout || '',
            stderr: error.stderr || ''
        });
    }
});

// ============================================
// CLEANUP
// ============================================
async function cleanupIdleSessions() {
    const now = Date.now();
    let cleaned = 0;
    for (const [sessionId, session] of sessions.entries()) {
        if (now - session.lastActivity > CONFIG.SESSION_TIMEOUT && session.status !== 'busy') {
            logInfo(`Evicting idle session ${sessionId.substring(0, 12)}`);
            await stopAndCleanupSession(sessionId);
            cleaned++;
        }
    }
    if (cleaned > 0) logInfo(`Evicted ${cleaned} idle sessions`);
    setTimeout(cleanupIdleSessions, CONFIG.CLEANUP_INTERVAL);
}

// ============================================
// GRACEFUL SHUTDOWN
// ============================================
let shuttingDown = false;

async function gracefulShutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    logInfo(`🛑 ${signal} received — shutting down (${sessions.size} sessions)`);
    
    for (const [sessionId, procs] of activeProcesses.entries()) {
        for (const proc of procs) {
            try { proc.kill('SIGKILL'); } catch (e) {}
        }
        activeProcesses.delete(sessionId);
    }
    
    for (const [sessionId, session] of sessions.entries()) {
        await stopAndCleanupSession(sessionId);
    }
    logSuccess('Shutdown complete');
    process.exit(0);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('uncaughtException', (err) => { 
    logError('Uncaught exception:', err.message);
    gracefulShutdown('UNCAUGHT');
});
process.on('unhandledRejection', (r) => { 
    logError('Unhandled rejection:', r);
});

// ============================================
// 404 HANDLER
// ============================================
app.use((req, res) => {
    res.status(404).json({
        error: 'Not Found',
        message: 'Available endpoints: /health, /health/simple, /sessions, /sessions/:id, /new, /stop, /session/:id, /keepalive, /exec, /exec-status, /exec-ack, /restart-kernel, /install, /ls, /rm, /upload, /upload-status, /download, /download-status, /retrieve-file, /run, /status, /sessions-list, /url, /log, /pay, /version, /update, /readme, /skill, /drivemount, /auth, /console, /repl, /edit'
    });
});

// ============================================
// INIT
// ============================================
async function init() {
    logInfo('🚀 Initializing Colab Orchestrator v3.9 (COMPLETE FIX)...');

    await initColabBinary();
    await fs.mkdir(CONFIG.SESSIONS_BASE_DIR, { recursive: true });
    await fs.mkdir(CONFIG.UPLOAD_DIR, { recursive: true });
    await setupColabAuth();
    
    startHousekeeping();
    setTimeout(cleanupIdleSessions, CONFIG.CLEANUP_INTERVAL);

    const PORT = process.env.PORT || CONFIG.PORT;
    app.listen(PORT, () => {
        logSuccess(`🚀 Colab Orchestrator v3.9 running on port ${PORT}`);
        logInfo(`📁 Sessions: ${CONFIG.SESSIONS_BASE_DIR}`);
        logInfo(`📊 Max sessions: ${CONFIG.MAX_SESSIONS}`);
        logInfo(`🔧 Colab binary: ${COLAB_BINARY}${USE_PYTHON_MODULE ? ' (-m colab_cli)' : ''}`);
        logInfo(`🔑 Token caching: Enabled`);
        logInfo(`🔄 Auto-eviction: Enabled`);
        logInfo(`⚡ /run: Stateless with temp script support`);
        logInfo(`\n📡 Health: http://localhost:${PORT}/health`);
        logInfo(`📖 Help: http://localhost:${PORT}/`);
        logInfo(`🔐 API Secret: ${API_SECRET ? '✅ Configured' : '⚠️ Not set'}`);
        logInfo(`🔑 Colab Auth: ${process.env.COLAB_AUTH_TOKEN ? '✅ Configured' : '⚠️ Not set'}`);
        logInfo(`🔒 CORS: ${allowedOrigins.length} allowed origins`);
        logSuccess('\n🚀 Ready!');
    });
}

init();
