const { test } = require('node:test')
const assert = require('node:assert/strict')
const { extractClaim, verify, websearch } = require('../lib')
test('requires actual mention and exact trigger', () => {
  for (const word of ['是真的吗', 'IS THAT TRUE', '核验事实', '求真']) assert.equal(extractClaim(`<at id="42"/> ${word}：地球是圆的`, '42'), '地球是圆的')
  assert.equal(extractClaim('求真 abc', '42'), null)
  assert.equal(extractClaim('<at id="43"/> 求真 abc', '42'), null)
  assert.equal(extractClaim('<at id="42"/> is that trueish abc', '42'), null)
})
test('search then follow-up tool and final answer', async () => {
  const original = global.fetch
  let count = 0
  global.fetch = async (_url, options) => {
    const body = JSON.parse(options.body)
    count++
    const data = body.query ? { results: [{ title: 'source', url: 'https://example.org', content: 'evidence' }] } : count === 2 ? { choices: [{ message: { role: 'assistant', tool_calls: [{ id: 'extra', type: 'function', function: { name: 'websearch', arguments: '{"query":"follow up"}' } }] } }] } : { choices: [{ message: { content: '证据不足' } }] }
    return { ok: true, json: async () => data }
  }
  try {
    assert.equal(await verify('claim', { searchProvider: 'tavily', searchKey: 'x', endpoint: 'https://example.org/v1', apiKey: 'x', model: 'test', timeout: 1000 }), '证据不足')
    assert.equal(count, 4)
  } finally { global.fetch = original }
})
test('Brave and Serper normalize results; HTTP failure propagates', async () => {
  const original = global.fetch
  try {
    for (const provider of ['brave', 'serper']) {
      global.fetch = async (url, options) => {
        if (provider === 'brave') {
          assert.match(url, /q=hello/)
          assert.equal(options.headers['X-Subscription-Token'], 'secret')
        } else assert.equal(options.headers['X-API-KEY'], 'secret')
        return { ok: true, json: async () => provider === 'brave' ? { web: { results: [{ title: 't', url: 'u', description: 'd' }] } } : { organic: [{ title: 't', link: 'u', snippet: 'd' }] } }
      }
      assert.deepEqual(await websearch('hello', { searchProvider: provider, searchKey: 'secret' }, AbortSignal.timeout(1000)), [{ title: 't', url: 'u', snippet: 'd' }])
    }
    global.fetch = async () => ({ ok: false, status: 401, text: async () => 'invalid key' })
    await assert.rejects(websearch('hello', { searchProvider: 'tavily' }, AbortSignal.timeout(1000)), /HTTP 401/)
  } finally { global.fetch = original }
})
test('no service registration; progress precedes search and answer is censored', async () => {
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fact-censor-'))
  fs.writeFileSync(path.join(dir, 'words.txt'), '  测试违禁词  \n')
  const original = global.fetch
  const messages = []
  let middleware
  const ctx = {
    baseDir: dir,
    logger: () => ({ info() {}, error() {} }),
    // Existing censor must not be touched or registered again.
    censor: {},
    plugin: () => { throw new Error('duplicate plugin detected') },
    middleware: fn => { middleware = fn },
  }
  global.fetch = async (url) => {
    assert.equal(messages[0], '核查中')
    return { ok: true, json: async () => url.includes('tavily') ? { results: [{ title: 't', url: 'u', content: 'e' }] } : { choices: [{ message: { content: '包含测试违禁词 <at id="1"/>' } }] } }
  }
  try {
    require('../lib').apply(ctx, { dictionary: 'words.txt', searchProvider: 'tavily', endpoint: 'https://example.org', timeout: 1000 })
    await middleware({ content: '<at id="42"/> 求真 内容', selfId: '42', userId: '7', platform: 'test', channelId: '1', send: async element => messages.push(element.attrs.content) }, () => {})
    assert.deepEqual(messages, ['核查中', '包含***** <at id="1"/>'])
  } finally { global.fetch = original; fs.rmSync(dir, { recursive: true, force: true }) }
})
test('attached and quoted forwards send every message to the model in order', async () => {
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path')
  const { h } = require('koishi')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fact-forward-'))
  const dictionary = path.join(dir, 'words.txt')
  fs.writeFileSync(dictionary, '测试违禁词')
  const original = global.fetch
  const firstMessage = '背景信息'.repeat(110)
  const firstNode = `<message><author name="甲"/>${firstMessage}<br/>补充<strong>背景</strong></message>`
  const secondNode = '<author name="乙"/>末尾提到停课 &amp; 日期'
  const forward = `<message forward>${firstNode}<message forward><message>${secondNode}</message></message></message>`
  const imageUrl = 'https://example.org/photo.png'
  const quotedRecord = `<figure>${firstNode}<figure><message>${secondNode}<img src="${imageUrl}"/></message></figure></figure>`
  const expected = `合并聊天记录：\n甲：${firstMessage}\n补充背景\n\n乙：末尾提到停课 & 日期`
  let middleware
  require('../lib').apply({
    baseDir: dir,
    logger: () => ({ info() {}, error() {} }),
    middleware: fn => { middleware = fn },
  }, { dictionary: 'words.txt', endpoint: 'https://example.org', searchProvider: 'tavily', timeout: 1000, maxToolRounds: 0, imageTransport: 'url' })

  try {
    for (const [content, quote, input] of [
      [`<at id="42"/> 求真 &#x20;${forward}`, undefined, expected],
      ['<at id="42"/> 求真 请查末尾的说法', { elements: h.parse(quotedRecord) }, `用户问题：请查末尾的说法\n\n${expected}`],
    ]) {
      const calls = [], sent = []
      global.fetch = async (url, options) => {
        const body = JSON.parse(options.body)
        calls.push(body)
        let data
        if (url.includes('tavily')) {
          data = { results: [{ title: '通知', content: '检索证据' }] }
        } else if (!body.tools) {
          data = { choices: [{ message: { content: '{"observations":"只有配图","query":""}' } }] }
        } else if (body.tool_choice !== 'none') {
          data = { choices: [{ message: { role: 'assistant', tool_calls: [{ id: 'forward-search', type: 'function', function: { name: 'websearch', arguments: '{"query":"停课通知 日期"}' } }] } }] }
        } else {
          data = { choices: [{ message: { content: '证据不足' } }] }
        }
        return { ok: true, json: async () => data }
      }
      await middleware({ content, quote, selfId: '42', userId: '7', send: async element => sent.push(element.attrs.content) }, () => assert.fail('指令未触发'))
      assert.deepEqual(sent, ['核查中', '证据不足'])
      if (quote) {
        const vision = calls.shift()
        assert.equal(vision.messages[1].content[0].text, input)
        assert.equal(vision.messages[1].content[1].image_url.url, imageUrl)
      }
      assert.equal(calls.length, 3)
      const [queryRequest, searchRequest, answerRequest] = calls
      assert.deepEqual(queryRequest.tool_choice, { type: 'function', function: { name: 'websearch' } })
      if (quote) assert.ok(queryRequest.messages[1].content.startsWith(`${input}\n图片模型观察`))
      else assert.equal(queryRequest.messages[1].content, input)
      assert.equal(searchRequest.query, '停课通知 日期')
      assert.equal(answerRequest.tool_choice, 'none')
      assert.equal(answerRequest.messages[1].content, queryRequest.messages[1].content)
    }
  } finally {
    global.fetch = original
    fs.unlinkSync(dictionary)
    fs.rmdirSync(dir)
  }
})

