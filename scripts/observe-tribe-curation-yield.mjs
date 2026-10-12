#!/usr/bin/env node
import {
  parseDecimal,
  formatScaled,
  addDecimalStrings,
  multiplyDecimalStrings,
  divideDecimalStrings,
  stripUnitSuffix,
} from "@red-cup-engineering/exact-number-data-service/decimal-string";
import { currentVotingMana, effectiveVestingShares } from "@red-cup-engineering/hive-blockchain-client-service/rewards.mjs";
import { HiveClient } from "@red-cup-engineering/hive-blockchain-client-service";
import { EngineClient } from "@red-cup-engineering/hive-blockchain-client-service/engine.mjs";
import { runJavascriptNodeOperation } from "@red-cup-engineering/javascript-node-services-section/operation";

const DEFAULT_NODES = Object.freeze(["https://api.hive.blog", "https://api.openhive.network"]);
const DEFAULT_HIVE_ENGINE_NODE = "https://api.hive-engine.com/rpc";
const DEFAULT_TAGS = Object.freeze([
  Object.freeze({ name: "LEO", tag: "leofinance", symbol: "LEO" }),
  Object.freeze({ name: "POB", tag: "proofofbrain", symbol: "POB" }),
  Object.freeze({ name: "CENT", tag: "cent", symbol: "CENT" }),
  Object.freeze({ name: "WAIV", tag: "waivio", symbol: "WAIV" }),
  Object.freeze({ name: "BASE", tag: "hive", symbol: null }),
]);
const DEFAULT_ACCOUNTS = Object.freeze([]);

/** Relative gap between two decimal-string quantities, in basis points of their mean; 0 when equal, Infinity when one side is zero and they disagree. */
function relativeBpsGap(a, b) {
  const x = Number(a);
  const y = Number(b);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return Infinity;
  const mid = (x + y) / 2;
  if (mid === 0) return x === y ? 0 : Infinity;
  return (Math.abs(x - y) / mid) * 10000;
}

/** Relative gap between two exact fractions, in basis points of their mean. */
function fractionBpsGap(a, b) {
  const left = BigInt(a.num) * BigInt(b.den);
  const right = BigInt(b.num) * BigInt(a.den);
  if (left === right) return 0;
  const meanTwice = (left < 0n ? -left : left) + (right < 0n ? -right : right);
  if (meanTwice === 0n) return Infinity;
  // Keep six decimal places without turning the on-chain rational into a float.
  return Number((((left - right < 0n ? right - left : left - right) * 20_000_000_000n) / meanTwice)) / 1_000_000;
}

function postIdentity(post) {
  return `${post.author}/${post.permlink}`;
}

function candidateWitness(node, post) {
  return {
    node,
    created: post.created,
    pendingPayoutValue: post.pending_payout_value,
    netRshares: String(post.net_rshares ?? "0"),
  };
}

function curationPriceRecord(price) {
  return {
    hbdPerRshare: {
      num: String(price.hbdPerRshare.num),
      den: String(price.hbdPerRshare.den),
    },
    percentCurationRewards: price.percentCurationRewards,
    votePowerReserveRate: price.votePowerReserveRate,
  };
}

/**
 * Keep a candidate only when both independent bridge readers identify the same post and its
 * decision-relevant values are sufficiently close.  A ranked-post page is a volatile discovery
 * surface, so disagreement excludes that post rather than making a single node authoritative.
 */
function agreedCandidates({ primary, secondary, primaryPosts, secondaryPosts, toleranceBasisPoints, tagSpec }) {
  const secondaryById = new Map((secondaryPosts ?? []).map((post) => [postIdentity(post), post]));
  const candidates = [];
  const excluded = [];
  for (const post of primaryPosts ?? []) {
    const id = postIdentity(post);
    const other = secondaryById.get(id);
    if (!other) {
      excluded.push({ author: post.author, permlink: post.permlink, reason: "missing-second-witness" });
      continue;
    }
    const payoutGapBps = relativeBpsGap(stripUnitSuffix(post.pending_payout_value), stripUnitSuffix(other.pending_payout_value));
    const rshareGapBps = relativeBpsGap(String(post.net_rshares ?? 0), String(other.net_rshares ?? 0));
    if (post.created !== other.created || payoutGapBps > toleranceBasisPoints || rshareGapBps > toleranceBasisPoints) {
      excluded.push({
        author: post.author,
        permlink: post.permlink,
        reason: "candidate-witness-disagreement",
        createdMatches: post.created === other.created,
        payoutGapBps,
        rshareGapBps,
      });
      continue;
    }
    candidates.push({
      tag: tagSpec.tag,
      symbol: tagSpec.symbol,
      post,
      witnesses: [candidateWitness(primary, post), candidateWitness(secondary, other)],
    });
  }
  return { candidates, excluded };
}

