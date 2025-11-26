/**
 * Screen Tools
 * Control HDMI display power
 */

export const screenTools = [
  {
    name: 'screen_power',
    aliases: ['set_screen_power'],
    description: 'Turn screen on or off',
    voiceDescription: 'Turn screen on or off. Use when user says "Turn on the screen" or "Screen off".',
    inputSchema: {
      type: 'object',
      properties: {
        on: { type: 'boolean', description: 'true to turn on, false to turn off' }
      },
      required: ['on']
    },
    handler: async (args, ctx) => {
      const on = args.on;
      const state = await ctx.ws.getState();
      const currentOn = state.screenPower === 1;

      // Idempotent check
      if (currentOn === on) {
        return { success: true, alreadySet: true, enabled: on };
      }

      await ctx.ws.sendControl('hdmiDisplay', 'hdmi.enabled.button', on ? 1 : 0);
      return { success: true, enabled: on };
    },
    formatVoice: (result) => {
      if (result.alreadySet) {
        return result.enabled ? 'Already on.' : 'Already off.';
      }
      return 'Done.';
    }
  },

  {
    name: 'get_screen_power',
    description: 'Get screen power state',
    inputSchema: { type: 'object', properties: {} },
    handler: async (args, ctx) => {
      const state = await ctx.ws.getState();
      return { enabled: state.screenPower === 1 };
    },
    formatVoice: (result) => {
      return result.enabled ? 'Screen is on.' : 'Screen is off.';
    }
  }
];

export default screenTools;
