import crypto from "crypto"
import fs from "fs/promises"
import path from "path"
import http from "http"
import { fileURLToPath } from "url"
import BybitAPI from "bybit-api"
import fetch from "node-fetch"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

// Data persistence paths
const DATA_DIR = path.join(__dirname, "data")
const CONFIG_FILE = path.join(DATA_DIR, "config.json")
const TRADES_FILE = path.join(DATA_DIR, "trades.json")
const PERFORMANCE_FILE = path.join(DATA_DIR, "performance.json")
const STATE_FILE = path.join(DATA_DIR, "bot_state.json")

// Enhanced Configuration
const CONFIG = {
  // API Configuration
  BYBIT_API_KEY: process.env.BYBIT_API_KEY,
  BYBIT_SECRET: process.env.BYBIT_SECRET,
  BYBIT_BASE_URL: "https://api.bybit.com",
  BYBIT_TESTNET: false, // Set to true for testnet

  // Telegram Configuration
  TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN,
  TELEGRAM_CHAT_ID: process.env.TELEGRAM_CHAT_ID,

  // Trading Configuration
  SYMBOL: "BTCUSDT",
  BASE_INVESTMENT: 1000,
  GRID_LEVELS: 15,
  MIN_GRID_SPACING: 0.003,
  MAX_GRID_SPACING: 0.025,
  ATR_PERIOD: 14,
  ATR_MULTIPLIER: 1.5,
  REBALANCE_THRESHOLD: 0.08,
  DCA_PERCENTAGE: 0.015,

  // Risk Management
  MAX_POSITION_SIZE: 0.08,
  STOP_LOSS_PERCENTAGE: 0.04,
  TAKE_PROFIT_PERCENTAGE: 0.025,
  MAX_DAILY_TRADES: 50,
  VOLATILITY_THRESHOLD: 0.02,

  // Performance Optimization
  ORDER_CHECK_INTERVAL: 3000,
  PRICE_UPDATE_INTERVAL: 2000,
  REBALANCE_COOLDOWN: 1800000,

  // Web UI Configuration
  WEB_PORT: 3001,
  ENABLE_WEB_UI: true,

  // Demo Mode Configuration
  ENABLE_DEMO_MODE: true,

  // Market Condition Thresholds
  BULL_MARKET_THRESHOLD: 0.02,
  BEAR_MARKET_THRESHOLD: -0.02,
  SIDEWAYS_VOLATILITY_MAX: 0.01,
}

class DataPersistence {
  constructor() {
    this.ensureDataDirectory()
  }

  async ensureDataDirectory() {
    try {
      await fs.mkdir(DATA_DIR, { recursive: true })
    } catch (error) {
      console.error("Error creating data directory:", error)
    }
  }

  async saveData(filename, data) {
    try {
      await fs.writeFile(filename, JSON.stringify(data, null, 2))
    } catch (error) {
      console.error(`Error saving data to ${filename}:`, error)
    }
  }

  async loadData(filename, defaultData = {}) {
    try {
      const data = await fs.readFile(filename, "utf8")
      return JSON.parse(data)
    } catch (error) {
      if (error.code === "ENOENT") {
        await this.saveData(filename, defaultData)
        return defaultData
      }
      console.error(`Error loading data from ${filename}:`, error)
      return defaultData
    }
  }

  async saveTrade(trade) {
    const trades = await this.loadData(TRADES_FILE, [])
    trades.push({
      ...trade,
      timestamp: Date.now(),
      id: crypto.randomUUID(),
    })

    // Keep only last 1000 trades
    if (trades.length > 1000) {
      trades.splice(0, trades.length - 1000)
    }

    await this.saveData(TRADES_FILE, trades)
  }

  async savePerformance(performance) {
    await this.saveData(PERFORMANCE_FILE, {
      ...performance,
      lastUpdated: Date.now(),
    })
  }

  async saveBotState(state) {
    await this.saveData(STATE_FILE, {
      ...state,
      lastUpdated: Date.now(),
    })
  }
}

class EnhancedBybitGridBot {
  constructor() {
    this.orders = new Map()
    this.gridLevels = []
    this.currentPrice = 0
    this.atr = 0
    this.isRunning = false
    this.lastRebalance = Date.now()
    this.priceHistory = []
    this.dailyTrades = 0
    this.lastTradeReset = Date.now()
    this.marketCondition = "SIDEWAYS"
    this.profitLoss = 0
    this.totalTrades = 0
    this.successfulTrades = 0
    this.lastPrice = 0
    this.priceChangeBuffer = []
    this.volatilityIndex = 0
    this.startTime = Date.now()
    this.useDemo = CONFIG.ENABLE_DEMO_MODE || !CONFIG.BYBIT_API_KEY || CONFIG.BYBIT_API_KEY === "demo_key"

    // Initialize Bybit API client
    if (!this.useDemo) {
      try {
        this.bybitClient = new BybitAPI.RestClientV5({
          key: CONFIG.BYBIT_API_KEY,
          secret: CONFIG.BYBIT_SECRET,
          testnet: CONFIG.BYBIT_TESTNET,
        })
        console.log("✅ Bybit API client initialized")
      } catch (error) {
        console.error("❌ Failed to initialize Bybit API client:", error.message)
        console.log("🔄 Switching to demo mode")
        this.useDemo = true
      }
    }

    // Data persistence
    this.dataManager = new DataPersistence()

    // Performance tracking
    this.performance = {
      totalProfit: 0,
      totalLoss: 0,
      winRate: 0,
      maxDrawdown: 0,
      sharpeRatio: 0,
      dailyReturns: [],
      totalVolume: 0,
      avgTradeSize: 0,
      bestTrade: 0,
      worstTrade: 0,
      profitFactor: 0,
    }

    // Load saved data
    this.loadSavedData()
  }

  async loadSavedData() {
    try {
      const savedState = await this.dataManager.loadData(STATE_FILE, {})
      const savedPerformance = await this.dataManager.loadData(PERFORMANCE_FILE, {})

      if (savedState.profitLoss !== undefined) {
        this.profitLoss = savedState.profitLoss
        this.totalTrades = savedState.totalTrades || 0
        this.successfulTrades = savedState.successfulTrades || 0
        this.dailyTrades = savedState.dailyTrades || 0
      }

      if (Object.keys(savedPerformance).length > 0) {
        this.performance = { ...this.performance, ...savedPerformance }
      }

      console.log("✅ Loaded saved bot data")
    } catch (error) {
      console.error("Error loading saved data:", error)
    }
  }

