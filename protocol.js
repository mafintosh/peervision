var lpstream = require('length-prefixed-stream')
var duplexify = require('duplexify')
var util = require('util')
var messages = require('./messages')

module.exports = Protocol

function Protocol () {
  if (!(this instanceof Protocol)) return new Protocol()

  var self = this
  var encode = lpstream.encode()
  var decode = lpstream.decode()

  this._encoder = encode
  this._requests = []

  decode.on('data', function (data) {
    self._decode(data)
  })

  duplexify.call(this, decode, encode)
}

util.inherits(Protocol, duplexify)

Protocol.prototype.request = function (index, cb) {
  var id = this._id()
  this._requests[id] = cb
  this._encode(0, messages.Request, {id: id, index: index})
}

Protocol.prototype.have = function (index) {
  this._encode(2, messages.Have, {index: index})
}

Protocol.prototype.bitfield = function (bitfield, head) {
  this._encode(3, messages.Bitfield, {bitfield: bitfield, head: head})
}

Protocol.prototype._decode = function (data) {
  var type = data[0]

  switch (type) {
    case 0:
    var req = messages.Request.decode(data, 1)
    this.emit('request', req.index, createCallback(this, req.id))
    return

    case 1:
    var res = messages.Response.decode(data, 1)
    var cb = removeCallback(this._requests, res.id)
    if (res.error) cb(new Error(res.error))
    else cb(null, res)
    return

    case 2:
    var have = messages.Have.decode(data, 1)
    this.emit('have', have.index)
    return

    case 3:
    var msg = messages.Bitfield.decode(data, 1)
    this.emit('bitfield', msg.bitfield, msg.head)
    return
  }

  this.emit('error', new Error('Unknown message'))
}

Protocol.prototype._encode = function (type, encoder, msg) {
  var buf = new Buffer(encoder.encodingLength(msg) + 1)
  encoder.encode(msg, buf, 1)
  buf[0] = type
  this._encoder.write(buf)
}

Protocol.prototype._id = function () {
  var id = this._requests.indexOf(null)
  return id === -1 ? this._requests.push(null) - 1 : id
}

function removeCallback (reqs, i) {
  var cb = reqs[i]
  reqs[i] = null
  while (reqs.length && !reqs[reqs.length - 1]) reqs.pop()
  return cb
}

function createCallback (self, id) {
  return function (err, response) {
    self._encode(1, messages.Response, {
      id: id,
      error: err && err.message,
      signature: response && response.signature,
      data: response && response.data,
      indexes: response && response.indexes,
      hashes: response && response.hashes
    })
  }
}

if (require.main !== module) return

var p = Protocol()

p.on('have', function (index) {
  console.log('have', index)
})

p.on('bitfield', function (data) {
  console.log('bitfield', data)
})

p.on('request', function (index, cb) {
  console.log('request', index)
  cb(null, {data: new Buffer('lol')})
  // cb(null, [new Buffer('hello-1'), new Buffer('world-1')])
})

p.request(10, console.log)
p.have(1)
p.bitfield(new Buffer(10))

p.pipe(p)