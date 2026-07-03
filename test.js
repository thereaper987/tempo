// ============================================
// COLAB ORCHESTRATOR - ULTIMATE TEST SUITE v5.1
// FIXED: Proper session cleanup before run tests
// All endpoints, all flows, all edge cases
// ============================================

const API_BASE = 'https://tempo-agxk.onrender.com';
let TRACKED_SESSIONS = [];
let ACTIVE_EXECUTION_ID = null;
let ACTIVE_TRANSFER_ID = null;
let TEST_FILE_CONTENT = null;

const TEST_RESULTS = {
    total: 0,
    passed: 0,
    failed: 0,
    skipped: 0,
    details: [],
    startTime: null,
    endTime: null
};

// ============================================
// ENHANCED LOGGING
// ============================================

const log = (title, data = null, type = 'info') => {
    const symbols = {
        info: 'ℹ️',
        success: '✅',
        error: '❌',
        warn: '⚠️',
        debug: '🔍',
        test: '🧪',
        pass: '✅',
        fail: '❌',
        section: '📌',
        edge: '⚡',
        performance: '⚡',
        request: '📤',
        response: '📥',
        url: '🔗'
    };
    console.log(`\n${'='.repeat(70)}`);
    console.log(`${symbols[type] || '📌'} [${new Date().toLocaleTimeString()}] ${title}`);
    console.log('─'.repeat(70));
    if (data) {
        if (typeof data === 'string' && data.startsWith('http')) {
            console.log(`  🌐 URL: ${data}`);
            console.log(`  📋 Click to open: ${data}`);
        } else {
            console.log(JSON.stringify(data, null, 2));
        }
    }
};

const logRequest = (method, url, body = null) => {
    console.log(`\n📤 ${method} ${url}`);
    if (body) {
        const truncated = typeof body === 'object' ? { ...body } : body;
        if (truncated.code) truncated.code = truncated.code.substring(0, 100) + '...';
        console.log(`  Body:`, truncated);
    }
};

const logResponse = (status, data) => {
    const icon = status >= 200 && status < 300 ? '✅' : '❌';
    console.log(`  📥 Response: ${status} ${icon}`);
    if (data) {
        const truncated = typeof data === 'object' ? { ...data } : data;
        if (truncated.output) truncated.output = truncated.output.substring(0, 200) + '...';
        if (truncated.stdout) truncated.stdout = truncated.stdout.substring(0, 200) + '...';
        console.log(`  Data:`, truncated);
    }
};

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// ============================================
// REQUEST HANDLER
// ============================================

const request = async (path, options = {}) => {
    const url = path.startsWith('http') ? path : `${API_BASE}${path}`;
    const method = options.method || 'GET';
    
    let body = options.body;
    let headers = {
        ...(body instanceof FormData ? {} : { 'Content-Type': 'application/json' }),
        ...(options.headers || {})
    };
    
    logRequest(method, url, body);
    
    try {
        const res = await fetch(url, {
            ...options,
            headers,
            body: body instanceof FormData ? body : (body ? JSON.stringify(body) : undefined)
        });
        
        const contentType = res.headers.get("content-type");
        let responseData;
        
        if (contentType && contentType.includes("application/json")) {
            responseData = await res.json();
        } else {
            responseData = {
                status: res.status,
                statusText: res.statusText,
                headers: Object.fromEntries(res.headers.entries())
            };
            try {
                const text = await res.text();
                if (text) responseData.text = text;
            } catch (e) {}
        }
        
        logResponse(res.status, responseData);
        
        return { 
            status: res.status, 
            data: responseData,
            headers: Object.fromEntries(res.headers.entries())
        };
    } catch (e) {
        logResponse(0, { error: e.message });
        return { status: 0, data: { error: e.message } };
    }
};

// ============================================
// ASSERTION HELPERS
// ============================================

const assert = (condition, testName, failureMsg) => {
    TEST_RESULTS.total++;
    if (condition) {
        TEST_RESULTS.passed++;
        console.log(`  ✅ PASS: ${testName}`);
        return true;
    } else {
        TEST_RESULTS.failed++;
        console.error(`  ❌ FAIL: ${testName} -> ${failureMsg}`);
        TEST_RESULTS.details.push(`${testName}: ${failureMsg}`);
        return false;
    }
};

const assertStatus = (response, expectedStatus, testName) => {
    return assert(response.status === expectedStatus, testName, `Expected status ${expectedStatus}, got ${response.status}`);
};

const assertHasFields = (data, fields, testName) => {
    if (!data || typeof data !== 'object') {
        return assert(false, testName, `Data is ${typeof data}, expected object`);
    }
    const missing = fields.filter(f => !(f in data));
    return assert(missing.length === 0, testName, `Missing fields: ${missing.join(', ')}`);
};

const assertContains = (haystack, needle, testName) => {
    const haystackStr = typeof haystack === 'string' ? haystack : (haystack || '');
    return assert(haystackStr.includes(needle), testName, `Expected to contain "${needle}"`);
};