/** A client pinned to one node, so each node's answer can be cross-checked against the other's. */
function nodeClient(node, fetchImpl) {
  return new HiveClient({ nodes: [node], fetch: fetchImpl });
}

/** `fixtureValue` when given (a literal pre-recorded result), else the awaited live call. */
async function resolveOrCall(fixtureValue, liveCall) {
  return fixtureValue !== undefined ? fixtureValue : liveCall();
}

/** Seconds between a Hive-returned ISO instant (no trailing 'Z') and `nowMs`. */
function ageSeconds(createdIso, nowMs) {
  return Math.max(0, Math.round((nowMs - new Date(`${createdIso}Z`).getTime()) / 1000));
}

/** Sum one node's ranked-posts page into postCount / pendingPayoutSumHbd / netRshareSum. */
function summarizePosts(posts) {
  const pendingPayoutSumHbd = posts.length === 0 ? "0" : addDecimalStrings(posts.map((post) => stripUnitSuffix(post.pending_payout_value)));
  const netRshareSum = posts.reduce((total, post) => total + BigInt(post.net_rshares ?? 0), 0n);
  return { postCount: posts.length, pendingPayoutSumHbd, netRshareSum: netRshareSum.toString() };
}

/** HBD pending payout per million net-rshares of accumulated vote weight — an inverse-competition curation-yield proxy, not the chain's own curator-share formula. Null when netRshareSum is zero (no signal). */
function yieldHbdPerMillionRshares(pendingPayoutSumHbd, netRshareSumString) {
  if (BigInt(netRshareSumString) === 0n) return null;
  return divideDecimalStrings(multiplyDecimalStrings(pendingPayoutSumHbd, "1000000", 30), netRshareSumString, 12);
}

/** Voting mana at `nowMs` as raw units and a percentage of max. */
function projectedMana(account, nowMs) {
  const { currentMana, maxMana } = currentVotingMana(account, nowMs / 1000);
  const currentManaPercent = maxMana === 0n ? "0" : divideDecimalStrings(multiplyDecimalStrings(currentMana.toString(), "100", 10), maxMana.toString(), 6);
  return { currentManaRaw: currentMana.toString(), maxManaRaw: maxMana.toString(), currentManaPercent, lastUpdateTime: account.voting_manabar.last_update_time };
}


/**
 * Observes the current curation-yield signal per Hive-Engine tribe tag (and the base layer), and the requested accounts' voting mana, read-only.
 * @param {object} [request]
 * @param {readonly string[]} [request.nodes] Two public Hive condenser/bridge JSON-RPC node base
 *   URLs to cross-check (default `["https://api.hive.blog","https://api.openhive.network"]`).
 * @param {string} [request.hiveEngineNode] One public Hive-Engine sidechain RPC base URL for tribe
 *   token supply/stake (default `"https://api.hive-engine.com/rpc"`).
 * @param {readonly {name:string,tag:string,symbol:(string|null)}[]} [request.tags] Tribe tags to
 *   observe (default LEO/POB/CENT/WAIV plus a `symbol:null` base-layer `"hive"` row).
 * @param {number} [request.postsPerTag] `bridge.get_ranked_posts` limit per tag (default 20).
 * @param {readonly string[]} [request.accounts] Accounts whose voting mana to project (default none).
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
 * @returns {Promise<object>} A `TribeCurationYieldObservationRecord`:
 *   `{type,version,observedAt,witnesses,tags,accounts,candidatePosts,curationPrice}`.  Candidate
 *   posts and the chain curation price are two-node observations for the downstream vote planner;
 *   local schedules are never allowed to make one RPC node authoritative.
 * @throws {TypeError} When `request.nodes` names fewer than two nodes.
 * @throws {Error} `CURATION_YIELD_NODE_DISAGREEMENT` when the two nodes' head-block-number, a tag's
 *   pending-payout sum, or an account's mana/vesting reading disagree beyond the declared tolerance.
 */