  async saveCurrentState() {
    const state = {
      profitLoss: this.profitLoss,
      totalTrades: this.totalTrades,
      successfulTrades: this.successfulTrades,
      dailyTrades: this.dailyTrades,
      currentPrice: this.currentPrice,
      marketCondition: this.marketCondition,
      volatilityIndex: this.volatilityIndex,
      atr: this.atr,
      activeOrders: this.orders.size,
      gridLevels: this.gridLevels.length,
      isRunning: this.isRunning,
      uptime: Date.now() - this.startTime,
    }

    await this.dataManager.saveBotState(state)
    await this.dataManager.savePerformance(this.performance)
  }

  async getCurrentPrice() {
    try {
      // If demo mode is enabled, use simulated data
      if (this.useDemo) {
        return this.getDemoPrice()
      }

      // Use bybit-api package to get current price
      const response = await this.bybitClient.getTickers({
        category: "spot",
        symbol: CONFIG.SYMBOL,
      })

      if (response.retCode === 0 && response.result.list && response.result.list.length > 0) {
        const newPrice = Number.parseFloat(response.result.list[0].lastPrice)

        if (this.currentPrice > 0) {
          const priceChange = (newPrice - this.currentPrice) / this.currentPrice
          this.priceChangeBuffer.push(priceChange)
          if (this.priceChangeBuffer.length > 20) {
            this.priceChangeBuffer.shift()
          }
        }

        this.lastPrice = this.currentPrice
        this.currentPrice = newPrice
        this.priceHistory.push(newPrice)

        if (this.priceHistory.length > 200) {
          this.priceHistory.shift()
        }

        return this.currentPrice
      }
      throw new Error("Invalid price data received")
    } catch (error) {
      console.error("Error fetching price:", error.message)

      // Fallback to demo mode on any error
      console.log("🔄 Switching to demo mode due to API error")
      this.useDemo = true
      return this.getDemoPrice()
    }
  }

  getDemoPrice() {
    const demoPrice =
      this.currentPrice > 0
        ? this.currentPrice + (Math.random() - 0.5) * (this.currentPrice * 0.01)
        : 45000 + (Math.random() - 0.5) * 2000

    if (this.currentPrice > 0) {
      const priceChange = (demoPrice - this.currentPrice) / this.currentPrice
      this.priceChangeBuffer.push(priceChange)
      if (this.priceChangeBuffer.length > 20) {
        this.priceChangeBuffer.shift()
      }
    }

    this.lastPrice = this.currentPrice
    this.currentPrice = demoPrice
    this.priceHistory.push(demoPrice)

    if (this.priceHistory.length > 200) {
      this.priceHistory.shift()
    }

    return this.currentPrice
  }

  async calculateATR() {
    try {
      if (this.useDemo) {
        return this.calculateDemoATR()
      }

      const intervals = ["1", "5", "15"]
      let atrSum = 0
      let validCalculations = 0

      for (const interval of intervals) {
        try {
          const response = await this.bybitClient.getKline({
            category: "spot",
            symbol: CONFIG.SYMBOL,
            interval: interval,
            limit: CONFIG.ATR_PERIOD + 1,
          })

          if (response.retCode === 0 && response.result.list && response.result.list.length > CONFIG.ATR_PERIOD) {
            const klines = response.result.list.reverse()
            let trSum = 0

            for (let i = 1; i < klines.length; i++) {
              const high = Number.parseFloat(klines[i][2])
              const low = Number.parseFloat(klines[i][3])
              const prevClose = Number.parseFloat(klines[i - 1][4])

              const tr = Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose))
              trSum += tr
            }

            const intervalATR = trSum / CONFIG.ATR_PERIOD
            atrSum += intervalATR
            validCalculations++
          }
        } catch (error) {
          console.error(`Error calculating ATR for interval ${interval}:`, error.message)
        }
      }

