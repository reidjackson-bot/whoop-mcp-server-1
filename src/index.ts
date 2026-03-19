import express from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { WhoopClient } from './whoop-client.js';

const PORT = parseInt(process.env.PORT || '3000', 10);
const WHOOP_CLIENT_ID = process.env.WHOOP_CLIENT_ID;
const WHOOP_CLIENT_SECRET = process.env.WHOOP_CLIENT_SECRET;
const WHOOP_REDIRECT_URI = process.env.WHOOP_REDIRECT_URI;

if (!WHOOP_CLIENT_ID || !WHOOP_CLIENT_SECRET || !WHOOP_REDIRECT_URI) {
  console.error('Missing required environment variables: WHOOP_CLIENT_ID, WHOOP_CLIENT_SECRET, WHOOP_REDIRECT_URI');
  process.exit(1);
}

const whoopClient = new WhoopClient(WHOOP_CLIENT_ID, WHOOP_CLIENT_SECRET, WHOOP_REDIRECT_URI);

function createServer(): McpServer {
  const server = new McpServer({
    name: 'whoop-mcp',
    version: '1.0.0',
  });

  server.tool(
    'whoop_get_today',
    'Get today\'s WHOOP summary including recovery score, HRV, RHR, sleep performance, strain, and workouts.',
    {},
    async () => {
      const summary = await whoopClient.getTodaySummary();
      return { content: [{ type: 'text', text: summary }] };
    }
  );

  server.tool(
    'whoop_get_recovery',
    'Get WHOOP recovery data including recovery score, HRV, RHR, SpO2, and skin temperature.',
    {
      start_date: z.string().optional().describe('Start date YYYY-MM-DD'),
      end_date: z.string().optional().describe('End date YYYY-MM-DD'),
    },
    async ({ start_date, end_date }) => {
      const recoveries = await whoopClient.getRecovery(start_date, end_date);
      return { content: [{ type: 'text', text: JSON.stringify(recoveries, null, 2) }] };
    }
  );

  server.tool(
    'whoop_get_sleep',
    'Get WHOOP sleep data including duration, stages, efficiency, performance, and respiratory rate.',
    {
      start_date: z.string().optional().describe('Start date YYYY-MM-DD'),
      end_date: z.string().optional().describe('End date YYYY-MM-DD'),
    },
    async ({ start_date, end_date }) => {
      const sleeps = await whoopClient.getSleep(start_date, end_date);
      return { content: [{ type: 'text', text: JSON.stringify(sleeps, null, 2) }] };
    }
  );

  server.tool(
    'whoop_get_strain',
    'Get WHOOP strain and cycle data including day strain score, calories, heart rate.',
    {
      start_date: z.string().optional().describe('Start date YYYY-MM-DD'),
      end_date: z.string().optional().describe('End date YYYY-MM-DD'),
    },
    async ({ start_date, end_date }) => {
      const cycles = await whoopClient.getCycles(start_date, end_date);
      return { content: [{ type: 'text', text: JSON.stringify(cycles, null, 2) }] };
    }
  );

  server.tool(
    'whoop_get_workouts',
    'Get WHOOP workout data including strain, heart rate zones, duration, and calories.',
    {
      start_date: z.string().optional().describe('Start date YYYY-MM-DD'),
      end_date: z.string().optional().describe('End date YYYY-MM-DD'),
    },
    async ({ start_date, end_date }) => {
      const workouts = await whoopClient.getWorkouts(start_date, end_date);
      return { content: [{ type: 'text', text: JSON.stringify(workouts, null, 2) }] };
    }
  );

  return server;
}

const app = express();
app.use(express.json());

app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    authenticated: whoopClient.isAuthenticated,
    timestamp: new Date().toISOString()
  });
});

app.get('/auth', (_req, res) => {
  const authUrl = whoopClient.getAuthUrl();
  res.redirect(authUrl);
});

app.get('/callback', async (req, res) => {
  const code = req.query.code as string;
  if (!code) {
    res.status(400).json({ error: 'Missing authorization code' });
    return;
  }
  try {
    await whoopClient.exchangeCode(code);
    res.json({ status: 'success', message: 'WHOOP account connected! You can close this window.' });
  } catch (error) {
    console.error('[AUTH] Error exchanging code:', error);
    res.status(500).json({ error: 'Failed to exchange authorization code', details: String(error) });
  }
});

app.post('/mcp', async (req, res) => {
  try {
    const server = createServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });

    res.on('close', () => {
      transport.close().catch(() => {});
      server.close().catch(() => {});
    });

    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    console.error('[MCP] Error handling request:', error);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: '2.0',
        error: { code: -32603, message: 'Internal server error' },
        id: null,
      });
    }
  }
});

app.get('/mcp', async (_req, res) => {
  res.writeHead(405).end(JSON.stringify({
    jsonrpc: '2.0',
    error: { code: -32000, message: 'Method not allowed. Use POST.' },
    id: null,
  }));
});

app.delete('/mcp', async (_req, res) => {
  res.writeHead(405).end(JSON.stringify({
    jsonrpc: '2.0',
    error: { code: -32000, message: 'Session management not supported.' },
    id: null,
  }));
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`[WHOOP MCP] Server running on http://0.0.0.0:${PORT}`);
  console.log(`[WHOOP MCP] MCP endpoint: http://0.0.0.0:${PORT}/mcp`);
  console.log(`[WHOOP MCP] Health check: http://0.0.0.0:${PORT}/health`);
  console.log(`[WHOOP MCP] Auth: http://0.0.0.0:${PORT}/auth`);
});
