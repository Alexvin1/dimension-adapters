import ADDRESSES from '../../helpers/coreAssets.json'
import * as sdk from '@defillama/sdk';
import { FetchOptions, FetchResult, SimpleAdapter } from "../../adapters/types";
import { CHAIN } from "../../helpers/chains";
import { getDexTokensBlacklisted } from '../../helpers/lists';
import { addOneToken } from '../../helpers/prices';
import { getEstablishedTokens, getWashPools } from '../../helpers/uniswap';
import { formatAddress } from '../../utils/utils';
import { ethers } from "ethers";
import PromisePool from "@supercharge/promise-pool";
import { handleBribeToken } from "./utils";

const CONFIG = {
  PoolFactory: '0x420DD381b31aEf6683db6B902084cB0FFECe40Da',
  voter: '0x16613524e02ad97eDfeF371bC883F2F5d6C480A5',
  GaugeFactory: '0x35f35ca5b132cadf2916bab57639128eac5bbcb5'
}

// V3 deployment, live on Base 2026-10-21. Addresses from the Aerodrome team:
// https://gist.githubusercontent.com/simplyoptimistic/f0d67b6fcaef3470f8589cb0d3cf4806/raw/fb2b8095869d5c8d2fe014f5825bff7047d062f8/setup-addresses.json
const V3_CONFIG = {
  poolFactories: [
    '0x8E6a9FCd1d638CC760Ffba397605Fe3355dE76D2', // VolatilePoolFactory
    '0x78589E876edcEbdce72ee3436ab3c9AD3a7cEF2D', // StablePoolFactory
  ],
  fromBlock: 52884700, // first V3 PoolCreated
  factoryRegistry: '0x7b2A2c12dC5Ea2a31455952a05031C3E4BB28F3E',
  gaugeFactories: [
    '0x9FBCf2Df0DC553ce40Ef63963Bff465b76792B7E', // volatile gauge factory
    '0x1e0f776E88649285f99e65Fa599aD6e0f9D97800', // stable gauge factory
  ],
}

const event_topics = {
  swap: '0xb3e2773606abfd36b5bd91394b3a54d1398336c65005baf7bf7a05efeffaf75b'
}

const eventAbis = {
  event_pool_created: 'event PoolCreated(address indexed token0,address indexed token1,bool indexed stable,address pool,uint256)',
  event_v3_pool_created: 'event PoolCreated(address indexed token0, address indexed token1, address pool, uint256)',
  event_fees: 'event Fees(address indexed sender, uint256 amount0, uint256 amount1)',
  event_claim: 'event Claim(address indexed caller, address indexed account, address indexed recipient, uint256 amount0, uint256 amount1)',
  event_swap: 'event Swap(address indexed sender, address indexed to, uint256 amount0In, uint256 amount1In, uint256 amount0Out, uint256 amount1Out)',
  event_gaugeCreated: 'event GaugeCreated(address indexed poolFactory, address indexed votingRewardsFactory, address indexed gaugeFactory, address pool, address bribeVotingReward, address feeVotingReward, address gauge, address creator)',
  event_notify_reward: 'event NotifyReward(address indexed from, address indexed reward, uint256 indexed epoch, uint256 amount)',
  event_claim_rewards: 'event ClaimRewards(address indexed from, address indexed reward, uint256 amount)'
}

const abis = {
  fees: 'function getFee(address pool, bool _stable) external view returns (uint256)'
}

// One pass over GaugeCreated supplies both: pool->gauge (for staked-LP share) and
// the bribe-contract set (for NotifyReward filtering).  Filtered to the canonical
// non-CL gauge factory.
const getGaugeMetadata = async (
  fetchOptions: FetchOptions,
): Promise<{ poolToGauge: Map<string, string>; bribeSet: Set<string> }> => {
  const logs = await fetchOptions.getLogs({
    target: CONFIG.voter,
    fromBlock: 3200601,
    eventAbi: eventAbis.event_gaugeCreated,
    skipIndexer: true,
    cacheInCloud: true,
  })
  const poolToGauge = new Map<string, string>()
  const bribeSet = new Set<string>()
  const factory = CONFIG.GaugeFactory.toLowerCase()
  for (const log of logs as any[]) {
    if (String(log[2]).toLowerCase() !== factory) continue
    poolToGauge.set(String(log[3]).toLowerCase(), String(log[6]).toLowerCase())
    bribeSet.add(String(log[4]).toLowerCase())
  }
  return { poolToGauge, bribeSet }
}

