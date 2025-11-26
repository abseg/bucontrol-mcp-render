/**
 * Unified Tool Registry
 * Single source of truth for all tools across MCP, Voice, and Stdio transports
 */
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
 * Execute a tool
 * @param {string} name - Tool name
 * @param {object} args - Tool arguments
 * @param {object} ctx - Execution context { transport: 'mcp'|'voice'|'stdio', ... }
 */
export async function executeTool(name, args = {}, ctx = {}) {
  const tool = getTool(name);
  if (!tool) {
    throw new Error(`Unknown tool: ${name}`);
  }

  // Execute handler
  const result = await tool.handler(args, {
    ws: wsManager,
    ...ctx
  });

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