const assertGreater = (value, threshold, testName) => {
    return assert(value > threshold, testName, `Expected ${value} > ${threshold}`);
};

// ============================================
// UTILITY: CLEANUP ALL SESSIONS
// ============================================

async function cleanupAllSessions() {
    log("🧹 Cleaning up all existing sessions...", null, 'info');
    
    try {
        // Get all sessions
        const list = await request('/sessions');
        const sessions = list.data.sessions || [];
        
        if (sessions.length === 0) {
            log("No sessions to clean up", null, 'info');
            return;
        }
        
        log(`Found ${sessions.length} sessions to clean up`, null, 'info');
        
        for (const session of sessions) {
            const sid = session.sessionId;
            log(`Stopping session: ${sid.substring(0, 12)}...`, null, 'debug');
            await request('/stop', { 
                method: 'POST', 
                body: { sessionId: sid } 
            });
            await sleep(1000);
        }
        
        // Verify cleanup
        const verify = await request('/sessions');
        const remaining = verify.data.sessions || [];
        assert(remaining.length === 0, "All sessions cleaned", `Remaining: ${remaining.length}`);
        
        log("✅ All sessions cleaned up", null, 'success');
    } catch (e) {
        log(`Cleanup error: ${e.message}`, null, 'error');
    }
}

// ============================================
// PHASE 0: DISCOVERY & HEALTH
// ============================================

async function suiteDiscovery() {
    log("Starting Suite: Discovery & Health", null, 'section');
    
    let serverUp = false;
    for (let i = 0; i < 5; i++) {
        const h1 = await request('/health/simple');
        if (h1.status === 200 && h1.data.status === 'up') {
            serverUp = true;
            log(`✅ Server responded (attempt ${i+1})`, null, 'success');
            break;
        }
        await sleep(2000);
    }
    assert(serverUp, "Server Availability", "Server is not responding");
    
    const h1 = await request('/health/simple');
    assertStatus(h1, 200, "Simple Health");
    assert(h1.data.status === 'up', "Simple Health Status", "Server is not reporting 'up'");
    assertHasFields(h1.data, ['status', 'timestamp', 'sessions'], "Simple Health Response");
    
    const h2 = await request('/health');
    assertStatus(h2, 200, "Full Health");
    assert(h2.data.maxSessions === 3, "Full Health Max Sessions", "Max sessions should be 3");
    assert(h2.data.activeSessions >= 0, "Full Health Active Sessions", "Active sessions should be >= 0");
    assertHasFields(h2.data, ['status', 'activeSessions', 'maxSessions', 'memoryUsage', 'colabBinary'], "Full Health Response");
    
    const help = await request('/');
    assertStatus(help, 200, "Help Endpoint");
    assert(help.data.version, "Help Endpoint Version", "Help/Index missing version info");
    assert(help.data.name === 'Colab Orchestrator API', "Help Endpoint Name", "Incorrect API name");
    
    const version = await request('/version');
    assertStatus(version, 200, "Version Endpoint");
    assert(version.data.version, "Version Value", "Version is empty");
    
    log('✅ Discovery tests passed', null, 'success');
}

// ============================================
// PHASE 1: STATELESS RUN (FIRST, BEFORE SESSIONS)
// ============================================

async function suiteStateless() {
    log("Starting Suite: Stateless /run (First - Before Sessions)", null, 'section');
    
    // Ensure no sessions exist
    await cleanupAllSessions();
    
    const before = await request('/sessions');
    const beforeCount = before.data.totalSessions || 0;
    log(`Sessions before /run: ${beforeCount}`, null, 'debug');
    assert(beforeCount === 0, "No sessions before run", `Found ${beforeCount} sessions`);

    log("Testing stateless /run...", null, 'info');
    const runRes = await request('/run', { 
        method: 'POST', 
        body: { 
            script: "print('STATELESS SCRIPT STARTED!')\nresult = 50 + 50\nprint(f'Result: {result}')\nprint('STATELESS SCRIPT COMPLETED!')",
            gpu: null,
            keep: false,
            timeout: 30
        } 
    });
    
    assertStatus(runRes, 200, "Stateless Run Call");
    assert(runRes.data.success === true, "Stateless Run Success", "Run failed");
    assert(runRes.data.output, "Stateless Run Output", "No output returned");
    assertContains(runRes.data.output, "STATELESS SCRIPT STARTED", "Stateless Run Output Content");
    assertContains(runRes.data.output, "Result: 100", "Stateless Run Result");
    assertContains(runRes.data.output, "STATELESS SCRIPT COMPLETED", "Stateless Run Completion");
    
    const after = await request('/sessions');
    const afterCount = after.data.totalSessions || 0;
    const sessionsList = after.data.sessions || [];
    const isTracked = sessionsList.some(s => s.colabSession && s.colabSession.includes('run_'));
    
    assert(!isTracked, "Stateless Isolation", "Stateless run was added to persistent session memory!");
    assert(afterCount === beforeCount, "Stateless Session Count", `Before: ${beforeCount}, After: ${afterCount} (should not increase)`);
    
    log("Testing /run with --keep flag...", null, 'info');
    const runKeep = await request('/run', { 
        method: 'POST', 
        body: { 
            script: "print('KEPT SESSION TEST')",
            gpu: null,
            keep: true,
            timeout: 30,
            sessionName: 'test-keep-session'
        } 
    });
    
    assertStatus(runKeep, 200, "Stateless Run with Keep");
    if (runKeep.data.success) {
        if (runKeep.data.url) {
            log('🔗 Session URL:', runKeep.data.url, 'url');
            assert(runKeep.data.url.includes('colab.research.google.com'), "Keep Session URL", "Invalid URL format");
        }
        assert(runKeep.data.sessionName === 'test-keep-session', "Keep Session Name", "Session name mismatch");
        
        await sleep(2000);
        await request('/stop', { 
            method: 'POST', 
            body: { sessionId: 'test-keep-session' } 
        });
    }
    
    log('✅ Stateless run tests passed', null, 'success');
}