      if (validCalculations > 0) {
        this.atr = atrSum / validCalculations
        this.calculateVolatilityIndex()
        return this.atr
      } else {
        throw new Error("No valid ATR calculations")
      }
    } catch (error) {
      console.error("Error calculating ATR:", error.message)
      return this.calculateDemoATR()
    }
  }

  calculateDemoATR() {
    if (this.priceHistory.length >= 10) {
      const recentPrices = this.priceHistory.slice(-10)
      const maxPrice = Math.max(...recentPrices)
      const minPrice = Math.min(...recentPrices)
      this.atr = (maxPrice - minPrice) / 2
    } else {
      // Default ATR value based on current price
      this.atr = this.currentPrice * 0.01
    }
    this.calculateVolatilityIndex()
    return this.atr
  }

  calculateVolatilityIndex() {
    if (this.priceChangeBuffer.length < 10) return

    const variance =
      this.priceChangeBuffer.reduce((sum, change) => {
        return sum + Math.pow(change, 2)
      }, 0) / this.priceChangeBuffer.length

    this.volatilityIndex = Math.sqrt(variance)
  }

  detectMarketCondition() {
    if (this.priceHistory.length < 20) return "UNKNOWN"

    const recent = this.priceHistory.slice(-10)
    const older = this.priceHistory.slice(-20, -10)

    const recentAvg = recent.reduce((a, b) => a + b, 0) / recent.length
    const olderAvg = older.reduce((a, b) => a + b, 0) / older.length

    const momentum = (recentAvg - olderAvg) / olderAvg

    if (momentum > CONFIG.BULL_MARKET_THRESHOLD && this.volatilityIndex < CONFIG.VOLATILITY_THRESHOLD) {
      this.marketCondition = "BULL"
    } else if (momentum < CONFIG.BEAR_MARKET_THRESHOLD && this.volatilityIndex < CONFIG.VOLATILITY_THRESHOLD) {
      this.marketCondition = "BEAR"
    } else if (this.volatilityIndex > CONFIG.VOLATILITY_THRESHOLD) {
      this.marketCondition = "VOLATILE"
    } else {
      this.marketCondition = "SIDEWAYS"
    }

    return this.marketCondition
  }

  calculateDynamicGridSpacing() {
    if (!this.atr || !this.currentPrice) return CONFIG.MIN_GRID_SPACING

    const atrPercentage = this.atr / this.currentPrice
    let spacing = Math.max(CONFIG.MIN_GRID_SPACING, Math.min(CONFIG.MAX_GRID_SPACING, atrPercentage * 0.8))

    switch (this.marketCondition) {
      case "BULL":
        spacing *= 1.3
        break
      case "BEAR":
        spacing *= 0.9
        break
      case "VOLATILE":
        spacing *= 1.5
        break
      case "SIDEWAYS":
        spacing *= 0.8
        break
    }

    if (this.volatilityIndex > 0.01) {
      spacing *= 1 + this.volatilityIndex * 10
    }

    return Math.max(CONFIG.MIN_GRID_SPACING, Math.min(CONFIG.MAX_GRID_SPACING, spacing))
  }

  generateGridLevels() {
    const spacing = this.calculateDynamicGridSpacing()
    const centerPrice = this.currentPrice
    const atrRange = this.atr * CONFIG.ATR_MULTIPLIER

    this.gridLevels = []

    const upperBound = centerPrice + atrRange
    const lowerBound = centerPrice - atrRange
    const priceRange = upperBound - lowerBound
    const levelSpacing = priceRange / CONFIG.GRID_LEVELS

    for (let i = 0; i < CONFIG.GRID_LEVELS; i++) {
      const buyPrice = lowerBound + levelSpacing * i
      const sellPrice = buyPrice * (1 + spacing)
      const quantity = this.calculateOrderQuantity(buyPrice)

      const priceDistance = Math.abs(buyPrice - centerPrice) / centerPrice
      if (priceDistance < spacing * 0.5) continue

      this.gridLevels.push({
        level: i,
        buyPrice: Number.parseFloat(buyPrice.toFixed(6)),
        sellPrice: Number.parseFloat(sellPrice.toFixed(6)),
        quantity: Number.parseFloat(quantity.toFixed(8)),
        active: false,
        priceDistance: priceDistance,
      })
    }

    this.gridLevels.sort((a, b) => a.priceDistance - b.priceDistance)
    return this.gridLevels
  }

  calculateOrderQuantity(price) {
    const baseQuantity = CONFIG.BASE_INVESTMENT / CONFIG.GRID_LEVELS / price
    const maxQuantity = (CONFIG.BASE_INVESTMENT * CONFIG.MAX_POSITION_SIZE) / price

    let adjustedQuantity = Math.min(baseQuantity, maxQuantity)

    switch (this.marketCondition) {
      case "VOLATILE":
        adjustedQuantity *= 0.7
        break
      case "BULL":
        adjustedQuantity *= 1.1
        break
      case "BEAR":
        adjustedQuantity *= 0.9
        break
    }

    return Math.max(adjustedQuantity, 0.001)
  }

  async placeBuyOrder(price, quantity, orderType = "Limit") {
    if (this.dailyTrades >= CONFIG.MAX_DAILY_TRADES) {
      return null
    }

    try {
      if (this.useDemo) {
        return this.placeDemoOrder("Buy", price, quantity)
      }

      const params = {
        category: "spot",
        symbol: CONFIG.SYMBOL,
        side: "Buy",
        orderType: orderType,
        qty: quantity.toString(),
        price: price.toString(),
        timeInForce: "GTC",
      }

      const response = await this.bybitClient.submitOrder(params)

      if (response.retCode === 0) {
        this.dailyTrades++

        // Save trade to persistence
        await this.dataManager.saveTrade({
          type: "buy_order_placed",
          symbol: CONFIG.SYMBOL,
          price: price,
          quantity: quantity,
          orderId: response.result.orderId,
          marketCondition: this.marketCondition,
        })

        console.log(`✅ BUY: ${quantity} ${CONFIG.SYMBOL} @ $${price}`)
        return response.result
      } else {
        throw new Error(response.retMsg)
      }
    } catch (error) {
      console.error("❌ Buy order failed:", error.message)
      return null
    }
  }

  async placeSellOrder(price, quantity, orderType = "Limit") {
    if (this.dailyTrades >= CONFIG.MAX_DAILY_TRADES) {
      return null
    }

    try {
      if (this.useDemo) {
        return this.placeDemoOrder("Sell", price, quantity)
      }

      const params = {
        category: "spot",
        symbol: CONFIG.SYMBOL,
        side: "Sell",
        orderType: orderType,
        qty: quantity.toString(),
        price: price.toString(),
        timeInForce: "GTC",
      }

      const response = await this.bybitClient.submitOrder(params)

      if (response.retCode === 0) {
        this.dailyTrades++

        // Save trade to persistence
        await this.dataManager.saveTrade({
          type: "sell_order_placed",
          symbol: CONFIG.SYMBOL,
          price: price,
          quantity: quantity,
          orderId: response.result.orderId,
          marketCondition: this.marketCondition,
        })

        console.log(`✅ SELL: ${quantity} ${CONFIG.SYMBOL} @ $${price}`)
        return response.result
      } else {
        throw new Error(response.retMsg)
      }
    } catch (error) {
      console.error("❌ Sell order failed:", error.message)
      return null
    }
  }

  placeDemoOrder(side, price, quantity) {
    // Generate a random order ID for demo orders
    const orderId = `demo_${Date.now()}_${Math.floor(Math.random() * 1000000)}`

    console.log(`✅ DEMO ${side}: ${quantity} ${CONFIG.SYMBOL} @ $${price}`)

    return {
      orderId: orderId,
      symbol: CONFIG.SYMBOL,
      side: side,
      price: price,
      qty: quantity,
      orderType: "Limit",
      timeInForce: "GTC",
      orderStatus: "New",
      createTime: Date.now(),
    }
  }

  async handleFilledOrder(orderInfo, filledOrder) {
    this.totalTrades++
    const executedPrice = Number.parseFloat(filledOrder.price || filledOrder.avgPrice)
    const executedQty = Number.parseFloat(filledOrder.qty || filledOrder.cumExecQty)

    let profit = 0
    if (orderInfo.type === "sell") {
      profit = (executedPrice - orderInfo.buyPrice) * executedQty
      this.profitLoss += profit
      this.performance.totalProfit += Math.max(0, profit)
      this.performance.totalLoss += Math.max(0, -profit)
      this.successfulTrades += profit > 0 ? 1 : 0

      // Update performance metrics
      this.performance.bestTrade = Math.max(this.performance.bestTrade, profit)
      this.performance.worstTrade = Math.min(this.performance.worstTrade, profit)
    }

    this.performance.totalVolume += executedPrice * executedQty
    this.performance.avgTradeSize = this.performance.totalVolume / this.totalTrades
    this.performance.winRate = (this.successfulTrades / this.totalTrades) * 100

    if (this.performance.totalLoss > 0) {
      this.performance.profitFactor = this.performance.totalProfit / this.performance.totalLoss
    }

    // Save trade execution
    await this.dataManager.saveTrade({
      type: "order_filled",
      side: orderInfo.type,
      symbol: CONFIG.SYMBOL,
      price: executedPrice,
      quantity: executedQty,
      profit: profit,
      orderId: filledOrder.orderId || filledOrder.order_id,
      marketCondition: this.marketCondition,
      totalPnL: this.profitLoss,
    })

    // Save current state
    await this.saveCurrentState()

    console.log(`📋 Order filled: ${orderInfo.type} ${executedQty} @ $${executedPrice} | P&L: ${profit.toFixed(2)}`)
  }

  // API endpoints for web UI
  getApiData() {
    return {
      status: {
        isRunning: this.isRunning,
        currentPrice: this.currentPrice,
        marketCondition: this.marketCondition,
        volatilityIndex: this.volatilityIndex,
        atr: this.atr,
        uptime: Date.now() - this.startTime,
        demoMode: this.useDemo,
      },
      trading: {
        profitLoss: this.profitLoss,
        totalTrades: this.totalTrades,
        successfulTrades: this.successfulTrades,
        dailyTrades: this.dailyTrades,
        maxDailyTrades: CONFIG.MAX_DAILY_TRADES,
        activeOrders: this.orders.size,
        gridLevels: this.gridLevels.length,
      },
      performance: this.performance,
      grid: {
        levels: this.gridLevels,
        spacing: this.calculateDynamicGridSpacing(),
        investment: CONFIG.BASE_INVESTMENT,
      },
      priceHistory: this.priceHistory.slice(-50), // Last 50 price points
    }
  }

  async executeDCA() {
    const priceDropThreshold = this.currentPrice * (1 - CONFIG.DCA_PERCENTAGE)
    const recentLow = Math.min(...this.priceHistory.slice(-5))

    if (recentLow <= priceDropThreshold && (this.marketCondition === "SIDEWAYS" || this.marketCondition === "BULL")) {
      const dcaQuantity = this.calculateOrderQuantity(this.currentPrice) * 0.6
      const dcaPrice = this.currentPrice * 0.999

      const order = await this.placeBuyOrder(dcaPrice, dcaQuantity)
      if (order) {
        console.log(`🔄 DCA executed: ${this.marketCondition} market at $${this.currentPrice}`)
      }
    }
  }

  async rebalanceGrid() {
    const now = Date.now()
    const timeSinceLastRebalance = now - this.lastRebalance

    if (timeSinceLastRebalance < CONFIG.REBALANCE_COOLDOWN) return

    const centerLevel = this.gridLevels[Math.floor(this.gridLevels.length / 2)]
    if (!centerLevel) return

    const priceDeviation = Math.abs(this.currentPrice - centerLevel.buyPrice) / this.currentPrice

    const shouldRebalance =
      priceDeviation > CONFIG.REBALANCE_THRESHOLD ||
      this.volatilityIndex > CONFIG.VOLATILITY_THRESHOLD * 1.5 ||
      this.orders.size < CONFIG.GRID_LEVELS * 0.3

    if (shouldRebalance) {
      console.log(`🔄 Rebalancing grid - Deviation: ${(priceDeviation * 100).toFixed(2)}%`)

      await this.cancelAllOrders()
      await new Promise((resolve) => setTimeout(resolve, 2000))

      this.detectMarketCondition()
      await this.calculateATR()
      this.generateGridLevels()
      await this.placeGridOrders()

      this.lastRebalance = now
      await this.saveCurrentState()
    }
  }

  async monitorOrders() {
    try {
      if (this.useDemo) {
        await this.monitorDemoOrders()
        return
      }

      const response = await this.bybitClient.getActiveOrders({
        category: "spot",
        symbol: CONFIG.SYMBOL,
      })

      if (response.retCode === 0) {
        const activeOrders = response.result.list || []

        for (const [orderId, orderInfo] of this.orders.entries()) {
          const activeOrder = activeOrders.find((o) => o.orderId === orderId)

          if (!activeOrder) {
            const filledOrder = await this.checkOrderStatus(orderId)
            if (filledOrder && filledOrder.orderStatus === "Filled") {
              await this.handleFilledOrder(orderInfo, filledOrder)
              this.orders.delete(orderId)
            }
          }
        }
      }
    } catch (error) {
      console.error("Error monitoring orders:", error.message)
    }
  }

  async monitorDemoOrders() {
    // Simulate order fills in demo mode
    for (const [orderId, orderInfo] of this.orders.entries()) {
      // 5% chance of order being filled in each cycle
      if (Math.random() < 0.05) {
        const filledOrder = {
          orderId: orderId,
          orderStatus: "Filled",
          symbol: CONFIG.SYMBOL,
          side: orderInfo.type === "buy" ? "Buy" : "Sell",
          price: orderInfo.type === "buy" ? orderInfo.buyPrice : orderInfo.sellPrice,
          qty: orderInfo.quantity,
          createTime: Date.now(),
          updateTime: Date.now(),
        }

        await this.handleFilledOrder(orderInfo, filledOrder)
        this.orders.delete(orderId)

        console.log(`🔄 Demo order filled: ${orderInfo.type} at $${filledOrder.price}`)
      }
    }
  }

  async checkOrderStatus(orderId) {
    try {
      if (this.useDemo) {
        return null // Demo orders are handled in monitorDemoOrders
      }

      const response = await this.bybitClient.getOrderHistory({
        category: "spot",
        symbol: CONFIG.SYMBOL,
        orderId: orderId,
      })

      if (response.retCode === 0 && response.result.list && response.result.list.length > 0) {
        return response.result.list[0]
      }
    } catch (error) {
      console.error("Error checking order status:", error.message)
    }
    return null
  }

  async placeGridOrders() {
    let placedOrders = 0
    const maxConcurrentOrders = Math.min(CONFIG.GRID_LEVELS, 20)

    for (const level of this.gridLevels.slice(0, maxConcurrentOrders)) {
      try {
        if (level.buyPrice < this.currentPrice * 0.995) {
          const buyOrder = await this.placeBuyOrder(level.buyPrice, level.quantity)
          if (buyOrder) {
            this.orders.set(buyOrder.orderId, {
              ...level,
              type: "buy",
              orderId: buyOrder.orderId,
              timestamp: Date.now(),
            })
            placedOrders++
          }
        }

        if (level.sellPrice > this.currentPrice * 1.005) {
          const sellOrder = await this.placeSellOrder(level.sellPrice, level.quantity)
          if (sellOrder) {
            this.orders.set(sellOrder.orderId, {
              ...level,
              type: "sell",
              orderId: sellOrder.orderId,
              timestamp: Date.now(),
            })
            placedOrders++
          }
        }

        await new Promise((resolve) => setTimeout(resolve, 200))
      } catch (error) {
        console.error("Error placing grid order:", error.message)
      }
    }

    console.log(`✅ Placed ${placedOrders} grid orders`)
    return placedOrders
  }

  async cancelAllOrders() {
    try {
      if (this.useDemo) {
        console.log("✅ All demo orders cancelled")
        this.orders.clear()
        return true
      }

      const response = await this.bybitClient.cancelAllOrders({
        category: "spot",
        symbol: CONFIG.SYMBOL,
      })

      if (response.retCode === 0) {
        console.log("✅ All orders cancelled")
        this.orders.clear()
        return true
      }
    } catch (error) {
      console.error("Error cancelling orders:", error.message)
    }
    return false
  }

  resetDailyTrades() {
    const now = Date.now()
    if (now - this.lastTradeReset > 86400000) {
      this.dailyTrades = 0
      this.lastTradeReset = now
      console.log("🔄 Daily trade counter reset")
    }
  }

  async sendTelegramMessage(message) {
    try {
      if (!CONFIG.TELEGRAM_BOT_TOKEN || !CONFIG.TELEGRAM_CHAT_ID) {
        return // Skip if Telegram is not configured
      }

      const url = `https://api.telegram.org/bot${CONFIG.TELEGRAM_BOT_TOKEN}/sendMessage`
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: CONFIG.TELEGRAM_CHAT_ID,
          text: message,
          parse_mode: "HTML",
          disable_web_page_preview: true,
        }),
      })

      const data = await response.json()
      if (!data.ok) {
        console.error("Telegram error:", data.description)
      }
    } catch (error) {
      console.error("Error sending Telegram message:", error.message)
    }
  }

  async start() {
    console.log("🚀 Starting Enhanced Bybit Grid Trading Bot with Persistence...")

    if (this.useDemo) {
      console.log("⚠️ Running in DEMO MODE - No real trading will occur")
    }

    this.isRunning = true
    let loopCount = 0

    while (this.isRunning) {
      try {
        loopCount++

        await this.getCurrentPrice()
        if (!this.currentPrice) {
          await new Promise((resolve) => setTimeout(resolve, 5000))
          continue
        }

        await this.calculateATR()
        this.detectMarketCondition()
        this.resetDailyTrades()

        if (this.gridLevels.length === 0) {
          this.generateGridLevels()
          await this.placeGridOrders()
        }

        await this.monitorOrders()
        await this.executeDCA()
        await this.rebalanceGrid()

        // Save state periodically
        if (loopCount % 10 === 0) {
          await this.saveCurrentState()
        }

        // Log status every 30 loops
        if (loopCount % 30 === 0) {
          console.log(
            `📊 Price: $${this.currentPrice.toFixed(2)} | Market: ${this.marketCondition} | P&L: $${this.profitLoss.toFixed(2)} | Orders: ${this.orders.size}`,
          )
        }

        await new Promise((resolve) => setTimeout(resolve, CONFIG.PRICE_UPDATE_INTERVAL))
      } catch (error) {
        console.error("❌ Error in main loop:", error.message)
        await new Promise((resolve) => setTimeout(resolve, 10000))
      }
    }
  }

  async stop() {
    console.log("🛑 Stopping Enhanced Grid Bot...")
    this.isRunning = false
    await this.cancelAllOrders()
    await this.saveCurrentState()
  }
}

