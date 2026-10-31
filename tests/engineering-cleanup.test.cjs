const assert = require('node:assert/strict')
const { test } = require('node:test')
const { readFileSync } = require('node:fs')
const { EventEmitter } = require('node:events')
const { resolve, dirname, extname, join } = require('node:path')
const { transformSync } = require('esbuild')
const vue = require('vue')

function loadModule(path, mocks = {}, source = readFileSync(path, 'utf8'), cache = new Map()) {
  path = resolve(path)
  if (cache.has(path)) return cache.get(path).exports
  const { code } = transformSync(source, { format: 'cjs' })
  const module = { exports: {} }
  cache.set(path, module)
  new Function('require', 'module', 'exports', code)(
    (id) => {
      if (id in mocks) return mocks[id]
      if (!id.startsWith('.')) return require(id)
      const target = resolve(dirname(path), extname(id) ? id : `${id}.js`)
      return loadModule(target, mocks, readFileSync(target, 'utf8'), cache)
    },
    module,
    module.exports
  )
  return module.exports
}

function uploader(sftp) {
  class Client extends EventEmitter {
    connect() {
      queueMicrotask(() => this.emit('ready'))
    }
    sftp(callback) {
      callback(null, sftp)
    }
    end() {}
  }
  return loadModule('src/main/tunnelManager.js', {
    electron: { BrowserWindow: { getAllWindows: () => [] } },
    ssh2: { Client },
    'fs/promises': {
      stat: async (path) => ({
        isDirectory: () => path === '/local/dataset',
        isFile: () => path !== '/local/dataset',
        size: 12
      }),
      readdir: async () => [{ name: 'a.png' }, { name: 'b.png' }]
    }
  }).uploadTunnelFiles
}

const uploadConfig = { command: 'ssh test@example.invalid', sources: ['/local/dataset'] }

test('upload checks each parent once and accepts the remote root', async () => {
  for (const remoteDir of ['/data/output/', '/']) {
    const checks = [],
      created = [],
      uploaded = []
    const upload = uploader({
      stat(path, callback) {
        checks.push(path)
        callback(Object.assign(new Error('missing'), { code: 2 }))
      },
      mkdir(path, callback) {
        created.push(path)
        callback()
      },
      fastPut(_source, path, callback) {
        uploaded.push(path)
        callback()
      },
      end() {}
    })
    const result = await upload({ ...uploadConfig, remoteDir })
    assert.equal(result.uploaded, 2)
    assert.equal(new Set(checks).size, checks.length)
    assert.deepEqual(created, checks)
    assert.equal(checks.includes('/'), false)
    assert.equal(uploaded.length, 2)
  }
})

test('upload propagates permission errors and non-directory paths without mkdir retries', async () => {
  for (const permissionDenied of [true, false]) {
    let mkdirCalls = 0,
      putCalls = 0
    const upload = uploader({
      stat(_path, callback) {
        if (permissionDenied) callback(Object.assign(new Error('permission denied'), { code: 3 }))
        else callback(null, { isDirectory: () => false })
      },
      mkdir() {
        mkdirCalls++
      },
      fastPut() {
        putCalls++
      },
      end() {}
    })
    await assert.rejects(
      upload({ ...uploadConfig, remoteDir: '/data' }),
      permissionDenied ? /permission denied/ : /不是目录/
    )
    assert.equal(mkdirCalls, 0)
    assert.equal(putCalls, 0)
  }
})

// Mount the composable with Vue's real lifecycle and reactivity, without Electron or a DOM.
function mountBrowser(api) {
  global.window = { api }
  const renderer = vue.createRenderer({
    createComment: () => ({}),
    insert() {},
    remove() {},
    parentNode() {},
    nextSibling() {}
  })
  const { useImageBrowser } = loadModule('src/renderer/src/composables/useImageBrowser.js')
  let browser
  const app = renderer.createApp({
    setup() {
      browser = useImageBrowser()
      return () => null
    }
  })
  app.mount({})
  return { browser, unmount: () => app.unmount() }
}

test('selection derives from the current files, including empty folders and deletion', async () => {
  const { browser, unmount } = mountBrowser({
    onTaskProgress: () => () => {},
    readImages: async () => [{ path: 'a' }, { path: 'b' }]
  })
  try {
    browser.toggleSelectAll()
    assert.equal(browser.selectAll.value, false)
    await browser.loadInputFolder('folder')
    browser.toggleSelectAll()
    assert.equal(browser.selectAll.value, true)
    browser.removeDeletedImages(['a'])
    assert.deepEqual(browser.getTargetFiles(), ['b'])
    assert.equal(browser.selectAll.value, true)
    browser.removeDeletedImages(['b'])
    assert.equal(browser.selectAll.value, false)
  } finally {
    unmount()
  }
})

