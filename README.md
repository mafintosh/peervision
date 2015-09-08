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

THIS CURRENTLY STILL A WORK IN PROGRESS.
CURRENTLY ALL DATA IS STORED IN MEMORY.

## How does it work?

peervision uses a flat merkle tree where every bottom
indirectly verifies the entire previous tree using [flat-tree](https://github.com/mafintosh/flat-tree) and
signs the latest node using elliptic curve cryptography.

(more details to be added here obviously)

## License

MIT