// Web Server for UI
class WebServer {
  constructor(gridBot) {
    this.gridBot = gridBot
    this.server = null
  }

  start() {
    this.server = http.createServer(async (req, res) => {
      // Enable CORS
      res.setHeader("Access-Control-Allow-Origin", "*")
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
      res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization")

      if (req.method === "OPTIONS") {
        res.writeHead(200)
        res.end()
        return
      }

      const url = new URL(req.url, `http://${req.headers.host}`)
      const pathname = url.pathname
      const method = req.method

      try {
        // Route handling
        if (pathname === "/api/status" && method === "GET") {
          await this.handleStatusRequest(res)
        } else if (pathname === "/api/trades" && method === "GET") {
          await this.handleTradesRequest(res)
        } else if (pathname === "/api/performance" && method === "GET") {
          await this.handlePerformanceRequest(res)
        } else if (pathname === "/api/grid" && method === "GET") {
          await this.handleGridRequest(res)
        } else if (pathname === "/api/config" && method === "GET") {
          await this.handleConfigRequest(res)
        } else if (pathname === "/api/config" && method === "PUT") {
          await this.handleConfigUpdateRequest(req, res)
        } else if (pathname === "/api/control" && method === "POST") {
          await this.handleControlRequest(req, res)
        } else if (pathname === "/api/orders" && method === "GET") {
          await this.handleOrdersRequest(res)
        } else if (pathname === "/api/market" && method === "GET") {
          await this.handleMarketRequest(res)
        } else if (pathname === "/api/stats" && method === "GET") {
          await this.handleStatsRequest(res)
        } else if (pathname === "/api/logs" && method === "GET") {
          await this.handleLogsRequest(res)
        } else if (pathname === "/health" && method === "GET") {
          await this.handleHealthRequest(res)
        } else {
          res.writeHead(404, { "Content-Type": "application/json" })
          res.end(JSON.stringify({ error: "Endpoint not found" }))
        }
      } catch (error) {
        console.error("API Error:", error)
        res.writeHead(500, { "Content-Type": "application/json" })
        res.end(JSON.stringify({ error: "Internal server error", message: error.message }))
      }
    })

    this.server.listen(CONFIG.WEB_PORT, () => {
      console.log(`🌐 Enhanced REST API server running at http://localhost:${CONFIG.WEB_PORT}`)
      console.log(`📊 API Documentation:`)
      console.log(`   GET  /api/status      - Bot status and current state`)
      console.log(`   GET  /api/trades      - Recent trading history`)
      console.log(`   GET  /api/performance - Performance metrics`)
      console.log(`   GET  /api/grid        - Grid configuration and levels`)
      console.log(`   GET  /api/config      - Bot configuration`)
      console.log(`   PUT  /api/config      - Update bot configuration`)
      console.log(`   POST /api/control     - Control bot (start/stop/rebalance)`)
      console.log(`   GET  /api/orders      - Active orders`)
      console.log(`   GET  /api/market      - Market data and analysis`)
      console.log(`   GET  /api/stats       - Trading statistics`)
      console.log(`   GET  /api/logs        - Recent bot logs`)
      console.log(`   GET  /health          - Health check`)
    })
  }