// ============================================
// PHASE 2: SESSION MANAGEMENT WITH EVICTION
// ============================================

async function suiteEviction() {
    log("Starting Suite: Auto-Eviction Logic", null, 'section');
    TRACKED_SESSIONS = [];

    log("Creating 3 sessions to fill the limit...");
    for (let i = 1; i <= 3; i++) {
        const res = await request('/new', { 
            method: 'POST', 
            body: { sessionId: `test-evict-${i}` } 
        });
        if (res.status === 200 && res.data.success) {
            TRACKED_SESSIONS.push(res.data.sessionId);
            log(`  ✅ Created session ${i}: test-evict-${i}`, null, 'debug');
        } else {
            log(`  ❌ Failed to create session ${i}`, res.data, 'error');
        }
    }
    assert(TRACKED_SESSIONS.length === 3, "Fill Capacity", `Failed to create 3 initial sessions (got ${TRACKED_SESSIONS.length})`);

    await sleep(3000);

    log("Creating 4th session (should trigger eviction of test-evict-1)...");
    const res4 = await request('/new', { 
        method: 'POST', 
        body: { sessionId: `test-evict-4` } 
    });
    assertStatus(res4, 200, "4th Session Creation");
    if (res4.data.success) {
        TRACKED_SESSIONS.push(res4.data.sessionId);
    }

    log("Verifying oldest session is gone (404)...");
    const checkOld = await request(`/sessions/test-evict-1`);
    assertStatus(checkOld, 404, "Verify Oldest Session Evicted");
    
    const checkNew = await request(`/sessions/test-evict-4`);
    assertStatus(checkNew, 200, "Verify Newest Session Exists");
    
    const list = await request('/sessions');
    assert(list.data.totalSessions === 3, "Session Count After Eviction", `Expected 3 sessions, got ${list.data.totalSessions}`);
    
    log('✅ Eviction tests passed', null, 'success');
}

async function suiteSessionDetails() {
    log("Starting Suite: Session Management Details", null, 'section');
    
    const sid = TRACKED_SESSIONS[TRACKED_SESSIONS.length - 1];
    
    const sub = sid.substring(0, 8);
    const bySub = await request(`/sessions/${sub}`);
    assertStatus(bySub, 200, "Get Session By Sub");
    assert(bySub.data.session.sub === sub, "Session Sub Match", "Sub resolution failed");
    
    const details = await request(`/sessions/${sid}`);
    assertStatus(details, 200, "Get Session Details");
    assertHasFields(details.data.session, ['colabSession', 'status', 'createdAt', 'lastActivity'], "Session Details Fields");
    assert(details.data.session.status === 'ready' || details.data.session.status === 'busy', "Session Status Valid", `Status is ${details.data.session.status}`);
    
    const invalid = await request('/sessions/invalid123');
    assertStatus(invalid, 404, "Invalid Session Returns 404");
    
    const restart = await request('/restart-kernel', {
        method: 'POST',
        body: { sessionId: sid }
    });
    assertStatus(restart, 200, "Restart Kernel");
    assert(restart.data.success === true, "Restart Kernel Success", "Kernel restart failed");
    
    const keepalive = await request('/keepalive', {
        method: 'POST',
        body: { sessionId: sid }
    });
    assertStatus(keepalive, 200, "Keep Alive");
    assert(keepalive.data.success === true, "Keep Alive Success", "Keep alive failed");
    
    log('✅ Session details tests passed', null, 'success');
}

// ============================================
// PHASE 3: CODE EXECUTION
// ============================================

