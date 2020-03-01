const test = require('tape')
const Epoch = require('..')
const { createStatement, decodeStatement } = Epoch
const ram = require('random-access-memory')
const { defer } = require('deferinfer')
const Hypercore = require('hypercore')

// Assertion steps
// assert context/target validity
// assert Statement size limit.
// authenticate author/Source (next gen)
// assert author/source-integrity / anti-tamper
// assert data against application-rules
//
// If all assertions above pass, the statement can be recorded by a witness
// or forwarded by a friendly neighour in good trust.
test.only('As a user i want my statement to be recorded and finalized', async t => {
  // t.plan(10)
  try {
    const filterChain = stmt => {
      t.equal(stmt.context, 'context/topic')
      // No dogs allowed.
      return !stmt.data.toString('utf8').match(/dog/)
    }

    const witness = new Epoch(ram, null, { filter: filterChain })
    witness.once('error', t.error)
    /*
    witness.once('statement', (stmt) => {
      debugger
      t.ok(stmt)
      witness.finalize()
    })
    e.on('finalize', t.end)*/
    await witness.ready()

    const e = new Epoch(ram, witness.key, { filter: filterChain })
    e.once('error', t.error)
    await e.ready()
    // A user feed is a feed capable to be addressed during replication `key@seq`
    // and can contain a Statement
    const myFeed = new Hypercore(ram)
    await defer(d => myFeed.ready(d))

    const stmt = createStatement(myFeed.secretKey,
      myFeed.length,
      'context/topic', // <-- context/target is tricky needs more research.
      Buffer.from('I bet freedom would be missed if it were taken'))

    t.ok(Buffer.isBuffer(stmt))
    const decoded = decodeStatement(stmt)
    t.ok(decoded.signature, 'A signed statement should have been generated')
    const seq = await defer(d => myFeed.append(stmt, d))
    t.equal(seq, decoded.sequence)

    // EZ Statement
    const s2 = await Epoch.appendStatement(myFeed, 'context/topic', Buffer.from('this is the data'))
    t.equal(s2, 1)
    const validStatement = await Epoch.verifyFeedEntry(myFeed, s2)
    t.ok(validStatement, 'should validate')
    const cnt = await e.contains(myFeed.key, seq)
    t.notOk(cnt, 'Should not contain our message yet')

    const finalizedPromise = e.publish(myFeed, seq)

    const stream = e.repliduce(true, { live: true })
    stream
      .pipe(witness.repliduce(false, { live: true }))
      .pipe(stream)
      .once('end', t.pass.bind(null, 'stream closed'))
    const id = await finalizedPromise
    t.equal(typeof id, 'number')
    t.ok(e.contains(myFeed.key, seq))
  } catch (e) { t.error(e) }
  t.end()
})

// TODO: test invalid statements

test('Epoch of time', async t => {
  const h = new Epoch(ram, {
    secretKey: undefined,
    filter ({ body, headers }, accept) { // Can be skipped if opening read-only.
      // Insert moderation code here.
      const isSpam = body.toString().match(/spam/)
      const finalize = true
      accept(!isSpam, finalize)
    }
  })

  await h.ready()

  t.equal(typeof h.finalize === 'function')

  t.ok(h.key)
  t.ok(h.writeTopic) // Multiwriter swarm here.
  t.ok(h.repliduce()) // Creates a reducer stream

  t.ok(h.readTopic) // Plain single resource
  t.ok(h.replicate()) // Creates a hypercore stream

  t.ok(h.isFinalized) // Terminator appended.
})
