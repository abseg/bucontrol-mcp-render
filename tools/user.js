/**
 * User Tools
 * Microsoft Graph integration, authentication, file access
 */

// Token storage (injected from server)
let msGraphTokens = null;

export function setTokenStorage(storage) {
  msGraphTokens = storage;
}

// Helper to call Microsoft Graph API
async function callGraphAPI(endpoint, options = {}) {
  if (!msGraphTokens?.current) {
    throw new Error('No Microsoft account signed in. Please sign in from the room display.');
  }

  if (Date.now() > msGraphTokens.current.expiresAt) {
    throw new Error('Microsoft token expired. Please sign in again from the room display.');
  }

  const url = endpoint.startsWith('http') ? endpoint : `https://graph.microsoft.com/v1.0${endpoint}`;

  const response = await fetch(url, {
    ...options,
    headers: {
      'Authorization': `Bearer ${msGraphTokens.current.accessToken}`,
      'Content-Type': 'application/json',
      ...options.headers
    }
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: { message: response.statusText } }));
    throw new Error(error.error?.message || `Graph API error: ${response.status}`);
  }

  return response.json();
}

export const userTools = [
  {
    name: 'get_auth_status',
    description: 'Check if a Microsoft user is signed in',
    inputSchema: { type: 'object', properties: {} },
    handler: async () => {
      if (!msGraphTokens?.current) {
        return { authenticated: false };
      }
      const isExpired = Date.now() > msGraphTokens.current.expiresAt;
      return {
        authenticated: !isExpired,
        user: msGraphTokens.current.user?.displayName,
        expiresAt: msGraphTokens.current.expiresAt,
        isExpired
      };
    },
    formatVoice: (result) => {
      if (!result.authenticated) return 'No one is signed in.';
      return `Signed in as ${result.user}.`;
    }
  },

  {
    name: 'sign_out',
    description: 'Clear Microsoft authentication tokens',
    inputSchema: { type: 'object', properties: {} },
    handler: async () => {
      if (msGraphTokens) {
        msGraphTokens.current = null;
      }
      return { success: true };
    },
    formatVoice: () => 'Signed out.'
  },

  {
    name: 'get_user',
    aliases: ['graph_get_user'],
    description: 'Get signed-in Microsoft user info',
    inputSchema: { type: 'object', properties: {} },
    handler: async () => {
      const user = await callGraphAPI('/me');
      return {
        displayName: user.displayName,
        email: user.mail || user.userPrincipalName,
        jobTitle: user.jobTitle,
        department: user.department
      };
    },
    formatVoice: (result) => `Signed in as ${result.displayName}.`
  },

  {
    name: 'list_recent_files',
    aliases: ['graph_list_recent_files'],
    description: 'List recently accessed files from OneDrive/SharePoint',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Max files to return (default 10)' }
      }
    },
    handler: async (args) => {
      const limit = args.limit || 10;
      const result = await callGraphAPI(`/me/drive/recent?$top=${limit}`);
      return {
        count: result.value.length,
        files: result.value.map(f => ({
          id: f.id,
          name: f.name,
          webUrl: f.webUrl,
          lastModified: f.lastModifiedDateTime,
          size: f.size,
          mimeType: f.file?.mimeType
        }))
      };
    },
    formatVoice: (result) => {
      if (result.count === 0) return 'No recent files found.';
      return `Found ${result.count} recent files.`;
    }
  },

  {
    name: 'list_presentations',
    aliases: ['graph_list_presentations'],
    description: 'List PowerPoint presentations from OneDrive',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Max files (default 10)' }
      }
    },
    handler: async (args) => {
      const limit = args.limit || 10;
      const result = await callGraphAPI(`/me/drive/root/search(q='.pptx')?$top=50`);
      const files = result.value
        .filter(f => f.name.toLowerCase().endsWith('.pptx'))
        .sort((a, b) => new Date(b.lastModifiedDateTime || 0) - new Date(a.lastModifiedDateTime || 0))
        .slice(0, limit)
        .map(f => ({
          id: f.id,
          name: f.name,
          webUrl: f.webUrl,
          lastModified: f.lastModifiedDateTime,
          size: f.size
        }));
      return { count: files.length, presentations: files };
    },
    formatVoice: (result) => {
      if (result.count === 0) return 'No presentations found.';
      return `Found ${result.count} presentations.`;
    }
  },

  {
    name: 'list_keynotes',
    aliases: ['graph_list_keynotes'],
    description: 'List Keynote presentations (.key files) from OneDrive',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Max files (default 10)' }
      }
    },
    handler: async (args) => {
      const limit = args.limit || 10;
      const result = await callGraphAPI(`/me/drive/root/search(q='.key')?$top=50`);
      const files = result.value
        .filter(f => f.name.toLowerCase().endsWith('.key'))
        .sort((a, b) => new Date(b.lastModifiedDateTime || 0) - new Date(a.lastModifiedDateTime || 0))
        .slice(0, limit)
        .map(f => ({
          id: f.id,
          name: f.name,
          webUrl: f.webUrl,
          lastModified: f.lastModifiedDateTime,
          size: f.size
        }));
      return { count: files.length, keynotes: files };
    },
    formatVoice: (result) => {
      if (result.count === 0) return 'No Keynote files found.';
      return `Found ${result.count} Keynote files.`;
    }
  },

  {
    name: 'get_recent_presentations',
    aliases: ['graph_list_presentation_files'],
    description: 'Get recent presentation files (PPTX, PDF, KEY) sorted by modification date',
    voiceDescription: 'Get recent presentation files. Use when user says "I want to present" or "Show my presentations".',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Max files per type (default 5)' }
      }
    },
    handler: async (args) => {
      const limit = args.limit || 5;

      // Search for PPTX and PDF in parallel
      const [pptxResult, pdfResult] = await Promise.all([
        callGraphAPI(`/me/drive/root/search(q='.pptx')?$top=50`),
        callGraphAPI(`/me/drive/root/search(q='.pdf')?$top=50`)
      ]);

      const mapFile = (f, type) => ({
        id: f.id,
        name: f.name,
        webUrl: f.webUrl,
        lastModified: f.lastModifiedDateTime,
        size: f.size,
        type
      });

      const pptx = pptxResult.value
        .filter(f => f.name.toLowerCase().endsWith('.pptx'))
        .sort((a, b) => new Date(b.lastModifiedDateTime || 0) - new Date(a.lastModifiedDateTime || 0))
        .slice(0, limit)
        .map(f => mapFile(f, 'pptx'));

      const pdf = pdfResult.value
        .filter(f => f.name.toLowerCase().endsWith('.pdf'))
        .sort((a, b) => new Date(b.lastModifiedDateTime || 0) - new Date(a.lastModifiedDateTime || 0))
        .slice(0, limit)
        .map(f => mapFile(f, 'pdf'));

      return { pptx, pdf };
    },
    formatVoice: (result) => {
      const total = (result.pptx?.length || 0) + (result.pdf?.length || 0);
      if (total === 0) return 'No presentation files found.';

      const names = [...(result.pptx || []), ...(result.pdf || [])]
        .slice(0, 3)
        .map(f => f.name.replace(/\.(pptx|pdf)$/i, ''));

      if (names.length === 1) return `Found ${names[0]}.`;
      if (names.length === 2) return `Found ${names[0]} and ${names[1]}.`;
      return `Found ${names[0]}, ${names[1]}, and ${total - 2} more.`;
    }
  },

  {
    name: 'get_file_info',
    aliases: ['graph_get_file_info'],
    description: 'Get details about a specific file by ID',
    inputSchema: {
      type: 'object',
      properties: {
        fileId: { type: 'string' }
      },
      required: ['fileId']
    },
    handler: async (args) => {
      const file = await callGraphAPI(`/me/drive/items/${args.fileId}`);
      return {
        id: file.id,
        name: file.name,
        webUrl: file.webUrl,
        size: file.size,
        lastModified: file.lastModifiedDateTime,
        createdBy: file.createdBy?.user?.displayName,
        mimeType: file.file?.mimeType
      };
    }
  },

  {
    name: 'get_file_url',
    aliases: ['graph_get_file_content_url'],
    description: 'Get download URL for a file',
    inputSchema: {
      type: 'object',
      properties: {
        fileId: { type: 'string' }
      },
      required: ['fileId']
    },
    handler: async (args) => {
      const file = await callGraphAPI(`/me/drive/items/${args.fileId}`);
      return {
        id: file.id,
        name: file.name,
        downloadUrl: file['@microsoft.graph.downloadUrl'],
        webUrl: file.webUrl
      };
    }
  },

  {
    name: 'open_presentation',
    description: 'Switch to AppleTV source and return iOS Shortcut URL to open presentation',
    voiceDescription: 'Open a presentation file on the video wall via AppleTV. Use after user selects a file from get_recent_presentations.',
    inputSchema: {
      type: 'object',
      properties: {
        fileId: { type: 'string', description: 'File ID from get_recent_presentations' }
      },
      required: ['fileId']
    },
    handler: async (args, ctx) => {
      // Get file info
      const file = await callGraphAPI(`/me/drive/items/${args.fileId}`);

      // Switch to AppleTV (source 3)
      const cmd = 'BV1:E:A1:1:W1S3X0Y0W100H100A0';
      await ctx.ws.sendControl('videoWall', 'WindowCommand', cmd);

      // Build shortcut URL - the file will be downloaded via our proxy
      const mcpServerUrl = ctx.mcpServerUrl || 'https://app-b5fcfac3-3d40-4e67-8d47-3a357835d274.cleverapps.io';
      const fileUrl = `${mcpServerUrl}/files/${args.fileId}/download`;
      const shortcutUrl = `shortcuts://run-shortcut?name=Start%20Presentation&input=text&text=${encodeURIComponent(fileUrl)}`;

      return {
        success: true,
        fileName: file.name,
        source: 'AppleTV',
        shortcutUrl,
        instructions: 'Tap "Start Presentation" on the room display to begin.'
      };
    },
    formatVoice: (result) => {
      return `Ready to present ${result.fileName.replace(/\.(pptx|pdf|key)$/i, '')}. Tap Start Presentation on the display.`;
    }
  }
];

export default userTools;