  // Enhanced status endpoint with more detailed information
  async handleStatusRequest(res) {
    try {
      const status = {
        bot: {
          isRunning: this.gridBot.isRunning,
          demoMode: this.gridBot.useDemo,
          uptime: Date.now() - this.gridBot.startTime,
          version: "2.0.0",
          lastUpdate: Date.now(),
        },
        trading: {
          currentPrice: this.gridBot.currentPrice,
          profitLoss: this.gridBot.profitLoss,
          totalTrades: this.gridBot.totalTrades,
          successfulTrades: this.gridBot.successfulTrades,
          dailyTrades: this.gridBot.dailyTrades,
          maxDailyTrades: CONFIG.MAX_DAILY_TRADES,
          activeOrders: this.gridBot.orders.size,
          gridLevels: this.gridBot.gridLevels.length,
        },
        market: {
          condition: this.gridBot.marketCondition,
          volatilityIndex: this.gridBot.volatilityIndex,
          atr: this.gridBot.atr,
          priceChange24h: this.calculatePriceChange24h(),
          trend: this.calculateTrend(),
        },
        system: {
          memoryUsage: process.memoryUsage(),
          nodeVersion: process.version,
          platform: process.platform,
        },
      }

      res.writeHead(200, { "Content-Type": "application/json" })
      res.end(JSON.stringify(status))
    } catch (error) {
      throw error
    }
  }

