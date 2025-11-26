/**
 * Status Tools
 * Room status, connection status, help
 */
import { SOURCE_NAMES, VOLUME_MAP } from '../shared/constants.js';

export const statusTools = [
  {
    name: 'room_status',
    description: 'Get complete room status including screen, source, lights, volume, and glass',
    voiceDescription: 'Get current room status including screen, source, lights, volume, and glass. Use when user asks "What\'s the status?" or "Is everything on?"',
    inputSchema: { type: 'object', properties: {} },
    handler: async (args, ctx) => {
      const state = await ctx.ws.getState();

      // Parse current source from hardware state
      let currentSource = null;
      if (state.hardwareState) {
        const match = String(state.hardwareState).match(/W1S(\d)/);
        if (match) currentSource = parseInt(match[1]);
      }

      return {
        screen: state.screenPower === 1,
        source: currentSource,
        sourceName: currentSource ? SOURCE_NAMES[currentSource] : null,
        lights: state.lightingLevel,
        volume: state.volumeLevel,
        glass: state.privacyGlass === 1,
        dido: state.didoOutput === 1,
        connectedSources: state.connectedSources
      };
    },
    formatVoice: (result) => {
      const parts = [];

      // Screen and source
      if (result.screen) {
        parts.push(`Screen on, showing ${result.sourceName || `source ${result.source}`}`);
      } else {
        parts.push('Screen off');
      }

      // Lights
      if (result.lights === 0) {
        parts.push('lights off');
      } else if (result.lights === 100) {
        parts.push('lights full');
      } else {
        parts.push(`lights at ${Math.round(result.lights)} percent`);
      }

      // Volume
      const volName = Object.entries(VOLUME_MAP)
        .find(([, v]) => Math.abs(v - result.volume) < 5)?.[0];
      if (volName === 'mute') {
        parts.push('muted');
      } else if (volName) {
        parts.push(`volume ${volName}`);
      } else {
        parts.push(`volume ${result.volume} dB`);
      }

      // Glass
      parts.push(result.glass ? 'glass frosted' : 'glass clear');

      return parts.join(', ') + '.';
    }
  },

  {
    name: 'get_connection_status',
    description: 'Get WebSocket connection status',
    inputSchema: { type: 'object', properties: {} },
    handler: async (args, ctx) => {
      return {
        connected: ctx.ws.isConnected,
        identified: ctx.ws.isIdentified,
        components: Object.keys(ctx.ws.discoveredComponents.list).length
      };
    },
    formatVoice: (result) => {
      if (result.connected && result.identified) {
        return `Connected with ${result.components} components.`;
      }
      return 'Not connected.';
    }
  },

  {
    name: 'reconnect',
    description: 'Force WebSocket reconnection',
    voiceDescription: 'Reconnect to the room control system. Use when health is degraded or when told to reconnect.',
    inputSchema: { type: 'object', properties: {} },
    handler: async (args, ctx) => {
      await ctx.ws.reconnect();
      return {
        success: true,
        components: Object.keys(ctx.ws.discoveredComponents.list).length
      };
    },
    formatVoice: () => 'Reconnected.'
  },

  {
    name: 'get_help',
    description: 'Get usage instructions for the AV system',
    voiceDescription: 'Get detailed instructions on how to use the AV system. Use when user asks for help, is confused, or you are unsure what to do.',
    inputSchema: { type: 'object', properties: {} },
    handler: async () => {
      return {
        help: `I control the BUControl AV system. Here's what I can do:

VIDEO WALL:
- Show a source: "Show the laptop", "Switch to AppleTV"
- Sources: Laptop (1), ClickShare (2), AppleTV (3), Conference (4)
- Complex layouts: "Split screen laptop and conference", "Picture-in-picture with AppleTV in corner"
- Check what's showing: "What's on the laptop?", "Describe all sources"

LIGHTING:
- Set level: "Lights to 50 percent"
- Adjust: "Dim the lights", "Brighten"
- Off/On: "Lights off", "Full brightness"

VOLUME:
- Levels: "Mute", "Volume low", "Medium", "High", "Max"

OTHER:
- Screen: "Screen on", "Screen off"
- Privacy glass: "Frost the glass", "Clear the glass"
- Status: "What's the room status?"

What would you like to do?`
      };
    },
    formatVoice: (result) => result.help
  }
];

export default statusTools;
