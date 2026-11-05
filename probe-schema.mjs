// Validates the apply_patch schema against dsh-tools' real compiler.
import { createRequire } from 'node:module'

const require = createRequire('D:/Program Files/DSH Desktop/resources/app/node_modules/')
const tools = require('@deepseek-ai/dsh-tools')

const valueSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    path: { type: 'string', required: true },
    blocks: { type: 'integer', required: true },
    replacements: { type: 'integer', required: true },
    before: { type: 'string', required: true },
    after: { type: 'string', required: true },
  },
}

const parameters = {
  file_path: { type: 'string', required: true },
  patch: { type: 'string', required: true },
  replace_all: { type: 'boolean' },
}

try {
  const tool = tools.defineTool({
    name: 'apply_patch',
    description: 'test',
    parameters,
    output: {
      schema: valueSchema,
      render: () => [{ type: 'text', text: 'ok' }],
      presentationMeta: () => ({ path: 'x' }),
    },
    async execute() {
      return { path: 'x', blocks: 1, replacements: 1, before: '', after: '' }
    },
  })
  console.log('COMPILED OK')
  console.log(JSON.stringify(tool.parameters, null, 2))
  console.log(JSON.stringify(tool.output.schema, null, 2))
} catch (error) {
  console.log('COMPILE FAILED:', error?.message)
  console.log(error?.stack)
}