async function suiteExecution() {
    log("Starting Suite: Code Execution", null, 'section');
    const sid = TRACKED_SESSIONS[TRACKED_SESSIONS.length - 1];

    const code = `import time
print('START')
time.sleep(2)
print('END')
result = 50 + 50
print(f'RESULT:{result}')
print('✅ DONE')`;
    
    const res = await request('/exec', { 
        method: 'POST', 
        body: { sessionId: sid, code, cellNo: 101 } 
    });

    if (!assertStatus(res, 200, "Exec Request")) return;
    if (!assert(res.data.executionId, "Exec ID Exists", "No execution ID returned")) return;
    
    const eid = res.data.executionId;
    ACTIVE_EXECUTION_ID = eid;

    log("Polling status for completion...");
    let completed = false;
    let partialOutputReceived = false;
    
    for (let i = 0; i < 15; i++) {
        await sleep(2000);
        const poll = await request(`/exec-status?sessionId=${sid}&executionId=${eid}`);
        
        if (poll.data.status === 'running') {
            if (poll.data.partialOutput && poll.data.partialOutput.includes('START')) {
                partialOutputReceived = true;
                log(`  Partial output received at attempt ${i+1}`, null, 'debug');
            }
        } else if (poll.data.status === 'completed') {
            completed = true;
            assert(poll.data.output.includes('RESULT:100'), "Output Verification", "Code output mismatch");
            assert(poll.data.output.includes('✅ DONE'), "Output Complete", "Final output missing");
            break;
        } else if (poll.data.status === 'failed') {
            log(`  Execution failed: ${poll.data.error}`, null, 'error');
            break;
        }
    }
    assert(completed, "Execution Polling", "Code execution timed out or failed");
    // Partial output is optional, don't fail if not received
    if (!partialOutputReceived) {
        log("  ⚠️ No partial output received (this is acceptable)", null, 'warn');
    }
    
    const invalidExec = await request(`/exec-status?sessionId=${sid}&executionId=invalid`);
    assertStatus(invalidExec, 404, "Invalid Execution ID");
    
    const ack = await request('/exec-ack', {
        method: 'POST',
        body: { executionId: eid }
    });
    assertStatus(ack, 200, "Acknowledge Execution");
    assert(ack.data.success === true, "Acknowledge Success", "Acknowledge failed");
    
    log('✅ Execution tests passed', null, 'success');
}

// ============================================
// PHASE 4: FILE SYSTEM LIFECYCLE
// ============================================

async function suiteFiles() {
    log("Starting Suite: File System Lifecycle", null, 'section');
    const sid = TRACKED_SESSIONS[TRACKED_SESSIONS.length - 1];

    TEST_FILE_CONTENT = `Hello Colab v3.9!\nCreated: ${new Date().toISOString()}\nContent: Test file for lifecycle testing.`;
    const blob = new Blob([TEST_FILE_CONTENT], { type: 'text/plain' });
    const testFile = new File([blob], 'testfile.txt', { type: 'text/plain' });
    
    const formData = new FormData();
    formData.append('sessionId', sid);
    formData.append('file', testFile);
    formData.append('remotePath', '/content/testfile.txt');

    const up = await request('/upload', { method: 'POST', body: formData });
    assertStatus(up, 200, "Upload Call");
    assert(up.data.success === true, "Upload Success", "Upload failed");
    assert(up.data.fileSize === TEST_FILE_CONTENT.length, "Upload Size", `Expected ${TEST_FILE_CONTENT.length}, got ${up.data.fileSize}`);
    ACTIVE_TRANSFER_ID = up.data.transferId;

    let uploadComplete = false;
    for (let i = 0; i < 10; i++) {
        await sleep(1500);
        const status = await request(`/upload-status?transferId=${ACTIVE_TRANSFER_ID}`);
        if (status.data.status === 'completed') {
            uploadComplete = true;
            assert(status.data.fileSize === TEST_FILE_CONTENT.length, "Upload Status Size", `Expected ${TEST_FILE_CONTENT.length}, got ${status.data.fileSize}`);
            break;
        }
    }
    assert(uploadComplete, "Upload Completion", "Upload never completed");

    await sleep(2000);
    const list = await request(`/ls?sessionId=${sid}`);
    assertStatus(list, 200, "LS Call");
    assert(Array.isArray(list.data.files), "LS Array", "Files is not an array");
    const fileFound = list.data.files.some(f => f.includes('testfile.txt'));
    assert(fileFound, "LS Verification", "Uploaded file not found in VM");

    const dl = await request('/download', { 
        method: 'POST', 
        body: { sessionId: sid, remotePath: '/content/testfile.txt' } 
    });
    assertStatus(dl, 200, "Download Call");
    assert(dl.data.transferId, "Download Transfer ID", "No transfer ID returned");
    
    const dlTid = dl.data.transferId;
    let dlReady = false;
    
    for (let i = 0; i < 10; i++) {
        await sleep(2000);
        const status = await request(`/download-status?transferId=${dlTid}`);
        if (status.data.status === 'completed') {
            dlReady = true;
            assert(status.data.fileSize === TEST_FILE_CONTENT.length, "Download Size", `Expected ${TEST_FILE_CONTENT.length}, got ${status.data.fileSize}`);
            break;
        }
    }
    assert(dlReady, "VM to Server Transfer", "File never reached Orchestrator storage");

    log("Retrieving file from Server...", null, 'info');
    const retrieve = await request(`/retrieve-file?sessionId=${sid}&filename=testfile.txt`);
    assertStatus(retrieve, 200, "Retrieve Endpoint");
    if (retrieve.data && retrieve.data.text) {
        assert(retrieve.data.text === TEST_FILE_CONTENT, "Retrieve Content", "File content mismatch");
    }

    const rm = await request('/rm', {
        method: 'POST',
        body: { sessionId: sid, path: '/content/testfile.txt' }
    });
    assertStatus(rm, 200, "Delete File");
    assert(rm.data.success === true, "Delete Success", "Delete failed");

    await sleep(2000);
    const listAfter = await request(`/ls?sessionId=${sid}`);
    const fileStillExists = listAfter.data.files.some(f => f.includes('testfile.txt'));
    assert(!fileStillExists, "Delete Verification", "File still exists after deletion");
    
    log('✅ File lifecycle tests passed', null, 'success');
}