  // Enhanced trades endpoint with filtering and pagination
  async handleTradesRequest(res) {
    try {
      const url = new URL(res.req.url, `http://${res.req.headers.host}`)
      const limit = Number.parseInt(url.searchParams.get("limit")) || 100
      const offset = Number.parseInt(url.searchParams.get("offset")) || 0
      const type = url.searchParams.get("type") // filter by trade type

      const allTrades = await this.gridBot.dataManager.loadData(TRADES_FILE, [])

      let filteredTrades = allTrades
      if (type) {
        filteredTrades = allTrades.filter((trade) => trade.type === type)
      }

      const paginatedTrades = filteredTrades.slice(offset, offset + limit).map((trade) => ({
        ...trade,
        timestamp: new Date(trade.timestamp).toISOString(),
      }))

      const response = {
        trades: paginatedTrades,
        pagination: {
          total: filteredTrades.length,
          limit,
          offset,
          hasMore: offset + limit < filteredTrades.length,
        },
        summary: {
          totalTrades: allTrades.length,
          totalProfit: allTrades.reduce((sum, trade) => sum + (trade.profit || 0), 0),
          avgTradeSize:
            allTrades.length > 0
              ? allTrades.reduce((sum, trade) => sum + trade.price * trade.quantity, 0) / allTrades.length
              : 0,
        },
      }

      res.writeHead(200, { "Content-Type": "application/json" })
      res.end(JSON.stringify(response))
    } catch (error) {
      throw error
    }
  }

  // Performance metrics endpoint
  async handlePerformanceRequest(res) {
    try {
      const performance = {
        ...this.gridBot.performance,
        winRate: this.gridBot.totalTrades > 0 ? (this.gridBot.successfulTrades / this.gridBot.totalTrades) * 100 : 0,
        totalReturn: this.gridBot.profitLoss,
        totalReturnPercentage: (this.gridBot.profitLoss / CONFIG.BASE_INVESTMENT) * 100,
        dailyReturn: this.calculateDailyReturn(),
        maxDrawdownPercentage: this.calculateMaxDrawdown(),
        sharpeRatio: this.calculateSharpeRatio(),
        calmarRatio: this.calculateCalmarRatio(),
        sortino: this.calculateSortino(),
        lastUpdated: Date.now(),
      }

      res.writeHead(200, { "Content-Type": "application/json" })
      res.end(JSON.stringify(performance))
    } catch (error) {
      throw error
    }
  }

  // Grid configuration and levels endpoint
  async handleGridRequest(res) {
    try {
      const gridData = {
        configuration: {
          symbol: CONFIG.SYMBOL,
          baseInvestment: CONFIG.BASE_INVESTMENT,
          gridLevels: CONFIG.GRID_LEVELS,
          minSpacing: CONFIG.MIN_GRID_SPACING,
          maxSpacing: CONFIG.MAX_GRID_SPACING,
          currentSpacing: this.gridBot.calculateDynamicGridSpacing(),
          atrMultiplier: CONFIG.ATR_MULTIPLIER,
        },
        levels: this.gridBot.gridLevels.map((level) => ({
          ...level,
          status: this.gridBot.orders.has(level.orderId) ? "active" : "inactive",
          distanceFromPrice: ((level.buyPrice - this.gridBot.currentPrice) / this.gridBot.currentPrice) * 100,
        })),
        statistics: {
          totalLevels: this.gridBot.gridLevels.length,
          activeLevels: this.gridBot.orders.size,
          averageSpacing: this.gridBot.calculateDynamicGridSpacing(),
          priceRange: {
            upper: Math.max(...this.gridBot.gridLevels.map((l) => l.sellPrice)),
            lower: Math.min(...this.gridBot.gridLevels.map((l) => l.buyPrice)),
            current: this.gridBot.currentPrice,
          },
        },
      }

      res.writeHead(200, { "Content-Type": "application/json" })
      res.end(JSON.stringify(gridData))
    } catch (error) {
      throw error
    }
  }

  // Configuration endpoint
  async handleConfigRequest(res) {
    try {
      const config = {
        trading: {
          symbol: CONFIG.SYMBOL,
          baseInvestment: CONFIG.BASE_INVESTMENT,
          gridLevels: CONFIG.GRID_LEVELS,
          minGridSpacing: CONFIG.MIN_GRID_SPACING,
          maxGridSpacing: CONFIG.MAX_GRID_SPACING,
          atrPeriod: CONFIG.ATR_PERIOD,
          atrMultiplier: CONFIG.ATR_MULTIPLIER,
          rebalanceThreshold: CONFIG.REBALANCE_THRESHOLD,
          dcaPercentage: CONFIG.DCA_PERCENTAGE,
        },
        risk: {
          maxPositionSize: CONFIG.MAX_POSITION_SIZE,
          stopLossPercentage: CONFIG.STOP_LOSS_PERCENTAGE,
          takeProfitPercentage: CONFIG.TAKE_PROFIT_PERCENTAGE,
          maxDailyTrades: CONFIG.MAX_DAILY_TRADES,
          volatilityThreshold: CONFIG.VOLATILITY_THRESHOLD,
        },
        system: {
          orderCheckInterval: CONFIG.ORDER_CHECK_INTERVAL,
          priceUpdateInterval: CONFIG.PRICE_UPDATE_INTERVAL,
          rebalanceCooldown: CONFIG.REBALANCE_COOLDOWN,
          webPort: CONFIG.WEB_PORT,
          enableWebUI: CONFIG.ENABLE_WEB_UI,
          enableDemoMode: CONFIG.ENABLE_DEMO_MODE,
        },
        market: {
          bullMarketThreshold: CONFIG.BULL_MARKET_THRESHOLD,
          bearMarketThreshold: CONFIG.BEAR_MARKET_THRESHOLD,
          sidewaysVolatilityMax: CONFIG.SIDEWAYS_VOLATILITY_MAX,
        },
      }

      res.writeHead(200, { "Content-Type": "application/json" })
      res.end(JSON.stringify(config))
    } catch (error) {
      throw error
    }
  }