test('folder switches discard stale reads and thumbnail results; loading stays bounded', async () => {
  const reads = {},
    thumbnails = []
  const { browser, unmount } = mountBrowser({
    onTaskProgress: () => () => {},
    readImages: (path) =>
      new Promise((resolve) => {
        reads[path] = resolve
      }),
    generateThumbnail: (path) =>
      new Promise((resolve) => {
        thumbnails.push({ path, resolve })
      })
  })
  try {
    const first = browser.loadInputFolder('first')
    const second = browser.loadInputFolder('second')
    reads.second([{ path: 'new' }])
    await second
    reads.first([{ path: 'old' }])
    await first
    assert.equal(browser.images.value[0].path, 'new')
    for (let i = 0; i < 8; i++) browser.enqueueThumbnail(`image-${i}`)
    assert.equal(thumbnails.length, 6)
    thumbnails[0].resolve('thumbnail')
    await Promise.resolve()
    assert.equal(thumbnails.length, 7)
    const third = browser.loadInputFolder('third')
    reads.third([])
    await third
    for (const item of thumbnails) item.resolve('stale')
    await Promise.resolve()
    assert.deepEqual(Object.keys(browser.thumbnails), [])
    assert.equal(thumbnails.length, 7)
  } finally {
    unmount()
  }
})

test('Python IPC reports a connection failure without replaying the request', async (t) => {
  const handlers = new Map()
  const child = new EventEmitter()
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  let requests = 0,
    starts = 0
  t.mock.method(global, 'fetch', async () => {
    requests++
    throw new TypeError('fetch failed', { cause: { code: 'ECONNREFUSED' } })
  })
  const { registerIPC } = loadModule('src/main/ipc.js', {
    electron: {
      app: { on() {}, getAppPath: () => process.cwd() },
      ipcMain: { on() {}, handle: (name, handler) => handlers.set(name, handler) }
    },
    sharp: {},
    './localFiles': {},
    './tunnelManager': { registerTunnelIPC() {} },
    child_process: {
      spawnSync: () => ({ status: 0 }),
      spawn: () => {
        starts++
        queueMicrotask(() => child.stdout.emit('data', Buffer.from('PORT:12345')))
        return child
      }
    }
  })
  registerIPC()
  const result = await handlers.get('call-python')({ sender: { id: 1 } }, '/mirror-flip', {})
  assert.equal(result.success, false)
  assert.equal(result.error, 'fetch failed')
  assert.equal(requests, 1)
  assert.equal(starts, 1)
})

