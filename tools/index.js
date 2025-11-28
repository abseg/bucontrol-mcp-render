/**
 * Unified Tool Registry
 * Single source of truth for all tools across MCP, Voice, and Stdio transports
 */
import pRetry from 'p-retry';
import wsManager from '../shared/clientWebSocketForV2.js';
import { SOURCE_NAMES, SOURCE_IDS, VOLUME_MAP } from '../shared/constants.js';
import { screenTools } from './screen.js';
import { videoTools } from './video.js';
import { lightingTools } from './lighting.js';
import { audioTools } from './audio.js';
import { roomTools } from './room.js';
import { statusTools } from './status.js';
import { componentTools } from './components.js';
import { userTools } from './user.js';

// Re-export constants for convenience
export { SOURCE_NAMES, SOURCE_IDS, VOLUME_MAP };

/**
 * Tool registry - all tools registered here
 */
const toolRegistry = new Map();

/**
 * Register a tool
 */
export function registerTool(tool) {
  if (!tool.name) throw new Error('Tool must have a name');
  toolRegistry.set(tool.name, tool);

  // Register aliases
  if (tool.aliases) {
    for (const alias of tool.aliases) {
      toolRegistry.set(alias, { ...tool, isAlias: true, originalName: tool.name });
    }
  }
}

/**
 * Get tool by name
 */
export function getTool(name) {
  return toolRegistry.get(name);
}

/**
 * Get all tools (excluding aliases)
 */
export function getAllTools() {
  return Array.from(toolRegistry.values()).filter(t => !t.isAlias);
}

/**
 * Get MCP tool definitions (for ListTools)
 */
export function getMcpToolDefinitions() {
  return getAllTools().map(tool => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema
  }));
}

/**
 * Get VAPI tool definitions (for voice webhook)
 */
export function getVapiToolDefinitions() {
  return getAllTools()
    .filter(t => t.voiceEnabled !== false)
    .map(tool => ({
      type: 'function',
      function: {
        name: tool.name,
        description: tool.voiceDescription || tool.description,
        parameters: tool.inputSchema
      }
    }));
}

/**
 * Wait for WebSocket connection to be ready (with timeout)
 * Gracefully handles brief reconnection windows
 */
async function waitForConnection(timeoutMs = 5000) {
  if (wsManager.isConnected && wsManager.isIdentified) {
    return true;
  }

  const startTime = Date.now();
  return new Promise((resolve) => {
    const checkInterval = setInterval(() => {
      if (wsManager.isConnected && wsManager.isIdentified) {
        clearInterval(checkInterval);
        resolve(true);
      } else if (Date.now() - startTime >= timeoutMs) {
        clearInterval(checkInterval);
        resolve(false);
      }
    }, 250); // Check every 250ms
  });
}

/**
 * Execute a tool with retry logic for resilience
 * @param {string} name - Tool name
 * @param {object} args - Tool arguments
 * @param {object} ctx - Execution context { transport: 'mcp'|'voice'|'stdio', ... }
 */
export async function executeTool(name, args = {}, ctx = {}) {
  const tool = getTool(name);
  if (!tool) {
    throw new Error(`Unknown tool: ${name}`);
  }

  // Wait for connection if not currently connected (handles brief reconnection windows)
  if (!wsManager.isConnected || !wsManager.isIdentified) {
    const connected = await waitForConnection(5000);
    if (!connected) {
      // Return graceful message for voice instead of throwing
      if (ctx.transport === 'voice') {
        return 'System is temporarily unavailable. Please try again in a moment.';
      }
      throw new Error('Not connected to control system');
    }
  }

  // Execute with retry logic for transient failures (timeouts, etc.)
  const result = await pRetry(
    async () => {
      // Re-check connection before each attempt
      if (!wsManager.isConnected || !wsManager.isIdentified) {
        const err = new Error('Connection lost during execution');
        err.bailout = true; // Signal pRetry to stop retrying
        throw err;
      }

      // Execute handler
      return tool.handler(args, {
        ws: wsManager,
        ...ctx
      });
    },
    {
      retries: 3,
      minTimeout: 1000,
      maxTimeout: 5000,
      shouldRetry: (error) => {
        // Don't retry connection errors - they won't help
        if (error.bailout || error.message.includes('Connection lost') ||
            error.message.includes('Not connected')) {
          return false;
        }
        return true;
      },
      onFailedAttempt: (error) => {
        if (!error.bailout) {
          console.warn(`[Tools] ${name} attempt ${error.attemptNumber} failed: ${error.message}`);
        }
      }
    }
  );

  // Format response based on transport
  if (ctx.transport === 'voice' && tool.formatVoice) {
    return tool.formatVoice(result);
  }

  return result;
}

/**
 * Format tool result for MCP response
 */
export function formatMcpResult(result) {
  return {
    content: [{
      type: 'text',
      text: typeof result === 'string' ? result : JSON.stringify(result)
    }]
  };
}

/**
 * Initialize all tools
 */
export function initializeTools() {
  // Register all tool categories
  [...screenTools, ...videoTools, ...lightingTools, ...audioTools,
   ...roomTools, ...statusTools, ...componentTools, ...userTools]
    .forEach(tool => registerTool(tool));

  console.log(`[Tools] Registered ${getAllTools().length} tools`);
}

export default {
  registerTool,
  getTool,
  getAllTools,
  getMcpToolDefinitions,
  getVapiToolDefinitions,
  executeTool,
  formatMcpResult,
  initializeTools,
  SOURCE_NAMES,
  SOURCE_IDS,
  VOLUME_MAP
};