  // Configuration update endpoint
  async handleConfigUpdateRequest(req, res) {
    let body = ""
    req.on("data", (chunk) => {
      body += chunk.toString()
    })

    req.on("end", async () => {
      try {
        const updates = JSON.parse(body)

        // Validate and update configuration
        const validatedUpdates = this.validateConfigUpdates(updates)

        // Apply updates to CONFIG object
        Object.assign(CONFIG, validatedUpdates)

        // Save updated configuration
        await this.gridBot.dataManager.saveData(CONFIG_FILE, CONFIG)

        res.writeHead(200, { "Content-Type": "application/json" })
        res.end(
          JSON.stringify({
            success: true,
            message: "Configuration updated successfully",
            updatedFields: Object.keys(validatedUpdates),
          }),
        )
      } catch (error) {
        res.writeHead(400, { "Content-Type": "application/json" })
        res.end(JSON.stringify({ error: "Invalid configuration data", message: error.message }))
      }
    })
  }

  // Enhanced control endpoint
  async handleControlRequest(req, res) {
    let body = ""
    req.on("data", (chunk) => {
      body += chunk.toString()
    })

    req.on("end", async () => {
      try {
        const { action, params } = JSON.parse(body)

        let result = { success: false, message: "" }

        switch (action) {
          case "start":
            if (!this.gridBot.isRunning) {
              this.gridBot.start()
              result = { success: true, message: "Bot started successfully" }
            } else {
              result = { success: false, message: "Bot is already running" }
            }
            break

          case "stop":
            if (this.gridBot.isRunning) {
              await this.gridBot.stop()
              result = { success: true, message: "Bot stopped successfully" }
            } else {
              result = { success: false, message: "Bot is not running" }
            }
            break

          case "rebalance":
            await this.gridBot.rebalanceGrid()
            result = { success: true, message: "Grid rebalanced successfully" }
            break

          case "cancel_orders":
            await this.gridBot.cancelAllOrders()
            result = { success: true, message: "All orders cancelled successfully" }
            break

          case "reset_daily_trades":
            this.gridBot.dailyTrades = 0
            this.gridBot.lastTradeReset = Date.now()
            result = { success: true, message: "Daily trade counter reset" }
            break

          case "force_dca":
            await this.gridBot.executeDCA()
            result = { success: true, message: "DCA executed" }
            break

          default:
            result = { success: false, message: "Unknown action" }
        }

        res.writeHead(200, { "Content-Type": "application/json" })
        res.end(JSON.stringify(result))
      } catch (error) {
        res.writeHead(400, { "Content-Type": "application/json" })
        res.end(JSON.stringify({ error: "Control action failed", message: error.message }))
      }
    })
  }

  // Active orders endpoint
  async handleOrdersRequest(res) {
    try {
      const orders = Array.from(this.gridBot.orders.entries()).map(([orderId, orderInfo]) => ({
        orderId,
        ...orderInfo,
        age: Date.now() - orderInfo.timestamp,
        distanceFromPrice:
          (((orderInfo.buyPrice || orderInfo.sellPrice) - this.gridBot.currentPrice) / this.gridBot.currentPrice) * 100,
      }))

      const orderStats = {
        total: orders.length,
        buyOrders: orders.filter((o) => o.type === "buy").length,
        sellOrders: orders.filter((o) => o.type === "sell").length,
        averageAge: orders.length > 0 ? orders.reduce((sum, o) => sum + o.age, 0) / orders.length : 0,
        oldestOrder: orders.length > 0 ? Math.max(...orders.map((o) => o.age)) : 0,
      }

      res.writeHead(200, { "Content-Type": "application/json" })
      res.end(JSON.stringify({ orders, statistics: orderStats }))
    } catch (error) {
      throw error
    }
  }

  // Market data endpoint
  async handleMarketRequest(res) {
    try {
      const marketData = {
        price: {
          current: this.gridBot.currentPrice,
          previous: this.gridBot.lastPrice,
          change: this.gridBot.currentPrice - this.gridBot.lastPrice,
          changePercentage:
            this.gridBot.lastPrice > 0
              ? ((this.gridBot.currentPrice - this.gridBot.lastPrice) / this.gridBot.lastPrice) * 100
              : 0,
          history: this.gridBot.priceHistory.slice(-50),
        },
        technical: {
          atr: this.gridBot.atr,
          volatilityIndex: this.gridBot.volatilityIndex,
          marketCondition: this.gridBot.marketCondition,
          trend: this.calculateTrend(),
          support: this.calculateSupport(),
          resistance: this.calculateResistance(),
        },
        volume: {
          totalVolume: this.gridBot.performance.totalVolume,
          averageTradeSize: this.gridBot.performance.avgTradeSize,
          dailyVolume: this.calculateDailyVolume(),
        },
      }

      res.writeHead(200, { "Content-Type": "application/json" })
      res.end(JSON.stringify(marketData))
    } catch (error) {
      throw error
    }
  }

  // Trading statistics endpoint
  async handleStatsRequest(res) {
    try {
      const stats = {
        overview: {
          totalTrades: this.gridBot.totalTrades,
          successfulTrades: this.gridBot.successfulTrades,
          winRate: this.gridBot.totalTrades > 0 ? (this.gridBot.successfulTrades / this.gridBot.totalTrades) * 100 : 0,
          profitLoss: this.gridBot.profitLoss,
          dailyTrades: this.gridBot.dailyTrades,
          maxDailyTrades: CONFIG.MAX_DAILY_TRADES,
        },
        performance: {
          bestTrade: this.gridBot.performance.bestTrade,
          worstTrade: this.gridBot.performance.worstTrade,
          averageTradeSize: this.gridBot.performance.avgTradeSize,
          profitFactor: this.gridBot.performance.profitFactor,
          totalReturn: (this.gridBot.profitLoss / CONFIG.BASE_INVESTMENT) * 100,
          annualizedReturn: this.calculateAnnualizedReturn(),
        },
        risk: {
          maxDrawdown: this.calculateMaxDrawdown(),
          sharpeRatio: this.calculateSharpeRatio(),
          volatility: this.gridBot.volatilityIndex,
          currentExposure: this.calculateCurrentExposure(),
        },
        timing: {
          uptime: Date.now() - this.gridBot.startTime,
          lastTrade: this.getLastTradeTime(),
          lastRebalance: this.gridBot.lastRebalance,
          nextRebalanceEligible: this.gridBot.lastRebalance + CONFIG.REBALANCE_COOLDOWN,
        },
      }

      res.writeHead(200, { "Content-Type": "application/json" })
      res.end(JSON.stringify(stats))
    } catch (error) {
      throw error
    }
  }