test('grid observes rendered cards and releases observation across KeepAlive transitions', async (t) => {
  const { parse, compileScript } = require('@vue/compiler-sfc')
  const { descriptor } = parse(readFileSync('src/renderer/src/components/ImageGrid.vue', 'utf8'))
  const script = compileScript(descriptor, { id: 'test-grid', inlineTemplate: true })
  const Grid = loadModule(
    'src/renderer/src/components/ImageGrid.vue',
    {
      './ImagePreview.vue': { render: () => null }
    },
    script.content
  ).default
  const observers = []
  const previousObserver = global.IntersectionObserver
  t.after(() => {
    global.IntersectionObserver = previousObserver
  })
  global.IntersectionObserver = class {
    constructor(callback) {
      this.callback = callback
      this.cards = []
      observers.push(this)
    }
    observe(card) {
      this.cards.push(card)
    }
    unobserve(card) {
      this.cards = this.cards.filter((item) => item !== card)
    }
    disconnect() {
      this.disconnected = true
    }
  }
  function element() {
    return {
      children: [],
      dataset: {},
      querySelectorAll() {
        return this.children.flatMap((child) => [
          ...(child.dataset.path ? [child] : []),
          ...child.querySelectorAll()
        ])
      }
    }
  }
  const body = element()
  function remove(node) {
    if (node.parent) node.parent.children.splice(node.parent.children.indexOf(node), 1)
  }
  const renderer = vue.createRenderer({
    createElement: element,
    createText: element,
    createComment: element,
    setText() {},
    setElementText() {},
    parentNode: (node) => node.parent,
    nextSibling: (node) => node.parent?.children[node.parent.children.indexOf(node) + 1],
    querySelector: () => body,
    patchProp(node, name, _old, value) {
      if (name === 'data-path') node.dataset.path = value
    },
    remove,
    insert(node, parent, anchor) {
      remove(node)
      node.parent = parent
      const index = anchor ? parent.children.indexOf(anchor) : parent.children.length
      parent.children.splice(index, 0, node)
    }
  })
  const images = vue.ref([]),
    active = vue.ref(true),
    thumbnails = vue.reactive({ cached: 'data:image' }),
    requested = []
  const app = renderer.createApp({
    render: () =>
      vue.h(vue.KeepAlive, null, {
        default: () =>
          active.value
            ? vue.h(Grid, {
                images: images.value,
                thumbnails,
                onLoadThumbnail: (path) => requested.push(path)
              })
            : null
      })
  })
  app.mount(element())
  try {
    images.value = [
      { path: 'new', name: 'new' },
      { path: 'cached', name: 'cached' }
    ]
    await vue.nextTick()
    const first = observers.at(-1)
    assert.deepEqual(
      first.cards.map((card) => card.dataset.path),
      ['new', 'cached']
    )
    first.callback(
      first.cards.map((target) => ({ target, isIntersecting: true })),
      first
    )
    assert.deepEqual(requested, ['new'])
    thumbnails.new = 'data:image'
    delete thumbnails.cached
    await vue.nextTick()
    // Cached cards must remain observed so they can reload after cache eviction.
    first.callback(
      first.cards.map((target) => ({ target, isIntersecting: true })),
      first
    )
    assert.deepEqual(requested, ['new', 'cached'])
    active.value = false
    await vue.nextTick()
    assert.equal(first.disconnected, true)
    active.value = true
    await vue.nextTick()
    const resumed = observers.at(-1)
    assert.notEqual(resumed, first)
    assert.deepEqual(
      resumed.cards.map((card) => card.dataset.path),
      ['new', 'cached']
    )
    images.value = []
    await vue.nextTick()
    assert.equal(resumed.disconnected, true)
  } finally {
    app.unmount()
  }
})

test('grab tasks share IPC cancellation and unregister when finished', async (t) => {
  const handlers = new Map(),
    progress = []
  let signal
  t.mock.method(global, 'fetch', (_url, options) => {
    signal = options.signal
    return new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true })
    })
  })
  const { registerIPC } = loadModule('src/main/ipc.js', {
    electron: {
      app: { on() {} },
      ipcMain: { on() {}, handle: (name, handler) => handlers.set(name, handler) }
    },
    sharp: {},
    './tunnelManager': { registerTunnelIPC() {} }
  })
  registerIPC()
  const event = { sender: { id: 7, send: (_channel, value) => progress.push(value) } }
  const request = handlers.get('scan-image-sources')(event, {
    sources: ['https://example.invalid/page']
  })
  assert.equal(signal.aborted, false)
  assert.equal((await handlers.get('abort-task')({ sender: { id: 8 } })).cancelled, false)
  assert.equal((await handlers.get('abort-task')(event)).cancelled, true)
  assert.equal((await request).aborted, true)
  assert.equal((await handlers.get('abort-task')(event)).cancelled, false)
  assert.equal(progress.at(-1).scope, 'grab-scan')
})

test('moving to del preserves existing files and reports access failures without fallback renames', async () => {
  const handlers = new Map(),
    moves = []
  const directory = resolve('test-fixture'),
    source = join(directory, 'photo.png')
  const existing = new Set([
    source,
    join(directory, 'del', 'photo.png'),
    join(directory, 'del', 'photo_2.png')
  ])
  let denied = false
  const { registerIPC } = loadModule('src/main/ipc.js', {
    electron: {
      app: { on() {} },
      ipcMain: { on() {}, handle: (name, handler) => handlers.set(name, handler) }
    },
    sharp: {},
    './tunnelManager': { registerTunnelIPC() {} },
    'fs/promises': {
      mkdir: async () => {},
      access: async (path) => {
        if (denied) throw Object.assign(new Error('permission denied'), { code: 'EACCES' })
        if (!existing.has(path)) throw Object.assign(new Error('missing'), { code: 'ENOENT' })
      },
      rename: async (from, to) => {
        assert.equal(existing.has(to), false)
        moves.push([from, to])
        existing.delete(from)
        existing.add(to)
      }
    }
  })
  registerIPC()
  assert.equal((await handlers.get('delete-image')({}, source)).success, true)
  assert.deepEqual(moves, [[source, join(directory, 'del', 'photo_3.png')]])
  assert.equal(existing.has(join(directory, 'del', 'photo.png')), true)
  denied = true
  const failure = await handlers.get('delete-image')({}, source)
  assert.deepEqual(failure, { success: false, error: 'permission denied' })
  assert.equal(moves.length, 1)
})

