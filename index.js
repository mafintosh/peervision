var events = require('events')
var util = require('util')
var protocol = require('./lib/protocol')
var bufferEquals = require('buffer-equals')
var sodium = require('sodium').api
var tree = require('flat-tree')
var crypto = require('crypto')
var bitfield = require('bitfield')
var eos = require('end-of-stream')
var map = require('numeric-id-map')

var HASH_NONE = new Buffer([0]) // enum to indicate no buffer
var HASH_DUPLICATE = new Buffer([1]) // enum to indicate buffer is a dup

module.exports = Peervision

function Peervision (id, opts) {
  if (!(this instanceof Peervision)) return new Peervision(id, opts)

  this.keypair = id ? {publicKey: id} : sodium.crypto_sign_keypair()
  this.id = this.keypair.publicKey

  this.tree = []
  this.signatures = []
  this.digests = []
  this.blocks = []
  this.have = bitfield(1, {grow: Infinity})
  this.peers = []

  this._pendingRequests = map()
  this._requests = map()
  this._head = -1

  events.EventEmitter.call(this)
}

util.inherits(Peervision, events.EventEmitter)

Peervision.prototype.createStream = function () {
  var self = this

  var stream = protocol({
    protocol: 1,
    blocks: this.have.buffer.slice(0, Math.ceil(this.blocks.length / 8))
  })

  stream.head = -1
  stream.blocks = null

  stream.on('handshake', function (handshake) {
    stream.blocks = bitfield(handshake.blocks ? handshake.blocks : 1, {grow: Infinity})
    stream.head = getHead(stream.blocks)
    self._update()
  })

  stream.on('have', function (have) {
    if (have.index > stream.head) stream.head = have.index
    stream.blocks.set(have.index)
  // console.error('remote have', have.index)
    self._update()
  })

  stream.on('request', function (request) {
    var hashes = []
    for (var i = 0; i < request.tree.length; i++) {
      // console.error('request for', request.tree[i], self.tree.length)
      hashes[i] = self._getTree(request.tree[i])
    }

    stream.response({
      id: request.id,
      tree: hashes,
      signature: request.signature ? self.signatures[request.index] : null,
      data: request.digest ? self.digests[request.index] : self.blocks[request.index]
    })
  })

  this.peers.push(stream)
  eos(stream, function () {
    self.peers.splice(self.peers.indexOf(stream), 1)
  })

  return stream
}

Peervision.prototype.get = function (index, cb) {
  if (!cb) cb = noop
  var i = this._getPeer(index)

  if (i === -1) {
    this._pendingRequests.add([index, cb])
    return
  }

  this._get(this.peers[i], index, cb)
}

Peervision.prototype._get = function (peer, index, cb) {
  if (this.blocks[index]) return cb(null, this.blocks[index])

  var self = this
  var head = this.digests.length - 1

  if (peer.head <= head || index <= head) send()
  else this._getHead(peer, send) // TODO: if the piece we need is peer.head we can save a roundtrip

  function send (err) {
    if (err) return cb(err)
    if (self.blocks[index]) return cb(null, self.blocks[index])

    var treeIndex = tree.index(0, index)

    var roots = tree.fullRoots(treeIndex)
    var treeCache = []
    var treeIndexes = []
    var treeDups = []

    var needed = treeIndex
    var checksum

    for (var i = 0; i < roots.length; i++) {
      pushIndex(self, roots[i], treeIndexes, treeCache)
    }

    while (!(checksum = self.tree[needed])) {
      var sibling = tree.sibling(needed)
      pushIndex(self, sibling, treeIndexes, treeCache, treeDups)
      needed = tree.parent(needed)
    }

// console.error('blocks', treeIndex, self.tree.length)
    peer.request({index: index, tree: treeIndexes, digest: false}, function (err, res) {
      if (err) return cb(err)

      treeCache = mergeTree(treeCache, res, treeDups)
      needed = treeIndex

      var digest = createHash().update(res.data).digest()
      var treeDigest = treeHash(treeCache, roots.length, digest)
      var sum = treeDigest

      for (var i = roots.length; i < treeCache.length; i++) {
        var sibling = tree.sibling(needed)
        var siblingSum = treeCache[i]

        if (needed > sibling) { // swap so "sum" is always left sibling
          var tmp = sum
          sum = siblingSum
          siblingSum = tmp
        }

        sum = createHash().update(sum).update(siblingSum).digest()
        needed = tree.parent(needed)

        // quick hash to push the possible parents to the response so they'll get stored on validation
        res.tree.push(sum)
        treeIndexes.push(needed)
      }

      if (!bufferEquals(sum, checksum)) return cb(new Error('Tree checksum mismatch'))

      // everything is fine - store the response

      for (var i = 0; i < treeIndexes.length; i++) self.tree[treeIndexes[i]] = res.tree[i]
      self.tree[treeIndex] = treeDigest
      self.blocks[index] = res.data
      self.digests[index] = digest
      self.signatures[index] = res.signature
      self._have(index)

      // console.log('After fetching block')
      // debugTree(self.tree)

      cb(null, res.data)
    })
  }
}

