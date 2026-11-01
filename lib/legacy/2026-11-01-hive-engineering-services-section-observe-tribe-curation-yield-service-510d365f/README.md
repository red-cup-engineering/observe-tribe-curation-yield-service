# @red-cup-engineering/observe-tribe-curation-yield-service

Observes the current curation-yield signal per Hive-Engine tribe tag (and the base layer), the
requested accounts' voting mana, and the exact candidate/price inputs a curation planner needs.
Every candidate retained for planning and the curation price are cross-checked on two public Hive
nodes; a post missing its second witness is deliberately excluded rather than silently chosen from
one node.

## Operation

~~~js
export async function observeTribeCurationYield(request = {})
~~~

### Parameters

- request (@param {readonly string[]} [request.nodes] Two public Hive condenser/bridge JSON-RPC node base
 *   URLs to cross-check (default `["https://api.hive.blog","https://api.openhive.network"]`).
 * @param {string} [request.hiveEngineNode] One public Hive-Engine sidechain RPC base URL for tribe
 *   token supply/stake (default `"https://api.hive-engine.com/rpc/contracts"`).
 * @param {readonly {name:string,tag:string,symbol:(string|null)}[]} [request.tags] Tribe tags to
 *   observe (default LEO/POB/CENT/WAIV plus a `symbol:null` base-layer `"hive"` row).
 * @param {number} [request.postsPerTag] `bridge.get_ranked_posts` limit per tag (default 20).
 * @param {readonly string[]} [request.accounts] Accounts whose voting mana to project (default
 *   `["emsenn0","michael561"]`).
 * @param {number} [request.toleranceBasisPoints] Max allowed disagreement between the two nodes'
 *   per-tag pending-payout sums and per-account mana/vesting readings, in basis points, before
 *   refusal (default 200).
 * @param {number} [request.maxBlockGap] Max allowed head-block-number disagreement between the two
 *   nodes before refusal (default 3).
 * @param {typeof fetch} [request.fetchImpl] Injectable fetch implementation, for tests.
 * @param {object} [request.fixtures] Literal pre-recorded results (`dynamicGlobalProperties` keyed
 *   by node; `rankedPosts` keyed by `` `${node}|${tag}` ``; `hiveEngineTokens` keyed by symbol;
 *   `accounts` keyed by `` `${node}|${account}` ``) standing in for the live reads they name.
 * @param {string} [request.now] An injectable ISO instant for `observedAt` and mana/post-age
 *   projection, for deterministic replay (default the real current time).
 * ): 

### Returns

Promise<object>: A `TribeCurationYieldObservationRecord`:
`{type,version,observedAt,witnesses,tags,accounts,candidatePosts,excludedCandidates,curationPrice,curationPriceWitnesses}`.

### Refusals

- TypeError: When `request.nodes` names fewer than two nodes.
- Error: `CURATION_YIELD_NODE_DISAGREEMENT` when the two nodes' head-block-number, a tag's
pending-payout sum, or an account's mana/vesting reading disagree beyond the declared tolerance.

## Command

observe-tribe-curation-yield reads one JSON value per input line and writes one JSON value per output line.

## Examples

### observes LEO tag yield and hive-engine supply from two agreeing fixture nodes

Input:

~~~json
{
  "nodes": [
    "https://api.hive.blog",
    "https://api.openhive.network"
  ],
  "tags": [
    {
      "name": "LEO",
      "tag": "leofinance",
      "symbol": "LEO"
    }
  ],
  "accounts": [],
  "now": "2026-09-05T00:10:00.000Z",
  "fixtures": {
    "dynamicGlobalProperties": {
      "https://api.hive.blog": {
        "head_block_number": 100000
      },
      "https://api.openhive.network": {
        "head_block_number": 100000
      }
    },
    "rankedPosts": {
      "https://api.hive.blog|leofinance": [
        {
          "author": "a",
          "permlink": "p1",
          "created": "2026-09-05T00:09:00",
          "pending_payout_value": "1.000 HBD",
          "net_rshares": 10000000
        }
      ],
      "https://api.openhive.network|leofinance": [
        {
          "author": "a",
          "permlink": "p1",
          "created": "2026-09-05T00:09:00",
          "pending_payout_value": "1.000 HBD",
          "net_rshares": 10000000
        }
      ]
    },
    "hiveEngineTokens": {
      "LEO": {
        "symbol": "LEO",
        "circulatingSupply": "29632400.359",
        "totalStaked": "14170916.645",
        "precision": 3
      }
    },
    "accounts": {}
  }
}
~~~

Output:

~~~json
{
  "type": "TribeCurationYieldObservationRecord",
  "version": 1,
  "observedAt": "2026-09-05T00:10:00.000Z",
  "witnesses": [
    {
      "node": "https://api.hive.blog",
      "headBlockNumber": 100000
    },
    {
      "node": "https://api.openhive.network",
      "headBlockNumber": 100000
    }
  ],
  "tags": [
    {
      "name": "LEO",
      "tag": "leofinance",
      "symbol": "LEO",
      "postCount": 1,
      "pendingPayoutSumHbd": "1",
      "netRshareSum": "10000000",
      "yieldHbdPerMillionRshares": "0.1",
      "oldestPostAgeSeconds": 60,
      "newestPostAgeSeconds": 60,
      "hiveEngine": {
        "node": "https://api.hive-engine.com/rpc/contracts",
        "circulatingSupply": "29632400.359",
        "totalStaked": "14170916.645",
        "precision": 3
      }
    }
  ],
  "accounts": {}
}
~~~
