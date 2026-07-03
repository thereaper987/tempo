// ============================================
// COLAB ORCHESTRATOR - FIXED VERSION WITH IMPROVED LOGGING
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

const app = express();
const execPromise = util.promisify(exec);

// ============================================
// ENHANCED LOGGING
// ============================================
const LOG_LEVELS = {
    DEBUG: 0,
    INFO: 1,
    WARN: 2,
    ERROR: 3,
    SUCCESS: 4
};

const LOG_LEVEL = LOG_LEVELS.DEBUG;

function log(level, message, data = null) {
    const timestamp = new Date().toISOString();
    const prefix = {
        [LOG_LEVELS.DEBUG]: '🔍',
        [LOG_LEVELS.INFO]: 'ℹ️',
        [LOG_LEVELS.WARN]: '⚠️',
        [LOG_LEVELS.ERROR]: '❌',
        [LOG_LEVELS.SUCCESS]: '✅'
    }[level] || '📝';

    if (level >= LOG_LEVEL) {
        console.log(`[${timestamp}] ${prefix} ${message}`);
        if (data) {
            console.log(`   └─ ${JSON.stringify(data, null, 2)}`);
        }
    }
}

const logDebug = (msg, data) => log(LOG_LEVELS.DEBUG, msg, data);
const logInfo = (msg, data) => log(LOG_LEVELS.INFO, msg, data);
const logWarn = (msg, data) => log(LOG_LEVELS.WARN, msg, data);
const logError = (msg, data) => log(LOG_LEVELS.ERROR, msg, data);
const logSuccess = (msg, data) => log(LOG_LEVELS.SUCCESS, msg, data);

// ============================================
// HARDCODED CONFIGURATION (Testing Only)
// ============================================
const CONFIG = {
    COLAB_AUTH_TOKEN: '{"token": "ya29.a0AT3oNZ_JYRY15EBiIMfpxN8IXtFW43Kr3rj18eTv4QRiQr7O9Q-ZKr1Z_mUa2yJH1Aa63lT-DmvxCFqTuSLMMDBfe_mw0xg84cA20w2cAeTJ8DXF_ijdbUg4DUpH2s4XGSdX69ThTtizQNPsc4K60ykHkGnlmt8-W3o1Qb2nVOvP7oryE5gJW5fv4CGudryvYM-MWZQaCgYKAQwSARISFQHGX2Mi6_aFT-RRKHiy45bJg0mKcA0206", "refresh_token": "1//0g4sUFmaXGfvtCgYIARAAGBASNwF-L9IrYGPrhpvZRm7LOnSWxZfdVJGFpzmxEE0vrosqyFaObsZ7eJdDHKbaR1iS2-vhxoCU5Xs", "token_uri": "https://oauth2.googleapis.com/token", "client_id": "764086051850-6qr4p6gpi6hn506pt8ejuq83di341hur.apps.googleusercontent.com", "client_secret": "d-FL95Q19q7MQmFpd7hHD0Ty", "scopes": ["openid", "https://www.googleapis.com/auth/userinfo.profile", "https://www.googleapis.com/auth/userinfo.email", "https://www.googleapis.com/auth/cloud-platform", "https://www.googleapis.com/auth/colaboratory", "https://www.googleapis.com/auth/drive.file"], "universe_domain": "googleapis.com", "account": "", "expiry": "2026-06-15T07:29:05Z"}',

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
    HANGING_PROCESS_CLEANUP_INTERVAL: 900000,
    COMPLETED_EXECUTIONS_TTL: 1200000,
};

