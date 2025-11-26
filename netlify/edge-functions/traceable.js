// Netlify Edge Function for request/response capture and export to Traceable
const VERSION = '1.0.0';

// Users should prefer to modify config with Netlify env vars to make upgrades easier
let CONFIG = {
    tpa_address: '', // TA_TPA_ADDRESS
    service_name: 'website', // TA_SERVICE_NAME
    traceable_guid: '', // TA_GUID **legacy, prefer TA_AGENT_TOKEN
    // token: '' // TA_AGENT_TOKEN - preferred over TA_GUID can be used depending on auth mechanism
    environment_name: '', // TA_ENVIRONMENT_NAME
    capture_content_types: ['json', 'xml', 'grpc', 'x-www-form-urlencoded'], // TA_CAPTURE_CONTENT_TYPES
    max_size_bytes: 131072, // TA_MAX_SIZE_BYTES
    debug: false, // TA_DEBUG
    timeout_ms: 500 // TA_TIMEOUT_MS
};

export function updateConfigFromEnv() {
    const override = (key, envName, transform = (v) => v) => {
        const v = getEnvVar(envName);
        if (v !== undefined && v !== null && String(v).length > 0) {
            CONFIG[key] = transform(v);
        }
    };

    override('tpa_address', 'TA_TPA_ADDRESS');
    override('service_name', 'TA_SERVICE_NAME');
    override('environment_name', 'TA_ENVIRONMENT_NAME');
    override('traceable_guid', 'TA_GUID');
    override('debug', 'TA_DEBUG', (v) => String(v).toLowerCase() === 'true');
    override('max_size_bytes', 'TA_MAX_SIZE_BYTES', (v) => {
        const n = parseInt(v, 10);
        return Number.isNaN(n) ? CONFIG.max_size_bytes : n;
    });
    override('timeout_ms', 'TA_TIMEOUT_MS', (v) => {
        const n = parseInt(v, 10)
        return Number.isNaN(n) ? CONFIG.timeout_ms : n;
    });

    const parseJson = (v, expectArray = true) => {
        try {
            const parsed = JSON.parse(v);
            if (!expectArray || Array.isArray(parsed)) {
                return parsed
            }
        } catch (e) {
            console.warn('Invalid JSON in env var:', e);
        }
        return undefined;
    };

    const cc = getEnvVar('TA_CAPTURE_CONTENT_TYPES');
    if (cc) {
        const parsed = parseJson(cc);
        if (parsed) {
            CONFIG.capture_content_types = parsed;
        }
    }
}

function debugLog(msg) {
    if (CONFIG.debug === true) {
        // eslint-disable-next-line no-console
        console.log(msg);
    }
}

export function createExtCapHeaders(start, end) {
    const timeNanos = (end.getTime() - start.getTime()) * 1_000_000;
    const headers = {
        'Content-Type': 'application/json',
        'traceableai-service-name': CONFIG.service_name,
        'traceableai-module-version': VERSION,
        'traceableai-environment-name': CONFIG.environment_name,
        'traceableai-module-name': 'netlify-edge',
        'traceableai-total-duration-nanos': String(timeNanos),
    };

    if (CONFIG.traceable_guid && CONFIG.traceable_guid.length > 0) {
        headers['x-traceable-guid'] = CONFIG.traceable_guid;
    }

    const token = getEnvVar('TA_AGENT_TOKEN');
    if (token && token.length > 0) {
        headers['traceableai-agent-token'] = token;
    }
    return headers;
}

async function exportData(extCapData, start, end) {
    const headers = createExtCapHeaders(start, end);

    const options = {
        method: 'POST',
        headers,
        signal: AbortSignal.timeout(CONFIG.timeout_ms),
        body: JSON.stringify(extCapData),
    };
    const url = CONFIG.tpa_address + '/ext_cap/v1/req_res_cap';

    try {
        const response = await fetch(url, options);
        debugLog(`Request to ${url} completed with status: ${response.status}`);

        if (!response.ok) {
            debugLog(`Error in exportData: HTTP ${response.status} - ${response.statusText}`);
        }
    } catch (error) {
        console.error('Error in exportData:', error);
    }
}

const staticExtensions = [
    '.css', '.js', '.mjs', '.jpg', '.jpeg', '.png', '.gif', '.svg', '.ico', '.woff', '.woff2',
    '.eot', '.ttf', '.otf', '.webp', '.avif', '.mp4', '.webm', '.txt', '.map',
];

export function isStatic(url) {
    return staticExtensions.some((ext) => url.pathname.endsWith(ext));
}

export function formatHeaders(headerCollection) {
    const headers = {};
    headerCollection.forEach((value, key) => {
        headers[key] = value;
    });
    return headers;
}

export function shouldCapture(headers) {
    const contentTypeHeader = headers.get('Content-Type') || headers.get('content-type');
    if (!contentTypeHeader) return false;
    const ct = String(contentTypeHeader).toLowerCase();
    for (let i = 0; i < CONFIG.capture_content_types.length; i++) {
        if (ct.indexOf(String(CONFIG.capture_content_types[i]).toLowerCase()) > -1) {
            return true;
        }
    }
    return false;
}

