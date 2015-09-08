# peervision

WIP (a live p2p streaming protocol)

```
npm install peervision
```

## Usage

``` js
var peervision = require('peervision')

var producer = peervision()

producer.append(new Buffer('some data'))
producer.append(new Buffer('some more data'))

console.log('stream id is', producer.id)

var client = peervision(producer.id)

var stream = client.createStream()

stream.pipe(producer.createStream()).pipe(stream)

client.get(0, function (err, buf) {
  console.log(buf) // some data
})

client.get(1, function (err, buf) {
  console.log(buf) // some more data
})

```

## License

MIT
