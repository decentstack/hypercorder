const HyperSim = require('hyper-simulator')
const Feed = require('hypercore')
const Reducer = require('..')
const { appendStatement } = Reducer
const { randomBytes } = require('crypto')
const { defer } = require('deferinfer')

const nFollowers = 0
const nAuthors = 6
const nSpambots = 0

const R_TOPIC = randomBytes(32)
const W_TOPIC = randomBytes(32)

const CONTEXT = 'cat-survey'

const CONSENSUS = stmt => {
  const msg = stmt.data.toString('utf8')
  // Must contain word 'cat'
  if (!msg.match(/cat/i)) return false
  // Must NOT contain word 'dog'
  if (msg.match(/dog/i)) return false
  return true
}

/** Peer behaviour/role base-class
 * defines an actor that has a hypercorder instance.
 * */
class Actor {
  constructor (ctx, done, opts = {}) {
    this.ctx = ctx
    this.storage = ctx.storage
    this.signal = ctx.signal
    this.objectivesComplete = done
    this.thread = new Reducer(
      p => ctx.storage('reducer/' + p),
      opts.key,
      {
        // contentEncoding: 'string' // Not yet supported.
        filter: opts.filter || CONSENSUS
      }
    )
    this._onConnection = this._onConnection.bind(this)
    this._errHandler = this._errHandler.bind(this)
    this.thread.on('error', this._errHandler)
    this.thread.once('finalized', seq => this.signal('eof', seq))
    // this.thread.on('statement', (_, seq) => { this.ctx.version = seq + 1})
    this.ctx.swarm.on('connection', this._onConnection)
    this.maxConn = this.ctx.opts.maxConnections || 3

    const timer0 = () => {
      this.ctx.version = this.thread.length
      if (this.thread.exchange) {
        const active = this.thread.exchange.stats.started - this.thread.exchange.stats.done
        // if (active > 10) debugger
        this.ctx.version += active * 100
      }
      this.ctx.setTimeout(timer0, 1000)
    }
    timer0()
    // this.thread.on('append', () => { this.ctx.version = this.thread.length })
  }

  _errHandler (error) {
    console.error(error)
    // if (error.message === 'Closed'
    //  || error.message === 'Readable stream closed before ending') return this.signal('err-closed', error.stack)
    // debugger
    this.signal(`err-${error.message.split(' ')[0]}`, error)
  }

  ready (cb) {
    if (cb) throw new Error('This method returns a promise')
    return defer(d => this.thread.ready(d))
  }

  _onConnection (socket, { client, topic }) {

    if (R_TOPIC.equals(topic)) { // Read
      // Attempt to balance connection counts (not a real world problem)
      const rPeers = this.thread.peers.length
      if (rPeers >= (this.maxConn / 2)) {
        socket.end()
      } else {
        socket
          .pipe(this.thread.replicate(client, { live: true }))
          .pipe(socket)
          .once('error', this._errHandler)
      }
    } else if (this.thread.finalized) {
      this.signal('invalid-connection') // A bug in hyper-simulator most likely.
      return socket.end()
    } else {
      // Attempt to balance connection counts (not a real world problem)
      const wPeers = this.thread.exchange.peers.length
      if (wPeers >= (this.maxConn / 2)) {
        socket.end()
      } else {
        socket
          .pipe(this.thread.repliduce(client, { live: true }))
          .pipe(socket)
          .once('error', this._errHandler)
      }
    }
  }

  joinReadSwarm () {
    //this.ctx.swarm.join(R_TOPIC)
  }

  joinWriteSwarm () {
    this.ctx.swarm.join(W_TOPIC)
  }

  // Standard leech behaviour, d/c @ 100%
  discoDone = () => {
    this.finalized = true
    this.ctx.swarm.leave(W_TOPIC, () => {
      this.ctx.swarm.leave(R_TOPIC, () => {
        // this.thread.exchange.close() // Wait what.?
        this.objectivesComplete()
      })
    })
  }
}

/**
 * Replicates everything that has been validated
 * objectives complete when finalization block is received
 */
class Consumer extends Actor {
  ready () {
    return super.ready()
      .then(this.joinReadSwarm.bind(this))
      .then(() => {
        this.thread.once('finalized', this.discoDone)
      })
  }
}