// ============================================
// PHASE 5: AUTOMATION & INTERACTIVE URLS
// ============================================

async function suiteAutomation() {
    log("Starting Suite: Automation & Interactive URLs", null, 'section');
    const sid = TRACKED_SESSIONS[TRACKED_SESSIONS.length - 1];

    log("Testing Drivemount...", null, 'info');
    const dm = await request('/drivemount', { 
        method: 'POST', 
        body: { sessionId: sid } 
    });
    assertStatus(dm, 200, "Drivemount Endpoint");
    assertHasFields(dm.data, ['sessionId', 'mountPath', 'message'], "Drivemount Response");
    if (dm.data.authUrl) {
        log('🔗 Drivemount Auth URL:', dm.data.authUrl, 'url');
        assert(dm.data.authUrl.includes('google.com'), "Drivemount Auth URL", "Invalid auth URL");
        assert(dm.data.success === true, "Drivemount Success", "Auth URL generation failed");
    } else if (dm.data.alreadyMounted) {
        assert(dm.data.alreadyMounted === true, "Already Mounted", "Drive is already mounted");
    } else {
        assert(dm.data.hint, "Drivemount Hint", "No hint provided for manual mount");
    }

    log("Testing Auth...", null, 'info');
    const auth = await request('/auth', { 
        method: 'POST', 
        body: { sessionId: sid } 
    });
    assertStatus(auth, 200, "Auth Endpoint");
    assertHasFields(auth.data, ['authUrl', 'command', 'hint'], "Auth Response");
    if (auth.data.authUrl) {
        log('🔗 Auth URL:', auth.data.authUrl, 'url');
        assert(auth.data.authUrl.includes('google.com'), "Auth URL", "Invalid auth URL");
    }
    assert(auth.data.command.includes('colab auth'), "Auth Command", "Invalid auth command");

    log("Testing Console...", null, 'info');
    const consoleReq = await request('/console', { 
        method: 'POST', 
        body: { sessionId: sid } 
    });
    assertStatus(consoleReq, 200, "Console Endpoint");
    assert(consoleReq.data.command.includes('colab console'), "Console Command", "Invalid console command");

    log("Testing REPL...", null, 'info');
    const repl = await request('/repl', { 
        method: 'POST', 
        body: { 
            sessionId: sid, 
            code: 'print("REPL test successful!")' 
        } 
    });
    assertStatus(repl, 200, "REPL Endpoint");
    if (repl.data.success) {
        assert(repl.data.output && repl.data.output.includes('REPL test successful'), "REPL Output", "Output missing or incorrect");
    } else {
        assert(repl.data.command, "REPL Command", "No command provided for no-code REPL");
    }

    log("Testing Edit...", null, 'info');
    const edit = await request('/edit', { 
        method: 'POST', 
        body: { 
            sessionId: sid, 
            remotePath: '/content/testfile.txt' 
        } 
    });
    assertStatus(edit, 200, "Edit Endpoint");
    assert(edit.data.command.includes('colab edit'), "Edit Command", "Invalid edit command");
    assert(edit.data.remotePath === '/content/testfile.txt', "Edit Path", "Remote path mismatch");
    
    log('✅ Automation tests passed', null, 'success');
}

// ============================================
// PHASE 6: STATUS & URL ENDPOINTS
// ============================================

