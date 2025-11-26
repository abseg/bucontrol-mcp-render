/**
 * Room Tools
 * Control privacy glass and other room features
 */

export const roomTools = [
  {
    name: 'privacy_glass',
    aliases: ['set_privacy_glass'],
    description: 'Set privacy glass frosted or clear',
    voiceDescription: 'Set privacy glass frosted or clear. Use when user says "Frost the glass" or "Make it clear".',
    inputSchema: {
      type: 'object',
      properties: {
        frosted: { type: 'boolean', description: 'true for frosted, false for clear' }
      },
      required: ['frosted']
    },
    handler: async (args, ctx) => {
      const frosted = args.frosted;
      const state = await ctx.ws.getState();
      const currentFrosted = state.privacyGlass === 1;

      if (currentFrosted === frosted) {
        return { success: true, alreadySet: true, frosted };
      }

      await ctx.ws.sendControl('gpio', 'pin.8.digital.out', frosted ? 1 : 0);
      return { success: true, frosted };
    },
    formatVoice: (result) => {
      if (result.alreadySet) {
        return result.frosted ? 'Already frosted.' : 'Already clear.';
      }
      return 'Done.';
    }
  },

  {
    name: 'get_privacy_glass',
    description: 'Get privacy glass state',
    inputSchema: { type: 'object', properties: {} },
    handler: async (args, ctx) => {
      const state = await ctx.ws.getState();
      return { frosted: state.privacyGlass === 1 };
    },
    formatVoice: (result) => {
      return result.frosted ? 'Glass is frosted.' : 'Glass is clear.';
    }
  }
];

export default roomTools;
