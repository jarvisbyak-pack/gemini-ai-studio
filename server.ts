import express from 'express';
import path from 'path';
import { createServer as createViteServer } from 'vite';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
const PORT = 3000;

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Health check endpoint
app.get('/api/health', (_req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
  });
});

// Test/Ping n8n Webhook Node endpoint
app.post('/api/n8n/test', async (req, res) => {
  const { webhookUrl, method = 'POST', headers = {} } = req.body;

  if (!webhookUrl || typeof webhookUrl !== 'string') {
    res.status(400).json({
      ok: false,
      error: 'A valid n8n Webhook URL is required to test connectivity.',
    });
    return;
  }

  const startTime = Date.now();
  try {
    const fetchOptions: RequestInit = {
      method: method.toUpperCase(),
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/plain, */*',
        'User-Agent': 'n8n-AI-Voice-Interface/1.0',
        ...headers,
      },
    };

    if (fetchOptions.method !== 'GET' && fetchOptions.method !== 'HEAD') {
      fetchOptions.body = JSON.stringify({
        event: 'test_connection',
        source: 'n8n_ai_voice_interface',
        timestamp: new Date().toISOString(),
        message: 'Ping from AI Voice & Chat Interface',
      });
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12000);
    fetchOptions.signal = controller.signal;

    const response = await fetch(webhookUrl, fetchOptions);
    clearTimeout(timeout);

    const latencyMs = Date.now() - startTime;
    const contentType = response.headers.get('content-type') || '';
    let responseData: any = null;

    if (contentType.includes('application/json')) {
      try {
        responseData = await response.json();
      } catch {
        responseData = await response.text();
      }
    } else {
      responseData = await response.text();
    }

    res.json({
      ok: response.ok,
      status: response.status,
      statusText: response.statusText,
      latencyMs,
      contentType,
      data: responseData,
    });
  } catch (error: any) {
    const latencyMs = Date.now() - startTime;
    res.status(502).json({
      ok: false,
      error: error.message || 'Failed to connect to n8n webhook',
      latencyMs,
      isTimeout: error.name === 'AbortError',
    });
  }
});

// Dispatch message to n8n Webhook node and return the workflow response
app.post('/api/n8n/dispatch', async (req, res) => {
  const {
    webhookUrl,
    method = 'POST',
    headers = {},
    customBody = {},
    userMessage = '',
    inputMode = 'text',
    sessionId = 'session-default',
    nodeEndpointId = '',
  } = req.body;

  let n8nResponseData: any = null;
  let n8nStatus: number | null = null;
  let n8nLatencyMs: number | null = null;
  let n8nError: string | null = null;
  let n8nReachable = false;

  const startTime = Date.now();

  if (webhookUrl && typeof webhookUrl === 'string' && webhookUrl.trim().length > 0) {
    try {
      const parsedUrl = webhookUrl.trim();
      const fetchHeaders: Record<string, string> = {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/plain, */*',
        'User-Agent': 'n8n-AI-Voice-Interface/1.0',
        ...headers,
      };

      const payload = {
        message: userMessage,
        query: userMessage,
        sessionId,
        nodeEndpointId,
        inputMode,
        timestamp: new Date().toISOString(),
        ...customBody,
      };

      const fetchOptions: RequestInit = {
        method: method.toUpperCase(),
        headers: fetchHeaders,
      };

      if (fetchOptions.method !== 'GET' && fetchOptions.method !== 'HEAD') {
        fetchOptions.body = JSON.stringify(payload);
      }

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 20000);
      fetchOptions.signal = controller.signal;

      const response = await fetch(parsedUrl, fetchOptions);
      clearTimeout(timeout);

      n8nLatencyMs = Date.now() - startTime;
      n8nStatus = response.status;
      n8nReachable = true;

      const contentType = response.headers.get('content-type') || '';
      if (contentType.includes('application/json')) {
        try {
          n8nResponseData = await response.json();
        } catch {
          n8nResponseData = await response.text();
        }
      } else {
        n8nResponseData = await response.text();
      }
    } catch (err: any) {
      n8nLatencyMs = Date.now() - startTime;
      n8nError = err.message || 'Unable to connect to n8n webhook';
    }
  }

  let extractedReplyText = '';

  if (n8nResponseData !== null) {
    if (typeof n8nResponseData === 'string') {
      extractedReplyText = n8nResponseData;
    } else if (typeof n8nResponseData === 'object') {
      if (typeof n8nResponseData.output === 'string') {
        extractedReplyText = n8nResponseData.output;
      } else if (typeof n8nResponseData.reply === 'string') {
        extractedReplyText = n8nResponseData.reply;
      } else if (typeof n8nResponseData.response === 'string') {
        extractedReplyText = n8nResponseData.response;
      } else if (typeof n8nResponseData.message === 'string') {
        extractedReplyText = n8nResponseData.message;
      } else if (typeof n8nResponseData.text === 'string') {
        extractedReplyText = n8nResponseData.text;
      } else if (Array.isArray(n8nResponseData) && n8nResponseData.length > 0) {
        const first = n8nResponseData[0];
        if (first?.json && typeof first.json === 'object') {
          extractedReplyText =
            first.json.output ||
            first.json.reply ||
            first.json.message ||
            first.json.text ||
            JSON.stringify(first.json, null, 2);
        } else if (typeof first === 'string') {
          extractedReplyText = first;
        } else {
          extractedReplyText = JSON.stringify(n8nResponseData, null, 2);
        }
      } else {
        extractedReplyText = JSON.stringify(n8nResponseData, null, 2);
      }
    }
  }

  const replyText = extractedReplyText ||
    (n8nReachable ? 'Workflow executed successfully.' : n8nError ? `Error contacting n8n node: ${n8nError}` : 'Webhook received.');

  res.json({
    ok: n8nReachable,
    n8n: {
      reachable: n8nReachable,
      status: n8nStatus,
      latencyMs: n8nLatencyMs,
      error: n8nError,
      data: n8nResponseData,
    },
    reply: {
      text: replyText,
      rawOutput: extractedReplyText,
      aiEnhanced: false,
    },
  });
});

async function startServer() {
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
