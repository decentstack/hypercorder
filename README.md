

[![Build Status](https://travis-ci.com/decentstack/hypercorder.svg?branch=master)](https://travis-ci.com/decentstack/hypercorder)
[![JavaScript Style Guide](https://img.shields.io/badge/code_style-standard-brightgreen.svg)](https://standardjs.com)
[![standard-readme compliant](https://img.shields.io/badge/readme%20style-standard-brightgreen.svg?style=flat-square)](https://github.com/RichardLitt/standard-readme)

# hypercorder

```
Version: alpha-0.0.1
```

> Hypercorder is a datastructure with a cryptographic signing scheme capable of
> embedding entries from foreign feeds in a publicly verifiable way.
>
> Simply put: Many to one feed encoder.

## Introduction

Hypercorder extends [`hypercore`](https://github.com/mafintosh/hypercore) and works exactly like a regular feed with the exception
that it has 2 modes of replication.

- `feed.replicate(initiator, opts)` replicates as usual, won't be mentioned here further.
- `feed.exchange(initiator, opts)` creates a [hyperplexed](decentlabs/hyperplexer) replication stream capable of accepting 'suggestions' on new content from other peers.

Suggestions come encoded as a [`Statement`](./schema.proto) -
each statment contains cryptographic proof of it's _origin_ and _integrity_.

When participating in a "RecorderTopic" as a **moderator**,
your goal is to collect valid statements.

You control _which_ Statments are recorded by providing a `filter` function.
For optimal performance, each peer should use identical filter functions -
forming a topic-wide consensus.
Deviations in consensus are perfectly acceptable but come at the cost of reduced network throughput.

When participating in a "RecorderTopic" as a **voice**,
your goal is to `publish` your own statements and replicate data until either your statements are recorded or the main feed finalized.

In order for your statement to be `recorded` it has to reach a moderator and
pass that individual's `filter` function.

Anyone with access to the "RecorderTopic" has **uncensored** access to content.

My hypothesis is that if each peer forwards only locally validated statements:
A self-curating network should form - your voice should be heard as long as there is anyone willing to listen.

## <a name="install"></a> Install

```
 yarn add hypercorder
 # or
 npm i hypercorder
```

## <a name="usage"></a> Usage

```js
const Recorder = require('hypercorder')

// Define a statement validation function for the network
// a statement failing the validation test will not be relayed
const filter = stmt => {
  const message = stmt.data.toString('utf8')
  if (message.match(/bad content/)) {
    return false
  } else {
    return true
  }
}

// Initialize a new hypercorder
const mainFeed = new Recorder(storage, { filter })
await mainFeed.ready()

// TODO: show how to simultaneously join 2 topics and
// differentiate between the two.

```

## <a name="contribute"></a> Contributing

Ideas and contributions to the project are welcome. You must follow this [guideline](https://github.com/telamon/hypercorder/blob/master/CONTRIBUTING.md).

## License

GNU AGPLv3 © Tony Ivanov
