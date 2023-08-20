import { ethers } from 'ethers'
import { DefenderRelaySigner, DefenderRelayProvider } from 'defender-relay-client/lib/ethers'
import { AutotaskEvent } from 'defender-autotask-utils'
import { RelayerParams } from 'defender-relay-client/lib/relayer'
import { request, gql } from 'graphql-request'
import axios from 'axios'

// Entrypoint for the Autotask
const RESERVE = '0xa150a825d425B36329D8294eeF8bD0fE68f8F6E0'
const RESERVE_ABI = ['function currentPriceDAI() view returns (uint256)']
const ORACLE = '0xFdd8bD58115FfBf04e47411c1d228eCC45E93075'
const ORACLE_ABI = [
  'function report(address token,uint256 value,address lesserKey,address greaterKey)',
  'function getRates(address token) view returns(address[],uint256[],uint8[])'
]
const ORACLE_TOKEN = "0x03d3daB843e6c03b3d271eff9178e6A96c28D25f";

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
    "Reserve Price Last 40 Blocks/10 minutes",
    average.toString(),
    pricesInDai.map((_) => _.toString())
  )
  //mento oracle expects 24 percision. inverse the price to g$ per $ in 24 precision (1e42/G$ is now in 18 decimals)
  return ethers.constants.WeiPerEther.pow(2).mul(1e6).div(average)
};

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
  const average = 1 / (sum / validHistories.length) //inverse price to G$ per 1$
  const daiPrice = ethers.utils.parseEther(average.toString()).mul(1e6) //return price in 24 decimals precission for oracle

  console.log("graph average:",{sum,average,daiPrice:daiPrice.toString()})
  return daiPrice
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

  const insertIndex = values.findIndex((val) => val.lt(average))
  const lesserKey = insertIndex >= 0 && keys[insertIndex].toLowerCase() != signer.toLowerCase() ? keys[insertIndex] : ethers.constants.AddressZero
  const greaterIndex = values.findIndex((val) => val.gt(average))
  const greaterKey = greaterIndex >=0 && keys[greaterIndex].toLowerCase() != signer.toLowerCase() ? keys[greaterIndex] : ethers.constants.AddressZero

  console.log({ insertIndex, keys, values, medianRelations, lesserKey, greaterKey })
  await oracleRO.callStatic.report(ORACLE_TOKEN, average, lesserKey, greaterKey, { from: signer })
  await oracle.report(ORACLE_TOKEN, average, lesserKey, greaterKey)
  return average
}

const getCeloPrice = async (cmcKey) => {
  let price = ethers.constants.WeiPerEther.div(2).mul(1e6) //default to 0.5$ in 24 decimals
  if(cmcKey)
  {
    const { data } = await axios.get("https://pro-api.coinmarketcap.com/v2/cryptocurrency/quotes/latest?symbol=CELO",{headers:{"X-CMC_PRO_API_KEY": cmcKey}})
    const quote = data?.data?.CELO?.[0]?.quote.USD?.price || 0
    price = ethers.utils.parseEther(quote.toString()).mul(1e6) //in 24 decimals
    console.log("got Celo price from cmc:",{quote, price})
  }
  return price;
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
    const averages = (results.filter(_ => _.status === 'fulfilled') as Array<PromiseFulfilledResult<ethers.BigNumber>>).map(_ => _.value) 
    const failed = results.filter(_ => _.status === 'rejected') as Array<PromiseRejectedResult>
    console.log(averages)
    const finalAverageInDai = averages
      .reduce((acc, cur) => acc.add(cur), ethers.BigNumber.from(0))
      .div(averages.length)
      
    const celoPrice = await getCeloPrice(event.secrets?.CMC_KEY)
    const finalAverageInCelo = finalAverageInDai.mul(celoPrice).div("1000000000000000000000000") //in celo in 24 decimals
    console.log({ finalAverageInDai, finalAverageInCelo })
    
    await reportOracle(finalAverageInCelo, oracle)
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
  const { API_KEY: apiKey, API_SECRET: apiSecret, CMC_KEY } = process.env
  console.log({ apiKey, apiSecret })
  exports
    .handler({ apiKey, apiSecret,secrets: {CMC_KEY} })
    .then(() => process.exit(0))
    .catch((error: Error) => {
      console.error(error)
      process.exit(1)
    })
}
