import axios from 'axios'
import config from "../../config";
import {abbreviateNumber, getPercentDiff} from "./utils";

export enum MetricsDailyType {
  walletsCount = 'wallets_count',
  transactionsCount = 'transactions_count',
  averageFee = 'average_fee',
  blockSize = 'block_size',
  totalFee = 'total_fee',
}

export interface MetricsDaily {
  date: string
  value: string
}

const { explorerRestApiUrl: apiUrl, explorerRestApiKey: apiKey } = config.schedule

const getDailyMetrics = async (type: string, limit: number) => {
  const feesUrl = `${apiUrl}/v0/metrics?type=${type}&limit=${limit}`
  const { data } = await axios.get<MetricsDaily[]>(feesUrl, {
    headers: {
      'X-API-KEY': apiKey
    }
  })
  return data
}

export const getFeeStats = async () => {
  const metrics = await getDailyMetrics('total_fee', 14)

  let feesWeek1 = 0, feesWeek2 = 0

  metrics.forEach((item, index) => {
    const value = +item.value
    if(index < 7) {
      feesWeek1 += value
    } else if(index < 14) {
      feesWeek2 += value
    }
  })

  // const walletsValue = wallets.reduce((acc, item) => {
  //   acc += Number(item.value)
  //   return acc
  // }, 0)

  const value = feesWeek1
  const average = (feesWeek1 + feesWeek2) / 2
  let change = getPercentDiff(average, value).toFixed(1)
  if(+change > 0) {
    change = `+${change}`
  }

  return {
    value: abbreviateNumber(value),
    change
  }
}