Peervision.prototype._getHead = function (peer, cb) {
  var self = this
  var peerHead = peer.head
  var treeHead = tree.index(0, peerHead)
  var roots = tree.fullRoots(treeHead)
  var treeCache = []
  var treeIndexes = []
  var treeDups = []

  var prevRoots = tree.fullRoots(tree.index(0, Math.max(0, this.digests.length - 1)))
  var prevRootParents = []

  for (var i = 0; i < roots.length; i++) {
    pushIndex(this, roots[i], treeIndexes, treeCache)
  }

  treeIndexes.push(treeHead)
  treeCache.push(HASH_NONE)

  // filter out dups
  var filter = []
  for (var j = 0; j < prevRoots.length; j++) {
    if (roots.indexOf(prevRoots[j]) === -1) filter.push(prevRoots[j])
  }
  prevRoots = filter

  // migrate from old roots to new roots
  for (var j = 0; j < prevRoots.length; j++) {
    var needed = prevRoots[j]
    var root = -1
    while ((root = roots.indexOf(needed)) === -1) {
      var sibling = tree.sibling(needed)
      pushIndex(this, sibling, treeIndexes, treeCache, treeDups)
      needed = tree.parent(needed)
    }
    prevRootParents.push(root)
  }
// console.error('heads', treeHead, roots, treeIndexes)
  peer.request({index: peerHead, tree: treeIndexes, digest: false, signature: true}, function (err, res) {
    if (self.blocks.length >= peerHead) return cb() // this request is no longer relevant
    if (err) return cb(err)

    mergeTree(treeCache, res, treeDups)

    var peerTreeDigest = treeCache[roots.length]
    var signed = sodium.crypto_sign_verify_detached(res.signature, peerTreeDigest, self.id)
    if (!signed) return cb(new Error('Tree signature is invalid'))

    var digest = createHash().update(res.data).digest()
    var treeDigest = treeHash(treeCache, roots.length, digest)

    if (!bufferEquals(treeDigest, peerTreeDigest)) return cb(new Error('Tree checksum mismatch'))

    // haxx - this is mostly duplicate code :/
    needed = prevRoots.length ? prevRoots.shift() : -1

    var sum = self.tree[needed]
    for (var i = roots.length + 1; i < treeCache.length; i++) {
      if (needed !== roots[prevRootParents[0]]) {
        var sibling = tree.sibling(needed)
        var siblingSum = treeCache[i]

        if (needed > sibling) { // swap so "sum" is always left sibling
          var tmp = sum
          sum = siblingSum
          siblingSum = tmp
        }
        sum = createHash().update(sum).update(siblingSum).digest()
        needed = tree.parent(needed)
      }

      // quick hash to push the possible parents to the response so they'll get stored on validation
      res.tree.push(sum)
      treeIndexes.push(needed)

      if (needed === roots[prevRootParents[0]]) {
        var cached = treeCache[prevRootParents.shift()]
        if (!bufferEquals(cached, sum)) {
          return cb(new Error('Tree checksum mismatch'))
        }
        needed = prevRoots.length ? prevRoots.shift() : -1
        sum = self.tree[needed]
      }
    }

    if (needed !== -1) return cb(new Error('Tree checksum mismatch'))

    // everything is fine - store the response

    for (var i = 0; i < treeIndexes.length; i++) self.tree[treeIndexes[i]] = res.tree[i]
    self.blocks[peerHead] = res.data
    self.digests[peerHead] = digest
    self.signatures[peerHead] = res.signature

    self._have(peerHead)

    cb(null)
  })
}