async function suiteStatusAndUrl() {
    log("Starting Suite: Status & URL Endpoints", null, 'section');
    const sid = TRACKED_SESSIONS[TRACKED_SESSIONS.length - 1];

    log("Testing Status...", null, 'info');
    const status = await request(`/status?sessionId=${sid}`);
    assertStatus(status, 200, "Status Endpoint");
    assertHasFields(status.data, ['success', 'sessionId', 'session', 'url'], "Status Response");
    assert(status.data.success === true, "Status Success", "Status retrieval failed");
    assert(status.data.session.name, "Status Session Name", "Session name missing");
    if (status.data.url) {
        log('🔗 Status URL:', status.data.url, 'url');
        assert(status.data.url.includes('colab.research.google.com'), "Status URL Valid", "Invalid URL format");
    }

    log("Testing URL...", null, 'info');
    const url = await request(`/url?sessionId=${sid}`);
    assertStatus(url, 200, "URL Endpoint");
    assertHasFields(url.data, ['success', 'url', 'session', 'host'], "URL Response");
    assert(url.data.success === true, "URL Success", "URL generation failed");
    if (url.data.url) {
        log('🔗 Session URL:', url.data.url, 'url');
        assert(url.data.url.includes('colab.research.google.com'), "URL Domain", "URL doesn't contain colab domain");
        assert(url.data.url.includes('dbu='), "URL DBU Parameter", "Missing dbu parameter");
        assert(url.data.url.includes('datalabBackendUrl'), "URL Backend URL", "Missing backend URL");
    }
    assert(url.data.host === 'https://colab.research.google.com', "URL Host", "Host is incorrect");

    const customHost = await request(`/url?sessionId=${sid}&host=https://colab.sandbox.google.com`);
    assert(customHost.data.host === 'https://colab.sandbox.google.com', "Custom Host", "Custom host not applied");
    if (customHost.data.url) {
        assert(customHost.data.url.includes('colab.sandbox.google.com'), "Custom Host URL", "Custom host not in URL");
        log('🔗 Custom Host URL:', customHost.data.url, 'url');
    }

    const invalidStatus = await request('/status?sessionId=invalid');
    assertStatus(invalidStatus, 404, "Invalid Status");
    
    const invalidUrl = await request('/url?sessionId=invalid');
    assertStatus(invalidUrl, 404, "Invalid URL");
    
    log('✅ Status and URL tests passed', null, 'success');
}

// ============================================
// PHASE 7: UTILITY COMMANDS
// ============================================

async function suiteUtilities() {
    log("Starting Suite: Utility Commands", null, 'section');

    const pay = await request('/pay');
    assertStatus(pay, 200, "Pay Endpoint");
    assert(pay.data.url === 'https://colab.research.google.com/signup', "Pay URL", "Invalid signup URL");
    if (pay.data.url) {
        log('🔗 Colab Signup URL:', pay.data.url, 'url');
    }
    assert(pay.data.success === true, "Pay Success", "Pay failed");

    const readme = await request('/readme');
    assertStatus(readme, 200, "Readme Endpoint");
    assert(readme.data.output && readme.data.output.length > 100, "Readme Content", "Readme output too short or missing");

    const skill = await request('/skill');
    assertStatus(skill, 200, "Skill Endpoint");
    assert(skill.data.output && skill.data.output.length > 100, "Skill Content", "Skill output too short or missing");

    const update = await request('/update');
    assertStatus(update, 200, "Update Endpoint");
    assert(update.data.success === true, "Update Success", "Update failed");
    assert(update.data.message, "Update Message", "No message returned");

    const sessionsList = await request('/sessions-list');
    assertStatus(sessionsList, 200, "Sessions List Endpoint");
    assert(Array.isArray(sessionsList.data.sessionsList), "Sessions List Array", "Sessions list is not an array");
    assert(sessionsList.data.trackedSessions >= 0, "Tracked Sessions", "Tracked sessions count invalid");
    
    log('✅ Utility tests passed', null, 'success');
}

// ============================================
// PHASE 8: EDGE CASES & CONCURRENCY
// ============================================

async function suiteEdgeCases() {
    log("Starting Suite: Edge Cases & Concurrency", null, 'section');
    const sid = TRACKED_SESSIONS[TRACKED_SESSIONS.length - 1];

    log("Testing Large Code Execution...", null, 'info');
    const largeString = 'x'.repeat(50000);
    const largeCode = `print("Large code test")\nresult = len("${largeString}")\nprint(f"String length: {result}")`;
    
    const largeExec = await request('/exec', {
        method: 'POST',
        body: { sessionId: sid, code: largeCode, cellNo: 999 }
    });
    assertStatus(largeExec, 200, "Large Code Execution");
    assert(largeExec.data.executionId, "Large Code Exec ID", "No execution ID returned");
    
    let largeCompleted = false;
    for (let i = 0; i < 15; i++) {
        await sleep(2000);
        const poll = await request(`/exec-status?sessionId=${sid}&executionId=${largeExec.data.executionId}`);
        if (poll.data.status === 'completed') {
            largeCompleted = true;
            assert(poll.data.output.includes('50000'), "Large Code Output", "Large string length incorrect");
            break;
        }
    }
    assert(largeCompleted, "Large Code Completion", "Large code execution timed out");

    log("Testing Special Characters...", null, 'info');
    const specialTests = [
        { name: 'Path with spaces', path: '/content/test file.txt' },
        { name: 'Path with symbols', path: '/content/test-file_v1.2.3.txt' },
        { name: 'Path with special chars', path: '/content/test_@#$%^&*.txt' }
    ];
    for (const test of specialTests) {
        const resp = await request(`/sessions/${encodeURIComponent(test.path)}`);
        assertStatus(resp, 404, `Special Char: ${test.name}`);
    }

    log("Testing Concurrent Requests...", null, 'info');
    const promises = [];
    for (let i = 0; i < 5; i++) {
        promises.push(request('/health'));
        promises.push(request('/health/simple'));
    }
    const results = await Promise.all(promises);
    const successes = results.filter(r => r.status === 200);
    assert(successes.length > 0, "Concurrent Requests", "Concurrent requests failed");
    log(`  ✅ ${successes.length}/${results.length} concurrent requests succeeded`, null, 'debug');

    log("Testing Rate Limiting...", null, 'info');
    const maxSessions = 3;
    const created = [];
    
    for (let i = 0; i < maxSessions + 2; i++) {
        const resp = await request('/new', {
            method: 'POST',
            body: { gpu: i % 2 === 0 ? 'T4' : 'L4' }
        });
        if (resp.data.success) {
            created.push(resp.data.sessionId);
        }
        await sleep(1000);
    }
    
    const final = await request('/sessions');
    const count = final.data.totalSessions || 0;
    assert(count <= maxSessions, "Auto Eviction", `Sessions (${count}) exceeds max (${maxSessions})`);
    
    for (const id of created) {
        await request('/stop', { method: 'POST', body: { sessionId: id } });
    }
    
    log('✅ Edge cases tests passed', null, 'success');
}

