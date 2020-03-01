// SPDX-License-Identifier: AGPL-3.0-or-later
const Feed = require('hypercore')
const { ReplicationManager } = require('../hyperplexer')

const { defer, infer } = require('deferinfer')
const { Statement } = require('./messages')
const { sign, verify } = require('hypercore-crypto')

// Statement magic byte-sequence
const INVALID_STMT = false
const STATEMENT_VERSION = 1
const STATEMENT_MAGIC = Buffer.from('HSTMTX')
STATEMENT_MAGIC.writeUInt8(STATEMENT_VERSION, STATEMENT_MAGIC.length - 1)

const magicStatementEncoder = {
  encode: (obj, buffer, offset) => Buffer.isBuffer(obj) ? obj
    : Statement.encode(obj, buffer, offset),
  decode: (buffer, offset, end) => {
    const mlen = STATEMENT_MAGIC.length
    if (Buffer.isBuffer(buffer) && buffer.slice(offset, mlen).equals(STATEMENT_MAGIC)) {
      return Statement.decode(buffer, (offset || 0) + mlen, end)
    } else return buffer
  }
}

module.exports = class Reducer extends Feed {
  constructor (storage, key, opts) {
    super(p => storage('reduced/' + p), key, {
      ...opts,
      valueEncoding: magicStatementEncoder
    })

    if (!opts && (!Buffer.isBuffer(key) || typeof key !== 'string')) {
      opts = key
    }
    this.__storage = storage
    this.__fctr = 0
    this.exchange = null
    this._filterFn = opts.filter || (() => true)
    this._exKey = opts.exchangeKey
    this._dataEncoding = opts.valueEncoding // TODO: override .get()
    this._finalized = false
    this._shares = {}
    this._recorded = {}
    this._verifyBlock = this._verifyBlock.bind(this)
    this._indexEntry = this._indexEntry.bind(this)
    this.on('append', this._indexEntry)
    this.on('download', this._indexEntry)
  }

  get finalized () { return this._finalized }

  ready (cb) {
    if (!this.__defReady) {
      this.__defReady = defer(d => super.ready(d))
        .then(() => this._index())
        .then(() => this._initHyperplexer())
    }
    return infer(this.__defReady, cb)
  }

  publish (feed, idx) {
    const mk = feed.key.toString('hex')
    if (this.contains(mk, idx)) return Promise.resolve(this._recorded[mk][idx])
    if (!this._shares[mk]) {
      let leak = null
      this._shares[mk] = {
        local: true,
        feed,
        indices: {},
        promise: defer(d => { leak = d }) // bad
      }
      this._shares[mk].resolve = leak // bad
      // TODO: invoke this._shares[mk].resolve(null, seq) somewhere
    }
    this._shares[mk].indices[idx] = 1
    return this._shares[mk].promise
  }

  /**
   * heads up, index Entry fetches last entry automatically if invoked
   * with params..
   */
  _indexEntry (idx, stmt) {
    if (!stmt) {
      const seq = this.length - 1
      // If the block is not yet downloaded,
      // let the download hook index this statement instead.
      if (!this.has(seq)) return
      // otherwise get it when available.
      return this.get(seq, { wait: false }, (err, stmt) => {
        if (err) return this.emit('error', err)
        this._indexEntry(seq, stmt)
      })
    }

    // hypercore.on('download') seems to ignore contentEncoding..
    if (Buffer.isBuffer(stmt)) stmt = magicStatementEncoder.decode(stmt)

    if (!stmt.key || !stmt.signature) debugger // This should never happen.

    const mk = stmt.key.toString('hex')
    if (!this._recorded[mk]) this._recorded[mk] = {}
    this._recorded[mk][idx] = 1

    // Resolve pending
    const share = this._shares[mk]

    if (share && share.resolve) share.resolve(null, idx)
    // Emit statement recorded event.
    this.emit('statement', stmt)
  }

  _initHyperplexer () {
    if (!this._exKey) {
      // TODO: there's room for improvement here..
      // The exchange-channel musn't collide with an actual core-channel.
      // It's a bug in repl-manager/hyperplexer
      this._exKey = Buffer.alloc(this.key.length)
      this.key.copy(this._exKey, 1, 1)
    }

    this.exchange = new ReplicationManager(this._exKey, {
      onerror: this.emit.bind(null, 'error'),
      ondisconnect: (err, conn) => {
        if (err) return this.emit('error', err)
      },

      onconnect: peer => {
        const feeds = Object.keys(this._shares).map(hexkey => {
          const share = this._shares[hexkey]
          return {
            key: Buffer.from(hexkey, 'hex'),
            headers: {
              // profile: share.profilePtr,
              // auth: share.authPtr,
              statements: Object.keys(share.indices)
                .filter(n => share.indices[n])
                .map(n => parseInt(n))
            }
          }
        })
        feeds.unshift({
          key: this.key,
          headers: { master_record: true, finalized: this.finalized, version: this.length }
        })
        this.exchange.share(peer, feeds, { namespace: 'default' })
      },
      /*
      onauthenticate (pk, done, peer) {
        debugger
        done()
      },
      */
      onforward: (namespace, key, candidates) => {
        debugger
        for (const peer of candidates) {
          this.exchange.share(peer, { namespace, keys: [key] })
        }
      },

      resolve: ({ key, namespace }, resolve) => {
        if (this.key.equals(key)) resolve(this)
        else resolve(this._shares[key.toString('hex')].feed)
      },

      onaccept: ({ key, headers, peer, namespace }, accept) => {
        if (this.key.equals(key)) return accept(true)
        // Reject all side-records if master feed is finalized.
        if (this.finalized) return accept(false)

        // Ignore unknown feeds
        if (!Array.isArray(headers.statements)) return accept(false)

        // - reject if all blocks are recorded/settled
        const allSettled = headers.statements.reduce((settled, idx) => {
          return settled && this.contains(key, idx)
        }, true)
        if (allSettled) return accept(false)

        const mk = key.toString('hex')
        if (!this._shares[mk]) {
          this._shares[mk] = {
            local: false,
            feed: null,
            indices: {}
          }
        }
        const share = this._shares[mk]
        // - reject if no new blocks were advertised
        const noNew = headers.statements.reduce((have, idx) => {
          return have && !!share.indices[idx]
        }, true)

        const noUnique = Object.keys(share.indices).reduce((have, idx) => {
          debugger
          return have && !!share.indices[idx]
        }, true)

        // noNew = localHaveAll, noUnique = remoteHasAll
        if (noNew && noUnique) return accept(false)

        // TODO: Request the master record on the write topic only
        // if it's not locally finalized yet.

        // Initialize feed here, instead of in fn resolve..
        if (!share.feed) {
          const fptr = ++this.__fctr
          const storage = p => this.__storage(`cache/${fptr}/${p}`)
          // Use sparse mode to avoid downloading the whole feed.
          share.feed = new Feed(storage, key, { sparse: true })
          share.feed.on('download', (i, d) => this._verifyBlock(share.feed, i, d))
        }

        // Mark indices remote wanted to share with us to be downloaded.
        share.feed.download({ blocks: headers.statements })

        return accept(true)
      }
    })
  }

  /**
   * Checks wether a remote ptr is included in the reduced log.
   */
  contains (key, idx) {
    const ks = parsePtr(key, idx)
    const mk = ks.key.toString('hex')
    return !!(this._recorded[mk] && this._recorded[mk][ks.idx])
    // return this.scanFind(key, idx).then(res => !!res)
  }

  /*
  async scanFind (key, idx) {
    for (let n = this.length - 1; n >= 0; n--) {
      debugger
    }
  } */

  repliduce (initator, opts) {
    if (this.finalized) throw new Error('We`re closed')
    return this.exchange.replicate(initator, opts)
  }

  _index () {
    for (let i = 0; i < this.length; i++) {
      debugger
    }
  }

  _verifyBlock (feed, idx, data) { // maybe peer as param also.
    const stmt = Reducer.decodeVerify(feed.key, data)
    if (!stmt && stmt.sequence !== idx) return this._expunge(feed, idx)
    // TODO: decode stmt.data using ops.contentEncoding if available.
    if (!this._filterFn(stmt)) return this._expunge(feed, idx)

    // Block is approved, append it to shares and forward || record.
    const mk = feed.key.toString('hex')
    this._shares[mk].indices[idx] = true

    if (!this.writable) { // We're just another peer
      // TODO: Forward announce
      debugger
    } else {
      // We're acting as witness, record the statement.
      this.append(data, err => {
        if (err) return this.emit('error', err)
        // Notify all connected peers that a new version is available.
        // This can be done automatically if hyperplexer supported
        // manual force resolve/share live-flag.

        // TODO: replace with mgr.broadcast()
        const meta = {
          key: this.key,
          headers: { master_record: true, finalized: this.finalized, version: this.length }
        }
        for (const peer of this.exchange.peers) {
          this.exchange.share(peer, [meta], { namespace: 'default' })
        }
      })
    }
  }

  // -- STATIC CRYPTO & SERIALIZATION -- //

  static appendStatement (feed, context, data, cb = null) {
    const buf = Reducer.createStatement(feed.secretKey, feed.length, context, data)
    const p = defer(done => feed.append(buf, done))
    return infer(p, cb)
  }

  static createStatement (secret, idx, context, data) {
    const out = {
      // sodium Ed25519 secret keys are a concatenation of (sk + pk)
      // thus we'll extract the publicKey from the signing secret.
      key: secret.slice(32),
      context,
      data,
      sequence: idx
    }

    // TODO: check sodium docs for in-place signing avoiding Buffer.concat
    // as this unecessarily doubles memory consumption.
    const signBuffer = Buffer.concat([
      out.key,
      Buffer.from([out.sequence]),
      Buffer.from(out.context),
      out.data
    ])

    out.signature = sign(signBuffer, secret)

    // Do a local integrity check to avoid appending invalid statements.
    const valid = verify(signBuffer, out.signature, out.key)
    if (!valid) throw new Error('Integrity check failed, did you provide a proper signing-pair?')

    const bin = Buffer.allocUnsafe(STATEMENT_MAGIC.length + Statement.encodingLength(out))
    STATEMENT_MAGIC.copy(bin)
    Statement.encode(out, bin, STATEMENT_MAGIC.length)
    return bin
  }

  static verifyFeedEntry (feed, idx, cb = null) {
    const p = defer(done => feed.get(idx, done))
      .then(entry => {
        const stmt = Reducer.decodeVerify(feed.key, entry)
        if (stmt === INVALID_STMT) return INVALID_STMT
        if (stmt.sequence !== idx) return INVALID_STMT
        return stmt
      })
    return infer(p, cb)
  }

  static decodeVerify (pkey, buf, offset = 0, end) {
    const stmt = Reducer.decodeStatement(buf, offset, end)
    if (!pkey.equals(stmt.key)) return INVALID_STMT

    // TODO: check sodium docs for in-place signing avoiding Buffer.concat
    // as this unecessarily doubles memory consumption.
    const signBuffer = Buffer.concat([
      stmt.key,
      Buffer.from([stmt.sequence]),
      Buffer.from(stmt.context),
      stmt.data
    ])

    const valid = verify(signBuffer, stmt.signature, pkey)
    if (!valid) return INVALID_STMT
    return stmt
  }

  static decodeStatement (buf, offset = 0, end) {
    if (!STATEMENT_MAGIC.equals(buf.slice(offset, STATEMENT_MAGIC.length))) throw new Error('Not a Statement or Magic header missing')
    return Statement.decode(buf, offset + STATEMENT_MAGIC.length, end)
  }
}

module.exports.STATEMENT_MAGIC = STATEMENT_MAGIC

function parsePtr (key, idx) {
  if (typeof key === 'string' && key.length > 64) {
    const [k, i] = key.split('@')
    return parsePtr(Buffer.from(k, 'hex'), parseInt(i))
  } else if (typeof key === 'string') {
    return parsePtr(Buffer.from(key, 'hex'), idx)
  }
  if (!Number.isInteger(idx)) throw new Error('second argumentd "idx" must be an integer')
  return { key, idx }
}
