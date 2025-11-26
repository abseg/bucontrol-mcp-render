/**
 * Lighting Tools
 * Control Lutron lighting
 */

export const lightingTools = [
  {
    name: 'set_lights',
    aliases: ['set_lighting_level'],
    description: 'Set lighting level 0-100. Use negative values for relative dimming (e.g., -20 to dim by 20%).',
    voiceDescription: 'Set lighting level. Use absolute (0-100) or relative (-20 to dim, +20 to brighten). Use when user says "Lights to 50", "Dim the lights", "Brighten", "Lights off".',
    inputSchema: {
      type: 'object',
      properties: {
        level: {
          oneOf: [
            { type: 'number', description: '0-100 for absolute, or negative to dim relatively' },
            { type: 'string', description: '+20 to brighten, -20 to dim' }
          ]
        }
      },
      required: ['level']
    },
    handler: async (args, ctx) => {
      let level = args.level;
      const state = await ctx.ws.getState();
      const currentLevel = state.lightingLevel ?? 100;

      // Handle relative adjustments
      if (typeof level === 'string') {
        if (level.startsWith('+') || level.startsWith('-')) {
          const delta = parseInt(level);
          level = currentLevel + delta;
        } else {
          level = parseInt(level);
        }
      } else if (typeof level === 'number' && level < 0 && level > -100) {
        // Small negative = relative decrease
        level = currentLevel + level;
      }

      // Clamp to valid range
      level = Math.max(0, Math.min(100, level));

      await ctx.ws.sendControl('lighting', 'ZoneDimLevel1', level);
      return { success: true, level };
    },
    formatVoice: (result) => {
      if (result.level === 0) return 'Lights off.';
      if (result.level === 100) return 'Full brightness.';
      return 'Done.';
    }
  },

  {
    name: 'get_lights',
    aliases: ['get_lighting_level'],
    description: 'Get current lighting level',
    inputSchema: { type: 'object', properties: {} },
    handler: async (args, ctx) => {
      const state = await ctx.ws.getState();
      return { level: state.lightingLevel };
    },
    formatVoice: (result) => {
      if (result.level === 0) return 'Lights are off.';
      if (result.level === 100) return 'Lights at full brightness.';
      return `Lights at ${Math.round(result.level)} percent.`;
    }
  }
];

export default lightingTools;
