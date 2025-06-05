"use client"

import { useState, useEffect } from "react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Progress } from "@/components/ui/progress"
import {
  Activity,
  TrendingUp,
  TrendingDown,
  DollarSign,
  BarChart3,
  Play,
  Square,
  RotateCcw,
  AlertTriangle,
  CheckCircle,
  Wifi,
  WifiOff,
  RefreshCw,
} from "lucide-react"

const API_BASE_URL = "http://localhost:3001"

interface BotData {
  status: {
    isRunning: boolean
    currentPrice: number
    marketCondition: string
    volatilityIndex: number
    atr: number
    uptime: number
    demoMode?: boolean
  }
  trading: {
    profitLoss: number
    totalTrades: number
    successfulTrades: number
    dailyTrades: number
    maxDailyTrades: number
    activeOrders: number
    gridLevels: number
  }
  performance: {
    totalProfit: number
    totalLoss: number
    winRate: number
    totalVolume: number
    avgTradeSize: number
    bestTrade: number
    worstTrade: number
    profitFactor: number
  }
  grid: {
    levels: Array<{
      level: number
      buyPrice: number
      sellPrice: number
      quantity: number
      active: boolean
      status?: string
      distanceFromPrice?: number
    }>
    spacing: number
    investment: number
  }
  priceHistory: number[]
}

interface Trade {
  id: string
  type: string
  side?: string
  symbol: string
  price: number
  quantity: number
  profit?: number
  timestamp: number
  marketCondition: string
}

interface ConnectionStatus {
  isConnected: boolean
  lastAttempt: Date
  errorMessage: string | null
  retryCount: number
}

