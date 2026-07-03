// ============================================
// COLAB ORCHESTRATOR - COMPLETE FIXED VERSION
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
// HARDCODED CONFIGURATION
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
// CORS
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
// MULTER
// ============================================
const storage = multer.diskStorage({
    destination: async (req, file, cb) => {
        const sessionId = req.body.sessionId || req.query.sessionId;
        if (!sessionId) {
            return cb(new Error('sessionId required'));
        }
        const uploadDir = path.join(CONFIG.UPLOAD_DIR, sessionId);
        try {
            await fs.mkdir(uploadDir, { recursive: true });
            cb(null, uploadDir);
        } catch (error) {
            cb(error);
        }
    },
    filename: (req, file, cb) => {
        const timestamp = Date.now();
        const uniqueName = `${timestamp}_${file.originalname}`;
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

async function findColabBinary() {
    const { execSync } = require('child_process');
    logInfo('🔍 Searching for colab binary...');

    try {
        const whichPath = execSync('which colab 2>/dev/null || echo ""', { encoding: 'utf8', timeout: 5000 }).trim();
        if (whichPath && whichPath !== '') {
            logSuccess(`Found colab via which: ${whichPath}`);
            return whichPath;
        }
    } catch (e) {}

    try {
        const pipPath = execSync('pip3 show google-colab-cli 2>/dev/null | grep Location | cut -d" " -f2', { encoding: 'utf8', timeout: 5000 }).trim();
        if (pipPath) {
            const possibleBinary = `${pipPath}/colab_cli/__main__.py`;
            if (require('fs').existsSync(possibleBinary)) {
                logSuccess(`Found colab via pip: ${possibleBinary}`);
                return 'python3';
            }
        }
    } catch (e) {}

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
// COLAB CLI RUNNER WITH TOKEN REFRESH
// ============================================
async function refreshColabToken() {
    try {
        const tokenData = JSON.parse(CONFIG.COLAB_AUTH_TOKEN);
        const tokenPath = path.join(os.homedir(), '.config/colab-cli', 'token.json');
        
        // Check if token is expired or about to expire
        let shouldRefresh = false;
        try {
            const existing = await fs.readFile(tokenPath, 'utf8');
            const parsed = JSON.parse(existing);
            if (parsed.expiry) {
                const expiry = new Date(parsed.expiry);
                const now = new Date();
                const fiveMinutes = 5 * 60 * 1000;
                if (now >= new Date(expiry.getTime() - fiveMinutes)) {
                    shouldRefresh = true;
                    logInfo('Token is near expiry, refreshing...');
                }
            }
        } catch {
            shouldRefresh = true;
        }

        if (!shouldRefresh && tokenData.access_token) {
            logDebug('Token is still valid, skipping refresh');
            return;
        }

        // Use refresh_token to get new access token
        if (tokenData.refresh_token) {
            logInfo('Refreshing token using refresh_token...');
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
                }
                logSuccess('Token refreshed successfully');
                
                // Write updated token
                await fs.writeFile(tokenPath, JSON.stringify(tokenData, null, 2));
                logInfo('Updated token file with new access token');
                return;
            } else {
                logError('Token refresh failed:', data);
            }
        }
    } catch (error) {
        logError('Token refresh error:', error.message);
    }
}

async function runColabCli(args, timeout = 30000) {
    return new Promise((resolve, reject) => {
        // Refresh token before running any command
        refreshColabToken().catch(err => logDebug('Token refresh during command:', err.message));
        
        let command;
        if (USE_PYTHON_MODULE) {
            const escapedArgs = args.map(a => `"${a.replace(/"/g, '\\"')}"`).join(' ');
            command = `${COLAB_BINARY} -m colab_cli ${escapedArgs}`;
        } else {
            const escapedArgs = args.map(a => `"${a.replace(/"/g, '\\"')}"`).join(' ');
            command = `${COLAB_BINARY} ${escapedArgs}`;
        }
        
        logDebug(`🛠  Running: ${command.substring(0, 150)}...`, { timeout });
        
        exec(command, { timeout, shell: '/bin/bash', maxBuffer: 50 * 1024 * 1024 }, (error, stdout, stderr) => {
            if (stdout && stdout.length > 0) {
                logDebug(`   STDOUT: ${stdout.substring(0, 200)}${stdout.length > 200 ? '...' : ''}`);
            }
            if (stderr && stderr.length > 0) {
                logDebug(`   STDERR: ${stderr.substring(0, 200)}${stderr.length > 200 ? '...' : ''}`);
            }
            
            if (error && error.code !== 0) {
                // Check if it's a TooManyAssignmentsError
                const errorMsg = stderr || error.message || '';
                if (errorMsg.includes('TooManyAssignmentsError') || errorMsg.includes('Precondition Failed')) {
                    logWarn('Too many assignments - cleaning up orphaned sessions');
                    // Try to list and clean up
                    exec(`${COLAB_BINARY} sessions`, { timeout: 10000 }, (listErr, listOut) => {
                        if (!listErr && listOut) {
                            const sessions = listOut.split('\n').filter(s => s.trim() && s.includes('|'));
                            logInfo(`Found ${sessions.length} sessions to clean up`);
                            // Try to stop each one (they're orphaned anyway)
                            for (const sess of sessions) {
                                const match = sess.match(/\[(.*?)\]/);
                                if (match) {
                                    const name = match[1];
                                    if (name !== '?' && !name.includes('colab_')) {
                                        exec(`${COLAB_BINARY} stop -s "${name}"`, { timeout: 5000 }, () => {});
                                    }
                                }
                            }
                        }
                    });
                }
                
                logError(`Command failed with code ${error.code}`, { 
                    command: command.substring(0, 100),
                    error: error.message,
                    stderr: stderr ? stderr.substring(0, 500) : ''
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
        
        // Write token
        await fs.writeFile(path.join(configDir, 'token.json'), JSON.stringify(tokenData, null, 2));
        
        // Also write sessions.json
        await fs.writeFile(path.join(configDir, 'sessions.json'), JSON.stringify({}));

        // Verify
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

// ============================================
// STATE MANAGEMENT
// ============================================
const sessions = new Map();
const completedExecutions = new Map();
const executionQueue = new Set();
const executionProcesses = new Map();
const fileTransfers = new Map();

// ============================================
// SESSION FOLDER MANAGEMENT
// ============================================
async function createSessionFolder(sessionId) {
    const folder = path.join(CONFIG.SESSIONS_BASE_DIR, sessionId);
    await fs.mkdir(folder, { recursive: true });
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
// CLEANUP ORPHANED SESSIONS
// ============================================
async function cleanupOrphanedSessions() {
    try {
        const result = await runColabCli(['sessions'], 10000);
        const lines = result.stdout.split('\n').filter(s => s.trim());
        const orphaned = lines.filter(s => s.includes('[?]'));
        
        for (const orphan of orphaned) {
            // Extract endpoint from the line
            const match = orphan.match(/\?\]\s+([^\s]+)/);
            if (match) {
                const endpoint = match[1];
                logWarn(`Found orphaned session: ${endpoint}`);
                try {
                    await runColabCli(['stop', '-s', endpoint], 5000);
                    logSuccess(`Cleaned up orphaned session: ${endpoint}`);
                } catch (e) {
                    logDebug(`Could not stop orphaned session: ${endpoint}`, e.message);
                }
            }
        }
    } catch (error) {
        logDebug('Orphan cleanup error:', error.message);
    }
}

// Run orphan cleanup on startup and periodically
setTimeout(() => {
    cleanupOrphanedSessions();
}, 5000);

setInterval(() => {
    cleanupOrphanedSessions();
}, 5 * 60 * 1000); // Every 5 minutes

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
    if (!session) throw new Error('Session not found');

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

        const proc = exec(command, {
            timeout: CONFIG.EXECUTION_TIMEOUT * 1000,
            maxBuffer: 50 * 1024 * 1024,
            shell: '/bin/bash'
        });

        executionProcesses.set(executionId, proc);

        let stdout = '';
        let stderr = '';

        proc.stdout.on('data', (data) => {
            stdout += data.toString();
            const s = sessions.get(sessionId);
            if (s?.currentExecution?.executionId === executionId) {
                s.currentExecution.partialOutput = stdout;
                s.currentExecution.partialError = stderr;
                sessions.set(sessionId, s);
            }
        });

        proc.stderr.on('data', (data) => {
            stderr += data.toString();
            const s = sessions.get(sessionId);
            if (s?.currentExecution?.executionId === executionId) {
                s.currentExecution.partialOutput = stdout;
                s.currentExecution.partialError = stderr;
                sessions.set(sessionId, s);
            }
        });

        const result = await new Promise((resolve, reject) => {
            proc.on('close', (code) => {
                if (code !== 0) reject({ error: new Error(`Process exited with code ${code}`), stdout, stderr });
                else resolve({ stdout, stderr });
            });
            proc.on('error', (err) => reject({ error: err, stdout, stderr }));
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
    if (executionQueue.has(execKey)) return;
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
    res.json({
        name: "Colab Orchestrator API",
        version: "3.1.0",
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
            exec: { method: "POST", path: "/exec", body: { sessionId: "required", code: "required", cellNo: "required" } },
            execStatus: { method: "GET/POST", path: "/exec-status", params: { sessionId: "required", executionId: "required" } },
            execAck: { method: "POST", path: "/exec-ack", body: { executionId: "required" } },
            install: { method: "POST", path: "/install", body: { sessionId: "required", packages: "optional" } },
            ls: { method: "GET", path: "/ls", params: { sessionId: "required" } },
            rm: { method: "POST", path: "/rm", body: { sessionId: "required", path: "required" } },
            upload: { method: "POST", path: "/upload", body: { sessionId: "required", file: "required" } },
            uploadStatus: { method: "GET", path: "/upload-status", params: { transferId: "required" } },
            download: { method: "POST", path: "/download", body: { sessionId: "required", remotePath: "required" } },
            downloadStatus: { method: "GET", path: "/download-status", params: { transferId: "required" } },
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
        },
        timestamp: new Date().toISOString()
    });
});

// ============================================
// SESSION ENDPOINTS
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

// POST /new - Create session with cleanup
app.post('/new', async (req, res) => {
    logInfo('Creating new session', { body: req.body });
    
    // First, clean up any orphaned sessions
    await cleanupOrphanedSessions();

    // Evict oldest session if at max
    if (sessions.size >= CONFIG.MAX_SESSIONS) {
        logWarn(`Max sessions reached (${sessions.size}), evicting oldest`);
        let oldestId = null;
        let oldestTime = Infinity;
        for (const [id, s] of sessions.entries()) {
            if (s.lastActivity < oldestTime) { 
                oldestTime = s.lastActivity; 
                oldestId = id; 
            }
        }
        if (oldestId) {
            const s = sessions.get(oldestId);
            try { 
                await runColabCli(['stop', '-s', s.colabSession], 10000);
                logInfo(`Stopped evicted session: ${oldestId.substring(0, 12)}`);
            } catch (e) {
                logWarn(`Failed to stop evicted session`, e.message);
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

        // Try to clean up orphaned sessions and retry once
        await cleanupOrphanedSessions();
        
        // Return error but include the sessionId for potential retry
        return res.status(500).json({
            success: false,
            sessionId,
            error: 'Failed to create session',
            details: error.stderr || error.message || String(error),
            suggestion: 'Try cleaning up orphaned sessions with: colab sessions && colab stop -s <session_name>'
        });
    }
});

// ============================================
// OTHER SESSION ENDPOINTS
// ============================================

app.post('/stop', async (req, res) => {
    const { sessionId } = req.body;
    if (!sessionId) {
        return res.status(400).json({ error: 'sessionId required' });
    }

    const found = resolveSession(sessionId);
    if (!found) {
        // Try to find it via CLI
        try {
            const result = await runColabCli(['sessions'], 5000);
            const lines = result.stdout.split('\n').filter(s => s.trim());
            for (const line of lines) {
                const match = line.match(/\[(.*?)\]/);
                if (match && match[1] === sessionId) {
                    // Found it, stop it
                    await runColabCli(['stop', '-s', sessionId], 10000);
                    logSuccess(`Stopped session ${sessionId} via CLI`);
                    return res.json({ success: true, sessionId, message: 'Session stopped' });
                }
            }
        } catch (e) {}
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

app.delete('/session/:sessionId', async (req, res) => {
    const { sessionId } = req.params;
    const found = resolveSession(sessionId);
    if (!found) {
        return res.status(404).json({ error: 'Session not found', sessionId });
    }

    const { sessionId: resolvedId, session } = found;
    logInfo(`Deleting session ${resolvedId.substring(0, 12)}`);

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

app.post('/keepalive', async (req, res) => {
    const { sessionId } = req.body;
    if (!sessionId) {
        return res.status(400).json({ error: 'sessionId required' });
    }

    const found = resolveSession(sessionId);
    if (!found) {
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
// EXECUTION ENDPOINTS
// ============================================

app.post('/exec', async (req, res) => {
    const { sessionId, code, cellNo } = req.body;
    
    if (!sessionId || !code || cellNo === undefined) {
        return res.status(400).json({ error: 'Missing required fields: sessionId, code, cellNo' });
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

app.all('/exec-status', async (req, res) => {
    const sessionId = req.body?.sessionId || req.query?.sessionId;
    const executionId = req.body?.executionId || req.query?.executionId;
    
    if (!sessionId || !executionId) {
        return res.status(400).json({ error: 'Missing required fields: sessionId, executionId' });
    }

    if (completedExecutions.has(executionId)) {
        const record = completedExecutions.get(executionId);
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
        return res.status(404).json({ error: 'Session not found', sessionId });
    }

    const { session, sessionId: resolvedId } = found;
    const execution = session.currentExecution;

    if (execution?.executionId === executionId) {
        return res.json({
            status: 'running',
            sessionId: resolvedId,
            executionId,
            elapsed: Date.now() - execution.startedAt,
            partialOutput: execution.partialOutput || '',
            partialError: execution.partialError || ''
        });
    }

    res.json({ status: 'not_found', sessionId, executionId, message: 'Execution not found or already completed' });
});

app.post('/exec-ack', async (req, res) => {
    const { executionId } = req.body;
    if (executionId && completedExecutions.has(executionId)) {
        completedExecutions.delete(executionId);
        logSuccess(`Execution ${executionId.substring(0, 12)} acknowledged`);
        return res.json({ success: true, executionId, message: 'Acknowledged' });
    }
    res.json({ success: false, executionId, message: 'Execution not found' });
});

app.post('/restart-kernel', async (req, res) => {
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
        await runColabCli(['restart-kernel', '-s', session.colabSession], 30000);
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

app.post('/download', async (req, res) => {
    const { sessionId, remotePath, localPath } = req.body;
    
    if (!sessionId || !remotePath) {
        return res.status(400).json({ error: 'Missing required fields: sessionId, remotePath' });
    }

    const found = resolveSession(sessionId);
    if (!found) {
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

    setImmediate(async () => {
        try {
            const transfer = fileTransfers.get(transferId);
            if (!transfer) return;
            
            transfer.status = 'running';
            transfer.startedAt = Date.now();
            fileTransfers.set(transferId, transfer);

            await runColabCli(['download', remotePath, destPath, '-s', session.colabSession], 60000);
            
            transfer.status = 'completed';
            transfer.completedAt = Date.now();
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
        pollInterval: CONFIG.POLL_INTERVAL
    });
});

app.get('/download-status', async (req, res) => {
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
        remotePath: transfer.remotePath,
        localPath: transfer.localPath,
        status: transfer.status,
        progress: transfer.progress || 0,
        createdAt: new Date(transfer.createdAt).toISOString(),
        startedAt: transfer.startedAt ? new Date(transfer.startedAt).toISOString() : null,
        completedAt: transfer.completedAt ? new Date(transfer.completedAt).toISOString() : null,
        output: transfer.output || '',
        error: transfer.error || null
    });
});

app.post('/upload', (req, res) => {
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

                    await runColabCli(['upload', localFilePath, remoteFilePath, '-s', session.colabSession], 60000);
                    
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
                status: 'pending'
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
        const result = await runColabCli(['ls', pathArg, '-s', session.colabSession], 15000);
        session.lastActivity = Date.now();
        sessions.set(resolvedId, session);
        
        const files = result.stdout.split('\n').filter(f => f.trim());
        
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

app.post('/rm', async (req, res) => {
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
        await runColabCli(['rm', remotePath, '-s', session.colabSession], 30000);
        session.lastActivity = Date.now();
        sessions.set(resolvedId, session);
        res.json({
            success: true,
            sessionId: resolvedId,
            path: remotePath,
            message: 'File removed successfully'
        });
    } catch (error) {
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

app.post('/install', async (req, res) => {
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
        const result = await runColabCli(args, 60000);
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
        const result = await runColabCli(['status', '-s', session.colabSession], 15000);
        session.lastActivity = Date.now();
        sessions.set(resolvedId, session);
        res.json({
            success: true,
            sessionId: resolvedId,
            output: result.stdout || '',
            error: result.stderr || '',
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
        const result = await runColabCli(['sessions'], 15000);
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
        const result = await runColabCli(['url', '-s', session.colabSession, '--host', host], 15000);
        session.lastActivity = Date.now();
        sessions.set(resolvedId, session);
        res.json({
            success: true,
            sessionId: resolvedId,
            url: result.stdout.trim(),
            host: host,
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
        
        const result = await runColabCli(args, 30000);
        session.lastActivity = Date.now();
        sessions.set(resolvedId, session);
        res.json({
            success: true,
            sessionId: resolvedId,
            output: result.stdout || '',
            error: result.stderr || '',
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
        const result = await runColabCli(['version'], 10000);
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
        const result = await runColabCli(args, 30000);
        res.json({
            success: true,
            install: install,
            output: result.stdout || '',
            error: result.stderr || '',
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
        const result = await runColabCli(['pay'], 10000);
        res.json({
            success: true,
            output: result.stdout || '',
            error: result.stderr || '',
            message: 'Colab signup page opened'
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
        const result = await runColabCli(['readme'], 10000);
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
        const result = await runColabCli(['skill'], 10000);
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
// INTERACTIVE COMMANDS (TTY required)
// ============================================

app.post('/drivemount', async (req, res) => {
    const { sessionId, path: mountPath } = req.body;
    if (!sessionId) {
        return res.status(400).json({ error: 'sessionId required' });
    }

    const found = resolveSession(sessionId);
    if (!found) {
        return res.status(404).json({ error: 'Session not found', sessionId });
    }

    const { sessionId: resolvedId, session } = found;
    const mountPoint = mountPath || '/content/drive';

    res.json({
        success: false,
        sessionId: resolvedId,
        mountPath: mountPoint,
        message: 'Drive mount requires interactive authentication. Please run manually:',
        hint: `colab drivemount ${mountPoint} -s ${session.colabSession}`
    });
});

app.post('/auth', async (req, res) => {
    const { sessionId } = req.body;
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
        message: 'VM authentication requires interactive input. Please run manually:',
        hint: `colab auth -s ${session.colabSession}`
    });
});

app.post('/console', async (req, res) => {
    const { sessionId } = req.body;
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
        message: 'Console requires interactive TTY access. Please run manually:',
        hint: `colab console -s ${session.colabSession}`
    });
});

app.post('/repl', async (req, res) => {
    const { sessionId, code } = req.body;
    if (!sessionId) {
        return res.status(400).json({ error: 'sessionId required' });
    }

    const found = resolveSession(sessionId);
    if (!found) {
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
});

app.post('/edit', async (req, res) => {
    const { sessionId, remotePath } = req.body;
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
        message: 'Edit requires interactive editor access. Please run manually:',
        hint: `colab edit ${remotePath} -s ${session.colabSession}`
    });
});

// POST /run - Run script
app.post('/run', async (req, res) => {
    const { script, gpu, keep, timeout, sessionName } = req.body;
    logInfo('Running script', { script, gpu });

    if (!script) {
        return res.status(400).json({ error: 'script path required' });
    }

    let actualScript = script;
    try {
        await fs.access(script);
    } catch {
        const tempDir = '/tmp/colab_scripts';
        await fs.mkdir(tempDir, { recursive: true });
        const tempScript = path.join(tempDir, `test_script_${Date.now()}.py`);
        const scriptContent = `#!/usr/bin/env python3
import sys
import time

print("🚀 Script started!")
print(f"Args: {sys.argv[1:] if len(sys.argv) > 1 else 'None'}")
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

    try {
        const result = await runColabCli(args, 60000);
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
        res.status(500).json({
            success: false,
            script: actualScript,
            error: 'Script execution failed',
            details: error.stderr || error.message || String(error)
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
            try {
                await runColabCli(['stop', '-s', session.colabSession], 10000);
                await cleanupSessionFolder(sessionId);
                cleaned++;
            } catch (e) {}
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
        } catch (e) {}
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
    res.status(404).json({
        error: 'Not Found',
        message: 'Available endpoints: /health, /health/simple, /sessions, /sessions/:id, /new, /stop, /session/:id, /keepalive, /exec, /exec-status, /exec-ack, /restart-kernel, /install, /ls, /rm, /upload, /upload-status, /download, /download-status, /run, /status, /sessions-list, /url, /log, /pay, /version, /update, /readme, /skill'
    });
});

// ============================================
// INIT
// ============================================
async function init() {
    logInfo('🚀 Initializing Colab Orchestrator v3.1...');

    await initColabBinary();
    await fs.mkdir(CONFIG.SESSIONS_BASE_DIR, { recursive: true });
    await fs.mkdir(CONFIG.UPLOAD_DIR, { recursive: true });
    await setupColabAuth();
    
    // Initial orphan cleanup
    await cleanupOrphanedSessions();

    setTimeout(cleanupIdleSessions, CONFIG.CLEANUP_INTERVAL);

    const PORT = process.env.PORT || CONFIG.PORT;
    app.listen(PORT, () => {
        logSuccess(`🚀 Colab Orchestrator v3.1 running on port ${PORT}`);
        logInfo(`📁 Sessions: ${CONFIG.SESSIONS_BASE_DIR}`);
        logInfo(`📊 Max sessions: ${CONFIG.MAX_SESSIONS}`);
        logInfo(`🔧 Colab binary: ${COLAB_BINARY}${USE_PYTHON_MODULE ? ' (-m colab_cli)' : ''}`);
        logInfo(`\n📡 Health: http://localhost:${PORT}/health`);
        logInfo(`📖 Help: http://localhost:${PORT}/`);
        logSuccess('\n🚀 Ready!');
    });
}

init();