class Moderator extends Actor {
  ready () {
    // Finalize thread after 20 seconds
    this.ctx.setTimeout(() => {
      this.signal('mod-eof')
      const path = this.ctx.trace().map(i => i.id + i.name)

      if (path.length === nAuthors + 1) this.signal('net-linked', { path })
      else {
        this.signal('net-segmented', { path })
      }

      this.thread.finalize()
    }, 30 * 1000 )

    // TODO: leave temporary swarm _AFTER_ transmitting the finalization proof.
    this.ctx.setTimeout(() => {
      return this.objectivesComplete()
      //this.ctx.swarm.leave(W_TOPIC, () => {
        //this.objectivesComplete()
        //// this.thread.exchange.close(this.objectivesComplete)
      //})
    }, 40 * 1000 ) // Leave writer topic after 30 secs

    return super.ready()
      .then(this.joinWriteSwarm.bind(this))
      .then(this.joinReadSwarm.bind(this))
      .then(() => {
        this.thread.on('statement', (stmt) => {
          const ptr = [stmt.key.toString('hex'), stmt.sequence].join('@')
          this.signal('mod-recorded', { ptr })
        })
      })
  }
}

class Author extends Actor {
  constructor (ctx, done, opts = {}) {
    super(ctx, done, opts)
    this.voice = new Feed(p => ctx.storage('voice/' + p))
  }

  ready () {
    return super.ready()
      .then(() => defer(d => this.voice.ready(d)))
      .then(this.makeContent.bind(this))
      .then(this.joinWriteSwarm.bind(this))
      // .then(this.joinReadSwarm.bind(this))
  }

  async makeContent () {
    const seq = await appendStatement(this.voice, 'CATS',
      Buffer.from('Cats are fluffy, I have a cat.'))

    // register statement listener
    this.thread.on('statement', (stmt, idx) => this.signal('stmt', {
      ptr: [stmt.key.hexSlice(), idx].join('@')
    }))
    this.voice.once('upload', seq =>  this.signal('upload-'+seq))
    // The promise returned by publish is the finalize condition
    // not to be confused with this ready state
    this.thread.publish(this.voice, seq)
      .then(() => appendStatement(this.voice, 'CATS', Buffer.from('Try to squezee another cat in')))
      .then(s => this.thread.publish(this.voice, s))
      .then(this.objectivesComplete) // Author is done after seeing his msg included.
      .catch(this._errHandler)
    // Let's add a final async statement.
    this.ctx.setTimeout(() => {
      appendStatement(this.voice, 'CATS', Buffer.from('timeout cat'))
        .then(s => this.thread.publish(this.voice, s))
        .then(() => this.signal('bonus-record'))
        .catch(this._errHandler)
    }, (5 + this.ctx.random() * 15) * 1000) // Random timeout 5 - 20 secs
  }
}

class Spambot extends Author { }

const boostrap = async () => {
  const actors = []
  const simulator = new HyperSim({
    logger: HyperSim.TermMachine()
  })

  await simulator.ready()

  const moderator = simulator.launch('mod',
    { maxConnections: 6 },
    (ctx, eFn) => new Moderator(ctx, eFn)
  )

  await moderator.ready()

  const key = moderator.thread.key

  for (let i = 0; i < nFollowers; i++) {
    simulator.launch('plb',
      { maxConnections: 3 },
      (ctx, eFn) => actors.push(new Consumer(ctx, eFn, { key }))
    )
  }

  for (let i = 0; i < nAuthors; i++) {
    simulator.launch('wrt',
      { maxConnections: 6 },
      (ctx, eFn) => actors.push(new Author(ctx, eFn, { key }))
    )
  }

  for (let i = 0; i < nSpambots; i++) {
    simulator.launch('bot',
      { maxConnections: 5 },
      (ctx, eFn) => actors.push(new Spambot(ctx, eFn, { key }))
    )
  }

  // Let all actors initialize.
  await Promise.all(actors.map(a => a.ready()))

  return simulator.run(3, 100)
}

boostrap()
  .then(() => console.error('Simulation finished'))
  .catch(err => {
    console.error('Simulation failed', err)
    process.exit(1)
  })