test('workflow catalog keeps defaults independent and migrates the legacy caption prompt', () => {
  const { NODE_DEFS, normalizeNodeParams, nodeCategories, DEFAULT_CAPTION_PROMPT } = loadModule(
    'src/renderer/src/services/workflowCatalog.js'
  )
  const first = normalizeNodeParams('metadata-caption', {
    user_prompt: 'Please describe this image.'
  })
  first.concurrency = 99
  assert.equal(first.user_prompt, DEFAULT_CAPTION_PROMPT)
  assert.equal(
    normalizeNodeParams('metadata-caption').concurrency,
    NODE_DEFS['metadata-caption'].params.concurrency
  )
  assert.deepEqual(
    nodeCategories.flatMap((group) => group.items.map((item) => item.kind)).sort(),
    Object.keys(NODE_DEFS).sort()
  )
})

test('workflow source, transforms and output execute without canvas state', async (t) => {
  const previousWindow = global.window
  t.after(() => {
    global.window = previousWindow
  })
  const calls = []
  global.window = {
    api: {
      resolveWorkflowPath: async (root, name) => `${root}/${name}`,
      readImages: async () => [{ path: 'a.png' }, { path: 'b.png' }],
      callPython: async (endpoint, payload) => {
        calls.push({ endpoint, payload })
        return {
          success: true,
          results: payload.files.map((file) => ({
            ok: true,
            output: `${payload.output_dir}/${file}`
          }))
        }
      },
      copyWorkflowFiles: async (files, folder) => ({
        success: true,
        results: files.map((_file, index) => ({ success: true, path: `${folder}/${index}.png` }))
      })
    }
  }
  const { createWorkflowExecutor } = loadModule('src/renderer/src/services/workflowExecutor.js')
  const executor = createWorkflowExecutor({
    isAborted: () => false,
    onNodeProgress() {},
    addLog() {}
  })
  const node = (kind, params = {}) => ({ id: 'node', data: { kind, params } })
  const source = await executor.runNode(
    node('source-folder', { folder: 'input' }),
    new Map(),
    'run'
  )
  assert.deepEqual(source.files.files, ['a.png', 'b.png'])
  const input = new Map([['files', [source.files]]])
  for (const [kind, endpoint] of [
    ['process-alpha', '/flatten-alpha'],
    ['process-resize', '/batch-resize'],
    ['process-ratio-crop', '/proportional-crop'],
    ['process-format', '/format-convert'],
    ['process-mirror', '/mirror-flip'],
    ['process-cutout', '/cutout'],
    ['process-perspective', '/perspective'],
    ['process-blur-noise', '/gaussian-blur-noise']
  ]) {
    const result = await executor.runNode(node(kind), input, 'run')
    assert.equal(calls.at(-1).endpoint, endpoint)
    assert.deepEqual(calls.at(-1).payload.files, ['a.png', 'b.png'])
    assert.equal(result.files.files.length, 2)
  }
  const saved = await executor.runNode(node('output-save', { subfolder: 'final' }), input, 'run')
  assert.deepEqual(saved.files.files, ['run/final/0.png', 'run/final/1.png'])
})

test('workflow filtering reports deletion progress and stops when cancellation changes', async (t) => {
  const previousWindow = global.window
  t.after(() => {
    global.window = previousWindow
  })
  let aborted = false
  const progress = [],
    deleted = []
  global.window = {
    api: {
      resolveWorkflowPath: async () => 'stage',
      callPython: async () => ({
        success: true,
        results: [
          { file: 'keep.png', ok: true, filtered: false },
          { file: 'drop.png', ok: true, filtered: true }
        ]
      }),
      deleteImage: async (file) => {
        deleted.push(file)
        return { success: true }
      }
    }
  }
  const { createWorkflowExecutor } = loadModule('src/renderer/src/services/workflowExecutor.js')
  const executor = createWorkflowExecutor({
    isAborted: () => aborted,
    onNodeProgress: (patch) => progress.push(patch),
    addLog() {}
  })
  const node = { id: 'filter', data: { kind: 'filter-resolution', params: {} } }
  const input = new Map([
    ['files', [{ files: ['keep.png', 'drop.png'], metadata: { 'keep.png': 'tag' } }]]
  ])
  const result = await executor.runNode(node, input, 'run')
  assert.deepEqual(result.files.files, ['keep.png'])
  assert.equal(result.files.metadata['keep.png'], 'tag')
  assert.deepEqual(deleted, ['drop.png'])
  assert.equal(progress.at(-1).progress.percent, 100)
  aborted = true
  await assert.rejects(executor.runNode(node, input, 'run'), /任务已停止/)
  assert.equal(deleted.length, 1)
})

