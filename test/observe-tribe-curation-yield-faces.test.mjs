import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { observeTribeCurationYield } from "../scripts/observe-tribe-curation-yield.mjs";

const examples = [
  {
    "type": "JavascriptNodeOperationExample",
    "name": "observes LEO tag yield and hive-engine supply from two agreeing fixture nodes",
    "input": {
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
    },
    "output": {
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
            "node": "https://api.hive-engine.com/rpc",
            "circulatingSupply": "29632400.359",
            "totalStaked": "14170916.645",
            "precision": 3
          }
        }
      ],
      "accounts": {}
    }
  }
];

for (const example of examples) {
  test(example.name, async () => {
    const importedOutput = await observeTribeCurationYield(example.input);
    assert.deepEqual(importedOutput, example.output);
    const command = spawnSync(process.execPath, [fileURLToPath(new URL("../scripts/observe-tribe-curation-yield.mjs", import.meta.url))], {
      input: JSON.stringify(example.input) + "\n",
      encoding: "utf8",
    });
    assert.equal(command.status, 0, command.stderr);
    const commandOutput = JSON.parse(command.stdout.trim());
    assert.deepEqual(commandOutput, example.output);
    assert.deepEqual(commandOutput, importedOutput);
  });
}
