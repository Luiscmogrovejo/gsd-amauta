#!/usr/bin/env node

/**
 * GSD-Amauta MCP Server — stdio JSON-RPC transport
 *
 * Implements the Model Context Protocol for Claude Code integration.
 * Each tool is a thin proxy to the Amauta daemon HTTP API on :18799.
 *
 * Zero external dependencies — uses only Node.js built-ins.
 */

'use strict';

const readline = require('readline');
const http = require('http');

// ─── Constants ──────────────────────────────────────────────────────────────

const DAEMON_HOST = '127.0.0.1';
const DAEMON_PORT = 18799;
const DAEMON_TIMEOUT = 5000;

const SERVER_INFO = {
  name: 'gsd-amauta',
  version: '2.0.0',
};

const PROTOCOL_VERSION = '2024-11-05';

// ─── Tool Definitions ───────────────────────────────────────────────────────

const TOOLS = [
  {
    name: 'memory-search',
    description: 'Search GSD-Amauta persistent memory for past learnings',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query' },
        limit: { type: 'number', description: 'Max results (default 10)' },
      },
      required: ['query'],
    },
  },
  {
    name: 'memory-store',
    description: 'Store a learning in GSD-Amauta persistent memory',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'The learning to store' },
        source: {
          type: 'string',
          description: 'Source type: lesson-learned, session-learning, auto_learning',
        },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: 'Tags for categorization',
        },
      },
      required: ['text'],
    },
  },
  {
    name: 'task-list',
    description: 'List tasks from GSD-Amauta task manager',
    inputSchema: {
      type: 'object',
      properties: {
        status: {
          type: 'string',
          description: 'Filter by status: pending, in-progress, done, all',
        },
        limit: { type: 'number', description: 'Max results (default 20)' },
      },
    },
  },
  {
    name: 'task-status',
    description: "Update a task's status in GSD-Amauta",
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: 'Task ID (e.g., TK-0001)' },
        status: { type: 'string', description: 'New status: pending, in-progress, done' },
      },
      required: ['task_id', 'status'],
    },
  },
  {
    name: 'rpetd-log',
    description: 'Log an RPETD phase for a task',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: 'Task ID' },
        phase: {
          type: 'string',
          enum: ['R', 'P', 'E', 'T', 'D'],
          description: 'RPETD phase',
        },
        content: { type: 'string', description: 'Phase content/evidence' },
      },
      required: ['task_id', 'phase', 'content'],
    },
  },
  {
    name: 'system-status',
    description: 'Get GSD-Amauta system health status',
    inputSchema: { type: 'object', properties: {} },
  },
];

// ─── Daemon HTTP Client ─────────────────────────────────────────────────────

function callDaemon(method, path, body = null) {
  return new Promise((resolve) => {
    const options = {
      hostname: DAEMON_HOST,
      port: DAEMON_PORT,
      path,
      method,
      headers: { 'Content-Type': 'application/json' },
      timeout: DAEMON_TIMEOUT,
    };
    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch {
          resolve({ raw: data });
        }
      });
    });
    req.on('error', () => resolve({ error: 'daemon_unavailable', hint: 'Start the daemon with: amauta daemon start' }));
    req.on('timeout', () => {
      req.destroy();
      resolve({ error: 'daemon_timeout', hint: 'Daemon did not respond within 5s' });
    });
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

// ─── Tool Handlers ──────────────────────────────────────────────────────────

const TOOL_HANDLERS = {
  'memory-search': async (args) => {
    const result = await callDaemon('POST', '/api/memory/search', {
      query: args.query,
      limit: args.limit || 10,
    });
    return result;
  },

  'memory-store': async (args) => {
    const result = await callDaemon('POST', '/api/memory/store', {
      text: args.text,
      source: args.source || 'session-learning',
      tags: args.tags || [],
    });
    return result;
  },

  'task-list': async (args) => {
    const params = [];
    if (args.status && args.status !== 'all') params.push(`status=${encodeURIComponent(args.status)}`);
    const qs = params.length ? `?${params.join('&')}` : '';
    const result = await callDaemon('GET', `/api/list${qs}`);
    return result;
  },

  'task-status': async (args) => {
    const result = await callDaemon('POST', '/api/status', {
      id: args.task_id,
      status_to: args.status,
    });
    return result;
  },

  'rpetd-log': async (args) => {
    const result = await callDaemon('POST', '/api/rpetd', {
      id: args.task_id,
      phase: args.phase,
      content: args.content,
    });
    return result;
  },

  'system-status': async () => {
    const result = await callDaemon('GET', '/health');
    return result;
  },
};

// ─── JSON-RPC Helpers ───────────────────────────────────────────────────────

function jsonRpcResponse(id, result) {
  return JSON.stringify({ jsonrpc: '2.0', id, result });
}

function jsonRpcError(id, code, message) {
  return JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } });
}

// ─── MCP Protocol Handlers ──────────────────────────────────────────────────

async function handleRequest(msg) {
  const { id, method, params } = msg;

  // Notifications (no id) — acknowledge silently
  if (id === undefined || id === null) {
    if (method === 'notifications/initialized') {
      // Client acknowledged initialization — no response needed
      return null;
    }
    // Unknown notification — ignore
    return null;
  }

  switch (method) {
    case 'initialize': {
      return jsonRpcResponse(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {
          tools: {},
        },
        serverInfo: SERVER_INFO,
      });
    }

    case 'tools/list': {
      return jsonRpcResponse(id, { tools: TOOLS });
    }

    case 'tools/call': {
      const toolName = params && params.name;
      const toolArgs = (params && params.arguments) || {};
      const handler = TOOL_HANDLERS[toolName];

      if (!handler) {
        return jsonRpcError(id, -32602, `Unknown tool: ${toolName}`);
      }

      try {
        const result = await handler(toolArgs);
        const text = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
        return jsonRpcResponse(id, {
          content: [{ type: 'text', text }],
          isError: !!(result && result.error),
        });
      } catch (err) {
        return jsonRpcResponse(id, {
          content: [{ type: 'text', text: JSON.stringify({ error: err.message }) }],
          isError: true,
        });
      }
    }

    default: {
      return jsonRpcError(id, -32601, `Method not found: ${method}`);
    }
  }
}

// ─── stdio Transport ────────────────────────────────────────────────────────

function startServer() {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: false,
  });

  // Suppress readline output — we write directly to stdout
  rl.output = null;

  let buffer = '';

  process.stdin.on('data', (chunk) => {
    buffer += chunk.toString();

    // Process all complete JSON-RPC messages in the buffer.
    // MCP uses newline-delimited JSON over stdio.
    let newlineIdx;
    while ((newlineIdx = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newlineIdx).trim();
      buffer = buffer.slice(newlineIdx + 1);

      if (!line) continue;

      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        const errResp = jsonRpcError(null, -32700, 'Parse error');
        process.stdout.write(errResp + '\n');
        continue;
      }

      handleRequest(msg).then((response) => {
        if (response !== null) {
          process.stdout.write(response + '\n');
        }
      });
    }
  });

  process.stdin.on('end', () => {
    process.exit(0);
  });

  // Prevent unhandled rejections from crashing the server
  process.on('unhandledRejection', (err) => {
    process.stderr.write(`[gsd-amauta-mcp] unhandled rejection: ${err}\n`);
  });
}

// ─── Entry Point ────────────────────────────────────────────────────────────

startServer();