export function isGrpc(headers) {
    const contentType = headers.get('Content-Type') || headers.get('content-type');
    if (!contentType) return false;
    return String(contentType).toLowerCase().indexOf('grpc') > -1;
}

export async function readClonedBody(config, clonedBody) {
    const rawBody = await clonedBody.arrayBuffer();
    const bodyUint8Array = new Uint8Array(rawBody);

    const maxSize = config.max_size_bytes;
    const isTruncated = bodyUint8Array.length > maxSize;
    const capturedBody = bodyUint8Array.slice(0, maxSize);

    return {
        body: capturedBody,
        truncated: isTruncated,
    };
}

export function uint8ArrayToBase64(buffer) {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    let base64 = '';

    const bytes = buffer.length;
    let uint24 = 0;
    for (let i = 0; i < bytes; i++) {
        uint24 = (uint24 << 8) | buffer[i];
        if (i % 3 === 2) {
            base64 += chars[(uint24 >>> 18) & 63];
            base64 += chars[(uint24 >>> 12) & 63];
            base64 += chars[(uint24 >>> 6) & 63];
            base64 += chars[uint24 & 63];
            uint24 = 0;
        }
    }

    if (bytes % 3 === 1) {
        uint24 <<= 16;
        base64 += chars[(uint24 >>> 18) & 63];
        base64 += chars[(uint24 >>> 12) & 63];
        base64 += '==';
    } else if (bytes % 3 === 2) {
        uint24 <<= 8;
        base64 += chars[(uint24 >>> 18) & 63];
        base64 += chars[(uint24 >>> 12) & 63];
        base64 += chars[(uint24 >>> 6) & 63];
        base64 += '=';
    }

    return base64;
}

function extractGrpcStatusCode(grpcBodyUint8) {
    try {
        const decoder = new TextDecoder();
        const grpcData = decoder.decode(grpcBodyUint8);
        const match = grpcData.match(/grpc-status\s*:\s*(\d+)/);
        if (match) return match[1];
    } catch (_) {
    }
    return null;
}

export function createExtCapReqResCapBody(url, req, res, reqBody, resBody, startDate, grpc, overrideStatus, reqTruncated, resTruncated) {
    const reqHeaders = formatHeaders(req.headers);
    const resHeaders = formatHeaders(res.headers);
    if (grpc && overrideStatus) {
        resHeaders['grpc-status'] = overrideStatus;
    }

    return {
        request: {
            method: req.method,
            headers: reqHeaders,
            body: reqBody,
            scheme: url.protocol,
            path: url.pathname,
            host: url.host,
            truncated: !!reqTruncated,
        },
        response: {
            headers: resHeaders,
            requestUrl: req.url,
            statusCode: res.status,
            body: resBody,
            truncated: !!resTruncated,
        },
        requestTimestampInMs: startDate.getTime(),
    };
}

export function getConfig() {
    return CONFIG;
}

// Safe env accessor that works across Netlify Edge variations
function getEnvVar(name) {
    try {
        // Preferred newer API in some Netlify runtimes
        if (typeof Netlify !== 'undefined' && Netlify?.env?.get) {
            return Netlify.env.get(name);
        }
    } catch (_) {
    }
    try {
        // Fallback (commonly supported on Edge/Deno)
        if (typeof Deno !== 'undefined' && Deno?.env?.get) {
            return Deno.env.get(name);
        }
    } catch (_) {
    }
    try {
        // Node/Jest fallback for local testing
        if (typeof process !== 'undefined' && process?.env && Object.prototype.hasOwnProperty.call(process.env, name)) {
            return process.env[name];
        }
    } catch (_) {
    }
    return undefined;
}

export default async (request, context) => {
    updateConfigFromEnv();

    const url = new URL(request.url);

    // Skip static assets early
    if (isStatic(url)) {
        return await context.next();
    }

    const startDate = new Date();

    // Capture request body (if content type matches)
    let requestBody = null;
    let requestTruncated = false;
    try {
        if (shouldCapture(request.headers)) {
            const {body, truncated} = await readClonedBody(CONFIG, request.clone());
            requestBody = uint8ArrayToBase64(body);
            requestTruncated = truncated;
        }
    } catch (e) {
        console.error('Error capturing request body', e);
    }

    // Forward request to origin/next handler
    const response = await context.next();

    try {
        const after = new Date();

        let responseBody = null;
        let responseTruncated = false;
        let overrideStatus = null;
        let grpc = false;

        if (response && shouldCapture(response.headers)) {
            const {body, truncated} = await readClonedBody(CONFIG, response.clone());
            responseTruncated = truncated;
            grpc = isGrpc(response.headers);
            if (grpc) {
                overrideStatus = extractGrpcStatusCode(body);
            }
            responseBody = uint8ArrayToBase64(body);
        }

        const extCap = createExtCapReqResCapBody(
            url,
            request,
            response,
            requestBody,
            responseBody,
            startDate,
            grpc,
            overrideStatus,
            requestTruncated,
            responseTruncated,
        );


        context.waitUntil(exportData(extCap, startDate, after));
    } catch (e) {
        console.error('Error during response capture phase', e);
    }

    return response;
};
