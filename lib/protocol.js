var messages = require('./messages')
var lpstream = require('length-prefixed-stream')
var duplexify = require('duplexify')
var util = require('util')

var DESTROYED = new Error('Stream was destroyed')
DESTROYED.retry = true

var ENCODERS = [
  messages.Handshake,
  messages.Have,
  messages.Request,
  messages.Response
]

module.exports = ProtocolStream

function ProtocolStream (opts) {
  if (!(this instanceof ProtocolStream)) return new ProtocolStream(opts)
  if (!opts) opts = {}

  this._encode = lpstream.encode()
  this._decode = lpstream.decode()
  this._requests = []
  this._handshook = false
  this.destroyed = false

  duplexify.call(this, this._decode, this._encode)
  var self = this

  this._decode.on('data', function (data) {
    self._parse(data)
  })

  this._send(0, opts)
}

util.inherits(ProtocolStream, duplexify)

ProtocolStream.prototype.destroy = function (err) {
  if (this.destroyed) return
  this.destroyed = true

  while (this._requests.length) {
    var cb = this._requests.shift()
    if (cb) cb(err || DESTROYED)
  }

  if (err) this.emit('error', err)
  this.emit('close')
}

ProtocolStream.prototype._parse = function (buf) {
  if (this.destroyed) return

  var dec = ENCODERS[buf[0]]

  try {
    var data = dec.decode(buf, 1)
  } catch (err) {
    return this.destroy(err)
  }

  if (!this._handshook && buf[0] !== 0) {
    this.emit('error', new Error('First message should be a handshake'))
    return
  }

  switch (buf[0]) {
    case 0:
    this._handshook = true
    this.emit('handshake', data)
    return

    case 1:
    this.emit('have', data)
    return

    case 2:
    this.emit('request', data)
    return

    case 3:
    if (this._requests.length > data.id) {
      var cb = this._requests[data.id]
      this._requests[data.id] = null
      while (this._requests.length && !this._requests[this._requests.length - 1]) this._requests.pop()
      if (cb) cb(null, data)
    }
    this.emit('response', data)
    return
  }

  this.emit('unknown', buf)
}

ProtocolStream.prototype.have = function (have) {
  this._send(1, have)
}

ProtocolStream.prototype.request = function (req, cb) {
  req.id = this._requests.indexOf(null)
  if (req.id === -1) req.id = this._requests.push(null) - 1
  this._requests[req.id] = cb
  this._send(2, req)
}

ProtocolStream.prototype.response = function (res) {
  this._send(3, res)
}

ProtocolStream.prototype._send = function (type, data, cb) {
  var enc = ENCODERS[type]
  var buf = new Buffer(1 + enc.encodingLength(data))
  buf[0] = type
  enc.encode(data, buf, 1)
  this._encode.write(buf, cb)
}