test('update shutdown stops the backend before closing windows and only runs once', async (t) => {
  const events = [],
    hooks = new Map()
  const child = new EventEmitter()
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  child.exitCode = null
  child.signalCode = null
  child.kill = () => {
    throw new Error('clean shutdown should not force kill')
  }
  t.mock.method(global, 'fetch', async (url) => {
    if (url.endsWith('/shutdown')) {
      events.push('backend')
      child.exitCode = 0
      child.emit('exit', 0)
      return { ok: true }
    }
    return {
      ok: true,
      headers: new Headers({ 'Content-Type': 'application/json' }),
      json: async () => ({ success: true })
    }
  })
  const runtime = loadModule('src/main/taskRuntime.js', {
    electron: {
      app: { on: (name, handler) => hooks.set(name, handler), getAppPath: () => process.cwd() },
      BrowserWindow: {
        getAllWindows: () => [{ isDestroyed: () => false, destroy: () => events.push('window') }]
      }
    },
    './tunnelManager': { stopTunnel: async () => events.push('tunnel') },
    child_process: {
      spawnSync: () => ({ status: 0 }),
      spawn: () => {
        queueMicrotask(() => child.stdout.emit('data', Buffer.from('PORT:12345')))
        return child
      }
    }
  })
  await runtime.callPython('/gpu-status', {}, { id: 1 })
  await runtime.prepareForUpdateRestart()
  await runtime.prepareForUpdateRestart()
  assert.deepEqual(events, ['tunnel', 'backend', 'window'])
  hooks.get('before-quit')({
    preventDefault: () => assert.fail('completed shutdown must allow quitting')
  })
  assert.equal(runtime.isForcedQuitInProgress(), false)
})

test('API config IPC distinguishes missing files from corrupt, unreadable and undecryptable data', async () => {
  const handlers = new Map()
  let raw,
    readError,
    writes = 0
  const { registerIPC } = loadModule('src/main/ipc.js', {
    electron: {
      app: { on() {}, getPath: () => 'user-data' },
      ipcMain: { on() {}, handle: (name, handler) => handlers.set(name, handler) },
      safeStorage: {
        decryptString: () => {
          throw new Error('decrypt failed')
        }
      }
    },
    sharp: {},
    './tunnelManager': { registerTunnelIPC() {} },
    'fs/promises': {
      readFile: async () => {
        if (readError) throw readError
        return raw
      },
      mkdir: async () => {},
      writeFile: async () => {
        writes++
      }
    }
  })
  registerIPC()
  readError = Object.assign(new Error('missing'), { code: 'ENOENT' })
  assert.deepEqual(await handlers.get('get-api-configs')(), [])
  readError = Object.assign(new Error('denied'), { code: 'EACCES' })
  await assert.rejects(handlers.get('get-api-configs')(), /denied/)
  readError = null
  raw = '{broken'
  await assert.rejects(handlers.get('migrate-api-configs')({}, [{ id: 'legacy' }]), SyntaxError)
  assert.equal(writes, 0)
  raw = '{}'
  await assert.rejects(handlers.get('get-api-configs')(), /格式错误/)
  raw = JSON.stringify({
    configs: [{ id: 'one', apiKeyProtected: { encoding: 'safeStorage', value: 'encoded' } }]
  })
  await assert.rejects(handlers.get('get-api-configs')(), /decrypt failed/)
})