export default function TradingBotDashboard() {
  const [balances, setBalances] = useState<any[]>([])
  const [botData, setBotData] = useState<BotData | null>(null)
  const [trades, setTrades] = useState<Trade[]>([])
  const [loading, setLoading] = useState(true)
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>({
    isConnected: false,
    lastAttempt: new Date(),
    errorMessage: null,
    retryCount: 0,
  })
  const [gridData, setGridData] = useState(null)
  const [performanceData, setPerformanceData] = useState(null)
  const [marketData, setMarketData] = useState(null)

const fetchBalance = async () => {
  try {
    const response = await fetch(`${API_BASE_URL}/api/balance`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) {
      throw new Error("Failed to fetch balance");
    }
    const data = await response.json();
    setBalances(data.balances || []);
  } catch (error) {
    setBalances([]);
    console.error("Failed to fetch balance:", error);
  }
};


  const fetchData = async () => {
    try {
      setConnectionStatus((prev) => ({
        ...prev,
        lastAttempt: new Date(),
        retryCount: prev.retryCount + 1,
      }))

      console.log(`Attempting API connection (attempt #${connectionStatus.retryCount + 1})...`)

      const [statusResponse, tradesResponse] = await Promise.all([
        fetch(`${API_BASE_URL}/api/status`, {
          signal: AbortSignal.timeout(5000),
        }),
        fetch(`${API_BASE_URL}/api/trades?limit=50`, {
          signal: AbortSignal.timeout(5000),
        }),
      ])

      if (!statusResponse.ok) {
        const errorText = await statusResponse.text().catch(() => "Unknown error")
        throw new Error(`Status API returned ${statusResponse.status}: ${errorText}`)
      }

      if (!tradesResponse.ok) {
        const errorText = await tradesResponse.text().catch(() => "Unknown error")
        throw new Error(`Trades API returned ${tradesResponse.status}: ${errorText}`)
      }

      const statusData = await statusResponse.json()
      const tradesData = await tradesResponse.json()

      console.log(`API connection successful using ${API_BASE_URL}!`)
      console.log("Status data:", statusData)

      const transformedData = {
        status: {
          isRunning: statusData.bot?.isRunning || statusData.status?.isRunning || false,
          currentPrice: statusData.trading?.currentPrice || statusData.status?.currentPrice || 0,
          marketCondition: statusData.market?.condition || statusData.status?.marketCondition || "UNKNOWN",
          volatilityIndex: statusData.market?.volatilityIndex || statusData.status?.volatilityIndex || 0,
          atr: statusData.market?.atr || statusData.status?.atr || 0,
          uptime: statusData.bot?.uptime || statusData.status?.uptime || 0,
          demoMode: statusData.bot?.demoMode || statusData.status?.demoMode || false,
        },
        trading: {
          profitLoss: statusData.trading?.profitLoss || 0,
          totalTrades: statusData.trading?.totalTrades || 0,
          successfulTrades: statusData.trading?.successfulTrades || 0,
          dailyTrades: statusData.trading?.dailyTrades || 0,
          maxDailyTrades: statusData.trading?.maxDailyTrades || 50,
          activeOrders: statusData.trading?.activeOrders || 0,
          gridLevels: statusData.trading?.gridLevels || 0,
        },
        performance: statusData.performance || {
          totalProfit: 0,
          totalLoss: 0,
          winRate: 0,
          totalVolume: 0,
          avgTradeSize: 0,
          bestTrade: 0,
          worstTrade: 0,
          profitFactor: 0,
        },
        grid: {
          levels: statusData.grid?.levels || [],
          spacing: statusData.grid?.spacing || 0.008,
          investment: statusData.grid?.investment || 1000,
        },
        priceHistory: statusData.market?.price?.history || statusData.priceHistory || [],
      }

      setBotData(transformedData)
      setTrades(Array.isArray(tradesData) ? tradesData : tradesData.trades || [])

      setConnectionStatus({
        isConnected: true,
        lastAttempt: new Date(),
        errorMessage: null,
        retryCount: 0,
      })

      fetchGridData()
      fetchPerformanceData()
      fetchMarketData()
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : "Unknown error connecting to API"
      console.error("API Connection Error:", errorMessage)

      setConnectionStatus((prev) => ({
        isConnected: false,
        lastAttempt: new Date(),
        errorMessage: errorMessage,
        retryCount: prev.retryCount,
      }))
    } finally {
      setLoading(false)
    }
  }

  const sendControlCommand = async (action: string) => {
    try {
      console.log(`Sending control command: ${action}`)

      const response = await fetch(`${API_BASE_URL}/api/control`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ action }),
        signal: AbortSignal.timeout(5000),
      })

      if (!response.ok) {
        const errorText = await response.text().catch(() => "Unknown error")
        throw new Error(`Control command failed: ${response.status} - ${errorText}`)
      }

      const result = await response.json()
      console.log("Control command result:", result)

      if (result.success) {
        setTimeout(fetchData, 1000)
      } else {
        throw new Error(result.message || "Control command failed")
      }
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : "Control command failed"
      console.error("Control Command Error:", errorMessage)

      setConnectionStatus((prev) => ({
        ...prev,
        errorMessage: errorMessage,
      }))
    }
  }

  const fetchGridData = async () => {
    try {
      const response = await fetch(`${API_BASE_URL}/api/grid`, {
        signal: AbortSignal.timeout(5000),
      }).catch((error) => {
        console.error("Grid API fetch error:", error)
        return null
      })

      if (!response?.ok) {
        const errorText = response ? await response.text().catch(() => "Unknown error") : "Network error"
        throw new Error(`Grid API returned ${response?.status || "no response"}: ${errorText}`)
      }

      const data = await response.json()
      console.log("Grid data:", data)
      setGridData(data)

      setBotData((prev) =>
        prev
          ? {
              ...prev,
              grid: {
                levels: data.levels || [],
                spacing: data.configuration?.currentSpacing || prev.grid.spacing,
                investment: data.configuration?.baseInvestment || prev.grid.investment,
              },
            }
          : null,
      )
    } catch (error) {
      console.error("Failed to fetch grid data:", error)
    }
  }

  const fetchPerformanceData = async () => {
    try {
      const response = await fetch(`${API_BASE_URL}/api/performance`, {
        signal: AbortSignal.timeout(5000),
      }).catch((error) => {
        console.error("Performance API fetch error:", error)
        return null
      })

      if (!response?.ok) {
        const errorText = response ? await response.text().catch(() => "Unknown error") : "Network error"
        throw new Error(`Performance API returned ${response?.status || "no response"}: ${errorText}`)
      }

      const data = await response.json()
      console.log("Performance data:", data)
      setPerformanceData(data)

      setBotData((prev) =>
        prev
          ? {
              ...prev,
              performance: {
                ...prev.performance,
                ...data,
              },
            }
          : null,
      )
    } catch (error) {
      console.error("Failed to fetch performance data:", error)
    }
  }

  const fetchMarketData = async () => {
    try {
      const response = await fetch(`${API_BASE_URL}/api/market`, {
        signal: AbortSignal.timeout(5000),
      }).catch((error) => {
        console.error("Market API fetch error:", error)
        return null
      })

      if (!response?.ok) {
        const errorText = response ? await response.text().catch(() => "Unknown error") : "Network error"
        throw new Error(`Market API returned ${response?.status || "no response"}: ${errorText}`)
      }

      const data = await response.json()
      console.log("Market data:", data)
      setMarketData(data)

      setBotData((prev) =>
        prev
          ? {
              ...prev,
              status: {
                ...prev.status,
                currentPrice: data.price?.current || prev.status.currentPrice,
                marketCondition: data.technical?.marketCondition || prev.status.marketCondition,
                volatilityIndex: data.technical?.volatilityIndex || prev.status.volatilityIndex,
                atr: data.technical?.atr || prev.status.atr,
              },
              priceHistory: data.price?.history || prev.priceHistory,
            }
          : null,
      )
    } catch (error) {
      console.error("Failed to fetch market data:", error)
    }
  }

  useEffect(() => {
    fetchData()
fetchBalance();
    const interval = setInterval(() => {
      if (connectionStatus.isConnected) {
        fetchData()
      } else {
        const backoffTime = Math.min(30000, 1000 * Math.pow(2, Math.min(connectionStatus.retryCount, 5)))
        const timeSinceLastAttempt = new Date().getTime() - connectionStatus.lastAttempt.getTime()

        if (timeSinceLastAttempt >= backoffTime) {
          console.log(`Retrying after backoff of ${backoffTime}ms...`)
          fetchData()
        }
      }
    }, 5000)

    return () => clearInterval(interval)
  }, [connectionStatus.isConnected, connectionStatus.retryCount, connectionStatus.lastAttempt])

  const formatCurrency = (value: number) => {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(value)
  }

  const formatUptime = (ms: number) => {
    const seconds = Math.floor(ms / 1000)
    const minutes = Math.floor(seconds / 60)
    const hours = Math.floor(minutes / 60)
    const days = Math.floor(hours / 24)

    if (days > 0) return `${days}d ${hours % 24}h`
    if (hours > 0) return `${hours}h ${minutes % 60}m`
    return `${minutes}m ${seconds % 60}s`
  }

  const getMarketConditionColor = (condition: string) => {
    switch (condition) {
      case "BULL":
        return "bg-green-500"
      case "BEAR":
        return "bg-red-500"
      case "VOLATILE":
        return "bg-orange-500"
      case "SIDEWAYS":
        return "bg-blue-500"
      default:
        return "bg-gray-500"
    }
  }

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <Card className="w-96">
          <CardContent className="flex flex-col items-center justify-center p-8">
            <div className="text-center">
              <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600 mx-auto mb-4"></div>
              <p className="mb-2">Connecting to trading bot API...</p>
              <p className="text-xs text-gray-500">
                Using API: {API_BASE_URL}
              </p>
            </div>
          </CardContent>
        </Card>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-gray-50 p-6">
      <div className="max-w-7xl mx-auto space-y-6">
        {/* Header */}
        <div className="flex justify-between items-center">
          <div>
            <h1 className="text-3xl font-bold text-gray-900">Bybit Grid Trading Bot</h1>
            <div className="flex items-center gap-2 mt-1">
              <p className="text-gray-600">Real-time monitoring and control dashboard</p>
              {botData?.status?.demoMode && (
                <Badge variant="outline" className="bg-yellow-50 text-yellow-700 border-yellow-200">
                  Bot Running in Demo Mode
                </Badge>
              )}
              {connectionStatus.isConnected ? (
                <Badge variant="outline" className="bg-green-50 text-green-700 border-green-200">
                  <Wifi className="h-3 w-3 mr-1" /> API Connected
                </Badge>
              ) : (
                <Badge variant="outline" className="bg-red-50 text-red-700 border-red-200">
                  <WifiOff className="h-3 w-3 mr-1" /> API Disconnected
                </Badge>
              )}
            </div>
          </div>
          <div className="flex gap-2">
            <Button onClick={fetchData} variant="outline" size="sm">
              <RefreshCw className="h-4 w-4 mr-2" />
              Refresh Data
            </Button>
            <Button
              onClick={() => sendControlCommand("rebalance")}
              variant="outline"
              size="sm"
              disabled={!connectionStatus.isConnected}
            >
              <RotateCcw className="h-4 w-4 mr-2" />
              Rebalance
            </Button>
            {botData?.status?.isRunning ? (
              <Button
                onClick={() => sendControlCommand("stop")}
                variant="destructive"
                size="sm"
                disabled={!connectionStatus.isConnected}
              >
                <Square className="h-4 w-4 mr-2" />
                Stop Bot
              </Button>
            ) : (
              <Button
                onClick={() => sendControlCommand("start")}
                variant="default"
                size="sm"
                disabled={!connectionStatus.isConnected}
              >
                <Play className="h-4 w-4 mr-2" />
                Start Bot
              </Button>
            )}
          </div>
        </div>

        {/* Connection Status */}
        {!connectionStatus.isConnected && (
          <Card className="border-red-200 bg-red-50">
            <CardContent className="p-4">
              <div className="flex flex-col gap-2 text-red-700">
                <div className="flex items-center">
                  <AlertTriangle className="h-4 w-4 mr-2" />
                  <span className="font-medium">API Connection Error</span>
                </div>
                <p className="text-sm">Unable to connect to the trading bot API. Tried both:</p>
                <ul className="text-sm list-disc ml-6">
                  <li>Primary API: {API_BASE_URL}</li>
                  <li>Fallback API: {FALLBACK_API_BASE_URL}</li>
                </ul>
                <p className="text-sm">Error: {connectionStatus.errorMessage || "Unknown error"}</p>
                <p className="text-sm">Last attempt: {connectionStatus.lastAttempt.toLocaleTimeString()}</p>
                <p className="text-sm">Retry count: {connectionStatus.retryCount}</p>
                <div className="flex justify-end mt-2">
                  <Button onClick={fetchData} variant="outline" size="sm" className="bg-white">
                    <RefreshCw className="h-4 w-4 mr-2" />
                    Retry Connection
                  </Button>
                </div>
              </div>
            </CardContent>
          </Card>
        )}

        {/* Status Cards */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Bot Status</CardTitle>
              {botData?.status?.isRunning ? (
                <CheckCircle className="h-4 w-4 text-green-600" />
              ) : (
                <AlertTriangle className="h-4 w-4 text-red-600" />
              )}
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{botData?.status?.isRunning ? "Running" : "Stopped"}</div>
              <p className="text-xs text-muted-foreground">Uptime: {formatUptime(botData?.status?.uptime || 0)}</p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Current Price</CardTitle>
              <DollarSign className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{formatCurrency(botData?.status?.currentPrice || 0)}</div>
              <div className="flex items-center gap-2 mt-1">
                <Badge className={getMarketConditionColor(botData?.status?.marketCondition || "UNKNOWN")}>
                  {botData?.status?.marketCondition || "UNKNOWN"}
                </Badge>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">P&L</CardTitle>
              {(botData?.trading?.profitLoss || 0) >= 0 ? (
                <TrendingUp className="h-4 w-4 text-green-600" />
              ) : (
                <TrendingDown className="h-4 w-4 text-red-600" />
              )}
            </CardHeader>
            <CardContent>
              <div
                className={`text-2xl font-bold ${(botData?.trading?.profitLoss || 0) >= 0 ? "text-green-600" : "text-red-600"}`}
              >
                {formatCurrency(botData?.trading?.profitLoss || 0)}
              </div>
              <p className="text-xs text-muted-foreground">
                Win Rate: {(botData?.performance?.winRate || 0).toFixed(1)}%
              </p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Active Orders</CardTitle>
              <Activity className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{botData?.trading?.activeOrders || 0}</div>
              <p className="text-xs text-muted-foreground">Grid Levels: {botData?.trading?.gridLevels || 0}</p>
            </CardContent>
          </Card>
        </div>

<Card>
  <CardHeader>
    <CardTitle>Spot Account Balance</CardTitle>
    <CardDescription>Available assets on Bybit Spot</CardDescription>
  </CardHeader>
  <CardContent>
    {balances.length === 0 ? (
      <div className="text-gray-500">No balances found.</div>
    ) : (
      <div className="space-y-1">
        {balances.map((asset: any) => (
          <div key={asset.coin || asset.asset}>
            <span className="font-semibold">{asset.coin || asset.asset}:</span>{" "}
            <span>
              {(asset.availableBalance || asset.free || asset.total || "0")}
            </span>
          </div>
        ))}
      </div>
    )}
  </CardContent>
</Card>

        {/* Main Content Tabs */}
        <Tabs defaultValue="overview" className="space-y-4">
          <TabsList>
            <TabsTrigger value="overview">Overview</TabsTrigger>
            <TabsTrigger value="grid">Grid Status</TabsTrigger>
            <TabsTrigger value="market">Market Data</TabsTrigger>
            <TabsTrigger value="trades">Trade History</TabsTrigger>
            <TabsTrigger value="performance">Performance</TabsTrigger>
          </TabsList>

          <TabsContent value="overview" className="space-y-4">
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              {/* Trading Stats */}
              <Card>
                <CardHeader>
                  <CardTitle>Trading Statistics</CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="flex justify-between">
                    <span>Total Trades:</span>
                    <span className="font-semibold">{botData?.trading?.totalTrades}</span>
                  </div>
                  <div className="flex justify-between">
                    <span>Successful Trades:</span>
                    <span className="font-semibold text-green-600">{botData?.trading?.successfulTrades}</span>
                  </div>
                  <div className="flex justify-between">
                    <span>Daily Trades:</span>
                    <span className="font-semibold">
                      {botData?.trading?.dailyTrades}/{botData?.trading?.maxDailyTrades}
                    </span>
                  </div>
                  <div className="space-y-2">
                    <div className="flex justify-between text-sm">
                      <span>Daily Limit Usage</span>
                      <span>
                        {((botData?.trading?.dailyTrades / botData?.trading?.maxDailyTrades) * 100).toFixed(1)}%
                      </span>
                    </div>
                    <Progress
                      value={(botData?.trading?.dailyTrades / botData?.trading?.maxDailyTrades) * 100}
                      className="h-2"
                    />
                  </div>
                </CardContent>
              </Card>

              {/* Market Data */}
              <Card>
                <CardHeader>
                  <CardTitle>Market Analysis</CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="flex justify-between">
                    <span>ATR:</span>
                    <span className="font-semibold">{botData?.status?.atr?.toFixed(2)}</span>
                  </div>
                  <div className="flex justify-between">
                    <span>Volatility Index:</span>
                    <span className="font-semibold">{(botData?.status?.volatilityIndex * 100).toFixed(2)}%</span>
                  </div>
                  <div className="flex justify-between">
                    <span>Grid Spacing:</span>
                    <span className="font-semibold">{(botData?.grid?.spacing * 100).toFixed(3)}%</span>
                  </div>
                  <div className="flex justify-between">
                    <span>Investment:</span>
                    <span className="font-semibold">{formatCurrency(botData?.grid?.investment)}</span>
                  </div>
                </CardContent>
              </Card>
            </div>

            {/* Price Chart Placeholder */}
            <Card>
              <CardHeader>
                <CardTitle>Price History</CardTitle>
                <CardDescription>Recent price movements</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="h-64 flex items-center justify-center bg-gray-100 rounded">
                  <div className="text-center">
                    <BarChart3 className="h-12 w-12 text-gray-400 mx-auto mb-2" />
                    <p className="text-gray-500">Price chart visualization</p>
                    <p className="text-sm text-gray-400">
                      Latest: {formatCurrency(botData?.priceHistory[botData?.priceHistory?.length - 1] || 0)}
                    </p>
                    {botData?.priceHistory?.length > 0 && (
                      <p className="text-xs text-gray-400 mt-1">
                        Range: {formatCurrency(Math.min(...(botData?.priceHistory || [0])))} -{" "}
                        {formatCurrency(Math.max(...(botData?.priceHistory || [0])))}
                      </p>
                    )}
                  </div>
                </div>
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="grid" className="space-y-4">
            <Card>
              <CardHeader>
                <CardTitle>Grid Configuration</CardTitle>
                <CardDescription>Current grid levels and order placement</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="space-y-4">
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
                    <div>
                      <span className="text-muted-foreground">Total Levels:</span>
                      <div className="font-semibold">
                        {gridData?.statistics?.totalLevels || botData?.grid?.levels?.length || 0}
                      </div>
                    </div>
                    <div>
                      <span className="text-muted-foreground">Active Levels:</span>
                      <div className="font-semibold">
                        {gridData?.statistics?.activeLevels || botData?.trading?.activeOrders || 0}
                      </div>
                    </div>
                    <div>
                      <span className="text-muted-foreground">Spacing:</span>
                      <div className="font-semibold">
                        {((gridData?.configuration?.currentSpacing || botData?.grid?.spacing || 0) * 100).toFixed(3)}%
                      </div>
                    </div>
                    <div>
                      <span className="text-muted-foreground">Investment:</span>
                      <div className="font-semibold">
                        {formatCurrency(gridData?.configuration?.baseInvestment || botData?.grid?.investment || 0)}
                      </div>
                    </div>
                  </div>

                  {gridData?.statistics?.priceRange && (
                    <div className="grid grid-cols-3 gap-4 text-sm bg-gray-50 p-3 rounded">
                      <div>
                        <span className="text-muted-foreground">Lower Bound:</span>
                        <div className="font-semibold">{formatCurrency(gridData.statistics.priceRange.lower)}</div>
                      </div>
                      <div>
                        <span className="text-muted-foreground">Current Price:</span>
                        <div className="font-semibold">{formatCurrency(gridData.statistics.priceRange.current)}</div>
                      </div>
                      <div>
                        <span className="text-muted-foreground">Upper Bound:</span>
                        <div className="font-semibold">{formatCurrency(gridData.statistics.priceRange.upper)}</div>
                      </div>
                    </div>
                  )}

                  <div className="border rounded-lg overflow-hidden">
                    <div className="bg-gray-50 px-4 py-2 border-b">
                      <div className="grid grid-cols-6 gap-4 text-sm font-medium text-gray-700">
                        <span>Level</span>
                        <span>Buy Price</span>
                        <span>Sell Price</span>
                        <span>Quantity</span>
                        <span>Distance</span>
                        <span>Status</span>
                      </div>
                    </div>
                    <div className="max-h-64 overflow-y-auto">
                      {(gridData?.levels || botData?.grid?.levels || []).length > 0 ? (
                        (gridData?.levels || botData?.grid?.levels || []).slice(0, 15).map((level, index) => (
                          <div key={index} className="px-4 py-2 border-b last:border-b-0">
                            <div className="grid grid-cols-6 gap-4 text-sm">
                              <span className="font-medium">{level.level}</span>
                              <span>{formatCurrency(level.buyPrice)}</span>
                              <span>{formatCurrency(level.sellPrice)}</span>
                              <span>{level.quantity.toFixed(6)}</span>
                              <span className={level.distanceFromPrice > 0 ? "text-green-600" : "text-red-600"}>
                                {level.distanceFromPrice?.toFixed(2) || "0.00"}%
                              </span>
                              <span>
                                <Badge
                                  variant={level.status === "active" || level.active ? "default" : "secondary"}
                                  className="text-xs"
                                >
                                  {level.status === "active" || level.active ? "Active" : "Inactive"}
                                </Badge>
                              </span>
                            </div>
                          </div>
                        ))
                      ) : (
                        <div className="px-4 py-8 text-center text-gray-500">No grid levels available</div>
                      )}
                    </div>
                  </div>
                </div>
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="market" className="space-y-4">
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              {/* Price Information */}
              <Card>
                <CardHeader>
                  <CardTitle>Price Information</CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="flex justify-between">
                    <span>Current Price:</span>
                    <span className="font-semibold">
                      {formatCurrency(marketData?.price?.current || botData?.status?.currentPrice || 0)}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span>Previous Price:</span>
                    <span className="font-semibold">{formatCurrency(marketData?.price?.previous || 0)}</span>
                  </div>
                  <div className="flex justify-between">
                    <span>24h Change:</span>
                    <span
                      className={`font-semibold ${(marketData?.price?.changePercentage || 0) >= 0 ? "text-green-600" : "text-red-600"}`}
                    >
                      {(marketData?.price?.changePercentage || 0).toFixed(2)}%
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span>Support Level:</span>
                    <span className="font-semibold">{formatCurrency(marketData?.technical?.support || 0)}</span>
                  </div>
                  <div className="flex justify-between">
                    <span>Resistance Level:</span>
                    <span className="font-semibold">{formatCurrency(marketData?.technical?.resistance || 0)}</span>
                  </div>
                </CardContent>
              </Card>

              {/* Technical Analysis */}
              <Card>
                <CardHeader>
                  <CardTitle>Technical Analysis</CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="flex justify-between">
                    <span>Market Condition:</span>
                    <Badge
                      className={getMarketConditionColor(
                        marketData?.technical?.marketCondition || botData?.status?.marketCondition || "UNKNOWN",
                      )}
                    >
                      {marketData?.technical?.marketCondition || botData?.status?.marketCondition || "UNKNOWN"}
                    </Badge>
                  </div>
                  <div className="flex justify-between">
                    <span>Trend:</span>
                    <span className="font-semibold capitalize">{marketData?.technical?.trend || "Unknown"}</span>
                  </div>
                  <div className="flex justify-between">
                    <span>ATR:</span>
                    <span className="font-semibold">
                      {(marketData?.technical?.atr || botData?.status?.atr || 0).toFixed(2)}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span>Volatility Index:</span>
                    <span className="font-semibold">
                      {(
                        (marketData?.technical?.volatilityIndex || botData?.status?.volatilityIndex || 0) * 100
                      ).toFixed(2)}
                      %
                    </span>
                  </div>
                </CardContent>
              </Card>
            </div>

            {/* Volume Information */}
            <Card>
              <CardHeader>
                <CardTitle>Volume Information</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                  <div className="text-center">
                    <div className="text-2xl font-bold">
                      {formatCurrency(marketData?.volume?.totalVolume || botData?.performance?.totalVolume || 0)}
                    </div>
                    <p className="text-sm text-muted-foreground">Total Volume</p>
                  </div>
                  <div className="text-center">
                    <div className="text-2xl font-bold">
                      {formatCurrency(marketData?.volume?.averageTradeSize || botData?.performance?.avgTradeSize || 0)}
                    </div>
                    <p className="text-sm text-muted-foreground">Average Trade Size</p>
                  </div>
                  <div className="text-center">
                    <div className="text-2xl font-bold">{formatCurrency(marketData?.volume?.dailyVolume || 0)}</div>
                    <p className="text-sm text-muted-foreground">Daily Volume</p>
                  </div>
                </div>
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="trades" className="space-y-4">
            <Card>
              <CardHeader>
                <CardTitle>Recent Trades</CardTitle>
                <CardDescription>Latest trading activity</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="space-y-4">
                  {trades.length === 0 ? (
                    <div className="text-center py-8 text-gray-500">No trades recorded yet</div>
                  ) : (
                    <div className="border rounded-lg overflow-hidden">
                      <div className="bg-gray-50 px-4 py-2 border-b">
                        <div className="grid grid-cols-6 gap-4 text-sm font-medium text-gray-700">
                          <span>Time</span>
                          <span>Type</span>
                          <span>Side</span>
                          <span>Price</span>
                          <span>Quantity</span>
                          <span>P&L</span>
                        </div>
                      </div>
                      <div className="max-h-96 overflow-y-auto">
                        {trades.slice(0, 20).map((trade) => (
                          <div key={trade.id} className="px-4 py-2 border-b last:border-b-0">
                            <div className="grid grid-cols-6 gap-4 text-sm">
                              <span className="text-gray-600">{new Date(trade.timestamp).toLocaleTimeString()}</span>
                              <span>
                                <Badge variant="outline" className="text-xs">
                                  {trade.type.replace("_", " ")}
                                </Badge>
                              </span>
                              <span>
                                {trade.side && (
                                  <Badge variant={trade.side === "buy" ? "default" : "secondary"} className="text-xs">
                                    {trade.side.toUpperCase()}
                                  </Badge>
                                )}
                              </span>
                              <span>{formatCurrency(trade.price)}</span>
                              <span>{trade.quantity.toFixed(6)}</span>
                              <span
                                className={
                                  trade.profit !== undefined
                                    ? trade.profit >= 0
                                      ? "text-green-600"
                                      : "text-red-600"
                                    : "text-gray-500"
                                }
                              >
                                {trade.profit !== undefined ? formatCurrency(trade.profit) : "-"}
                              </span>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="performance" className="space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
              <Card>
                <CardHeader>
                  <CardTitle className="text-lg">Profit & Loss</CardTitle>
                </CardHeader>
                <CardContent className="space-y-3">
                  <div className="flex justify-between">
                    <span>Total Profit:</span>
                    <span className="font-semibold text-green-600">
                      {formatCurrency(botData?.performance?.totalProfit)}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span>Total Loss:</span>
                    <span className="font-semibold text-red-600">
                      {formatCurrency(botData?.performance?.totalLoss)}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span>Net P&L:</span>
                    <span
                      className={`font-semibold ${botData?.trading?.profitLoss >= 0 ? "text-green-600" : "text-red-600"}`}
                    >
                      {formatCurrency(botData?.trading?.profitLoss)}
                    </span>
                  </div>
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle className="text-lg">Trade Metrics</CardTitle>
                </CardHeader>
                <CardContent className="space-y-3">
                  <div className="flex justify-between">
                    <span>Win Rate:</span>
                    <span className="font-semibold">{botData?.performance?.winRate?.toFixed(1)}%</span>
                  </div>
                  <div className="flex justify-between">
                    <span>Best Trade:</span>
                    <span className="font-semibold text-green-600">
                      {formatCurrency(botData?.performance?.bestTrade)}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span>Worst Trade:</span>
                    <span className="font-semibold text-red-600">
                      {formatCurrency(botData?.performance?.worstTrade)}
                    </span>
                  </div>
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle className="text-lg">Volume & Size</CardTitle>
                </CardHeader>
                <CardContent className="space-y-3">
                  <div className="flex justify-between">
                    <span>Total Volume:</span>
                    <span className="font-semibold">{formatCurrency(botData?.performance?.totalVolume)}</span>
                  </div>
                  <div className="flex justify-between">
                    <span>Avg Trade Size:</span>
                    <span className="font-semibold">{formatCurrency(botData?.performance?.avgTradeSize)}</span>
                  </div>
                  <div className="flex justify-between">
                    <span>Profit Factor:</span>
                    <span className="font-semibold">{botData?.performance?.profitFactor?.toFixed(2)}</span>
                  </div>
                </CardContent>
              </Card>
            </div>
          </TabsContent>
        </Tabs>
      </div>
    </div>
  )
  
  
}
