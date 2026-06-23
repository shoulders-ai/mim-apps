export const tools = {
  analyze: {
    name: 'word_count_2.analyze',
    label: 'Analyze word count',
    description: 'Count words, characters, and lines in pasted text or a workspace text file.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Text to count directly.' },
        path: { type: 'string', description: 'Workspace text file to read when text is omitted.' },
      },
    },
    async execute(ctx, input) {
      let source = 'text'
      let text = typeof input.text === 'string' ? input.text : ''
      const path = typeof input.path === 'string' ? input.path.trim() : ''
      if (!text && path) {
        text = await ctx.files.readWorkspaceText(path)
        source = path
      }
      const trimmed = text.trim()
      const words = trimmed ? trimmed.split(/\s+/u).length : 0
      const lines = text.length ? text.split(/\r\n|\r|\n/u).length : 0
      return {
        source,
        words,
        characters: text.length,
        charactersNoSpaces: text.replace(/\s/gu, '').length,
        lines,
      }
    },
  },
}