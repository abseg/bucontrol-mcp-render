#!/usr/bin/env node

/**
 * Remote MCP Server Wrapper for Claude Desktop
 *
 * This wrapper allows Claude Desktop to connect to the remote SSE endpoint
 * by proxying the stdio transport to HTTP SSE.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

const REMOTE_URL = 'https://cold-chicken-allow.loca.lt/sse';
const API_KEY = 'Rw3L7PBF5WW+78u8JnFfs9cm+sLzm2zFdQCXr172XoI=';

async function main() {
  console.error('[Remote Wrapper] Connecting to remote MCP server...');
  console.error(`[Remote Wrapper] URL: ${REMOTE_URL}`);

  try {
    // Create client to connect to remote server
    const transport = new SSEClientTransport(
      new URL(REMOTE_URL),
      {
        headers: {
          'x-api-key': API_KEY,
          'bypass-tunnel-reminder': 'true'
        }
      }
    );

    const client = new Client(
      {
        name: 'claude-desktop-remote',
        version: '1.0.0'
      },
      {
        capabilities: {}
      }
    );

    await client.connect(transport);
    console.error('[Remote Wrapper] Connected to remote server');

    // Create stdio transport for Claude Desktop
    const stdioTransport = new StdioServerTransport();

    // Proxy requests between Claude Desktop and remote server
    // This is a simplified version - you may need to implement
    // proper request/response forwarding

    console.error('[Remote Wrapper] Ready for Claude Desktop');

    // Keep alive
    await new Promise(() => {});

  } catch (error) {
    console.error('[Remote Wrapper] Error:', error.message);
    process.exit(1);
  }
}

main();