const getBribes = async (
  fetchOptions: FetchOptions,
  bribeSet: Set<string>,
): Promise<{ dailyBribesRevenue: sdk.Balances }> => {
  const { createBalances, startTimestamp } = fetchOptions
  const iface = new ethers.Interface([eventAbis.event_notify_reward])
  const dailyBribesRevenue = createBalances()
  if (bribeSet.size === 0) return { dailyBribesRevenue }

  // need to manually parse logs, auto parsing fails for some reason
  const logs = await fetchOptions.getLogs({ noTarget: true, eventAbi: eventAbis.event_notify_reward, entireLog: true })
  logs.forEach((log: any) => {
    const contract = (log.address || log.source).toLowerCase()
    if (!bribeSet.has(contract)) return
    const parsedLog = iface.parseLog(log)
    const token = parsedLog!.args.reward.toLowerCase()
    const amount = parsedLog!.args.amount
    handleBribeToken(token, amount, startTimestamp, dailyBribesRevenue)
  })
  return { dailyBribesRevenue }
}

// ignore pools holding blacklisted (scam/wash-traded) tokens, and the day's
// wash-flagged pools (see getWashPools) unless every side is established (core
// asset or CoinGecko-listed) - everything downstream derives from the kept pools
const filterPools = async (fetchOptions: FetchOptions, pools: any[]) => {
  const blacklistTokens = new Set(await getDexTokensBlacklisted(fetchOptions))
  pools = pools.filter(({ token0, token1 }: any) => !blacklistTokens.has(formatAddress(token0)) && !blacklistTokens.has(formatAddress(token1)))

  const washPools: Set<string> = fetchOptions.preFetchedResults?.washPools ?? new Set()
  const flagged = pools.filter((p: any) => washPools.has(formatAddress(p.pool)))
  if (!flagged.length) return pools
  const established = await getEstablishedTokens(fetchOptions.chain, flagged.flatMap((p: any) => [p.token0, p.token1]))
  const drop = new Set(flagged
    .filter((p: any) => !(established.has(formatAddress(p.token0)) && established.has(formatAddress(p.token1))))
    .map((p: any) => formatAddress(p.pool)))
  return pools.filter((p: any) => !drop.has(formatAddress(p.pool)))
}