export async function observeTribeCurationYield(request = {}) {
  const nodes = request.nodes ?? DEFAULT_NODES;
  if (!Array.isArray(nodes) || nodes.length < 2) throw new TypeError("observe-tribe-curation-yield: request.nodes must name at least two nodes");
  const hiveEngineNode = request.hiveEngineNode ?? DEFAULT_HIVE_ENGINE_NODE;
  const tags = request.tags ?? DEFAULT_TAGS;
  const postsPerTag = request.postsPerTag ?? 20;
  const accounts = request.accounts ?? DEFAULT_ACCOUNTS;
  const toleranceBasisPoints = request.toleranceBasisPoints ?? 200;
  const maxBlockGap = request.maxBlockGap ?? 3;
  const fetchImpl = request.fetchImpl ?? fetch;
  const fixtures = request.fixtures;
  const nowMs = request.now ? new Date(request.now).getTime() : Date.now();
  const [primary, secondary] = nodes;

  const [primaryDgp, secondaryDgp] = await Promise.all([
    resolveOrCall(fixtures?.dynamicGlobalProperties?.[primary], () => nodeClient(primary, fetchImpl).getDynamicGlobalProperties()),
    resolveOrCall(fixtures?.dynamicGlobalProperties?.[secondary], () => nodeClient(secondary, fetchImpl).getDynamicGlobalProperties()),
  ]);
  const blockGap = Math.abs(primaryDgp.head_block_number - secondaryDgp.head_block_number);
  if (blockGap > maxBlockGap) {
    throw new Error(
      `CURATION_YIELD_NODE_DISAGREEMENT: head_block_number gap ${blockGap} exceeds maxBlockGap ${maxBlockGap} (${primary}=${primaryDgp.head_block_number}, ${secondary}=${secondaryDgp.head_block_number})`,
    );
  }

  const tagResults = [];
  const candidatePosts = [];
  const excludedCandidates = [];
  for (const tagSpec of tags) {
    const [primaryPosts, secondaryPosts] = await Promise.all([
      resolveOrCall(fixtures?.rankedPosts?.[`${primary}|${tagSpec.tag}`], () => nodeClient(primary, fetchImpl).getRankedPosts({ sort: "created", tag: tagSpec.tag, limit: postsPerTag, observer: "" })),
      resolveOrCall(fixtures?.rankedPosts?.[`${secondary}|${tagSpec.tag}`], () => nodeClient(secondary, fetchImpl).getRankedPosts({ sort: "created", tag: tagSpec.tag, limit: postsPerTag, observer: "" })),
    ]);
    const primarySummary = summarizePosts(primaryPosts ?? []);
    const secondarySummary = summarizePosts(secondaryPosts ?? []);
    const payoutGapBps = relativeBpsGap(primarySummary.pendingPayoutSumHbd, secondarySummary.pendingPayoutSumHbd);
    if (payoutGapBps > toleranceBasisPoints) {
      throw new Error(
        `CURATION_YIELD_NODE_DISAGREEMENT: tag ${tagSpec.tag} pending-payout-sum gap ${payoutGapBps.toFixed(4)}bps exceeds toleranceBasisPoints ${toleranceBasisPoints} (${primary}=${primarySummary.pendingPayoutSumHbd}, ${secondary}=${secondarySummary.pendingPayoutSumHbd})`,
      );
    }
    const agreed = agreedCandidates({
      primary,
      secondary,
      primaryPosts,
      secondaryPosts,
      toleranceBasisPoints,
      tagSpec,
    });
    candidatePosts.push(...agreed.candidates);
    excludedCandidates.push(...agreed.excluded.map((candidate) => ({ tag: tagSpec.tag, ...candidate })));
    let hiveEngine = null;
    if (tagSpec.symbol) {
      const token = await resolveOrCall(fixtures?.hiveEngineTokens?.[tagSpec.symbol], () => new EngineClient({ nodes: [hiveEngineNode], fetch: fetchImpl }).getToken(tagSpec.symbol));
      hiveEngine = token ? { node: hiveEngineNode, circulatingSupply: token.circulatingSupply, totalStaked: token.totalStaked, precision: token.precision } : null;
    }
    const ages = (primaryPosts ?? []).map((post) => ageSeconds(post.created, nowMs));
    tagResults.push({
      name: tagSpec.name,
      tag: tagSpec.tag,
      symbol: tagSpec.symbol,
      postCount: primarySummary.postCount,
      pendingPayoutSumHbd: primarySummary.pendingPayoutSumHbd,
      netRshareSum: primarySummary.netRshareSum,
      yieldHbdPerMillionRshares: yieldHbdPerMillionRshares(primarySummary.pendingPayoutSumHbd, primarySummary.netRshareSum),
      oldestPostAgeSeconds: ages.length ? Math.max(...ages) : null,
      newestPostAgeSeconds: ages.length ? Math.min(...ages) : null,
      hiveEngine,
    });
  }

  // Price is decision input, not a convenience read: use the same independent witnesses as the
  // yield observation before a vote can be planned from it.  The legacy `curationPrice` fixture is
  // deliberately accepted for replay compatibility and supplies the identical captured fact to both
  // witnesses; live operation always reads each node.
  let curationPrice = null;
  let curationPriceWitnesses = [];
  if (candidatePosts.length > 0) {
    const curationPriceFor = (node) => fixtures?.curationPrices?.[node] ?? fixtures?.curationPrice;
    const [primaryCurationPrice, secondaryCurationPrice] = await Promise.all([
      resolveOrCall(curationPriceFor(primary), () => nodeClient(primary, fetchImpl).getCurationPrice()),
      resolveOrCall(curationPriceFor(secondary), () => nodeClient(secondary, fetchImpl).getCurationPrice()),
    ]);
    const priceGapBps = fractionBpsGap(primaryCurationPrice.hbdPerRshare, secondaryCurationPrice.hbdPerRshare);
    if (priceGapBps > toleranceBasisPoints
      || primaryCurationPrice.percentCurationRewards !== secondaryCurationPrice.percentCurationRewards
      || primaryCurationPrice.votePowerReserveRate !== secondaryCurationPrice.votePowerReserveRate) {
      throw new Error(`CURATION_YIELD_NODE_DISAGREEMENT: curation price differs between ${primary} and ${secondary} (price ${priceGapBps.toFixed(4)}bps)`);
    }
    curationPrice = curationPriceRecord(primaryCurationPrice);
    curationPriceWitnesses = [
      { node: primary, hbdPerRshare: curationPriceRecord(primaryCurationPrice).hbdPerRshare },
      { node: secondary, hbdPerRshare: curationPriceRecord(secondaryCurationPrice).hbdPerRshare },
    ];
  }

  const accountResults = {};
  for (const account of accounts) {
    const [primaryAccount, secondaryAccount] = await Promise.all([
      resolveOrCall(fixtures?.accounts?.[`${primary}|${account}`], async () => nodeClient(primary, fetchImpl).getAccount(account)),
      resolveOrCall(fixtures?.accounts?.[`${secondary}|${account}`], async () => nodeClient(secondary, fetchImpl).getAccount(account)),
    ]);
    const primaryEffective = effectiveVestingShares(primaryAccount).toString();
    const secondaryEffective = effectiveVestingShares(secondaryAccount).toString();
    const vestingGapBps = relativeBpsGap(primaryEffective, secondaryEffective);
    const manaGapBps = relativeBpsGap(String(primaryAccount.voting_manabar.current_mana), String(secondaryAccount.voting_manabar.current_mana));
    if (vestingGapBps > toleranceBasisPoints || manaGapBps > toleranceBasisPoints) {
      throw new Error(
        `CURATION_YIELD_NODE_DISAGREEMENT: account ${account} vesting/mana gap (vesting ${vestingGapBps.toFixed(4)}bps, mana ${manaGapBps.toFixed(4)}bps) exceeds toleranceBasisPoints ${toleranceBasisPoints}`,
      );
    }
    accountResults[account] = { votingManabar: projectedMana(primaryAccount, nowMs) };
  }

  return {
    type: "TribeCurationYieldObservationRecord",
    version: 2,
    observedAt: new Date(nowMs).toISOString(),
    witnesses: [
      { node: primary, headBlockNumber: primaryDgp.head_block_number },
      { node: secondary, headBlockNumber: secondaryDgp.head_block_number },
    ],
    tags: tagResults,
    accounts: accountResults,
    candidatePosts,
    excludedCandidates,
    // The operational record must remain JSON-carrier-safe.  The planner restores the two
    // rational components to BigInt only while it computes a vote.
    curationPrice,
    curationPriceWitnesses,
  };
}

if (import.meta.main) {
  const result = await runJavascriptNodeOperation({ name: "observe-tribe-curation-yield", description: "Observes the current curation-yield signal per Hive-Engine tribe tag (and the base layer), and the requested accounts' voting mana, read-only.", operation: observeTribeCurationYield }, { arguments: process.argv.slice(2), standardInput: process.stdin, standardOutput: process.stdout });
  process.exitCode = result.exitCode;
}
