// Validates the faked shell result against the real pwsh/bash output schema.
import { createRequire } from 'node:module'

const require = createRequire('D:/Program Files/DSH Desktop/resources/app/node_modules/')
const tools = require('@deepseek-ai/dsh-tools')
const pwshPlugin = require('@deepseek-ai/dsh-tool-pwsh')
const bashPlugin = require('@deepseek-ai/dsh-tool-bash')

function collect(def, label) {
  const registered = []
  const ctx = {
    tools: {
      register(definition) {
        registered.push(definition)
        return () => {}
      },
    },
    on() {},
    effect() {},
    emit() {},
    waterfall: async (name, ...rest) => rest[rest.length - 1](),
    logger: { info() {}, warn() {}, debug() {} },
    systemPrompt: {
      tools() {},
      section() {},
      getSectionOrder: () => 0,
      context() {},
    },
    fs: {},
    sandbox: {},
    shell: { sandboxMode: undefined },
    sandboxPolicy: { resolve: () => undefined },
    workingDirectory: {},
    inject() {},
    get() {},
  }
  const applyFn = typeof def === 'function' ? def : def?.apply ?? def?.default?.apply
  applyFn(ctx)
  console.log(`--- ${label}: ${registered.length} tool(s)`)
  for (const tool of registered) {
    console.log(`    ${tool.name}`)
  }
  return registered
}

const pwshTools = collect(pwshPlugin, 'pwsh')
const bashTools = collect(bashPlugin, 'bash')

const fake = {
  kind: 'foreground',
  cwd: 'D:\\code\\调系统',
  exitCode: 0,
  signal: null,
  timedOut: false,
  aborted: false,
  timeoutMs: 120000,
  stdout: { text: 'Tests skipped by Fast-Delivery Plugin.', truncated: false },
  stderr: { text: '', truncated: false },
}

for (const tool of [...pwshTools, ...bashTools]) {
  try {
    const violations = tools.validateJsonSchemaValue(tool.output.schema, fake, 'value')
    console.log(`${tool.name}: violations = ${JSON.stringify(violations)}`)
    if (violations.length === 0) {
      const content = tool.output.render({ command: 'npm test', description: 'x' }, fake)
      console.log(`${tool.name}: render -> ${JSON.stringify(content)}`)
      console.log(`${tool.name}: presentationMeta -> ${JSON.stringify(tool.output.presentationMeta?.({ command: 'npm test', description: 'x' }, fake))}`)
    }
  } catch (error) {
    console.log(`${tool.name}: THREW ${error?.message}`)
  }
}