// Strategy A: per-pool staked share = pool.balanceOf(gauge) / pool.totalSupply.
// Non-CL Aerodrome v2 has no unstaked-LP rake module, so all unstaked fees stay
// with LPs.  For each swap fee we split: holders = fee × stakedShare,
// supplySide = fee × (1 - stakedShare).  Pools without a gauge contribute 0 to
// holders.  Snapshot ratio is read at the cron block.
const getVolumeFeesAndRevenue = async (
  fromBlock: number,
  toBlock: number,
  fetchOptions: FetchOptions,
  poolToGauge: Map<string, string>,
) => {
  const { createBalances, api, chain } = fetchOptions
  const dailyVolume = createBalances()
  const dailyFees = createBalances()
  const dailyHoldersRevenue = createBalances()
  const dailySupplySideRevenue = createBalances()

  const rawPools = await filterPools(fetchOptions, await fetchOptions.getLogs({ target: CONFIG.PoolFactory, fromBlock: 3200668, eventAbi: eventAbis.event_pool_created, onlyArgs: true, cacheInCloud: true, skipIndexer: true }))

  const fees = await api.multiCall({
    abi: abis.fees, target: CONFIG.PoolFactory, calls: rawPools.map(i => ({ params: [i.pool, i.stable] }))
  })
  const ZERO_ADDR = ADDRESSES.null
  const gaugeForPool = rawPools.map((p: any) => poolToGauge.get(String(p.pool).toLowerCase()) ?? ZERO_ADDR)
  const [stakedBalances, totalSupplies] = await Promise.all([
    api.multiCall({
      abi: 'function balanceOf(address) view returns (uint256)',
      calls: rawPools.map((p: any, i: number) => ({ target: p.pool, params: [gaugeForPool[i]] })),
      permitFailure: true,
    }),
    api.multiCall({
      abi: 'erc20:totalSupply',
      calls: rawPools.map((p: any) => p.pool),
      permitFailure: true,
    }),
  ])

  const poolInfoMap = {} as any
  const aeroPoolSet = new Set<string>()
  rawPools.forEach(({ token0, token1, stable, pool }: any, index: number) => {
    pool = String(pool).toLowerCase()
    const fee = Number(fees[index]) / 1e4
    const hasGauge = poolToGauge.has(pool)
    const totalSupply = Number(totalSupplies[index] ?? 0)
    const stakedSupply = Number(stakedBalances[index] ?? 0)
    let stakedShare = 0
    if (hasGauge && totalSupply > 0) {
      stakedShare = Math.min(1, stakedSupply / totalSupply)
    }
    poolInfoMap[pool] = { token0, token1, stable, fee, stakedShare }
    aeroPoolSet.add(pool)
  })


  const blockStep = 2000;
  let i = 0;
  let startBlock = fromBlock;
  let ranges: any = []



  while (startBlock < toBlock) {
    const endBlock = Math.min(startBlock + blockStep - 1, toBlock)
    ranges.push([startBlock, endBlock])
    startBlock += blockStep
  }

  let errorFound: any = false

  await PromisePool
    .withConcurrency(5)
    .for(ranges)
    .process(async ([startBlock, endBlock]: any) => {
      if (errorFound) return;
      try {
        const logs = await fetchOptions.getLogs({
          noTarget: true,
          fromBlock: startBlock,
          toBlock: endBlock,
          eventAbi: eventAbis.event_swap,
          topics: [event_topics.swap],
          entireLog: true,
          skipCache: true,
        })
        sdk.log(`Aerodrome got logs (${logs.length}) for ${i++}/ ${Math.ceil((toBlock - fromBlock) / blockStep)}`)
        const iface = new ethers.Interface([eventAbis.event_swap]);

        logs.forEach((log: any) => {
          const pool = (log.address || log.source).toLowerCase()
          if (!aeroPoolSet.has(pool)) return;
          const parsedLog = iface.parseLog(log)
          const { token0, token1, fee, stakedShare } = poolInfoMap[pool]
          const amount0 = Number(parsedLog!.args.amount0In) + Number(parsedLog!.args.amount0Out)
          const amount1 = Number(parsedLog!.args.amount1In) + Number(parsedLog!.args.amount1Out)
          const fee0 = amount0 * fee
          const fee1 = amount1 * fee
          addOneToken({ chain, balances: dailyVolume, token0, token1, amount0, amount1 })
          addOneToken({ chain, balances: dailyFees, token0, token1, amount0: fee0, amount1: fee1 })
          if (stakedShare > 0) {
            addOneToken({ chain, balances: dailyHoldersRevenue, token0, token1, amount0: fee0 * stakedShare, amount1: fee1 * stakedShare })
          }
          if (stakedShare < 1) {
            const supplyShare = 1 - stakedShare
            addOneToken({ chain, balances: dailySupplySideRevenue, token0, token1, amount0: fee0 * supplyShare, amount1: fee1 * supplyShare })
          }
        })
      } catch (e) {
        errorFound = e
        throw e
      }
    })

  if (errorFound) throw errorFound

  return { dailyVolume, dailyFees, dailyHoldersRevenue, dailySupplySideRevenue }
}

// pool -> gauge for the V3 gauge factories, from the FactoryRegistry at the api's block
const getV3Gauges = async (api: any): Promise<Map<string, string>> => {
  const gauges: string[] = (await api.multiCall({ target: V3_CONFIG.factoryRegistry, abi: 'function factoryToGauges(address) view returns (address[])', calls: V3_CONFIG.gaugeFactories })).flat()
  const pools: string[] = await api.multiCall({ target: V3_CONFIG.factoryRegistry, abi: 'function gaugeToTarget(address) view returns (address)', calls: gauges })
  return new Map(pools.map((pool, i) => [pool.toLowerCase(), gauges[i].toLowerCase()]))
}