test('debug switch and concrete API errors are logged with secrets redacted', async () => {
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fact-debug-'))
  fs.writeFileSync(path.join(dir, 'words.txt'), '测试违禁词')
  const original = global.fetch
  try {
    for (const debug of [false, true]) {
      const info = [], errors = [], sent = []
      let middleware
      require('../lib').apply({ baseDir: dir, logger: () => ({ info: (_, text) => info.push(text), error: (_, text) => errors.push(text) }), middleware: fn => { middleware = fn } }, { debug, dictionary: 'words.txt', searchProvider: 'tavily', searchKey: 'secret-search-key', apiKey: 'secret-model-key', timeout: 1000 })
      global.fetch = async () => ({ ok: false, status: 429, text: async () => 'rate limit exceeded secret-search-key secret-model-key' })
      await middleware({ content: '<at id="42"/> 求真 内容', selfId: '42', userId: '7', send: async element => sent.push(element.attrs.content) }, () => {})
      assert.equal(info.length > 0, debug)
      assert.match(errors.join('\n'), /HTTP 429.*rate limit exceeded/)
      assert.doesNotMatch(errors.join('\n'), /secret-search-key|secret-model-key/)
      assert.match(errors.join('\n'), /REDACTED/)
      assert.equal(sent.length, 2)
    }
  } finally { global.fetch = original; fs.rmSync(dir, { recursive: true, force: true }) }
})
test('custom literal triggers, optional mention and English boundary', () => {
  assert.equal(extractClaim('check+ 事实', '42', ['check+'], false), '事实')
  assert.equal(extractClaim('checkkk 事实', '42', ['check+'], false), null)
  assert.equal(extractClaim('truthful 事实', '42', ['truth'], false), null)
  assert.equal(extractClaim('核验事实 内容', '42', ['核验', '核验事实'], false), '内容')
  assert.equal(extractClaim('求真 内容', '42', [], false), null)
})
test('custom search count, prompt, token limit and zero extra rounds', async () => {
  const original = global.fetch
  let calls = 0
  global.fetch = async (url, options) => {
    calls++
    const body = JSON.parse(options.body)
    if (url.includes('tavily')) {
      assert.equal(body.max_results, 2)
      return { ok: true, json: async () => ({ results: [{ title: 't' }] }) }
    }
    assert.equal(body.max_tokens, 800)
    assert.equal(body.tool_choice, 'none')
    assert.match(body.messages[0].content, /150–300/)
    assert.match(body.messages[0].content, /关注日期/)
    return { ok: true, json: async () => ({ choices: [{ message: { content: '结果' } }] }) }
  }
  try {
    assert.equal(await verify('事实', { searchProvider: 'tavily', endpoint: 'https://example.org', timeout: 1000, searchCount: 2, maxToolRounds: 0, maxTokens: 800, responseStyle: 'brief', extraPrompt: '关注日期' }), '结果')
    assert.equal(calls, 2)
  } finally { global.fetch = original }
})
test('images extracted from nested messages and deduplicated', () => {
  const { extractImages } = require('../lib')
  assert.deepEqual(extractImages('<img src="https://example.org/a.png"/><message><img src="https://example.org/b.png"/></message><img src="https://example.org/a.png"/>'), ['https://example.org/a.png', 'https://example.org/b.png'])
})
test('vision observation leads to search then grounded answer', async () => {
  const original = global.fetch
  const bodies = []
  global.fetch = async (_url, options) => {
    const body = JSON.parse(options.body)
    bodies.push(body)
    let data
    if (bodies.length === 1) {
      assert.equal(body.model, 'vision-test')
      assert.equal(body.messages[1].content[1].image_url.url, 'https://example.org/a.png')
      data = { choices: [{ message: { content: JSON.stringify({ observations: '图片宣称某事发生', query: '某事 是否发生' }) } }] }
    } else if (bodies.length === 2) {
      assert.equal(body.query, '某事 是否发生')
      data = { results: [{ title: '来源', url: 'https://example.org', content: '证据' }] }
    } else {
      assert.match(body.messages[1].content, /未经证实/)
      data = { choices: [{ message: { content: '证据不足' } }] }
    }
    return { ok: true, json: async () => data }
  }
  try {
    assert.equal(await verify('', { endpoint: 'https://example.org', imageTransport: 'url', visionModel: 'vision-test', model: 'text-test', searchProvider: 'tavily', timeout: 1000 }, undefined, ['https://example.org/a.png']), '证据不足')
    assert.equal(bodies.length, 3)
    await assert.rejects(verify('', { timeout: 1000 }, undefined, ['file:///etc/passwd']), /HTTP\(S\)/)
    assert.equal(bodies.length, 3)
  } finally { global.fetch = original }
})
test('no visual claim does not invent a search or verdict', async () => {
  const original = global.fetch
  let calls = 0
  global.fetch = async () => { calls++; return { ok: true, json: async () => ({ choices: [{ message: { content: '{"observations":"模糊图片","query":""}' } }] }) } }
  try {
    assert.match(await verify('', { imageTransport: 'url', endpoint: 'https://example.org', timeout: 1000 }, undefined, ['https://example.org/a.png']), /未识别到明确/)
    assert.equal(calls, 1)
  } finally { global.fetch = original }
})
test('downloads image bytes inline, blocks local URLs, enforces size and rejects HTML', async () => {
  const { prepareImage } = require('../lib')
  const original = global.fetch
  const png = Buffer.from([137,80,78,71,13,10,26,10,0])
  try {
    global.fetch = async () => new Response(png)
    assert.equal(await prepareImage('https://8.8.8.8/image', {}, AbortSignal.timeout(1000)), 'data:image/png;base64,'+png.toString('base64'))
    await assert.rejects(prepareImage('http://127.0.0.1/img', {}, AbortSignal.timeout(1000)), /内网/)
    await assert.rejects(prepareImage('https://8.8.8.8/image', { imageMaxBytes: 4 }, AbortSignal.timeout(1000)), /大小上限/)
    global.fetch = async () => new Response('<html>expired</html>')
    await assert.rejects(prepareImage('https://8.8.8.8/image', {}, AbortSignal.timeout(1000)), /过期链接/)
    global.fetch = async () => new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/private' } })
    await assert.rejects(prepareImage('https://8.8.8.8/image', {}, AbortSignal.timeout(1000)), /内网/)
  } finally { global.fetch = original }
})
test('vision accepts string arrays and empty observation arrays', async () => {
  const { inspectImages } = require('../lib')
  const original = global.fetch
  try {
    for (const observations of [['visible text'], []]) {
      global.fetch = async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({ observations, query: '' }) } }] }) })
      const result = await inspectImages('', ['https://example.org/a.png'], { endpoint: 'https://example.org', imageTransport: 'url' }, AbortSignal.timeout(1000))
      assert.equal(typeof result.observations, 'string')
      assert.equal(result.query, '')
    }
  } finally { global.fetch = original }
})