test('API config migration preserves the legacy value on failure and does not silently fall back', async (t) => {
  const previousWindow = global.window,
    previousStorage = global.localStorage
  t.after(() => {
    global.window = previousWindow
    global.localStorage = previousStorage
  })
  const values = new Map([['api-configs', JSON.stringify([{ id: 'old' }])]])
  global.localStorage = {
    getItem: (key) => values.get(key) ?? null,
    removeItem: (key) => values.delete(key)
  }
  let fallbackReads = 0
  global.window = {
    api: {
      migrateApiConfigs: async () => {
        throw new Error('cannot encrypt')
      },
      getApiConfigs: async () => {
        fallbackReads++
        throw new Error('cannot read')
      }
    }
  }
  const { loadApiConfigs } = loadModule('src/renderer/src/services/apiConfigs.js')
  await assert.rejects(loadApiConfigs(), /cannot encrypt/)
  assert.equal(values.has('api-configs'), true)
  assert.equal(fallbackReads, 0)
  global.window.api.migrateApiConfigs = async (configs) => ({ configs })
  assert.deepEqual(await loadApiConfigs(), [{ id: 'old' }])
  assert.equal(values.has('api-configs'), false)
  await assert.rejects(loadApiConfigs(), /cannot read/)
})

test('Settings keeps saved configuration and an open form when a write fails', async (t) => {
  const { parse, compileScript } = require('@vue/compiler-sfc')
  const previousWindow = global.window,
    previousStorage = global.localStorage,
    previousDocument = global.document
  let app
  t.after(() => {
    app.unmount()
    global.window = previousWindow
    global.localStorage = previousStorage
    global.document = previousDocument
  })
  const config = {
    id: 'one',
    name: 'Original',
    model: 'model',
    endpoint: 'https://example.invalid',
    apiKey: 'key',
    enabled: true
  }
  let readFails = false
  global.localStorage = { getItem: () => null, setItem() {}, removeItem() {} }
  global.document = { addEventListener() {}, removeEventListener() {} }
  global.window = {
    dispatchEvent() {},
    api: {
      callPython: async () => ({ enabled: true }),
      getAutoCheckUpdate: async () => true,
      onUpdateStatus: () => () => {},
      getApiConfigs: async () => {
        if (readFails) throw new Error('cannot read')
        return [{ ...config }]
      },
      saveApiConfigs: async () => {
        throw new Error('disk full')
      }
    }
  }
  const path = 'src/renderer/src/views/Settings.vue'
  const script = compileScript(parse(readFileSync(path, 'utf8')).descriptor, {
    id: 'settings-test'
  })
  const Settings = loadModule(path, {}, script.content).default
  Settings.render = () => null
  const renderer = vue.createRenderer({
    createComment: () => ({}),
    insert() {},
    remove() {},
    parentNode() {},
    nextSibling() {}
  })
  app = renderer.createApp(Settings)
  app.mount({})
  const state = app._instance.setupState
  await state.refreshConfigs()
  state.openEditForm(state.apiConfigs[0])
  state.formName = 'Changed'
  await state.submitForm()
  assert.equal(state.apiConfigs[0].name, 'Original')
  assert.equal(state.showForm, true)
  assert.equal(state.formName, 'Changed')
  assert.match(state.apiConfigError, /disk full/)
  await state.toggleEnabled(state.apiConfigs[0])
  assert.equal(state.apiConfigs[0].enabled, true)
  await state.deleteConfig('one')
  assert.equal(state.apiConfigs.length, 1)
  readFails = true
  await state.refreshConfigs()
  assert.equal(state.apiConfigsLoaded, false)
  assert.match(state.apiConfigError, /cannot read/)
  assert.equal(state.apiConfigs[0].name, 'Original')
})

test('automatic update preference changes only after persistence succeeds', () => {
  const handlers = new Map()
  const updater = new EventEmitter()
  updater.checkForUpdates = async () => null
  let fail = true,
    stored
  const { setupAutoUpdater } = loadModule('src/main/updater.js', {
    'electron-updater': { autoUpdater: updater },
    electron: {
      app: { getPath: () => 'user-data' },
      ipcMain: { handle: (name, handler) => handlers.set(name, handler) }
    },
    './taskRuntime': {},
    './windowManager': {},
    fs: {
      readFileSync: () => '{"autoCheck":true}',
      writeFileSync: (_path, contents) => {
        if (fail) throw new Error('disk full')
        stored = JSON.parse(contents)
      }
    }
  })
  setupAutoUpdater()
  assert.throws(() => handlers.get('set-auto-check-update')({}, false), /disk full/)
  assert.equal(handlers.get('get-auto-check-update')(), true)
  fail = false
  handlers.get('set-auto-check-update')({}, false)
  assert.equal(handlers.get('get-auto-check-update')(), false)
  assert.deepEqual(stored, { autoCheck: false })
})