// V3 pools (verified source V3/src/pools/Pool.sol): every swap emits Fees with the
// exact fee charged, MEV tax included. The staked LPs' share accrues to the gauge
// inside the pool, so holders revenue = growth of pool.pendingFees(gauge) over the
// window + what the gauge claimed (Claim with account = gauge); the rest stays with
// unstaked LPs.
// ponytail: V3 voting incentives (VotingRewardsManager) are not tracked yet, no gauge existed at launch
const getV3VolumeFeesAndRevenue = async (fromBlock: number, toBlock: number, fetchOptions: FetchOptions) => {
  const { createBalances, api, fromApi, chain, getLogs } = fetchOptions
  const dailyVolume = createBalances()
  const dailyFees = createBalances()
  const dailyHoldersRevenue = createBalances()
  const dailySupplySideRevenue = createBalances()
  if (toBlock < V3_CONFIG.fromBlock) return { dailyVolume, dailyFees, dailyHoldersRevenue, dailySupplySideRevenue }

  const pools = await filterPools(fetchOptions, await getLogs({ targets: V3_CONFIG.poolFactories, fromBlock: V3_CONFIG.fromBlock, eventAbi: eventAbis.event_v3_pool_created, cacheInCloud: true }))
  const poolInfo: Record<string, any> = Object.fromEntries(pools.map((p: any) => [p.pool.toLowerCase(), p]))
  const targets = Object.keys(poolInfo)
  const [swapLogs, feeLogs, claimLogs] = await Promise.all([
    getLogs({ targets, eventAbi: eventAbis.event_swap, onlyArgs: false }),
    getLogs({ targets, eventAbi: eventAbis.event_fees, onlyArgs: false }),
    getLogs({ targets, eventAbi: eventAbis.event_claim, onlyArgs: false }),
  ])

  for (const log of swapLogs) {
    const { token0, token1 } = poolInfo[log.address.toLowerCase()]
    const amount0 = Number(log.args.amount0In) + Number(log.args.amount0Out)
    const amount1 = Number(log.args.amount1In) + Number(log.args.amount1Out)
    addOneToken({ chain, balances: dailyVolume, token0, token1, amount0, amount1 })
  }
  const poolFees: Record<string, number[]> = {}
  for (const log of feeLogs) {
    const fees = poolFees[log.address.toLowerCase()] ??= [0, 0]
    fees[0] += Number(log.args.amount0)
    fees[1] += Number(log.args.amount1)
  }

  // a gauge that did not exist at the window start had accrued nothing before it
  const gaugesEnd = await getV3Gauges(api)
  const gaugesStart = fromBlock < V3_CONFIG.fromBlock ? new Map<string, string>() : await getV3Gauges(fromApi)
  const staked = [...gaugesEnd].filter(([pool]) => poolFees[pool])
  const stakedAtStart = staked.filter(([pool, gauge]) => gaugesStart.get(pool) === gauge)
  const pendingAbi = 'function pendingFees(address) view returns (uint256 amount0, uint256 amount1)'
  const [pendingEnd, pendingStart] = await Promise.all([
    api.multiCall({ abi: pendingAbi, calls: staked.map(([pool, gauge]) => ({ target: pool, params: [gauge] })) }),
    fromApi.multiCall({ abi: pendingAbi, calls: stakedAtStart.map(([pool, gauge]) => ({ target: pool, params: [gauge] })) }),
  ])
  const startByPool = Object.fromEntries(stakedAtStart.map(([pool], i) => [pool, pendingStart[i]]))
  const holders: Record<string, number[]> = {}
  staked.forEach(([pool], i) => {
    const start = startByPool[pool] ?? { amount0: 0, amount1: 0 }
    holders[pool] = [
      Number(pendingEnd[i].amount0) - Number(start.amount0),
      Number(pendingEnd[i].amount1) - Number(start.amount1),
    ]
  })
  for (const log of claimLogs) {
    const pool = log.address.toLowerCase()
    if (!holders[pool] || log.args.account.toLowerCase() !== gaugesEnd.get(pool)) continue
    holders[pool][0] += Number(log.args.amount0)
    holders[pool][1] += Number(log.args.amount1)
  }

  for (const [pool, fees] of Object.entries(poolFees)) {
    const { token0, token1 } = poolInfo[pool]
    ;[token0, token1].forEach((token, k) => {
      if (!fees[k]) return
      // clamp: state reads and logs can disagree by the boundary block
      const toHolders = Math.min(Math.max(holders[pool]?.[k] ?? 0, 0), fees[k])
      dailyFees.add(token, fees[k])
      if (toHolders > 0) dailyHoldersRevenue.add(token, toHolders)
      if (toHolders < fees[k]) dailySupplySideRevenue.add(token, fees[k] - toHolders)
    })
  }
  return { dailyVolume, dailyFees, dailyHoldersRevenue, dailySupplySideRevenue }
}

