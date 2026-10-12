import assert from "node:assert/strict";
import test from "node:test";
import { observeTribeCurationYield } from "../scripts/observe-tribe-curation-yield.mjs";

const PRIMARY = "https://mock-primary.example";
const SECONDARY = "https://mock-secondary.example";
const NOW = "2026-09-05T00:10:00.000Z";

function post({ author, permlink, payout, rshares, createdSecondsAgo }) {
  const created = new Date(new Date(NOW).getTime() - createdSecondsAgo * 1000).toISOString().slice(0, -5);
  return { author, permlink, created, pending_payout_value: `${payout} HBD`, net_rshares: rshares };
}

function makeMockFetch(options) {
  const answer = answerMock(options);
  return async (input, init) => {
    const reply = await answer(input, init);
    return new Response(JSON.stringify(await reply.json()), { status: reply.status });
  };
}

function answerMock({ primaryBlock, secondaryBlock, leoPosts, hiveEngineLeo, accountsByNode }) {
  return async (input, init) => {
    const node = String(input);
    const body = JSON.parse(init.body);
    if (body.method === "condenser_api.get_dynamic_global_properties") {
      return { ok: true, status: 200, json: async () => ({ result: { head_block_number: node === PRIMARY ? primaryBlock : secondaryBlock } }) };
    }
    if (body.method === "bridge.get_ranked_posts") {
      const posts = body.params.tag === "leofinance" ? leoPosts : [];
      return { ok: true, status: 200, json: async () => ({ result: posts }) };
    }
    if (body.method === "findOne") {
      return { ok: true, status: 200, json: async () => ({ result: body.params.query.symbol === "LEO" ? hiveEngineLeo : null }) };
    }
    if (body.method === "find") {
      return { ok: true, status: 200, json: async () => ({ result: body.params.query.symbol === "LEO" ? [hiveEngineLeo] : [] }) };
    }
    if (body.method === "condenser_api.get_accounts") {
      const account = body.params[0][0];
      return { ok: true, status: 200, json: async () => ({ result: [accountsByNode[node][account]] }) };
    }
    throw new Error(`unmocked method ${body.method}`);
  };
}

function account({ vesting, delegated, mana, lastUpdate }) {
  return {
    voting_manabar: { current_mana: mana, last_update_time: lastUpdate },
    vesting_shares: `${vesting} VESTS`,
    delegated_vesting_shares: `${delegated} VESTS`,
    received_vesting_shares: "0.000000 VESTS",
  };
}

test("observes tag yield, hive-engine supply, and projected account mana", async () => {
  const leoPosts = [
    post({ author: "a", permlink: "p1", payout: "1.000", rshares: 10_000_000, createdSecondsAgo: 60 }),
    post({ author: "b", permlink: "p2", payout: "0.500", rshares: 5_000_000, createdSecondsAgo: 600 }),
  ];
  const hiveEngineLeo = { symbol: "LEO", circulatingSupply: "29632400.359", totalStaked: "14170916.645", precision: 3 };
  const acct = account({ vesting: "1000000.000000", delegated: "0.000000", mana: 500_000_000_000, lastUpdate: Math.floor(new Date(NOW).getTime() / 1000) - 216000 });
  const fetchImpl = makeMockFetch({
    primaryBlock: 100000,
    secondaryBlock: 100001,
    leoPosts,
    hiveEngineLeo,
    accountsByNode: { [PRIMARY]: { emsenn0: acct }, [SECONDARY]: { emsenn0: acct } },
  });

  const record = await observeTribeCurationYield({ nodes: [PRIMARY, SECONDARY], accounts: ["emsenn0"], tags: [{ name: "LEO", tag: "leofinance", symbol: "LEO" }], now: NOW, fetchImpl });

  assert.equal(record.type, "TribeCurationYieldObservationRecord");
  assert.deepEqual(record.witnesses, [
    { node: PRIMARY, headBlockNumber: 100000 },
    { node: SECONDARY, headBlockNumber: 100001 },
  ]);
  const leo = record.tags[0];
  assert.equal(leo.postCount, 2);
  assert.equal(leo.pendingPayoutSumHbd, "1.5");
  assert.equal(leo.netRshareSum, "15000000");
  assert.equal(leo.yieldHbdPerMillionRshares, "0.1");
  assert.equal(leo.newestPostAgeSeconds, 60);
  assert.equal(leo.oldestPostAgeSeconds, 600);
  assert.equal(leo.hiveEngine.circulatingSupply, "29632400.359");
  const mana = record.accounts.emsenn0.votingManabar;
  assert.equal(mana.maxManaRaw, "1000000000000");
  assert.equal(mana.currentManaRaw, "1000000000000");
  assert.equal(mana.currentManaPercent, "100");
});

test("refuses when the two nodes' head_block_number disagrees beyond maxBlockGap", async () => {
  const acct = account({ vesting: "1.000000", delegated: "0.000000", mana: 1, lastUpdate: 1 });
  const fetchImpl = makeMockFetch({
    primaryBlock: 100000,
    secondaryBlock: 100010,
    leoPosts: [],
    hiveEngineLeo: { symbol: "LEO", circulatingSupply: "0", totalStaked: "0", precision: 3 },
    accountsByNode: { [PRIMARY]: { emsenn0: acct }, [SECONDARY]: { emsenn0: acct } },
  });
  await assert.rejects(
    observeTribeCurationYield({ nodes: [PRIMARY, SECONDARY], accounts: ["emsenn0"], tags: [], now: NOW, fetchImpl }),
    /CURATION_YIELD_NODE_DISAGREEMENT: head_block_number gap/u,
  );
});

test("refuses when the two nodes' account vesting disagrees beyond toleranceBasisPoints", async () => {
  const fetchImpl = makeMockFetch({
    primaryBlock: 100000,
    secondaryBlock: 100000,
    leoPosts: [],
    hiveEngineLeo: { symbol: "LEO", circulatingSupply: "0", totalStaked: "0", precision: 3 },
    accountsByNode: {
      [PRIMARY]: { emsenn0: account({ vesting: "1000000.000000", delegated: "0.000000", mana: 1, lastUpdate: 1 }) },
      [SECONDARY]: { emsenn0: account({ vesting: "10.000000", delegated: "0.000000", mana: 1, lastUpdate: 1 }) },
    },
  });
  await assert.rejects(
    observeTribeCurationYield({ nodes: [PRIMARY, SECONDARY], accounts: ["emsenn0"], tags: [], now: NOW, fetchImpl }),
    /CURATION_YIELD_NODE_DISAGREEMENT: account emsenn0 vesting\/mana gap/u,
  );
});

test("refuses a request naming fewer than two nodes", async () => {
  await assert.rejects(observeTribeCurationYield({ nodes: [PRIMARY] }), /request\.nodes must name at least two nodes/u);
});
