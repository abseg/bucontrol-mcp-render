/**
 * Component Tools (Advanced)
 * Low-level access to Q-SYS components
 */

export const componentTools = [
  {
    name: 'list_components',
    description: 'List all discovered Q-SYS components. Optional filter by name.',
    voiceEnabled: false,
    inputSchema: {
      type: 'object',
      properties: {
        filter: { type: 'string', description: 'Filter by component name' }
      }
    },
    handler: async (args, ctx) => {
      let list = Object.values(ctx.ws.discoveredComponents.list);
      if (args.filter) {
        const filter = args.filter.toLowerCase();
        list = list.filter(c => c.name.toLowerCase().includes(filter));
      }
      return {
        count: list.length,
        components: list.map(c => ({
          id: c.id,
          name: c.name,
          controlCount: Object.keys(c.controls).length
        }))
      };
    }
  },

  {
    name: 'get_component_details',
    description: 'Get component details including all controls. Automatically subscribes to receive updates for this component.',
    voiceEnabled: false,
    inputSchema: {
      type: 'object',
      properties: {
        componentName: { type: 'string' }
      },
      required: ['componentName']
    },
    handler: async (args, ctx) => {
      const component = ctx.ws.findComponent(args.componentName);
      if (!component) throw new Error(`Component not found: ${args.componentName}`);

      // Subscribe to this component for state updates (on-demand)
      try {
        await ctx.ws.subscribeToComponent(component.id);
      } catch (e) {
        // Non-fatal - we still return the cached data
        console.warn(`[Components] Subscribe warning for ${component.id}: ${e.message}`);
      }

      return { id: component.id, name: component.name, controls: component.controls };
    }
  },

  {
    name: 'get_control',
    description: 'Get a specific control value from a component. Automatically subscribes to receive updates for this control.',
    voiceEnabled: false,
    inputSchema: {
      type: 'object',
      properties: {
        componentName: { type: 'string', description: 'Name of the component' },
        controlId: { type: 'string', description: 'ID of the control to get' }
      },
      required: ['componentName', 'controlId']
    },
    handler: async (args, ctx) => {
      const component = ctx.ws.findComponent(args.componentName);
      if (!component) throw new Error(`Component not found: ${args.componentName}`);

      const control = component.controls[args.controlId];
      if (!control) throw new Error(`Control not found: ${args.controlId}`);

      // Subscribe to this specific control for updates (on-demand)
      try {
        await ctx.ws.subscribeToControl(component.id, args.controlId);
      } catch (e) {
        // Non-fatal - we still return the cached data
        console.warn(`[Components] Subscribe warning for ${component.id}:${args.controlId}: ${e.message}`);
      }

      return {
        componentId: component.id,
        componentName: component.name,
        controlId: args.controlId,
        control
      };
    }
  },

  {
    name: 'set_control_generic',
    description: 'Set any control value on any component. Automatically subscribes to receive updates for this control.',
    voiceEnabled: false,
    inputSchema: {
      type: 'object',
      properties: {
        componentName: { type: 'string' },
        controlId: { type: 'string' },
        value: {}
      },
      required: ['componentName', 'controlId', 'value']
    },
    handler: async (args, ctx) => {
      const component = ctx.ws.findComponent(args.componentName);
      if (!component) throw new Error(`Component not found: ${args.componentName}`);
      await ctx.ws.sendControl(component.id, args.controlId, args.value);

      // Subscribe to this control for future updates (on-demand)
      try {
        await ctx.ws.subscribeToControl(component.id, args.controlId);
      } catch (e) {
        // Non-fatal
        console.warn(`[Components] Subscribe warning after set: ${e.message}`);
      }

      return { success: true, component: component.name, controlId: args.controlId };
    }
  }
];

export default componentTools;