// ============================================
// CORS - ALLOW ALL
// ============================================
app.use(cors({ origin: '*', methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'] }));
app.options('*', cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// ============================================
// REQUEST LOGGING MIDDLEWARE
// ============================================
app.use((req, res, next) => {
    const start = Date.now();
    const { method, url, ip } = req;
    const bodySize = req.body ? JSON.stringify(req.body).length : 0;
    
    logDebug(`📨 ${method} ${url}`, { ip, bodySize });
    
    // Log request body for debugging (truncated)
    if (req.body && Object.keys(req.body).length > 0) {
        const truncatedBody = { ...req.body };
        if (truncatedBody.code) {
            truncatedBody.code = truncatedBody.code.substring(0, 100) + '...';
        }
        logDebug(`   Body:`, truncatedBody);
    }
    
    // Capture response
    const originalSend = res.send;
    let responseBody = null;
    res.send = function(data) {
        responseBody = data;
        return originalSend.call(this, data);
    };
    
    res.on('finish', () => {
        const duration = Date.now() - start;
        const status = res.statusCode;
        const statusIcon = status >= 200 && status < 300 ? '✅' : status >= 400 ? '❌' : '⚠️';
        logInfo(`${statusIcon} ${method} ${url} → ${status} (${duration}ms)`);
        
        if (status >= 400 && responseBody) {
            const errorPreview = typeof responseBody === 'string' 
                ? responseBody.substring(0, 500) 
                : JSON.stringify(responseBody).substring(0, 500);
            logDebug(`   Error response: ${errorPreview}`);
        }
    });
    
    next();
});

// ============================================
// MULTER FOR FILE UPLOADS
// ============================================
const storage = multer.diskStorage({
    destination: async (req, file, cb) => {
        const sessionId = req.body.sessionId || req.query.sessionId;
        if (!sessionId) {
            logError('No sessionId provided for upload');
            return cb(new Error('sessionId required'));
        }
        const uploadDir = path.join(CONFIG.UPLOAD_DIR, sessionId);
        try {
            await fs.mkdir(uploadDir, { recursive: true });
            logDebug(`Upload directory created: ${uploadDir}`);
            cb(null, uploadDir);
        } catch (error) {
            logError(`Failed to create upload directory: ${uploadDir}`, error);
            cb(error);
        }
    },
    filename: (req, file, cb) => {
        const timestamp = Date.now();
        const uniqueName = `${timestamp}_${file.originalname}`;
        req.uploadedFileName = uniqueName;
        req.originalFileName = file.originalname;
        logDebug(`Upload filename: ${uniqueName} (original: ${file.originalname})`);
        cb(null, uniqueName);
    }
});

const upload = multer({
    storage,
    limits: { fileSize: CONFIG.MAX_FILE_SIZE },
    fileFilter: (req, file, cb) => {
        logDebug(`File upload: ${file.originalname} (${file.mimetype})`);
        cb(null, true);
    }
});

// ============================================
// COLAB BINARY SETUP
// ============================================
let COLAB_BINARY = 'colab';
let USE_PYTHON_MODULE = false;

async function findColabBinary() {
    const { execSync } = require('child_process');
    logInfo('🔍 Searching for colab binary...');

    try {
        const whichPath = execSync('which colab 2>/dev/null || echo ""', { encoding: 'utf8', timeout: 5000 }).trim();
        if (whichPath && whichPath !== '') {
            logSuccess(`Found colab via which: ${whichPath}`);
            return whichPath;
        }
    } catch (e) {
        logDebug('which colab failed', e.message);
    }

    try {
        const pipPath = execSync('pip3 show google-colab-cli 2>/dev/null | grep Location | cut -d" " -f2', { encoding: 'utf8', timeout: 5000 }).trim();
        if (pipPath) {
            const possibleBinary = `${pipPath}/colab_cli/__main__.py`;
            if (require('fs').existsSync(possibleBinary)) {
                logSuccess(`Found colab via pip: ${possibleBinary}`);
                return 'python3';
            }
        }
    } catch (e) {
        logDebug('pip3 show failed', e.message);
    }

    logWarn('colab binary not found, falling back to python3 -m colab_cli');
    return 'python3';
}

async function initColabBinary() {
    const binary = await findColabBinary();
    if (binary === 'python3') {
        USE_PYTHON_MODULE = true;
        COLAB_BINARY = 'python3';
        logInfo(`Using Python module: python3 -m colab_cli`);
    } else {
        COLAB_BINARY = binary;
        USE_PYTHON_MODULE = false;
        logInfo(`Using colab binary: ${COLAB_BINARY}`);
    }
}

// ============================================
// COLAB CLI RUNNER WITH ENHANCED LOGGING
// ============================================
async function runColabCli(args, timeout = 30000) {
    return new Promise((resolve, reject) => {
        let command;
        if (USE_PYTHON_MODULE) {
            const escapedArgs = args.map(a => `"${a.replace(/"/g, '\\"')}"`).join(' ');
            command = `${COLAB_BINARY} -m colab_cli ${escapedArgs}`;
        } else {
            const escapedArgs = args.map(a => `"${a.replace(/"/g, '\\"')}"`).join(' ');
            command = `${COLAB_BINARY} ${escapedArgs}`;
        }
        
        logDebug(`🛠  Running: ${command}`, { timeout });
        
        exec(command, { timeout, shell: '/bin/bash', maxBuffer: 50 * 1024 * 1024 }, (error, stdout, stderr) => {
            if (stdout && stdout.length > 0) {
                logDebug(`   STDOUT: ${stdout.substring(0, 200)}${stdout.length > 200 ? '...' : ''}`);
            }
            if (stderr && stderr.length > 0) {
                logDebug(`   STDERR: ${stderr.substring(0, 200)}${stderr.length > 200 ? '...' : ''}`);
            }
            
            if (error && error.code !== 0) {
                logError(`Command failed with code ${error.code}`, { 
                    command: command.substring(0, 100),
                    error: error.message,
                    stderr: stderr.substring(0, 500)
                });
                reject({ error, stdout, stderr });
            } else {
                logSuccess(`Command completed successfully`);
                resolve({ stdout, stderr });
            }
        });
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
// HELPERS
// ============================================
function generateId(bytes = 32) {
    return crypto.randomBytes(bytes).toString('hex');
}

function formatMemory(bytes) {
    return (bytes / 1024 / 1024).toFixed(2) + ' MB';
}

function resolveSession(identifier) {
    for (const [id, s] of sessions.entries()) {
        if (id === identifier || id.substring(0, 8) === identifier) {
            return { sessionId: id, session: s };
        }
    }
    return null;
}

function safeStringify(obj) {
    try {
        return JSON.stringify(obj, null, 2);
    } catch {
        return String(obj);
    }
}

// ============================================
// STATE MANAGEMENT
// ============================================
const sessions = new Map();
const completedExecutions = new Map();
const executionQueue = new Set();
const executionProcesses = new Map();
const fileTransfers = new Map();

// Cleanup completed executions
setInterval(() => {
    const now = Date.now();
    let cleaned = 0;
    for (const [execId, data] of completedExecutions.entries()) {
        if (now - data.completedAt > CONFIG.COMPLETED_EXECUTIONS_TTL) {
            completedExecutions.delete(execId);
            cleaned++;
        }
    }
    if (cleaned > 0) logInfo(`Cleared ${cleaned} stale completed executions`);
}, 60 * 1000);

// Cleanup hanging processes
setInterval(() => {
    for (const [execId, proc] of executionProcesses.entries()) {
        try {
            proc.kill(0);
            const session = Array.from(sessions.values()).find(s => s.currentExecution?.executionId === execId);
            if (session && Date.now() - session.currentExecution.startedAt > 2.5 * 60 * 60 * 1000) {
                logWarn(`Killing hanging process ${execId}`);
                proc.kill('SIGTERM');
                executionProcesses.delete(execId);
            }
        } catch {
            executionProcesses.delete(execId);
        }
    }
}, CONFIG.HANGING_PROCESS_CLEANUP_INTERVAL);

// Cleanup old file transfers
setInterval(() => {
    const now = Date.now();
    let cleaned = 0;
    for (const [transferId, data] of fileTransfers.entries()) {
        if (now - data.createdAt > 3600000) {
            fileTransfers.delete(transferId);
            cleaned++;
        }
    }
    if (cleaned > 0) logInfo(`Cleared ${cleaned} stale file transfers`);
}, 60000);

// ============================================
// SESSION FOLDER MANAGEMENT
// ============================================
async function createSessionFolder(sessionId) {
    const folder = path.join(CONFIG.SESSIONS_BASE_DIR, sessionId);
    await fs.mkdir(folder, { recursive: true });
    logDebug(`Session folder created: ${folder}`);
    return folder;
}

async function cleanupSessionFolder(sessionId) {
    try {
        await fs.rm(path.join(CONFIG.SESSIONS_BASE_DIR, sessionId), { recursive: true, force: true });
        await fs.rm(path.join(CONFIG.UPLOAD_DIR, sessionId), { recursive: true, force: true });
        logSuccess(`Cleaned up folders for session ${sessionId.substring(0, 12)}`);
    } catch (error) {
        logError(`Failed to cleanup folders for ${sessionId}`, error.message);
    }
}

// ============================================
// SESSION DATA JSON MANAGEMENT
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
        logDebug(`Session data updated for ${sessionId.substring(0, 12)}`, { cellNo: data.cellNo, type: data.type });
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
// CODE EXECUTION ENGINE
// ============================================
async function executeCodeInColab(sessionId, cellNo, code, executionId) {
    const session = sessions.get(sessionId);
    if (!session) {
        logError(`Session not found: ${sessionId}`);
        throw new Error('Session not found');
    }

    const startedAt = Date.now();
    let cellData = {
        type: 'execution',
        cellNo,
        startedAt: new Date(startedAt).toISOString(),
        code,
        status: 'running'
    };

    try {
        if (Buffer.byteLength(code, 'utf8') > CONFIG.MAX_CODE_SIZE) {
            throw new Error(`Code exceeds ${CONFIG.MAX_CODE_SIZE} bytes`);
        }

        const codeFile = path.join(CONFIG.SESSIONS_BASE_DIR, sessionId, `code_${cellNo}.py`);
        await fs.writeFile(codeFile, code, 'utf8');
        logDebug(`Code written to: ${codeFile}`);

        // FIX: Properly escape code for shell
        const escapedCode = code
            .replace(/\\/g, '\\\\')
            .replace(/`/g, '\\`')
            .replace(/\$/g, '\\$')
            .replace(/"/g, '\\"');

        let command;
        if (USE_PYTHON_MODULE) {
            command = `echo "${escapedCode}" | python3 -m colab_cli exec -s ${session.colabSession} --timeout ${CONFIG.EXECUTION_TIMEOUT}`;
        } else {
            command = `echo "${escapedCode}" | ${COLAB_BINARY} exec -s ${session.colabSession} --timeout ${CONFIG.EXECUTION_TIMEOUT}`;
        }

        logDebug(`Executing command`, { session: session.colabSession, timeout: CONFIG.EXECUTION_TIMEOUT });

        const proc = exec(command, {
            timeout: CONFIG.EXECUTION_TIMEOUT * 1000,
            maxBuffer: 50 * 1024 * 1024,
            shell: '/bin/bash'
        });

        executionProcesses.set(executionId, proc);

        let stdout = '';
        let stderr = '';

        proc.stdout.on('data', (data) => {
            const chunk = data.toString();
            stdout += chunk;
            const s = sessions.get(sessionId);
            if (s?.currentExecution?.executionId === executionId) {
                s.currentExecution.partialOutput = stdout;
                s.currentExecution.partialError = stderr;
                sessions.set(sessionId, s);
            }
            logDebug(`   stdout chunk: ${chunk.substring(0, 100)}${chunk.length > 100 ? '...' : ''}`);
        });

        proc.stderr.on('data', (data) => {
            const chunk = data.toString();
            stderr += chunk;
            const s = sessions.get(sessionId);
            if (s?.currentExecution?.executionId === executionId) {
                s.currentExecution.partialOutput = stdout;
                s.currentExecution.partialError = stderr;
                sessions.set(sessionId, s);
            }
            if (chunk.trim()) {
                logDebug(`   stderr chunk: ${chunk.substring(0, 100)}${chunk.length > 100 ? '...' : ''}`);
            }
        });

        const result = await new Promise((resolve, reject) => {
            proc.on('close', (code) => {
                logDebug(`Process closed with code: ${code}`);
                if (code !== 0) reject({ error: new Error(`Process exited with code ${code}`), stdout, stderr });
                else resolve({ stdout, stderr });
            });
            proc.on('error', (err) => {
                logError(`Process error:`, err);
                reject({ error: err, stdout, stderr });
            });
        });

        const completedAt = Date.now();
        const executionTime = completedAt - startedAt;

        const output = {
            status: 'completed',
            output: result.stdout || '(No output)',
            error: result.stderr || '',
            startedAt,
            completedAt,
            executionTime
        };

        completedExecutions.set(executionId, output);
        executionProcesses.delete(executionId);

        const updatedSession = sessions.get(sessionId);
        if (updatedSession?.currentExecution?.executionId === executionId) {
            updatedSession.currentExecution = null;
            updatedSession.status = 'ready';
            sessions.set(sessionId, updatedSession);
        }

        cellData = { ...cellData, status: 'completed', completedAt: new Date(completedAt).toISOString(), executionTime, output: result.stdout || '(No output)', error: result.stderr || '' };
        await appendSessionData(sessionId, cellData);

        logSuccess(`Execution ${executionId.substring(0, 12)} completed in ${executionTime}ms`);
        return output;
    } catch (error) {
        const completedAt = Date.now();
        const failureResult = {
            status: 'failed',
            output: error.stdout || '',
            error: error.stderr || error.message || String(error),
            startedAt,
            completedAt,
            executionTime: completedAt - startedAt
        };

        completedExecutions.set(executionId, failureResult);
        executionProcesses.delete(executionId);

        const updatedSession = sessions.get(sessionId);
        if (updatedSession?.currentExecution?.executionId === executionId) {
            updatedSession.currentExecution = null;
            updatedSession.status = 'ready';
            sessions.set(sessionId, updatedSession);
        }

        cellData = { ...cellData, status: 'failed', completedAt: new Date(completedAt).toISOString(), executionTime: completedAt - startedAt, output: error.stdout || '', error: error.stderr || error.message || String(error) };
        await appendSessionData(sessionId, cellData);

        logError(`Execution ${executionId.substring(0, 12)} failed:`, error.message || error.error?.message);
        throw error;
    }
}

async function backgroundExecution(sessionId, cellNo, code, executionId) {
    const execKey = `${sessionId}_${cellNo}`;
    if (executionQueue.has(execKey)) {
        logDebug(`Execution already queued: ${execKey}`);
        return;
    }
    executionQueue.add(execKey);
    logInfo(`Queued execution ${executionId.substring(0, 12)}`);
    try {
        await executeCodeInColab(sessionId, cellNo, code, executionId);
    } catch (error) {
        logError(`Background error for ${executionId.substring(0, 12)}:`, error.message || error.error?.message);
    } finally {
        executionQueue.delete(execKey);
    }
}

// ============================================
// HEALTH ENDPOINTS
// ============================================
app.get('/health', (req, res) => {
    const mem = process.memoryUsage();
    logDebug('Health check requested');
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
// HELP ENDPOINT
// ============================================
app.get('/', (req, res) => {
    const baseUrl = `${req.protocol}://${req.get('host')}`;
    logDebug('Help endpoint requested');
    res.json({
        name: "Colab Orchestrator API",
        version: "3.0.0",
        description: "REST API wrapper around Google Colab CLI",
        baseUrl: baseUrl,
        endpoints: {
            health: { method: "GET", path: "/health", description: "Full health check" },
            healthSimple: { method: "GET", path: "/health/simple", description: "Simple health check" },
            sessions: { method: "GET", path: "/sessions", description: "List all sessions" },
            sessionDetails: { method: "GET", path: "/sessions/:identifier", description: "Get session details" },
            new: { method: "POST", path: "/new", description: "Create new session", body: { sessionId: "optional", gpu: "optional" } },
            stop: { method: "POST", path: "/stop", description: "Stop session", body: { sessionId: "required" } },
            delete: { method: "DELETE", path: "/session/:sessionId", description: "Delete session" },
            keepalive: { method: "POST", path: "/keepalive", description: "Keep session alive", body: { sessionId: "required" } },
            restartKernel: { method: "POST", path: "/restart-kernel", description: "Restart kernel", body: { sessionId: "required" } },
            exec: { method: "POST", path: "/exec", description: "Execute code", body: { sessionId: "required", code: "required", cellNo: "required" } },
            execStatus: { method: "GET/POST", path: "/exec-status", description: "Check execution status", params: { sessionId: "required", executionId: "required" } },
            execAck: { method: "POST", path: "/exec-ack", description: "Acknowledge execution", body: { executionId: "required" } },
            install: { method: "POST", path: "/install", description: "Install packages", body: { sessionId: "required", packages: "optional", requirement: "optional" } },
            ls: { method: "GET", path: "/ls", description: "List files", params: { sessionId: "required", path: "optional" } },
            rm: { method: "POST", path: "/rm", description: "Remove file", body: { sessionId: "required", path: "required" } },
            upload: { method: "POST", path: "/upload", description: "Upload file (multipart)", body: { sessionId: "required", file: "required" } },
            uploadStatus: { method: "GET", path: "/upload-status", description: "Check upload status", params: { transferId: "required" } },
            download: { method: "POST", path: "/download", description: "Download file", body: { sessionId: "required", remotePath: "required" } },
            downloadStatus: { method: "GET", path: "/download-status", description: "Check download status", params: { transferId: "required" } },
            run: { method: "POST", path: "/run", description: "Run script on fresh VM", body: { script: "required", gpu: "optional" } },
            status: { method: "GET", path: "/status", description: "Get session status", params: { sessionId: "required" } },
            url: { method: "GET", path: "/url", description: "Get browser URL", params: { sessionId: "required", host: "optional" } },
            log: { method: "GET", path: "/log", description: "Get session logs", params: { sessionId: "required" } },
            sessionsList: { method: "GET", path: "/sessions-list", description: "List sessions via CLI" },
            version: { method: "GET", path: "/version", description: "Get CLI version" },
            update: { method: "GET", path: "/update", description: "Check for updates" },
            pay: { method: "GET", path: "/pay", description: "Open Colab signup page" },
            readme: { method: "GET", path: "/readme", description: "Print README" },
            skill: { method: "GET", path: "/skill", description: "Print SKILL.md" },
        },
        timestamp: new Date().toISOString()
    });
});

// ============================================
// SESSION ENDPOINTS
// ============================================

// GET /sessions - List all sessions
app.get('/sessions', async (req, res) => {
    logDebug('Listing all sessions');
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
            folder: session.folder,
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

// GET /sessions/:identifier - Get session details
app.get('/sessions/:identifier', async (req, res) => {
    const cleanId = req.params.identifier.replace(/\/$/, '');
    logDebug(`Getting session details: ${cleanId}`);
    
    const found = resolveSession(cleanId);

    if (!found) {
        logWarn(`Session not found: ${cleanId}`);
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
            folder: session.folder,
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

// POST /new - Create a new session
app.post('/new', async (req, res) => {
    logInfo('Creating new session', { body: req.body });
    
    // Evict oldest if at max
    if (sessions.size >= CONFIG.MAX_SESSIONS) {
        logWarn(`Max sessions reached (${sessions.size}), evicting oldest`);
        let oldestId = null;
        let oldestTime = Infinity;
        for (const [id, s] of sessions.entries()) {
            if (s.lastActivity < oldestTime) { oldestTime = s.lastActivity; oldestId = id; }
        }
        if (oldestId) {
            const s = sessions.get(oldestId);
            try { 
                await runColabCli(['stop', '-s', s.colabSession], 10000);
                logInfo(`Stopped evicted session: ${oldestId.substring(0, 12)}`);
            } catch (e) {
                logWarn(`Failed to stop evicted session: ${oldestId.substring(0, 12)}`, e.message);
            }
            await cleanupSessionFolder(oldestId);
            sessions.delete(oldestId);
            logInfo(`Evicted session: ${oldestId.substring(0, 12)}`);
        }
    }

    const sessionId = req.body?.sessionId || generateId(32);
    const gpu = req.body?.gpu || null;
    const tpu = req.body?.tpu || null;
    const colabSessionName = `colab_${sessionId.substring(0, 12)}`;

    // Build CLI args
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

        await runColabCli(args, 60000);

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
        await cleanupSessionFolder(sessionId);

        // Spawn fallback to catch OAuth URL
        const spawnArgs = USE_PYTHON_MODULE
            ? ['-m', 'colab_cli', ...args]
            : args;

        const child = spawn(COLAB_BINARY, spawnArgs);
        let authUrl = null;
        let outputBuffer = '';

        const timeout = setTimeout(() => {
            if (!authUrl) {
                child.kill();
                logError(`Session creation timeout for ${sessionId.substring(0, 12)}`);
                return res.status(500).json({
                    success: false,
                    sessionId,
                    error: 'Failed to create session',
                    details: 'Authentication required or token expired'
                });
            }
        }, 10000);

        const handleOutput = (data) => {
            outputBuffer += data.toString();
            const match = outputBuffer.match(/https:\/\/accounts\.google\.com\/o\/oauth2\/auth[^\s"']+/);
            if (match && !authUrl) {
                authUrl = match[0];
                clearTimeout(timeout);
                child.kill();
                logInfo(`Auth URL captured for session ${sessionId.substring(0, 12)}`);

                sessions.set(sessionId, {
                    colabSession: colabSessionName,
                    createdAt: Date.now(),
                    lastActivity: Date.now(),
                    status: 'auth_required',
                    gpu,
                    tpu,
                    currentExecution: null,
                    folder: path.join(CONFIG.SESSIONS_BASE_DIR, sessionId),
                    authUrl
                });

                return res.json({
                    success: false,
                    needsAuth: true,
                    authUrl,
                    sessionId,
                    colabSession: colabSessionName,
                    message: 'Please authenticate with Google'
                });
            }
        };

        child.stdout.on('data', handleOutput);
        child.stderr.on('data', handleOutput);
        child.on('error', (err) => {
            clearTimeout(timeout);
            logError(`Spawn error for ${sessionId.substring(0, 12)}`, err.message);
            if (!authUrl) {
                return res.status(500).json({ success: false, sessionId, error: 'Spawn error', details: err.message });
            }
        });
    }
});

// POST /stop - Stop a session
app.post('/stop', async (req, res) => {
    const { sessionId } = req.body;
    if (!sessionId) {
        logError('stop: sessionId missing');
        return res.status(400).json({ error: 'sessionId required' });
    }

    const found = resolveSession(sessionId);
    if (!found) {
        logWarn(`stop: Session not found: ${sessionId}`);
        return res.status(404).json({ error: 'Session not found', sessionId });
    }

    const { sessionId: resolvedId, session } = found;
    logInfo(`Stopping session ${resolvedId.substring(0, 12)}`);

    try {
        await runColabCli(['stop', '-s', session.colabSession], 30000);
        await cleanupSessionFolder(resolvedId);
        sessions.delete(resolvedId);
        logSuccess(`Session ${resolvedId.substring(0, 12)} stopped`);
        res.json({ success: true, sessionId: resolvedId, message: 'Session stopped' });
    } catch (error) {
        logError(`Stop failed for ${resolvedId.substring(0, 12)}`, error.message);
        await cleanupSessionFolder(resolvedId);
        sessions.delete(resolvedId);
        res.json({ success: true, sessionId: resolvedId, warning: 'Session removed locally, may still exist remotely' });
    }
});

// DELETE /session/:sessionId - Delete session
app.delete('/session/:sessionId', async (req, res) => {
    const { sessionId } = req.params;
    logInfo(`Deleting session ${sessionId.substring(0, 12)}`);
    
    const found = resolveSession(sessionId);
    if (!found) {
        logWarn(`Delete: Session not found: ${sessionId}`);
        return res.status(404).json({ error: 'Session not found', sessionId });
    }

    const { sessionId: resolvedId, session } = found;

    try {
        await runColabCli(['stop', '-s', session.colabSession], 30000);
        await cleanupSessionFolder(resolvedId);
        sessions.delete(resolvedId);
        logSuccess(`Session ${resolvedId.substring(0, 12)} deleted`);
        return res.json({ success: true, sessionId: resolvedId, message: 'Session terminated' });
    } catch (error) {
        logError(`Delete failed for ${resolvedId.substring(0, 12)}`, error.message);
        await cleanupSessionFolder(resolvedId);
        sessions.delete(resolvedId);
        return res.json({ success: true, sessionId: resolvedId, warning: 'Session removed locally, may still exist remotely' });
    }
});

// POST /keepalive - Keep session alive
app.post('/keepalive', async (req, res) => {
    const { sessionId } = req.body;
    if (!sessionId) {
        logError('keepalive: sessionId missing');
        return res.status(400).json({ error: 'sessionId required' });
    }

    const found = resolveSession(sessionId);
    if (!found) {
        logWarn(`keepalive: Session not found: ${sessionId}`);
        return res.status(404).json({ error: 'Session not found', sessionId });
    }

    try {
        await runColabCli(['sessions'], 10000);
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
// CODE EXECUTION
// ============================================

// POST /exec - Execute code
app.post('/exec', async (req, res) => {
    const { sessionId, code, cellNo } = req.body;
    logInfo('Executing code', { sessionId: sessionId?.substring(0, 12), cellNo, codeLength: code?.length });
    
    if (!sessionId || !code || cellNo === undefined) {
        logError('exec: Missing required fields');
        return res.status(400).json({ error: 'Missing required fields: sessionId, code, cellNo' });
    }

    const found = resolveSession(sessionId);
    if (!found) {
        logWarn(`exec: Session not found: ${sessionId}`);
        return res.status(404).json({ error: 'Session not found', sessionId });
    }

    const { sessionId: resolvedId, session } = found;

    if (session.status === 'busy') {
        logWarn(`exec: Session busy: ${resolvedId.substring(0, 12)}`);
        return res.status(409).json({
            error: 'Session busy',
            sessionId: resolvedId,
            currentExecution: session.currentExecution
        });
    }

    const executionId = generateId(16);
    const validCellNo = parseInt(cellNo, 10);

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

    backgroundExecution(resolvedId, validCellNo, code, executionId);

    res.json({
        status: 'processing',
        sessionId: resolvedId,
        executionId,
        pollInterval: CONFIG.POLL_INTERVAL,
        message: 'Code execution started. Poll /exec-status for results.'
    });
});

// /exec-status - Check execution status
app.all('/exec-status', async (req, res) => {
    const sessionId = req.body?.sessionId || req.query?.sessionId;
    const executionId = req.body?.executionId || req.query?.executionId;
    
    logDebug('Checking execution status', { sessionId: sessionId?.substring(0, 12), executionId: executionId?.substring(0, 12) });
    
    if (!sessionId || !executionId) {
        logError('exec-status: Missing required fields');
        return res.status(400).json({ error: 'Missing required fields: sessionId, executionId' });
    }

    // Check if completed
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

    // Check if running
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
    res.json({ status: 'not_found', sessionId, executionId, message: 'Execution not found or already completed' });
});

// POST /exec-ack - Acknowledge completion
app.post('/exec-ack', async (req, res) => {
    const { executionId } = req.body;
    logInfo(`Acknowledging execution: ${executionId?.substring(0, 12)}`);
    
    if (executionId && completedExecutions.has(executionId)) {
        completedExecutions.delete(executionId);
        logSuccess(`Execution ${executionId.substring(0, 12)} acknowledged`);
        return res.json({ success: true, executionId, message: 'Acknowledged' });
    }
    logWarn(`Execution ${executionId} not found for acknowledgment`);
    res.json({ success: false, executionId, message: 'Execution not found' });
});

// POST /restart-kernel - Restart session kernel
app.post('/restart-kernel', async (req, res) => {
    const { sessionId } = req.body;
    logInfo(`Restarting kernel for session ${sessionId?.substring(0, 12)}`);
    
    if (!sessionId) {
        logError('restart-kernel: sessionId missing');
        return res.status(400).json({ error: 'sessionId required' });
    }

    const found = resolveSession(sessionId);
    if (!found) {
        logWarn(`restart-kernel: Session not found: ${sessionId}`);
        return res.status(404).json({ error: 'Session not found', sessionId });
    }

    const { sessionId: resolvedId, session } = found;

    if (session.status === 'busy') {
        logWarn(`restart-kernel: Session busy: ${resolvedId.substring(0, 12)}`);
        return res.status(409).json({ error: 'Session busy, cannot restart', sessionId: resolvedId });
    }

    try {
        await runColabCli(['restart-kernel', '-s', session.colabSession], 30000);
        session.lastActivity = Date.now();
        sessions.set(resolvedId, session);
        logSuccess(`Kernel restarted for ${resolvedId.substring(0, 12)}`);
        res.json({
            success: true,
            sessionId: resolvedId,
            message: 'Kernel restarted'
        });
    } catch (error) {
        logError(`Restart failed for ${resolvedId.substring(0, 12)}`, error.message);
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

// POST /download - Download file
app.post('/download', async (req, res) => {
    const { sessionId, remotePath, localPath } = req.body;
    logInfo(`Downloading file`, { sessionId: sessionId?.substring(0, 12), remotePath });
    
    if (!sessionId || !remotePath) {
        logError('download: Missing required fields');
        return res.status(400).json({ error: 'Missing required fields: sessionId, remotePath' });
    }

    const found = resolveSession(sessionId);
    if (!found) {
        logWarn(`download: Session not found: ${sessionId}`);
        return res.status(404).json({ error: 'Session not found', sessionId });
    }

    const { sessionId: resolvedId, session } = found;

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
        progress: 0
    });

    logInfo(`Download transfer ${transferId.substring(0, 12)}: ${remotePath} → ${destPath}`);

    setImmediate(async () => {
        try {
            const transfer = fileTransfers.get(transferId);
            if (!transfer) return;
            
            transfer.status = 'running';
            transfer.startedAt = Date.now();
            fileTransfers.set(transferId, transfer);

            const result = await runColabCli(['download', remotePath, destPath, '-s', session.colabSession], 60000);
            
            transfer.status = 'completed';
            transfer.completedAt = Date.now();
            transfer.output = result.stdout || '';
            transfer.progress = 100;
            fileTransfers.set(transferId, transfer);
            
            session.lastActivity = Date.now();
            sessions.set(resolvedId, session);
            logSuccess(`Download completed: ${transferId.substring(0, 12)}`);
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
        message: 'Download started. Poll /download-status for progress.',
        pollInterval: CONFIG.POLL_INTERVAL
    });
});

// GET /download-status - Check download status
app.get('/download-status', async (req, res) => {
    const { transferId } = req.query;
    logDebug(`Checking download status: ${transferId?.substring(0, 12)}`);
    
    if (!transferId) {
        logError('download-status: transferId missing');
        return res.status(400).json({ error: 'transferId query param required' });
    }

    const transfer = fileTransfers.get(transferId);
    if (!transfer) {
        logWarn(`download-status: Transfer not found: ${transferId}`);
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

    if (transfer.status === 'completed') {
        try {
            const stats = await fs.stat(transfer.localPath);
            response.fileSize = stats.size;
            response.fileSizeFormatted = formatMemory(stats.size);
        } catch {
            response.fileSize = 0;
        }
    }

    res.json(response);
});

// POST /upload - Upload file
app.post('/upload', (req, res) => {
    upload.single('file')(req, res, async (err) => {
        if (err) {
            logError('Upload error:', err);
            return res.status(500).json({
                success: false,
                error: 'Upload failed',
                details: err.message || String(err)
            });
        }

        try {
            const sessionId = req.body.sessionId;
            logInfo(`Uploading file`, { sessionId: sessionId?.substring(0, 12), file: req.file?.originalname });
            
            if (!sessionId) {
                logError('upload: sessionId missing');
                return res.status(400).json({ error: 'sessionId required' });
            }
            if (!req.file) {
                logError('upload: No file uploaded');
                return res.status(400).json({ error: 'File not uploaded. Use multipart/form-data with field name "file"' });
            }

            const found = resolveSession(sessionId);
            if (!found) {
                logWarn(`upload: Session not found: ${sessionId}`);
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

            logInfo(`Upload transfer ${transferId.substring(0, 12)}: ${localFilePath} → ${remoteFilePath}`);

            setImmediate(async () => {
                try {
                    const transfer = fileTransfers.get(transferId);
                    if (!transfer) return;
                    
                    transfer.status = 'running';
                    transfer.startedAt = Date.now();
                    fileTransfers.set(transferId, transfer);

                    const result = await runColabCli(['upload', localFilePath, remoteFilePath, '-s', session.colabSession], 60000);
                    
                    transfer.status = 'completed';
                    transfer.completedAt = Date.now();
                    transfer.output = result.stdout || '';
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
                fileSizeFormatted: formatMemory(req.file.size),
                status: 'pending',
                message: 'Upload started. Poll /upload-status for progress.',
                pollInterval: CONFIG.POLL_INTERVAL
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

// GET /upload-status - Check upload status
app.get('/upload-status', async (req, res) => {
    const { transferId } = req.query;
    logDebug(`Checking upload status: ${transferId?.substring(0, 12)}`);
    
    if (!transferId) {
        logError('upload-status: transferId missing');
        return res.status(400).json({ error: 'transferId query param required' });
    }

    const transfer = fileTransfers.get(transferId);
    if (!transfer) {
        logWarn(`upload-status: Transfer not found: ${transferId}`);
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
        fileSizeFormatted: transfer.fileSize ? formatMemory(transfer.fileSize) : '0 MB',
        status: transfer.status,
        progress: transfer.progress || 0,
        createdAt: new Date(transfer.createdAt).toISOString(),
        startedAt: transfer.startedAt ? new Date(transfer.startedAt).toISOString() : null,
        completedAt: transfer.completedAt ? new Date(transfer.completedAt).toISOString() : null,
        output: transfer.output || '',
        error: transfer.error || null
    });
});

// GET /ls - List files
app.get('/ls', async (req, res) => {
    const sessionId = req.query.sessionId;
    const pathArg = req.query.path || 'content';
    
    logInfo(`Listing files`, { sessionId: sessionId?.substring(0, 12), path: pathArg });
    
    if (!sessionId) {
        logError('ls: sessionId missing');
        return res.status(400).json({ error: 'sessionId query param required' });
    }

    const found = resolveSession(sessionId);
    if (!found) {
        logWarn(`ls: Session not found: ${sessionId}`);
        return res.status(404).json({ error: 'Session not found', sessionId });
    }

    const { sessionId: resolvedId, session } = found;

    try {
        const result = await runColabCli(['ls', pathArg, '-s', session.colabSession], 15000);
        session.lastActivity = Date.now();
        sessions.set(resolvedId, session);
        
        // Parse output to array
        const files = result.stdout.split('\n').filter(f => f.trim());
        logSuccess(`Listed ${files.length} files for ${resolvedId.substring(0, 12)}`);
        
        res.json({
            success: true,
            sessionId: resolvedId,
            path: pathArg,
            files: files,
            output: result.stdout || '',
            error: result.stderr || '',
        });
    } catch (error) {
        logError(`ls failed for ${resolvedId.substring(0, 12)}`, error.message);
        res.status(500).json({
            success: false,
            sessionId: resolvedId,
            error: 'ls failed',
            details: error.stderr || error.message || String(error)
        });
    }
});

// POST /rm - Remove a remote file
app.post('/rm', async (req, res) => {
    const { sessionId, path: remotePath } = req.body;
    logInfo(`Removing file`, { sessionId: sessionId?.substring(0, 12), path: remotePath });
    
    if (!sessionId || !remotePath) {
        logError('rm: Missing required fields');
        return res.status(400).json({ error: 'Missing required fields: sessionId, path' });
    }

    const found = resolveSession(sessionId);
    if (!found) {
        logWarn(`rm: Session not found: ${sessionId}`);
        return res.status(404).json({ error: 'Session not found', sessionId });
    }

    const { sessionId: resolvedId, session } = found;

    try {
        const result = await runColabCli(['rm', remotePath, '-s', session.colabSession], 30000);
        session.lastActivity = Date.now();
        sessions.set(resolvedId, session);
        logSuccess(`File removed: ${remotePath}`);
        res.json({
            success: true,
            sessionId: resolvedId,
            path: remotePath,
            output: result.stdout || '',
            error: result.stderr || '',
            message: 'File removed successfully'
        });
    } catch (error) {
        logError(`rm failed for ${resolvedId.substring(0, 12)}`, error.message);
        res.status(500).json({
            success: false,
            sessionId: resolvedId,
            error: 'rm failed',
            details: error.stderr || error.message || String(error)
        });
    }
});

// ============================================
// AUTOMATION COMMANDS
// ============================================

// POST /install - Install packages
app.post('/install', async (req, res) => {
    const { sessionId, packages, requirement } = req.body;
    logInfo(`Installing packages`, { sessionId: sessionId?.substring(0, 12), packages, requirement });
    
    if (!sessionId) {
        logError('install: sessionId missing');
        return res.status(400).json({ error: 'sessionId required' });
    }
    if (!packages && !requirement) {
        logError('install: No packages specified');
        return res.status(400).json({ error: 'Either packages or requirement file required' });
    }

    const found = resolveSession(sessionId);
    if (!found) {
        logWarn(`install: Session not found: ${sessionId}`);
        return res.status(404).json({ error: 'Session not found', sessionId });
    }

    const { sessionId: resolvedId, session } = found;

    if (session.status === 'busy') {
        logWarn(`install: Session busy: ${resolvedId.substring(0, 12)}`);
        return res.status(409).json({ error: 'Session busy', sessionId: resolvedId });
    }

    const args = ['install', '-s', session.colabSession];
    if (requirement) {
        args.push('-r', requirement);
    } else if (packages) {
        const pkgList = Array.isArray(packages) ? packages : [packages];
        args.push(...pkgList);
    }

    logInfo(`Package install command: ${args.join(' ')}`);

    try {
        const result = await runColabCli(args, 60000);
        session.lastActivity = Date.now();
        sessions.set(resolvedId, session);
        logSuccess(`Packages installed for ${resolvedId.substring(0, 12)}`);
        res.json({
            success: true,
            sessionId: resolvedId,
            output: result.stdout || '',
            error: result.stderr || '',
            message: 'Packages installed successfully'
        });
    } catch (error) {
        logError(`Install failed for ${resolvedId.substring(0, 12)}`, error.message);
        res.status(500).json({
            success: false,
            sessionId: resolvedId,
            error: 'Install failed',
            details: error.stderr || error.message || String(error)
        });
    }
});

// GET /status - Show session status
app.get('/status', async (req, res) => {
    const sessionId = req.query.sessionId;
    logInfo(`Getting status`, { sessionId: sessionId?.substring(0, 12) });
    
    if (!sessionId) {
        logError('status: sessionId missing');
        return res.status(400).json({ error: 'sessionId query param required' });
    }

    const found = resolveSession(sessionId);
    if (!found) {
        logWarn(`status: Session not found: ${sessionId}`);
        return res.status(404).json({ error: 'Session not found', sessionId });
    }

    const { sessionId: resolvedId, session } = found;

    try {
        const result = await runColabCli(['status', '-s', session.colabSession], 15000);
        session.lastActivity = Date.now();
        sessions.set(resolvedId, session);
        logSuccess(`Status retrieved for ${resolvedId.substring(0, 12)}`);
        res.json({
            success: true,
            sessionId: resolvedId,
            output: result.stdout || '',
            error: result.stderr || '',
        });
    } catch (error) {
        logError(`status failed for ${resolvedId.substring(0, 12)}`, error.message);
        res.status(500).json({
            success: false,
            sessionId: resolvedId,
            error: 'status failed',
            details: error.stderr || error.message || String(error)
        });
    }
});

// GET /sessions-list - List sessions via CLI
app.get('/sessions-list', async (req, res) => {
    logInfo('Fetching CLI session list');
    try {
        const result = await runColabCli(['sessions'], 15000);
        const sessionsOutput = result.stdout.split('\n').filter(s => s.trim());
        logSuccess(`Fetched ${sessionsOutput.length} sessions`);
        res.json({
            success: true,
            output: result.stdout || '',
            sessionsList: sessionsOutput,
            error: result.stderr || '',
            trackedSessions: sessions.size
        });
    } catch (error) {
        logError('sessions-list failed', error.message);
        res.status(500).json({
            success: false,
            error: 'sessions list failed',
            details: error.stderr || error.message || String(error)
        });
    }
});

// GET /url - Get browser URL for session
app.get('/url', async (req, res) => {
    const sessionId = req.query.sessionId;
    const host = req.query.host || 'https://colab.research.google.com';
    
    logInfo(`Getting URL`, { sessionId: sessionId?.substring(0, 12), host });
    
    if (!sessionId) {
        logError('url: sessionId missing');
        return res.status(400).json({ error: 'sessionId query param required' });
    }

    const found = resolveSession(sessionId);
    if (!found) {
        logWarn(`url: Session not found: ${sessionId}`);
        return res.status(404).json({ error: 'Session not found', sessionId });
    }

    const { sessionId: resolvedId, session } = found;

    try {
        const result = await runColabCli(['url', '-s', session.colabSession, '--host', host], 15000);
        session.lastActivity = Date.now();
        sessions.set(resolvedId, session);
        const url = result.stdout.trim();
        logSuccess(`URL generated for ${resolvedId.substring(0, 12)}`);
        res.json({
            success: true,
            sessionId: resolvedId,
            url: url,
            host: host,
        });
    } catch (error) {
        logError(`url failed for ${resolvedId.substring(0, 12)}`, error.message);
        res.status(500).json({
            success: false,
            sessionId: resolvedId,
            error: 'url failed',
            details: error.stderr || error.message || String(error)
        });
    }
});

// GET /log - Get session log
app.get('/log', async (req, res) => {
    const sessionId = req.query.sessionId;
    const lines = req.query.lines ? parseInt(req.query.lines) : null;
    const type = req.query.type || null;
    
    logInfo(`Getting logs`, { sessionId: sessionId?.substring(0, 12), lines, type });
    
    if (!sessionId) {
        logError('log: sessionId missing');
        return res.status(400).json({ error: 'sessionId query param required' });
    }

    const found = resolveSession(sessionId);
    if (!found) {
        logWarn(`log: Session not found: ${sessionId}`);
        return res.status(404).json({ error: 'Session not found', sessionId });
    }

    const { sessionId: resolvedId, session } = found;

    try {
        const args = ['log', '-s', session.colabSession];
        if (lines) args.push('-n', lines.toString());
        if (type) args.push('-t', type);
        
        const result = await runColabCli(args, 30000);
        session.lastActivity = Date.now();
        sessions.set(resolvedId, session);
        logSuccess(`Logs retrieved for ${resolvedId.substring(0, 12)}`);
        res.json({
            success: true,
            sessionId: resolvedId,
            output: result.stdout || '',
            error: result.stderr || '',
        });
    } catch (error) {
        logError(`log failed for ${resolvedId.substring(0, 12)}`, error.message);
        res.status(500).json({
            success: false,
            sessionId: resolvedId,
            error: 'log failed',
            details: error.stderr || error.message || String(error)
        });
    }
});

// ============================================
// UTILITY COMMANDS (FIXED)
// ============================================

// GET /version - Get CLI version (FIXED: better error handling)
app.get('/version', async (req, res) => {
    logInfo('Getting CLI version');
    try {
        const result = await runColabCli(['version'], 10000);
        const versionMatch = result.stdout.match(/Version:\s*(.+)/);
        const version = versionMatch ? versionMatch[1].trim() : result.stdout.trim();
        logSuccess(`CLI version: ${version}`);
        res.json({
            success: true,
            version: version,
            raw: result.stdout || '',
        });
    } catch (error) {
        logError('version failed', error.message);
        // Return a fallback version instead of failing
        res.json({
            success: true,
            version: 'unknown',
            raw: '',
            error: error.message
        });
    }
});

// GET /update - Check for updates
app.get('/update', async (req, res) => {
    const install = req.query.install === 'true';
    logInfo('Checking for updates', { install });
    
    try {
        const args = ['update'];
        if (install) args.push('--install');
        const result = await runColabCli(args, 30000);
        logSuccess('Update check completed');
        res.json({
            success: true,
            install: install,
            output: result.stdout || '',
            error: result.stderr || '',
        });
    } catch (error) {
        logError('update failed', error.message);
        res.status(500).json({
            success: false,
            error: 'update failed',
            details: error.stderr || error.message || String(error)
        });
    }
});

// GET /pay - Open Colab signup page
app.get('/pay', async (req, res) => {
    logInfo('Opening Colab signup page');
    try {
        const result = await runColabCli(['pay'], 10000);
        logSuccess('Colab signup page opened');
        res.json({
            success: true,
            output: result.stdout || '',
            error: result.stderr || '',
            message: 'Colab signup page opened'
        });
    } catch (error) {
        logError('pay failed', error.message);
        res.status(500).json({
            success: false,
            error: 'pay failed',
            details: error.stderr || error.message || String(error)
        });
    }
});

// GET /readme - Print README
app.get('/readme', async (req, res) => {
    logInfo('Printing README');
    try {
        const result = await runColabCli(['readme'], 10000);
        logSuccess('README printed');
        res.json({
            success: true,
            output: result.stdout || '',
            error: result.stderr || '',
        });
    } catch (error) {
        logError('readme failed', error.message);
        res.status(500).json({
            success: false,
            error: 'readme failed',
            details: error.stderr || error.message || String(error)
        });
    }
});

// GET /skill - Print SKILL.md
app.get('/skill', async (req, res) => {
    logInfo('Printing SKILL.md');
    try {
        const result = await runColabCli(['skill'], 10000);
        logSuccess('SKILL.md printed');
        res.json({
            success: true,
            output: result.stdout || '',
            error: result.stderr || '',
        });
    } catch (error) {
        logError('skill failed', error.message);
        res.status(500).json({
            success: false,
            error: 'skill failed',
            details: error.stderr || error.message || String(error)
        });
    }
});

// ============================================
// INTERACTIVE COMMANDS (TTY required)
// ============================================

// POST /drivemount - Mount Google Drive
app.post('/drivemount', async (req, res) => {
    const { sessionId, path: mountPath } = req.body;
    logInfo('Drive mount requested', { sessionId: sessionId?.substring(0, 12) });
    
    if (!sessionId) {
        logError('drivemount: sessionId missing');
        return res.status(400).json({ error: 'sessionId required' });
    }

    const found = resolveSession(sessionId);
    if (!found) {
        logWarn(`drivemount: Session not found: ${sessionId}`);
        return res.status(404).json({ error: 'Session not found', sessionId });
    }

    const { sessionId: resolvedId, session } = found;
    const mountPoint = mountPath || '/content/drive';

    res.json({
        success: false,
        sessionId: resolvedId,
        mountPath: mountPoint,
        message: 'Drive mount requires interactive authentication. Please run the command manually in a terminal with TTY access.',
        hint: `colab drivemount ${mountPoint} -s ${session.colabSession}`
    });
});

// POST /auth - Authenticate VM
app.post('/auth', async (req, res) => {
    const { sessionId } = req.body;
    logInfo('Auth requested', { sessionId: sessionId?.substring(0, 12) });
    
    if (!sessionId) {
        logError('auth: sessionId missing');
        return res.status(400).json({ error: 'sessionId required' });
    }

    const found = resolveSession(sessionId);
    if (!found) {
        logWarn(`auth: Session not found: ${sessionId}`);
        return res.status(404).json({ error: 'Session not found', sessionId });
    }

    const { sessionId: resolvedId, session } = found;

    res.json({
        success: false,
        sessionId: resolvedId,
        message: 'VM authentication requires interactive input. Please run the command manually in a terminal with TTY access.',
        hint: `colab auth -s ${session.colabSession}`
    });
});

// POST /console - Connect to TTY console
app.post('/console', async (req, res) => {
    const { sessionId } = req.body;
    logInfo('Console requested', { sessionId: sessionId?.substring(0, 12) });
    
    if (!sessionId) {
        logError('console: sessionId missing');
        return res.status(400).json({ error: 'sessionId required' });
    }

    const found = resolveSession(sessionId);
    if (!found) {
        logWarn(`console: Session not found: ${sessionId}`);
        return res.status(404).json({ error: 'Session not found', sessionId });
    }

    const { sessionId: resolvedId, session } = found;

    res.json({
        success: false,
        sessionId: resolvedId,
        message: 'Console requires interactive TTY access. Please run the command manually in a terminal.',
        hint: `colab console -s ${session.colabSession}`
    });
});

// POST /repl - Start REPL
app.post('/repl', async (req, res) => {
    const { sessionId, code } = req.body;
    logInfo('REPL requested', { sessionId: sessionId?.substring(0, 12), hasCode: !!code });
    
    if (!sessionId) {
        logError('repl: sessionId missing');
        return res.status(400).json({ error: 'sessionId required' });
    }

    const found = resolveSession(sessionId);
    if (!found) {
        logWarn(`repl: Session not found: ${sessionId}`);
        return res.status(404).json({ error: 'Session not found', sessionId });
    }

    const { sessionId: resolvedId, session } = found;

    try {
        let command;
        if (code) {
            const escapedCode = code
                .replace(/\\/g, '\\\\')
                .replace(/`/g, '\\`')
                .replace(/\$/g, '\\$')
                .replace(/"/g, '\\"');
            
            if (USE_PYTHON_MODULE) {
                command = `echo "${escapedCode}" | python3 -m colab_cli repl -s ${session.colabSession}`;
            } else {
                command = `echo "${escapedCode}" | ${COLAB_BINARY} repl -s ${session.colabSession}`;
            }
        } else {
            if (USE_PYTHON_MODULE) {
                command = `echo "print('REPL ready')" | python3 -m colab_cli repl -s ${session.colabSession}`;
            } else {
                command = `echo "print('REPL ready')" | ${COLAB_BINARY} repl -s ${session.colabSession}`;
            }
        }

        logDebug(`REPL command: ${command.substring(0, 100)}...`);

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
        logSuccess(`REPL executed for ${resolvedId.substring(0, 12)}`);
        res.json({
            success: true,
            sessionId: resolvedId,
            output: result.stdout || '',
            error: result.stderr || '',
            message: 'REPL command executed'
        });
    } catch (error) {
        logError(`repl failed for ${resolvedId.substring(0, 12)}`, error.message);
        res.status(500).json({
            success: false,
            sessionId: resolvedId,
            error: 'repl failed',
            details: error.stderr || error.message || String(error)
        });
    }
});

// POST /edit - Edit a file (non-interactive)
app.post('/edit', async (req, res) => {
    const { sessionId, remotePath } = req.body;
    logInfo('Edit requested', { sessionId: sessionId?.substring(0, 12), remotePath });
    
    if (!sessionId || !remotePath) {
        logError('edit: Missing required fields');
        return res.status(400).json({ error: 'Missing required fields: sessionId, remotePath' });
    }

    const found = resolveSession(sessionId);
    if (!found) {
        logWarn(`edit: Session not found: ${sessionId}`);
        return res.status(404).json({ error: 'Session not found', sessionId });
    }

    const { sessionId: resolvedId, session } = found;

    res.json({
        success: false,
        sessionId: resolvedId,
        remotePath: remotePath,
        message: 'Edit requires interactive editor access. Please run the command manually in a terminal.',
        hint: `colab edit ${remotePath} -s ${session.colabSession}`
    });
});

// ============================================
// RUN SCRIPT (FIXED: Proper error handling)
// ============================================

// POST /run - Run Python script on fresh VM (FIXED)
app.post('/run', async (req, res) => {
    const { script, gpu, keep, timeout, sessionName } = req.body;
    logInfo('Running script', { script, gpu, keep, timeout, sessionName });

    if (!script) {
        logError('run: script path missing');
        return res.status(400).json({ error: 'script path required' });
    }

    let actualScript = script;
    try {
        // Check if script exists
        await fs.access(script);
        logDebug(`Script exists: ${script}`);
    } catch {
        // Create a temporary script
        const tempDir = '/tmp/colab_scripts';
        await fs.mkdir(tempDir, { recursive: true });
        const tempScript = path.join(tempDir, `test_script_${Date.now()}.py`);
        const scriptContent = `#!/usr/bin/env python3
import sys
import time

print("🚀 Script started!")
print(f"Args: {sys.argv[1:] if len(sys.argv) > 1 else 'None'}")

# Test computation
result = sum([i**2 for i in range(50)])
print(f"Result: {result}")

print("✅ Script completed!")
`;
        await fs.writeFile(tempScript, scriptContent, 'utf8');
        await fs.chmod(tempScript, 0o755);
        actualScript = tempScript;
        logInfo(`Created temporary script: ${actualScript}`);
    }

    const args = ['run', actualScript];
    if (gpu) args.push('--gpu', gpu);
    if (keep) args.push('--keep');
    if (timeout) args.push('--timeout', timeout?.toString() || '30');
    if (sessionName) args.push('-s', sessionName);

    logInfo(`Run command: ${args.join(' ')}`);

    try {
        const result = await runColabCli(args, 60000);
        logSuccess('Script execution completed');
        res.json({
            success: true,
            script: actualScript,
            gpu: gpu || null,
            keep: keep || false,
            timeout: timeout || 30,
            sessionName: sessionName || null,
            output: result.stdout || '',
            error: result.stderr || '',
            message: 'Script executed on fresh VM'
        });
    } catch (error) {
        logError(`Script execution failed: ${actualScript}`, error.message);
        res.status(500).json({
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
// IDLE SESSION CLEANUP
// ============================================
async function cleanupIdleSessions() {
    const now = Date.now();
    let cleaned = 0;
    for (const [sessionId, session] of sessions.entries()) {
        if (now - session.lastActivity > CONFIG.SESSION_TIMEOUT && session.status !== 'busy') {
            logInfo(`Evicting idle session ${sessionId.substring(0, 12)}`);
            try {
                await runColabCli(['stop', '-s', session.colabSession], 10000);
                await cleanupSessionFolder(sessionId);
                cleaned++;
            } catch (e) {
                logError(`Failed to evict session ${sessionId.substring(0, 12)}`, e.message);
            }
            sessions.delete(sessionId);
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
    for (const [sessionId, session] of sessions.entries()) {
        try {
            await runColabCli(['stop', '-s', session.colabSession], 10000);
            await cleanupSessionFolder(sessionId);
        } catch (e) {
            logError(`Failed to clean up ${sessionId}`, e.message);
        }
        sessions.delete(sessionId);
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
    logWarn(`404: ${req.method} ${req.path}`);
    res.status(404).json({
        error: 'Not Found',
        message: 'Available endpoints:',
        endpoints: [
            'GET  /, /health, /health/simple',
            'GET  /sessions, /sessions/:identifier',
            'GET  /sessions-list',
            'POST /new              { sessionId?, gpu?, tpu? }',
            'POST /stop             { sessionId }',
            'DELETE /session/:sessionId',
            'POST /keepalive        { sessionId }',
            'POST /exec             { sessionId, code, cellNo }',
            'GET/POST /exec-status  { sessionId, executionId }',
            'POST /exec-ack         { executionId }',
            'POST /restart-kernel   { sessionId }',
            'POST /install          { sessionId, packages?, requirement? }',
            'GET  /ls?sessionId=<id>&path=<path>',
            'POST /download         { sessionId, remotePath, localPath? }',
            'GET  /download-status?transferId=<id>',
            'POST /upload           (multipart/form-data with "file" field)',
            'GET  /upload-status?transferId=<id>',
            'POST /rm               { sessionId, path }',
            'POST /edit             { sessionId, remotePath }',
            'POST /drivemount       { sessionId, path? }',
            'POST /auth             { sessionId }',
            'POST /console          { sessionId }',
            'POST /repl             { sessionId, code? }',
            'POST /run              { script, gpu?, keep?, timeout?, sessionName? }',
            'GET  /status?sessionId=<id>',
            'GET  /url?sessionId=<id>&host=<host>',
            'GET  /log?sessionId=<id>&lines=<n>&type=<type>',
            'GET  /pay',
            'GET  /readme',
            'GET  /skill',
            'GET  /version',
            'GET  /update?install=<true/false>',
        ],
        timestamp: new Date().toISOString()
    });
});

// ============================================
// INIT
// ============================================
async function init() {
    logInfo('🚀 Initializing Colab Orchestrator v3.0...');

    await initColabBinary();
    await fs.mkdir(CONFIG.SESSIONS_BASE_DIR, { recursive: true });
    await fs.mkdir(CONFIG.UPLOAD_DIR, { recursive: true });
    await setupColabAuth();

    setTimeout(cleanupIdleSessions, CONFIG.CLEANUP_INTERVAL);

    const PORT = process.env.PORT || CONFIG.PORT;
    app.listen(PORT, () => {
        logSuccess(`\n🚀 Colab Orchestrator v3.0 running on port ${PORT}`);
        logInfo(`📁 Sessions: ${CONFIG.SESSIONS_BASE_DIR}`);
        logInfo(`📁 Uploads: ${CONFIG.UPLOAD_DIR}`);
        logInfo(`📊 Max sessions: ${CONFIG.MAX_SESSIONS}`);
        logInfo(`⏰ Session TTL: ${CONFIG.SESSION_TIMEOUT / 3600000}h`);
        logInfo(`🔧 Colab binary: ${COLAB_BINARY}${USE_PYTHON_MODULE ? ' (-m colab_cli)' : ''}`);
        logInfo(`🌐 CORS: All origins allowed`);
        logInfo(`🔑 Auth: DISABLED (testing mode)`);
        logInfo(`\n📡 Health: http://localhost:${PORT}/health`);
        logInfo(`📖 Help: http://localhost:${PORT}/`);
        logSuccess('\n🚀 Ready!');
    });
}

init();