const fetch = async (options: FetchOptions): Promise<FetchResult> => {
  const { getToBlock, getFromBlock } = options
  const [toBlock, fromBlock] = await Promise.all([getToBlock(), getFromBlock()])
  const { poolToGauge, bribeSet } = await getGaugeMetadata(options)
  const [{ dailyVolume, dailyFees, dailyHoldersRevenue, dailySupplySideRevenue }, v3, { dailyBribesRevenue }] = await Promise.all([
    getVolumeFeesAndRevenue(fromBlock, toBlock, options, poolToGauge),
    getV3VolumeFeesAndRevenue(fromBlock, toBlock, options),
    getBribes(options, bribeSet),
  ])
  dailyVolume.add(v3.dailyVolume)
  dailyFees.add(v3.dailyFees)
  dailyHoldersRevenue.add(v3.dailyHoldersRevenue)
  dailySupplySideRevenue.add(v3.dailySupplySideRevenue)

  const totalFees = options.createBalances()
  const totalHoldersRevenue = options.createBalances()
  const totalSupplySideRevenue = options.createBalances()
  
  totalFees.add(dailyFees, 'Token Swap Fees');
  totalFees.add(dailyBribesRevenue, 'External Bribes Rewards');
  totalHoldersRevenue.add(dailyHoldersRevenue, 'Staked-LP Fees And Unstaked-LP Rake');
  totalHoldersRevenue.add(dailyBribesRevenue, 'External Bribes Revenue');
  totalSupplySideRevenue.add(dailySupplySideRevenue, 'Unstaked-LP Fees');
  
  return {
    dailyFees: totalFees,
    dailyRevenue: totalHoldersRevenue,
    dailyHoldersRevenue: totalHoldersRevenue,
    dailySupplySideRevenue: totalSupplySideRevenue,
    dailyVolume,
  }
}

const prefetch: any = async (options: FetchOptions) => {
  return { washPools: await getWashPools(options, { blockchain: 'base', project: 'aerodrome', version: '1' }) }
}

const methodology = {
  Volume: 'Swap volume on Aerodrome volatile and stable pools, excluding wash trading.',
  Fees: 'Swap fees paid by traders, plus bribes deposited for veAERO voters.',
  Revenue: 'Swap fees earned by liquidity staked in gauges, plus bribes, all distributed to veAERO voters.',
  HoldersRevenue: 'Swap fees earned by liquidity staked in gauges, plus bribes, all distributed to veAERO voters.',
  SupplySideRevenue: 'Swap fees earned by liquidity providers that do not stake in a gauge.',
}

const breakdownMethodology = {
  Fees: {
    'Token Swap Fees': 'Swap fees paid by traders.',
    'External Bribes Rewards': 'Bribes deposited for veAERO voters.',
  },
  Revenue: {
    'Staked-LP Fees And Unstaked-LP Rake': 'Swap fees earned by liquidity staked in gauges, distributed to veAERO voters.',
    'External Bribes Revenue': 'Bribes distributed to veAERO voters.',
  },
  HoldersRevenue: {
    'Staked-LP Fees And Unstaked-LP Rake': 'Swap fees earned by liquidity staked in gauges, distributed to veAERO voters.',
    'External Bribes Revenue': 'Bribes distributed to veAERO voters.',
  },
  SupplySideRevenue: {
    'Unstaked-LP Fees': 'Swap fees earned by liquidity providers that do not stake in a gauge.',
  },
}

const adapters: SimpleAdapter = {
  version: 2,
  pullHourly: true,
  fetch,
  prefetch,
  chains: [CHAIN.BASE],
  start: '2023-08-28',
  methodology,
  breakdownMethodology,
}

export default adapters
