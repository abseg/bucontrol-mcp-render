/**
 * Audio Tools
 * Control mixer volume
 */
import { VOLUME_MAP } from '../shared/constants.js';

export const audioTools = [
  {
    name: 'set_volume',
    description: 'Set volume level. Use dB value (-100 to +10) or preset name (mute, low, medium, high, max).',
    voiceDescription: 'Set volume level. Levels: mute, low, medium, high, max. Use when user says "Volume up" or "Mute".',
    inputSchema: {
      type: 'object',
      properties: {
        level: {
          oneOf: [
            { type: 'number', description: 'dB value (-100 to +10)' },
            { type: 'string', enum: ['mute', 'low', 'medium', 'high', 'max'], description: 'Preset level' }
          ]
        }
      },
      required: ['level']
    },
    handler: async (args, ctx) => {
      let level = args.level;
      let dbValue;

      if (typeof level === 'string') {
        dbValue = VOLUME_MAP[level.toLowerCase()];
        if (dbValue === undefined) {
          throw new Error('Invalid volume level. Use: mute, low, medium, high, max');
        }
      } else if (typeof level === 'number') {
        dbValue = Math.max(-100, Math.min(10, level));
      } else {
        throw new Error('Invalid volume level');
      }

      await ctx.ws.sendControl('mixer', 'output.1.gain', dbValue);

      // Find friendly name for response
      const levelName = Object.entries(VOLUME_MAP)
        .find(([, v]) => Math.abs(v - dbValue) < 2)?.[0];

      return { success: true, level: dbValue, levelName, unit: 'dB' };
    },
    formatVoice: (result) => {
      if (result.levelName === 'mute') return 'Muted.';
      if (result.levelName === 'max') return 'Maximum volume.';
      return 'Done.';
    }
  },

  {
    name: 'get_volume',
    description: 'Get current volume level',
    inputSchema: { type: 'object', properties: {} },
    handler: async (args, ctx) => {
      const state = await ctx.ws.getState();
      const dbValue = state.volumeLevel;

      // Find friendly name
      const levelName = Object.entries(VOLUME_MAP)
        .find(([, v]) => Math.abs(v - dbValue) < 5)?.[0];

      return { level: dbValue, levelName, unit: 'dB' };
    },
    formatVoice: (result) => {
      if (result.levelName === 'mute') return 'Volume is muted.';
      if (result.levelName) return `Volume is ${result.levelName}.`;
      return `Volume at ${result.level} dB.`;
    }
  }
];

export default audioTools;
