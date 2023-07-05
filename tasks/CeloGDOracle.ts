import { ethers } from 'ethers'
import { DefenderRelaySigner, DefenderRelayProvider } from 'defender-relay-client/lib/ethers'
import { AutotaskEvent } from 'defender-autotask-utils'
import { RelayerParams } from 'defender-relay-client/lib/relayer'
import { request, gql } from 'graphql-request'
import axios from 'axios'

// Entrypoint for the Autotask
const RESERVE = '0xa150a825d425B36329D8294eeF8bD0fE68f8F6E0'
const RESERVE_ABI = ['function currentPriceDAI() view returns (uint256)']
const ORACLE = '0xefb84935239dacdecf7c5ba76d8de40b077b7b33'
const ORACLE_ABI = [
  'function report(address token,uint256 value,address lesserKey,address greaterKey) returns (void)',
  'function getRates(address token) view returns(address[],uint256[],uint8[])'
]
const ORACLE_TOKEN = '0xe8537a3d056DA446677B9E9d6c5dB704EaAb4787'

const ethProvider = new ethers.providers.JsonRpcProvider('https://cloudflare-eth.com')
const celoProvider = new ethers.providers.JsonRpcProvider('https://forno.celo.org')
const getReservePrice = async () => {
  const reserve = new ethers.Contract(RESERVE, RESERVE_ABI, ethProvider)
  const curBlock = await ethProvider.getBlockNumber()
  const prices: Array<typeof reserve.currentPriceDAI> = []
  for (let i = curBlock; i > curBlock - 40; i--) {
    prices.push(reserve.currentPriceDAI({ blockTag: i }).catch(() => 0))
  }
  const pricesInDai: Array<ethers.BigNumber> = await Promise.all(prices)
  const sum = pricesInDai.filter(_ => _).reduce((acc, cur) => acc.add(cur), ethers.BigNumber.from(0))
  const average = sum.div(pricesInDai.length)
  console.log(
    'Reserve Price Last 40 Blocks/10 minutes',
    average.toNumber() / 1e18,
    pricesInDai.map(_ => _.toNumber())
  )
  return average
}

const getGraphPrice = async () => {
  // graphql query
  const tenMinAgo = Date.now() / 1000 - 600
  const query = gql`
    {
      reserveHistories(first: 10, orderBy: blockTimestamp, orderDirection: desc) {
        blockTimestamp
        closePriceDAI
        openPriceDAI
      }
    }
  `
  const { reserveHistories } = await request('https://api.thegraph.com/subgraphs/name/gooddollar/goodsubgraphs', query)
  const validHistories = reserveHistories.filter(_ => _ && Number(_.blockTimestamp) >= tenMinAgo)
  console.log({ reserveHistories, validHistories })
  if (validHistories.length === 0) validHistories.push(reserveHistories[0])
  const sum = validHistories.reduce((acc: number, cur: { closePriceDAI: number }) => acc + Number(cur.closePriceDAI), 0)
  const average = sum / reserveHistories.length
  return ethers.BigNumber.from(average * 1e18)
}

const reportOracle = async (average: ethers.BigNumber, oracle: ethers.Contract) => {
  const oracleRO = new ethers.Contract(ORACLE, ORACLE_ABI, celoProvider)
  const signer = await oracle.signer.getAddress()
  const rates = await oracle.getRates(ORACLE_TOKEN)
  const [keys, values, medianRelations] = rates
  const lastReportIndex = keys.findIndex(val => val.toLowerCase() === signer.toLocaleLowerCase())

  //verify no significant price movement
  if(lastReportIndex)
  {
    const lastReport = values[lastReportIndex];
    if(lastReport.mul(100).div(average).sub(100).abs().gte(15))
    {
      throw new Error(`price change > 15% last:${lastReport.toString()} new:${average.toString()}`)
    }
  }
  const insertIndex = values.findIndex(val => val.lt(average))
  const lesserKey = insertIndex >= 0 ? keys[insertIndex] : ethers.constants.AddressZero
  const greaterKey =
    insertIndex === -1 ? keys[keys.length - 1] : insertIndex > 0 ? keys[insertIndex - 1] : ethers.constants.AddressZero

  console.log({ insertIndex, keys, values, medianRelations, lesserKey, greaterKey })
  await oracleRO.callStatic.report(ORACLE_TOKEN, average, lesserKey, greaterKey, { from: signer })
  await oracle.report(ORACLE_TOKEN, average, lesserKey, greaterKey)
  return average
}

const handleError = async (msg, slackUrl) => {
  if (!slackUrl) return
  const responses = await Promise.all(
    slackUrl.split(',').map(webhook => axios.post(webhook, JSON.stringify({ text: msg })))
  )
  console.log(
    'SUCCEEDED: Sent slack webhook: \n',
    responses.map(_ => _.data)
  )
}

exports.handler = async function (event: AutotaskEvent) {
  try {
    // Initialize defender relayer provider and signer
    const provider = new DefenderRelayProvider(event as RelayerParams)
    const signer = new DefenderRelaySigner(event as RelayerParams, provider, { speed: 'fast' })
    console.log({ signer })
    const oracle = new ethers.Contract(ORACLE, ORACLE_ABI, signer)
    // Create contract instance from the signer and use it to send a tx
    const results = await Promise.allSettled([getReservePrice(), getGraphPrice()])
    const averages = results.filter(_ => _.status === 'fulfilled') as Array<PromiseFulfilledResult<ethers.BigNumber>>
    const failed = results.filter(_ => _.status === 'rejected') as Array<PromiseRejectedResult>
    console.log(averages)
    const finalAverage = averages
      .reduce((acc, cur) => acc.add(cur.value), ethers.BigNumber.from(0))
      .div(averages.length)
    console.log({ finalAverage })
    await reportOracle(finalAverage, oracle)
    if (failed.length) {
      const error = `price fetch failed ${failed.map(_ => _.reason).join(', ')}`
      throw new Error(error)
    }
  } catch (e) {
    if (e instanceof Error) {
      const slack = event.secrets?.SLACK_WEBHOOK_URL
      await handleError(e.message, slack)
      throw e
    }
  }
}

// To run locally (this code will not be executed in Autotasks)
if (require.main === module) {
  const { API_KEY: apiKey, API_SECRET: apiSecret } = process.env
  console.log({ apiKey, apiSecret })
  exports
    .handler({ apiKey, apiSecret })
    .then(() => process.exit(0))
    .catch((error: Error) => {
      console.error(error)
      process.exit(1)
    })
}