Peervision.prototype._getPeer = function (index) {
  var selected = -1
  var found = 1

  for (var i = 0; i < this.peers.length; i++) {
    var p = this.peers[i]
    if (p && p.blocks && p.blocks.get(index)) {
      if (Math.random() < (1 / found++)) selected = i
    }
  }

  return selected
}

Peervision.prototype.append = function (block, cb) {
  if (!this.keypair.secretKey) throw new Error('Only the producer can append chunks')

  var index = this.blocks.length
  var treeIndex = tree.index(0, index)
  var digest = createHash().update(block).digest()
  var roots = tree.fullRoots(treeIndex)

  var hash = createHash()
  hash.update(digest)
  for (var i = 0; i < roots.length; i++) {
    hash.update(this._getTree(roots[i]))
  }

  var treeDigest = hash.digest()
  var signature = sodium.crypto_sign_detached(treeDigest, this.keypair.secretKey)

  this.blocks[index] = block
  this.digests[index] = digest
  this.signatures[index] = signature
  this.tree[treeIndex] = treeDigest

  this._have(index)

  if (cb) cb()
}

Peervision.prototype._have = function (index) {
  this.have.set(index, true)
  for (var i = 0; i < this.peers.length; i++) {
    this.peers[i].have({index: index})
  }

  if (index > this._head) {
    this._head = index
    this.emit('head', index)
  }
}

Peervision.prototype._update = function () {
  if (!this._pendingRequests.length) return

  for (var i = 0; i < this._pendingRequests.length; i++) {
    var pair = this._pendingRequests.get(i)
    if (!pair) continue

    var index = pair[0]
    var cb = pair[1]

    var peer = this._getPeer(index)
    if (peer === -1) continue

    this._pendingRequests.remove(i)
    this._get(this.peers[peer], index, cb)
  }
}

Peervision.prototype._getTree = function (index) {
  if (index === -1) throw new Error('Invalid index')
  if (this.tree[index]) return this.tree[index]

  var hash = createHash()
    .update(this._getTree(tree.leftChild(index)))
    .update(this._getTree(tree.rightChild(index)))
    .digest()

  this.tree[index] = hash
  return hash
}

function noop () {}

function pushIndex (self, index, treeIndexes, treeCache, treeDups) {
  if (treeDups) {
    var i = treeIndexes.indexOf(index)
    if (i > -1) {
      treeCache.push(HASH_DUPLICATE)
      treeDups.push(i)
      return
    }
  }

  var hash = self.tree[index]

  if (!hash) {
    treeIndexes.push(index)
    treeCache.push(HASH_NONE)
  } else {
    treeCache.push(hash)
  }
}

function mergeTree (tree, res, dups) {
  var offset = 0
  var dupsOffset = 0

  for (var i = 0; i < tree.length; i++) {
    if (tree[i] === HASH_NONE) tree[i] = res.tree[offset++]
    if (tree[i] === HASH_DUPLICATE) tree[i] = res.tree[dups[dupsOffset++]]
  }

  return tree
}

function treeHash (roots, end, digest) {
  var hash = createHash()
  hash.update(digest)
  for (var i = 0; i < end; i++) hash.update(roots[i])
  return hash.digest()
}

function createHash () {
  return crypto.createHash('sha256')
}

function getHead (bitfield) {
  var end = bitfield.buffer.length * 8
  var max = -1
  for (var i = end - 8; i < end; i++) {
    if (bitfield.get(i)) max = i
  }
  return max
}