// ============================================
// PHASE 9: PACKAGE INSTALLATION & LOGS
// ============================================

async function suitePackageAndLogs() {
    log("Starting Suite: Package Installation & Logs", null, 'section');
    const sid = TRACKED_SESSIONS[TRACKED_SESSIONS.length - 1];

    log("Testing Package Installation...", null, 'info');
    const install = await request('/install', {
        method: 'POST',
        body: { 
            sessionId: sid, 
            packages: ['pandas', 'numpy'] 
        }
    });
    assertStatus(install, 200, "Install Endpoint");
    assert(install.data.success === true, "Install Success", "Package installation failed");
    assert(install.data.message, "Install Message", "No message returned");

    log("Testing Logs...", null, 'info');
    const logs = await request(`/log?sessionId=${sid}&lines=20`);
    assertStatus(logs, 200, "Logs Endpoint");
    assert(logs.data.success === true, "Logs Success", "Log retrieval failed");
    assert(logs.data.output, "Logs Output", "No output returned");
    assert(Array.isArray(logs.data.events), "Logs Events", "Events is not an array");
    assert(logs.data.events.length > 0, "Logs Events Count", "No events found");

    const filtered = await request(`/log?sessionId=${sid}&type=execution&lines=5`);
    assert(filtered.data.success === true, "Log Filtering", "Filtered logs failed");
    assert(filtered.data.events.length <= 5, "Log Lines Limit", "Lines limit not respected");

    const invalidLogs = await request('/log?sessionId=invalid');
    assertStatus(invalidLogs, 404, "Invalid Logs");
    
    log('✅ Package and logs tests passed', null, 'success');
}

// ============================================
// PHASE 10: CLEANUP
// ============================================

async function suiteCleanup() {
    log("Starting Suite: Cleanup", null, 'section');

    for (const id of TRACKED_SESSIONS) {
        log(`Stopping session: ${id.substring(0, 12)}...`, null, 'debug');
        const stop = await request('/stop', { 
            method: 'POST', 
            body: { sessionId: id } 
        });
        if (stop.status === 200) {
            assert(true, `Stop Session ${id.substring(0, 12)}`, "Session stopped successfully");
        } else if (stop.status === 404) {
            log(`  Session ${id.substring(0, 12)} already stopped`, null, 'warn');
            assert(true, `Stop Session ${id.substring(0, 12)}`, "Session already stopped (404)");
        } else {
            assert(false, `Stop Session ${id.substring(0, 12)}`, `Unexpected status: ${stop.status}`);
        }
    }

    await sleep(2000);
    const list = await request('/sessions');
    const remaining = list.data.sessions || [];
    const trackedIds = TRACKED_SESSIONS.map(id => id.substring(0, 8));
    const stillExist = remaining.some(s => trackedIds.includes(s.sub));
    assert(!stillExist, "All Sessions Cleaned", "Some sessions still exist after cleanup");
    
    const invalidStop = await request('/stop', {
        method: 'POST',
        body: { sessionId: 'nonexistent' }
    });
    assertStatus(invalidStop, 404, "Stop Non-Existent Session");
    
    const invalidDelete = await request('/session/nonexistent', {
        method: 'DELETE'
    });
    assertStatus(invalidDelete, 404, "Delete Non-Existent Session");
    
    log('✅ Cleanup tests passed', null, 'success');
}

// ============================================
// MAIN RUNNER
// ============================================

