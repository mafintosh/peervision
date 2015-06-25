var protocol = require('./protocol')
var eos = require('end-of-stream')
var bitfield = require('bitfield')
var events = require('events')

var MAX_FIELD = 5 * 1024 * 1024

// TODO: add the hashes and flat-tree
// and store them in a level + store
// the actual data in a file/blob-store
module.exports = function () {
  var that = new events.EventEmitter()
  var blocks = []
  var haves = bitfield(1024, {grow: MAX_FIELD})

  var peers = []
  var pending = []

  function update () {
    if (!pending.length) return

    var updated = []

    for (var i = 0; i < pending.length; i++) {
      var args = pending[i]
      var p = selectPeer(args[0])
      if (p === -1) continue
      updated.push(i)
    }

    for (var j = updated.length - 1; j >= 0; j--) {
      var args = pending.splice(updated[j], 1)[0]
      request(peers[selectPeer(args[0])], args[0], args[1])
    }
  }

  function have (index) {
    haves.set(index)
    for (var i = 0; i < peers.length; i++) {
      if (!peers[i].blocks.get(index)) peers[i].have(index)
    }
  }

  function selectPeer (index) {
    var selected = []
    for (var i = 0; i < peers.length; i++) {
      if (peers[i].blocks.get(index)) selected.push(i)
    }
    if (!selected.length) return -1
    return selected[(Math.random() * selected.length) | 0]
  }

  function request (peer, index, cb) {
    peer.request(index, function (err, result) {
      if (err) return cb(err)
      blocks[index] = result.data
      have(index)
      cb(null, result.data)
    })
  }

  function updateHead (index) {
    if (index <= that.head) return
    that.head = index
    that.emit('head', index)
  }

  that.head = 0

  that.createStream = function () {
    var peer = protocol()

    peer.blocks = bitfield(1024, {grow: MAX_FIELD})

    peer.on('request', function (index, cb) {
      if (blocks[index]) return cb(null, {data: blocks[index]})
      cb(new Error('block not available'))
    })

    peer.on('have', function (index) {
      peer.blocks.set(index)
      updateHead(index)
      update()
    })

    peer.on('bitfield', function (data) {
      peer.blocks = bitfield(data, {grow: MAX_FIELD})
      var len = 8 * data.length
      for (var i = len - 1; i >= Math.max(0, len - 8); i--) {
        if (peer.blocks.get(i)) {
          updateHead(i)
          break
        }
      }
      update()
    })

    peers.push(peer)
    eos(peer, function () {
      peers.splice(peers.indexOf(peer), 1)
    })

    peer.bitfield(haves.buffer)

    return peer
  }

  that.append = function (data) {
    blocks.push(data)
    have(blocks.length - 1)
    updateHead(blocks.length - 1)
  }

  that.get = function (index, cb) {
    if (blocks[index]) return cb(null, blocks[index])

    var p = selectPeer(index)
    if (p === -1) pending.push([index, cb])
    else request(peers[p], index, cb)
  }

  return that
}

if (require.main !== module) return

var producer = module.exports()

var viewer1 = module.exports()
var viewer2 = module.exports()

var s1 = producer.createStream()
s1.pipe(viewer1.createStream()).pipe(s1)

var s2 = viewer1.createStream()
s2.pipe(viewer2.createStream()).pipe(s2)

viewer1.get(0, console.log)
viewer2.get(0, console.log)
viewer1.get(1, console.log)
viewer2.get(1, console.log)

producer.append(new Buffer('hello-0'))
setTimeout(function () {
  producer.append(new Buffer('hello-1'))
}, 1000)