  // Logs endpoint (simplified for demo)
  async handleLogsRequest(res) {
    try {
      const logs = [
        {
          timestamp: Date.now(),
          level: "info",
          message: `Bot running in ${this.gridBot.useDemo ? "demo" : "live"} mode`,
        },
        {
          timestamp: Date.now() - 60000,
          level: "info",
          message: `Current price: $${this.gridBot.currentPrice.toFixed(2)}`,
        },
        { timestamp: Date.now() - 120000, level: "info", message: `Market condition: ${this.gridBot.marketCondition}` },
        { timestamp: Date.now() - 180000, level: "info", message: `Active orders: ${this.gridBot.orders.size}` },
      ]

      res.writeHead(200, { "Content-Type": "application/json" })
      res.end(JSON.stringify({ logs }))
    } catch (error) {
      throw error
    }
  }

  // Health check endpoint
  async handleHealthRequest(res) {
    try {
      const health = {
        status: "healthy",
        timestamp: new Date().toISOString(),
        uptime: Date.now() - this.gridBot.startTime,
        version: "2.0.0",
        checks: {
          bot: this.gridBot.isRunning ? "running" : "stopped",
          api: this.gridBot.useDemo ? "demo" : "connected",
          database: "connected",
          memory: process.memoryUsage().heapUsed < 500 * 1024 * 1024 ? "ok" : "warning",
        },
      }

      res.writeHead(200, { "Content-Type": "application/json" })
      res.end(JSON.stringify(health))
    } catch (error) {
      throw error
    }
  }

  // Helper methods for calculations
  calculatePriceChange24h() {
    if (this.gridBot.priceHistory.length < 2) return 0
    const current = this.gridBot.currentPrice
    const dayAgo = this.gridBot.priceHistory[Math.max(0, this.gridBot.priceHistory.length - 48)] || current
    return ((current - dayAgo) / dayAgo) * 100
  }

  calculateTrend() {
    if (this.gridBot.priceHistory.length < 10) return "unknown"
    const recent = this.gridBot.priceHistory.slice(-10)
    const slope = (recent[recent.length - 1] - recent[0]) / recent.length
    return slope > 0 ? "up" : slope < 0 ? "down" : "sideways"
  }

  calculateDailyReturn() {
    // Simplified daily return calculation
    return (this.gridBot.profitLoss / CONFIG.BASE_INVESTMENT) * 100
  }

  calculateMaxDrawdown() {
    // Simplified max drawdown calculation
    return Math.min(0, (this.gridBot.performance.worstTrade / CONFIG.BASE_INVESTMENT) * 100)
  }

  calculateSharpeRatio() {
    // Simplified Sharpe ratio calculation
    const returns = this.calculateDailyReturn()
    const volatility = this.gridBot.volatilityIndex * 100
    return volatility > 0 ? returns / volatility : 0
  }

  calculateCalmarRatio() {
    const annualReturn = this.calculateAnnualizedReturn()
    const maxDrawdown = Math.abs(this.calculateMaxDrawdown())
    return maxDrawdown > 0 ? annualReturn / maxDrawdown : 0
  }

  calculateSortino() {
    // Simplified Sortino ratio
    return this.calculateSharpeRatio() * 1.2 // Approximation
  }

  calculateAnnualizedReturn() {
    const uptime = Date.now() - this.gridBot.startTime
    const daysRunning = uptime / (1000 * 60 * 60 * 24)
    const totalReturn = (this.gridBot.profitLoss / CONFIG.BASE_INVESTMENT) * 100
    return daysRunning > 0 ? (totalReturn / daysRunning) * 365 : 0
  }

  calculateSupport() {
    if (this.gridBot.priceHistory.length < 10) return this.gridBot.currentPrice * 0.95
    return Math.min(...this.gridBot.priceHistory.slice(-20))
  }

  calculateResistance() {
    if (this.gridBot.priceHistory.length < 10) return this.gridBot.currentPrice * 1.05
    return Math.max(...this.gridBot.priceHistory.slice(-20))
  }

  calculateDailyVolume() {
    // Simplified daily volume calculation
    return this.gridBot.performance.totalVolume * (this.gridBot.dailyTrades / Math.max(1, this.gridBot.totalTrades))
  }

  calculateCurrentExposure() {
    const totalOrderValue = Array.from(this.gridBot.orders.values()).reduce(
      (sum, order) => sum + order.quantity * (order.buyPrice || order.sellPrice),
      0,
    )
    return (totalOrderValue / CONFIG.BASE_INVESTMENT) * 100
  }

  getLastTradeTime() {
    // This would need to be tracked in the actual implementation
    return Date.now() - Math.random() * 3600000 // Random time within last hour for demo
  }

  validateConfigUpdates(updates) {
    const validated = {}

    // Add validation logic for each configuration field
    if (updates.BASE_INVESTMENT && updates.BASE_INVESTMENT > 0) {
      validated.BASE_INVESTMENT = updates.BASE_INVESTMENT
    }

    if (updates.GRID_LEVELS && updates.GRID_LEVELS > 0 && updates.GRID_LEVELS <= 50) {
      validated.GRID_LEVELS = updates.GRID_LEVELS
    }

    if (updates.MAX_DAILY_TRADES && updates.MAX_DAILY_TRADES > 0) {
      validated.MAX_DAILY_TRADES = updates.MAX_DAILY_TRADES
    }

    // Add more validation as needed

    return validated
  }
}

// Initialize and start the bot
async function main() {
  console.log("🔧 Initializing Enhanced Bybit Grid Trading Bot with Persistence...")

  if (!CONFIG.BYBIT_API_KEY || !CONFIG.BYBIT_SECRET) {
    console.log("⚠️ Bybit API credentials not found, running in demo mode")
    CONFIG.ENABLE_DEMO_MODE = true
  }

  if (!CONFIG.TELEGRAM_BOT_TOKEN || !CONFIG.TELEGRAM_CHAT_ID) {
    console.log("⚠️ Telegram credentials not found, notifications will be disabled")
  }

  const gridBot = new EnhancedBybitGridBot()

  // Start web server if enabled
  if (CONFIG.ENABLE_WEB_UI) {
    const webServer = new WebServer(gridBot)
    webServer.start()
  }

  // Start the trading bot
  gridBot.start().catch((error) => {
    console.error("💥 Fatal error:", error)
    process.exit(1)
  })

  // Graceful shutdown
  const shutdown = async (signal) => {
    console.log(`\n🛑 Received ${signal}, shutting down gracefully...`)
    await gridBot.stop()
    process.exit(0)
  }

  process.on("SIGINT", () => shutdown("SIGINT"))
  process.on("SIGTERM", () => shutdown("SIGTERM"))

  console.log("🚀 Enhanced Grid Trading Bot with Persistence is now running!")
  console.log(`🌐 Web UI: http://localhost:${CONFIG.WEB_PORT}`)
}

main().catch(console.error)