async function runAllTests() {
    console.clear();
    console.log('\n' + '='.repeat(70));
    console.log('🧪 COLAB ORCHESTRATOR - ULTIMATE TEST SUITE v5.1');
    console.log('='.repeat(70) + '\n');
    
    TEST_RESULTS.startTime = Date.now();
    TEST_RESULTS.total = 0;
    TEST_RESULTS.passed = 0;
    TEST_RESULTS.failed = 0;
    TEST_RESULTS.skipped = 0;
    TEST_RESULTS.details = [];
    TRACKED_SESSIONS = [];
    
    try {
        // First: Discovery & Health
        await suiteDiscovery();
        
        // Second: Stateless Run (no sessions needed)
        await suiteStateless();
        
        // Third: Session Management & Eviction
        await suiteEviction();
        await suiteSessionDetails();
        
        // Fourth: Execution
        await suiteExecution();
        
        // Fifth: Files
        await suiteFiles();
        
        // Sixth: Automation
        await suiteAutomation();
        
        // Seventh: Status & URL
        await suiteStatusAndUrl();
        
        // Eighth: Utilities
        await suiteUtilities();
        
        // Ninth: Edge Cases
        await suiteEdgeCases();
        
        // Tenth: Package & Logs
        await suitePackageAndLogs();
        
        // Eleventh: Cleanup
        await suiteCleanup();

        printSummary();
    } catch (e) {
        log(`FATAL TEST ERROR: ${e.message}`, null, 'error');
        console.error(e.stack);
        
        // Try to clean up on error
        await cleanupAllSessions();
        printSummary();
    }
}

function printSummary() {
    TEST_RESULTS.endTime = Date.now();
    const duration = ((TEST_RESULTS.endTime - TEST_RESULTS.startTime) / 1000).toFixed(1);
    const rate = ((TEST_RESULTS.passed / TEST_RESULTS.total) * 100).toFixed(1);
    
    console.log("\n" + "=".repeat(70));
    console.log("📊 FINAL TEST REPORT");
    console.log("-".repeat(70));
    console.log(`Total Assertions:  ${TEST_RESULTS.total}`);
    console.log(`✅ Passed:          ${TEST_RESULTS.passed}`);
    console.log(`❌ Failed:          ${TEST_RESULTS.failed}`);
    console.log(`⏭️ Skipped:         ${TEST_RESULTS.skipped}`);
    console.log(`Pass Rate:         ${rate}%`);
    console.log(`Duration:          ${duration}s`);
    console.log("=".repeat(70));

    if (TEST_RESULTS.failed > 0) {
        console.log("\n❌ FAILURE LOG:");
        TEST_RESULTS.details.forEach(d => console.log(`  - ${d}`));
    } else {
        console.log("\n✅ ALL TESTS PASSED! SERVER IS STABLE.");
    }
    console.log("\n");
}

// ============================================
// EXPOSE FOR CONSOLE USE
// ============================================

window.API_BASE = API_BASE;
window.TRACKED_SESSIONS = TRACKED_SESSIONS;
window.TEST_RESULTS = TEST_RESULTS;
window.runAllTests = runAllTests;
window.cleanupAllSessions = cleanupAllSessions;

console.log(`
╔═══════════════════════════════════════════════════════════════════════════════╗
║  COLAB ORCHESTRATOR - ULTIMATE TEST SUITE v5.1                              ║
╠═══════════════════════════════════════════════════════════════════════════════╣
║                                                                              ║
║  🚀 MAIN COMMAND:                                                            ║
║  ────────────────                                                           ║
║  await runAllTests()     - Run complete test suite                          ║
║                                                                              ║
║  🧹 UTILITY:                                                                 ║
║  ────────────                                                                ║
║  await cleanupAllSessions() - Clean up all sessions                         ║
║                                                                              ║
║  📌 TEST ORDER (Optimized):                                                  ║
║  ────────────────────────                                                    ║
║  1. Discovery & Health                                                       ║
║  2. Stateless /run (First - No sessions needed)                            ║
║  3. Session Management with Eviction                                        ║
║  4. Session Details                                                         ║
║  5. Code Execution                                                          ║
║  6. File System Lifecycle                                                   ║
║  7. Automation & Interactive URLs                                           ║
║  8. Status & URL Endpoints                                                  ║
║  9. Utility Commands                                                        ║
║  10. Edge Cases & Concurrency                                               ║
║  11. Package Installation & Logs                                           ║
║  12. Cleanup                                                                ║
║                                                                              ║
║  🔗 URL DISPLAY:                                                             ║
║  ─────────────                                                               ║
║  All URLs are displayed with clickable links                                ║
║  - Drivemount auth URLs                                                      ║
║  - Session URLs                                                              ║
║  - Colab signup URL                                                          ║
║                                                                              ║
╚═══════════════════════════════════════════════════════════════════════════════╝

💡 Quick Start:
  await runAllTests()

💡 Clean up first if needed:
  await cleanupAllSessions()
  await runAllTests()

💡 URLs are displayed as clickable links in the console!
`);

console.log(`✅ Ultimate Test Suite v5.1 loaded!`);
console.log(`📍 API Base: ${API_BASE}`);
console.log('💡 Run: await runAllTests() to start comprehensive testing');
console.log('🔗 URLs will be displayed as clickable links');
console.log('📤 Request/Response logging is enabled');
