/**
 * Video Tools
 * Control video wall sources, layouts, DIDO output
 */
import { SOURCE_NAMES, SOURCE_IDS } from '../shared/constants.js';

export const videoTools = [
  {
    name: 'set_source',
    description: 'Switch video wall to a single source. Sources: 1=Laptop, 2=ClickShare, 3=AppleTV, 4=Conference',
    voiceDescription: 'Switch video wall source. Sources: 1=Laptop, 2=ClickShare, 3=AppleTV, 4=Conference. Use when user says "Show the laptop" or "Switch to AppleTV".',
    inputSchema: {
      type: 'object',
      properties: {
        source: {
          oneOf: [
            { type: 'number', description: '1=Laptop, 2=ClickShare, 3=AppleTV, 4=Conference' },
            { type: 'string', description: 'Source name: laptop, clickshare, appletv, conference' }
          ]
        }
      },
      required: ['source']
    },
    handler: async (args, ctx) => {
      let sourceId = args.source;

      // Handle string source names
      if (typeof sourceId === 'string') {
        sourceId = SOURCE_IDS[sourceId.toLowerCase()] || parseInt(sourceId);
      }

      if (isNaN(sourceId) || sourceId < 1 || sourceId > 4) {
        throw new Error('Invalid source. Use 1-4 or: laptop, clickshare, appletv, conference');
      }

      const state = await ctx.ws.getState();
      const currentSource = parseCurrentSource(state.hardwareState);

      // Idempotent check
      if (currentSource === sourceId) {
        return { success: true, alreadySet: true, source: sourceId, sourceName: SOURCE_NAMES[sourceId] };
      }

      // Build WindowCommand for single source fullscreen
      const cmd = `BV1:E:A1:1:W1S${sourceId}X0Y0W100H100A0`;
      await ctx.ws.sendControl('videoWall', 'WindowCommand', cmd);

      return { success: true, source: sourceId, sourceName: SOURCE_NAMES[sourceId] };
    },
    formatVoice: (result) => {
      if (result.alreadySet) {
        return `Already on ${result.sourceName}.`;
      }
      return 'Done.';
    }
  },

  {
    name: 'list_sources',
    aliases: ['list_video_sources'],
    description: 'List video sources and their connection status',
    voiceDescription: 'List available video sources and connection status. Use when user asks "What sources are available?"',
    inputSchema: { type: 'object', properties: {} },
    handler: async (args, ctx) => {
      const state = await ctx.ws.getState();
      const sources = state.connectedSources || [];

      return {
        status: sources.length > 0 ? 'success' : 'unknown',
        sources: sources.map((s, i) => ({
          id: i + 1,
          name: SOURCE_NAMES[i + 1],
          connected: s.connected,
          snapshotUrl: s.snapshotUrl,
          proxiedPreviewUrl: s.proxiedPreviewUrl
        }))
      };
    },
    formatVoice: (result) => {
      if (!result.sources || result.sources.length === 0) {
        return 'No sources detected.';
      }
      const status = result.sources.map(s =>
        `${s.name} ${s.connected ? 'connected' : 'not connected'}`
      );
      return `${result.sources.length} sources: ${status.join(', ')}.`;
    }
  },

  {
    name: 'set_layout',
    description: 'Set video wall layout with multiple windows for PiP, split screen, etc.',
    voiceDescription: 'Set video wall layout with multiple windows. Sources: 1=Laptop, 2=ClickShare, 3=AppleTV, 4=Conference. Use when user wants picture-in-picture, split screen, or overlay layouts.',
    inputSchema: {
      type: 'object',
      properties: {
        windows: {
          type: 'array',
          description: 'Array of windows to display (max 4)',
          items: {
            type: 'object',
            properties: {
              source: { type: 'number', description: '1=Laptop, 2=ClickShare, 3=AppleTV, 4=Conference' },
              x: { type: 'number', description: 'X position 0-100%' },
              y: { type: 'number', description: 'Y position 0-100%' },
              width: { type: 'number', description: 'Width 0-100%' },
              height: { type: 'number', description: 'Height 0-100%' },
              opacity: { type: 'number', description: 'Opacity 0-100 (100=opaque)' }
            },
            required: ['source']
          }
        }
      },
      required: ['windows']
    },
    handler: async (args, ctx) => {
      const windows = args.windows;

      if (!windows || !Array.isArray(windows) || windows.length === 0) {
        throw new Error('No windows specified');
      }

      if (windows.length > 4) {
        throw new Error('Maximum 4 windows allowed');
      }

      // Build WindowCommand string
      const windowParts = windows.map((win, i) => {
        let sourceId = win.source;

        if (typeof sourceId === 'string') {
          sourceId = SOURCE_IDS[sourceId.toLowerCase()] || parseInt(sourceId);
        }

        if (isNaN(sourceId) || sourceId < 1 || sourceId > 4) {
          throw new Error(`Invalid source ${win.source}`);
        }

        const x = Math.max(0, Math.min(100, win.x || 0));
        const y = Math.max(0, Math.min(100, win.y || 0));
        const w = Math.max(1, Math.min(100, win.width || 100));
        const h = Math.max(1, Math.min(100, win.height || 100));
        // Opacity: 0 = transparent, 100 = opaque
        // WindowCommand: A0 = opaque, A100 = transparent (inverted)
        const opacity = win.opacity !== undefined ? win.opacity : 100;
        const alpha = 100 - Math.max(0, Math.min(100, opacity));

        return `W${i + 1}S${sourceId}X${x}Y${y}W${w}H${h}A${alpha}`;
      });

      const cmd = `BV1:E:A1:${windows.length}:${windowParts.join(':')}`;
      await ctx.ws.sendControl('videoWall', 'WindowCommand', cmd);

      return { success: true, windowCount: windows.length };
    },
    formatVoice: () => 'Done.'
  },

  {
    name: 'send_videowall_command',
    description: 'Send raw WindowCommand to video wall. Format: BV1:E:A1:1:W1S1X0Y0W100H100A0',
    voiceEnabled: false, // Not for voice - too technical
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Raw WindowCommand string' }
      },
      required: ['command']
    },
    handler: async (args, ctx) => {
      await ctx.ws.sendControl('videoWall', 'WindowCommand', args.command);
      return { success: true };
    }
  },

  {
    name: 'get_videowall_status',
    description: 'Get current video wall hardware state',
    inputSchema: { type: 'object', properties: {} },
    handler: async (args, ctx) => {
      const state = await ctx.ws.getState();
      return {
        status: state.hardwareState ? 'success' : 'unknown',
        hardwareState: state.hardwareState
      };
    },
    formatVoice: (result) => {
      if (!result.hardwareState) return 'Status unknown.';
      return `Video wall state: ${result.hardwareState}`;
    }
  },

  {
    name: 'dido_output',
    aliases: ['set_dido_output'],
    description: 'Enable or disable DIDO video output routing',
    voiceDescription: 'Enable or disable DIDO output routing. Use when user says "Enable output" or "Turn off DIDO".',
    inputSchema: {
      type: 'object',
      properties: {
        enabled: { type: 'boolean', description: 'true to enable, false to disable' }
      },
      required: ['enabled']
    },
    handler: async (args, ctx) => {
      const enabled = args.enabled;
      const state = await ctx.ws.getState();
      const currentEnabled = state.didoOutput === 1;

      if (currentEnabled === enabled) {
        return { success: true, alreadySet: true, enabled };
      }

      await ctx.ws.sendControl('hdmiDecoder', 'hdmi.out.1.select.hdmi.1', enabled ? 1 : 0);
      return { success: true, enabled };
    },
    formatVoice: (result) => {
      if (result.alreadySet) {
        return result.enabled ? 'Already enabled.' : 'Already disabled.';
      }
      return 'Done.';
    }
  },

  {
    name: 'get_dido_output',
    description: 'Get DIDO output state',
    inputSchema: { type: 'object', properties: {} },
    handler: async (args, ctx) => {
      const state = await ctx.ws.getState();
      return { enabled: state.didoOutput === 1 };
    },
    formatVoice: (result) => {
      return result.enabled ? 'DIDO output enabled.' : 'DIDO output disabled.';
    }
  },

  {
    name: 'describe_sources',
    description: 'Analyze what each source is showing using AI vision (Gemini)',
    voiceDescription: 'Analyze what each source is showing using AI vision. Use when user asks "What\'s on the laptop?", "Is there a presentation?"',
    inputSchema: {
      type: 'object',
      properties: {
        source: {
          type: 'number',
          description: 'Specific source to analyze (1-4). Omit to analyze all connected sources.'
        }
      }
    },
    handler: async (args, ctx) => {
      // This requires Gemini integration - delegated to specialized handler
      if (!ctx.geminiModel) {
        throw new Error('Vision not available. Set GEMINI_API_KEY.');
      }

      const state = await ctx.ws.getState();
      const sources = state.connectedSources || [];

      if (sources.length === 0) {
        return { descriptions: [], message: 'No sources detected.' };
      }

      // Determine which sources to analyze
      let toAnalyze = [];
      if (args.source) {
        const idx = args.source - 1;
        if (sources[idx] && sources[idx].connected && sources[idx].proxiedPreviewUrl) {
          toAnalyze = [{ index: idx, source: sources[idx] }];
        } else {
          throw new Error(`${SOURCE_NAMES[args.source]} not connected or no snapshot.`);
        }
      } else {
        sources.forEach((s, i) => {
          if (s.connected && s.proxiedPreviewUrl) {
            toAnalyze.push({ index: i, source: s });
          }
        });
      }

      if (toAnalyze.length === 0) {
        return { descriptions: [], message: 'No sources with snapshots available.' };
      }

      // Analyze each source with Gemini
      const descriptions = [];
      for (const item of toAnalyze) {
        try {
          const name = SOURCE_NAMES[item.index + 1];
          const frame = await ctx.grabMjpegFrame(item.source.proxiedPreviewUrl);
          const base64 = Buffer.from(await frame.arrayBuffer()).toString('base64');

          const result = await ctx.geminiModel.generateContent([
            'Describe what is shown on this screen in 10 words or less. Focus on: presentation type, video call, desktop, video content, app name. Be concise.',
            { inlineData: { mimeType: 'image/jpeg', data: base64 } }
          ]);

          descriptions.push({
            source: item.index + 1,
            name,
            description: result.response.text().trim()
          });
        } catch (error) {
          descriptions.push({
            source: item.index + 1,
            name: SOURCE_NAMES[item.index + 1],
            error: 'Analysis failed'
          });
        }
      }

      return { descriptions };
    },
    formatVoice: (result) => {
      if (result.message) return result.message;
      if (!result.descriptions || result.descriptions.length === 0) {
        return 'No sources to describe.';
      }
      return result.descriptions
        .map(d => `${d.name}: ${d.description || d.error}`)
        .join('. ') + '.';
    }
  }
];

// Helper to parse current source from hardware state
function parseCurrentSource(hardwareState) {
  if (!hardwareState) return null;
  const match = String(hardwareState).match(/W1S(\d)/);
  return match ? parseInt(match[1]) : null;
}

export default videoTools;
